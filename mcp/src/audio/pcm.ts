/**
 * Uncompressed audio in and out: WAV (PCM 8/16/24/32-bit, float 32/64, extensible) and AIFF/AIFC.
 *
 * Pure TypeScript, so the formats every engine and DAW reads need no ffmpeg on the user's machine.
 * TAKEBOX's own 24-bit writer (`shared/dsp/wav.ts`) stays the reference for 24-bit; this adds the
 * depths a game asks for: 16-bit for Unreal and old tooling, 32-bit float for a sound designer
 * who wants headroom.
 */

export interface Audio {
  channels: Float32Array[];
  sampleRate: number;
}

export type WavDepth = 16 | 24 | 32;

// ── Reading ──────────────────────────────────────────────────────────────────────────

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

export function sniffPcm(bytes: Uint8Array): "wav" | "aiff" | null {
  if (bytes.length < 12) return null;
  const head = ascii(bytes, 0, 4);
  const kind = ascii(bytes, 8, 4);
  if ((head === "RIFF" || head === "RF64") && kind === "WAVE") return "wav";
  if (head === "FORM" && (kind === "AIFF" || kind === "AIFC")) return "aiff";
  return null;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function decodeWav(bytes: Uint8Array): Audio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
        // The sub-format GUID starts with the real format tag.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataStart = body;
      // A file written to a pipe (ffmpeg's stdout) cannot go back and fill the size in: it says
      // 0 or 0xFFFFFFFF, and the data runs to the end of the file.
      const remaining = bytes.length - body;
      dataLength = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
      break;
    }
    if (size === 0xffffffff) size = 0;
    offset = body + size + (size % 2);
  }

  if (dataStart < 0 || channelCount < 1 || sampleRate < 1) {
    throw new Error("This WAV file has no readable audio (no fmt or data chunk).");
  }
  const bytesPerSample = bits / 8;
  if (![1, 2, 3, 4, 8].includes(bytesPerSample)) throw new Error(`WAV with ${bits}-bit samples is not supported.`);
  const isFloat = format === WAVE_FORMAT_IEEE_FLOAT;
  if (!isFloat && format !== WAVE_FORMAT_PCM) {
    throw new Error(`WAV format tag ${format} (compressed WAV) needs ffmpeg to read.`);
  }
  if (isFloat && bytesPerSample !== 4 && bytesPerSample !== 8) throw new Error("Float WAV must be 32 or 64-bit.");

  const frameSize = bytesPerSample * channelCount;
  const frames = Math.floor(dataLength / frameSize);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  let at = dataStart;
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c]![frame] = readSample(view, at, bytesPerSample, isFloat, true);
      at += bytesPerSample;
    }
  }
  return { channels, sampleRate };
}

function readSample(view: DataView, at: number, size: number, isFloat: boolean, little: boolean): number {
  if (isFloat) return size === 4 ? view.getFloat32(at, little) : view.getFloat64(at, little);
  switch (size) {
    case 1:
      // 8-bit WAV is unsigned; 8-bit AIFF is signed. Only WAV reaches here with size 1 unsigned.
      return little ? (view.getUint8(at) - 128) / 128 : view.getInt8(at) / 128;
    case 2:
      return view.getInt16(at, little) / 32768;
    case 3: {
      const b0 = view.getUint8(at);
      const b1 = view.getUint8(at + 1);
      const b2 = view.getUint8(at + 2);
      let value = little ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    }
    case 4:
      return view.getInt32(at, little) / 2147483648;
    default:
      throw new Error(`Unsupported sample size ${size}.`);
  }
}

/** 80-bit IEEE extended, as AIFF stores its sample rate. */
function readExtended(view: DataView, at: number): number {
  const exponent = view.getUint16(at) & 0x7fff;
  const hi = view.getUint32(at + 2);
  const lo = view.getUint32(at + 6);
  if (exponent === 0 && hi === 0 && lo === 0) return 0;
  return (hi * 2 ** 32 + lo) * 2 ** (exponent - 16383 - 63);
}

export function decodeAiff(bytes: Uint8Array): Audio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isAifc = ascii(bytes, 8, 4) === "AIFC";
  let channelCount = 0;
  let frames = 0;
  let bits = 0;
  let sampleRate = 0;
  let compression = "NONE";
  let dataStart = -1;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4);
    const body = offset + 8;
    if (id === "COMM") {
      channelCount = view.getInt16(body);
      frames = view.getUint32(body + 2);
      bits = view.getInt16(body + 6);
      sampleRate = readExtended(view, body + 8);
      if (isAifc && size >= 22) compression = ascii(bytes, body + 18, 4);
    } else if (id === "SSND") {
      const dataOffset = view.getUint32(body);
      dataStart = body + 8 + dataOffset;
    }
    offset = body + size + (size % 2);
  }

  if (dataStart < 0 || channelCount < 1 || sampleRate < 1) throw new Error("This AIFF file has no readable audio.");
  let little = false;
  let isFloat = false;
  if (compression === "sowt") little = true;
  else if (compression === "fl32" || compression === "FL32") isFloat = true;
  else if (compression === "fl64" || compression === "FL64") isFloat = true;
  else if (compression !== "NONE" && compression !== "twos") {
    throw new Error(`AIFC compression "${compression}" needs ffmpeg to read.`);
  }
  if (isFloat) bits = compression.toLowerCase() === "fl64" ? 64 : 32;
  const bytesPerSample = Math.ceil(bits / 8);
  const available = Math.floor((bytes.length - dataStart) / (bytesPerSample * channelCount));
  const count = Math.min(frames, available);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(count));
  let at = dataStart;
  for (let frame = 0; frame < count; frame++) {
    for (let c = 0; c < channelCount; c++) {
      // AIFF 8-bit is signed, so it goes through the big-endian branch of readSample.
      channels[c]![frame] = readSample(view, at, bytesPerSample, isFloat, little && bytesPerSample > 1);
      at += bytesPerSample;
    }
  }
  return { channels, sampleRate };
}

// ── Writing ──────────────────────────────────────────────────────────────────────────

const clamp = (value: number) => (value > 1 ? 1 : value < -1 ? -1 : value);

function checkChannels(channels: readonly Float32Array[]) {
  if (channels.length === 0) throw new Error("Nothing to encode.");
  const frames = channels[0]!.length;
  if (channels.some((channel) => channel.length !== frames)) throw new Error("Every channel must be the same length.");
  return frames;
}

/**
 * WAV at 16 or 24-bit integer, or 32-bit float. Plain format tags (1 and 3), never EXTENSIBLE,
 * for the reason `shared/dsp/wav.ts` gives: every engine reads them, some old tools read nothing else.
 * 16-bit is dithered with TPDF noise, so quiet tails fade out instead of breaking into steps.
 */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, depth: WavDepth = 24): Uint8Array {
  const frames = checkChannels(channels);
  const channelCount = channels.length;
  const bytesPerSample = depth / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frames * blockAlign;
  const pad = dataSize % 2;
  const isFloat = depth === 32;
  // A float WAV carries a fact chunk (12 bytes) by the spec; readers that skip it lose nothing.
  const factSize = isFloat ? 12 : 0;
  const bytes = new Uint8Array(44 + factSize + dataSize + pad);
  const view = new DataView(bytes.buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + factSize + dataSize + pad, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, depth, true);
  let at = 36;
  if (isFloat) {
    write(at, "fact");
    view.setUint32(at + 4, 4, true);
    view.setUint32(at + 8, frames, true);
    at += 12;
  }
  write(at, "data");
  view.setUint32(at + 4, dataSize, true);
  at += 8;

  const random = ditherSource();
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = channels[c]![frame]!;
      if (depth === 32) {
        // Float keeps what is above full scale: a render peaking at +2 dB is recoverable by
        // turning it down later. Only a non-number becomes silence (Codex review, finding 14).
        view.setFloat32(at, Number.isFinite(sample) ? sample : 0, true);
      } else if (depth === 16) {
        const dithered = sample * 32767 + (random() - random());
        view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(dithered))), true);
      } else {
        const value = Math.max(-8388608, Math.min(8388607, Math.round(clamp(sample) * 8388607)));
        view.setUint8(at, value & 0xff);
        view.setUint8(at + 1, (value >> 8) & 0xff);
        view.setUint8(at + 2, (value >> 16) & 0xff);
      }
      at += bytesPerSample;
    }
  }
  return bytes;
}

/** AIFF, big-endian 16 or 24-bit, for Pro Tools and Logic sessions that still prefer it. */
export function encodeAiff(channels: readonly Float32Array[], sampleRate: number, depth: 16 | 24 = 24): Uint8Array {
  const frames = checkChannels(channels);
  const channelCount = channels.length;
  const bytesPerSample = depth / 8;
  const dataSize = frames * channelCount * bytesPerSample;
  const pad = dataSize % 2;
  const commSize = 18;
  const ssndSize = 8 + dataSize;
  const total = 4 + (8 + commSize) + (8 + ssndSize) + pad;
  const bytes = new Uint8Array(8 + total);
  const view = new DataView(bytes.buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  write(0, "FORM");
  view.setUint32(4, total);
  write(8, "AIFF");
  write(12, "COMM");
  view.setUint32(16, commSize);
  view.setInt16(20, channelCount);
  view.setUint32(22, frames);
  view.setInt16(26, depth);
  writeExtended(view, 28, sampleRate);
  write(38, "SSND");
  view.setUint32(42, ssndSize);
  view.setUint32(46, 0);
  view.setUint32(50, 0);
  let at = 54;
  const random = ditherSource();
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channelCount; c++) {
      const sample = channels[c]![frame]!;
      if (depth === 16) {
        const dithered = sample * 32767 + (random() - random());
        view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(dithered))));
      } else {
        const value = Math.max(-8388608, Math.min(8388607, Math.round(clamp(sample) * 8388607)));
        view.setUint8(at, (value >> 16) & 0xff);
        view.setUint8(at + 1, (value >> 8) & 0xff);
        view.setUint8(at + 2, value & 0xff);
      }
      at += bytesPerSample;
    }
  }
  return bytes;
}

/**
 * 80-bit IEEE extended for a positive integer sample rate: the 64-bit mantissa carries its leading
 * 1 explicitly. A rate has at most 32 significant bits, so every product here is exact in a double.
 */
function writeExtended(view: DataView, at: number, value: number) {
  let exponent = Math.floor(Math.log2(value));
  if (2 ** exponent > value) exponent -= 1;
  if (2 ** (exponent + 1) <= value) exponent += 1;
  const mantissa = value * 2 ** (63 - exponent);
  const hi = Math.floor(mantissa / 2 ** 32);
  view.setUint16(at, exponent + 16383);
  view.setUint32(at + 2, hi);
  view.setUint32(at + 6, mantissa - hi * 2 ** 32);
}

/** Deterministic noise for dither: the same input always writes the same file. */
function ditherSource() {
  let state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
