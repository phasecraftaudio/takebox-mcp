/**
 * A 24-bit PCM WAV encoder.
 *
 * Written out rather than pulled in, because the same forty lines are what PHASEFLOW needs for
 * export and drag-out, and in a browser there is no ffmpeg to hand the job to. One encoder,
 * both products.
 *
 * Plain `WAVE_FORMAT_PCM` (tag 1), not `WAVE_FORMAT_EXTENSIBLE`. Microsoft's spec prefers the
 * extensible header above 16 bits, but every engine and DAW TAKEBOX hands off to — Unity,
 * Unreal, Godot, Wwise, FMOD, Pro Tools, Reaper — reads tag 1 at 24 bits, and some older game
 * tooling does not read the extensible one.
 */

const BYTES_PER_SAMPLE = 3;
const MAX_24 = 8388607;

export function encodeWav24(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = channels.length;
  if (channelCount === 0) throw new Error("Nothing to encode.");
  const frames = channels[0]!.length;
  if (channels.some((channel) => channel.length !== frames)) {
    throw new Error("Every channel must be the same length.");
  }

  const blockAlign = channelCount * BYTES_PER_SAMPLE;
  const dataSize = frames * blockAlign;
  // RIFF chunks are word-aligned: an odd data chunk (mono, odd frame count) is followed by one
  // zero byte, counted in the RIFF size but never in the data size.
  const pad = dataSize % 2;
  const bytes = new Uint8Array(44 + dataSize + pad);
  const view = new DataView(bytes.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize + pad, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channelCount; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c]![frame]!));
      const value = Math.max(-MAX_24 - 1, Math.min(MAX_24, Math.round(clamped * MAX_24)));
      // Little-endian two's complement, three bytes.
      bytes[offset++] = value & 0xff;
      bytes[offset++] = (value >> 8) & 0xff;
      bytes[offset++] = (value >> 16) & 0xff;
    }
  }

  return bytes;
}
