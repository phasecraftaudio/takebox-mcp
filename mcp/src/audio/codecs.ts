/**
 * Every file format in and out, with ffmpeg as a bonus rather than a requirement.
 *
 * Built in, so `npx` is all a user needs:
 *   read   WAV · AIFF · MP3 · OGG Vorbis · Opus · FLAC
 *   write  WAV (16/24/32f) · AIFF · MP3 · OGG Vorbis
 *
 * With ffmpeg on the machine (TAKEBOX desktop's own build, or any other), also:
 *   read   anything ffmpeg reads (M4A/AAC, CAF, W64, ALAC…)
 *   write  FLAC, and Opus and M4A when that ffmpeg has the encoder and container
 *
 * The decoders are eshaz's wasm-audio-decoders (MIT wrappers; mpg123 is LGPL-2.1, libvorbis,
 * libopus and libFLAC are BSD). The encoders are wasm-media-encoders (MIT wrapper; LAME is
 * LGPL-2.0, libvorbis BSD). All run as separate WebAssembly modules, replaceable as LGPL asks.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAiff, decodeWav, encodeAiff, encodeWav, sniffPcm, type Audio, type WavDepth } from "./pcm.js";
import { resample } from "./resample.js";
import { workingName } from "../lock.js";

export const FORMATS = ["wav", "ogg", "mp3", "flac", "opus", "m4a", "aiff"] as const;
export type Format = (typeof FORMATS)[number];
export const QUALITIES = ["high", "standard", "small"] as const;
export type Quality = (typeof QUALITIES)[number];

export const EXTENSION: Record<Format, string> = {
  wav: "wav",
  ogg: "ogg",
  mp3: "mp3",
  flac: "flac",
  opus: "opus",
  m4a: "m4a",
  aiff: "aif",
};

export const AUDIO_EXTENSIONS = ["wav", "wave", "ogg", "oga", "mp3", "flac", "opus", "m4a", "aac", "aif", "aiff", "aifc", "caf", "w64"];

const BUILT_IN_WRITE: readonly Format[] = ["wav", "aiff", "mp3", "ogg"];

/** Longest file analysed or processed. Library ambiences can run an hour; nobody needs that in RAM. */
export const MAX_SECONDS = 20 * 60;

// ── ffmpeg ───────────────────────────────────────────────────────────────────────────

export interface Ffmpeg {
  path: string;
  /** Formats this particular ffmpeg can write (encoder and container both present). */
  writes: Format[];
  /** The encoder found for each ffmpeg-only format, used as found (Codex review 2026-11-09, finding 19). */
  encoders: Partial<Record<"opus" | "m4a", string>>;
}

let ffmpegLookup: Promise<Ffmpeg | null> | null = null;

function candidates(): string[] {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const list: string[] = [];
  if (process.env.TAKEBOX_FFMPEG) list.push(process.env.TAKEBOX_FFMPEG);
  // TAKEBOX desktop ships an LGPL ffmpeg beside its service.
  if (process.platform === "darwin") list.push(`/Applications/TAKEBOX.app/Contents/Resources/bin/${exe}`);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, "Programs", "TAKEBOX", "resources", "bin", exe));
  }
  // A development checkout of TAKEBOX, where this server lives in mcp/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const up of ["../../..", "../.."]) {
    list.push(path.resolve(here, up, ".cache", "ffmpeg", "bin", `${process.platform}-${process.arch}`, exe));
  }
  list.push(exe);
  return list;
}

function capture(command: string, args: string[], input?: Uint8Array, signal?: AbortSignal): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = [];
    let err = "";
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(out), err }));
    if (input && child.stdin) child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  });
}

async function probe(command: string): Promise<Ffmpeg | null> {
  if (command.includes(path.sep) && !existsSync(command)) return null;
  try {
    const [encoderList, muxers] = await Promise.all([
      capture(command, ["-hide_banner", "-encoders"]),
      capture(command, ["-hide_banner", "-muxers"]),
    ]);
    if (encoderList.code !== 0) return null;
    const enc = encoderList.out.toString();
    const mux = muxers.out.toString();
    const has = (text: string, name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(text);
    const writes: Format[] = ["wav", "aiff", "mp3", "ogg"];
    const encoders: Ffmpeg["encoders"] = {};
    if (has(enc, "flac") && has(mux, "flac")) writes.push("flac");
    // libopus first: ffmpeg's own Opus encoder is marked experimental. Native AAC first: it ships
    // with every build and is LGPL; libfdk_aac is non-free and only in custom builds.
    const opus = has(enc, "libopus") ? "libopus" : has(enc, "opus") ? "opus" : null;
    const aac = has(enc, "aac") ? "aac" : has(enc, "libfdk_aac") ? "libfdk_aac" : null;
    if (opus && has(mux, "ogg")) {
      writes.push("opus");
      encoders.opus = opus;
    }
    if (aac && (has(mux, "ipod") || has(mux, "mp4"))) {
      writes.push("m4a");
      encoders.m4a = aac;
    }
    return { path: command, writes, encoders };
  } catch {
    return null;
  }
}

export function findFfmpeg(): Promise<Ffmpeg | null> {
  ffmpegLookup ??= (async () => {
    for (const candidate of candidates()) {
      const found = await probe(candidate);
      if (found) return found;
    }
    return null;
  })();
  return ffmpegLookup;
}

/** For tests: forget a cached lookup. */
export function resetFfmpegLookup() {
  ffmpegLookup = null;
}

export async function writableFormats(): Promise<Format[]> {
  const ffmpeg = await findFfmpeg();
  return ffmpeg ? FORMATS.filter((format) => ffmpeg.writes.includes(format)) : [...BUILT_IN_WRITE];
}

// ── Reading ──────────────────────────────────────────────────────────────────────────

type Kind = "wav" | "aiff" | "mp3" | "vorbis" | "opus" | "flac" | "other";

function skipId3(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  return 10 + size + (bytes[5]! & 0x10 ? 10 : 0);
}

export function sniff(bytes: Uint8Array): Kind {
  const pcm = sniffPcm(bytes);
  if (pcm) return pcm;
  const at = skipId3(bytes);
  const text = (from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));
  if (text(at, 4) === "fLaC") return "flac";
  if (text(0, 4) === "OggS") {
    const page = text(0, Math.min(bytes.length, 200));
    if (page.includes("OpusHead")) return "opus";
    if (page.includes("\x01vorbis")) return "vorbis";
    return "other";
  }
  // MPEG audio frame sync, layer bits not 00 (00 is AAC in ADTS).
  if (bytes[at] === 0xff && (bytes[at + 1]! & 0xe0) === 0xe0 && (bytes[at + 1]! & 0x06) !== 0) return "mp3";
  return "other";
}

interface Decoded {
  channelData: Float32Array[];
  sampleRate: number;
  samplesDecoded: number;
}

async function runDecoder<D extends { ready: Promise<void>; free(): void }>(decoder: D, decode: (d: D) => Promise<Decoded> | Decoded): Promise<Audio | null> {
  try {
    await decoder.ready;
    const result = await decode(decoder);
    if (!result.channelData.length || result.samplesDecoded === 0) return null;
    return {
      channels: result.channelData.map((channel) => channel.slice(0, result.samplesDecoded)),
      sampleRate: result.sampleRate,
    };
  } finally {
    decoder.free();
  }
}

async function decodeCompressed(kind: Kind, bytes: Uint8Array): Promise<Audio | null> {
  switch (kind) {
    case "mp3": {
      const { MPEGDecoder } = await import("mpg123-decoder");
      return runDecoder(new MPEGDecoder(), (d) => d.decode(bytes));
    }
    case "vorbis": {
      const { OggVorbisDecoder } = await import("@wasm-audio-decoders/ogg-vorbis");
      return runDecoder(new OggVorbisDecoder(), (d) => d.decodeFile(bytes));
    }
    case "opus": {
      const { OggOpusDecoder } = await import("ogg-opus-decoder");
      return runDecoder(new OggOpusDecoder(), (d) => d.decodeFile(bytes));
    }
    case "flac": {
      const { FLACDecoder } = await import("@wasm-audio-decoders/flac");
      return runDecoder(new FLACDecoder(), (d) => d.decodeFile(bytes));
    }
    default:
      return null;
  }
}

async function decodeWithFfmpeg(file: string, signal?: AbortSignal): Promise<Audio> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new Error(
      `${path.basename(file)} is in a format TAKEBOX reads only through ffmpeg, and there is no ffmpeg on this machine. Convert it to WAV, or install ffmpeg.`,
    );
  }
  const result = await capture(
    ffmpeg.path,
    ["-hide_banner", "-loglevel", "error", "-i", file, "-t", String(MAX_SECONDS), "-f", "wav", "-c:a", "pcm_f32le", "pipe:1"],
    undefined,
    signal,
  );
  if (result.code !== 0) throw new Error(`ffmpeg could not read ${path.basename(file)}: ${result.err.slice(-300).trim()}`);
  return decodeWav(new Uint8Array(result.out.buffer, result.out.byteOffset, result.out.byteLength));
}

export async function decodeBytes(bytes: Uint8Array, nameForErrors = "audio"): Promise<Audio> {
  const kind = sniff(bytes);
  let audio: Audio | null = null;
  if (kind === "wav") audio = decodeWav(bytes);
  else if (kind === "aiff") audio = decodeAiff(bytes);
  else audio = await decodeCompressed(kind, bytes);
  if (!audio) throw new Error(`Could not read ${nameForErrors} without ffmpeg.`);
  return audio;
}

export async function decodeFile(file: string, signal?: AbortSignal): Promise<Audio> {
  const bytes = new Uint8Array(await readFile(file));
  const kind = sniff(bytes);
  let audio: Audio | null = null;
  try {
    if (kind === "wav") audio = decodeWav(bytes);
    else if (kind === "aiff") audio = decodeAiff(bytes);
    else if (kind !== "other") audio = await decodeCompressed(kind, bytes);
  } catch {
    // A file our readers choke on (compressed WAV, odd AIFC) may still be fine for ffmpeg.
    audio = null;
  }
  audio ??= await decodeWithFfmpeg(file, signal);
  const seconds = (audio.channels[0]?.length ?? 0) / audio.sampleRate;
  if (seconds > MAX_SECONDS + 1) {
    throw new Error(`${path.basename(file)} runs ${(seconds / 60).toFixed(1)} minutes; TAKEBOX works on files up to ${MAX_SECONDS / 60} minutes.`);
  }
  return audio;
}

// ── Writing ──────────────────────────────────────────────────────────────────────────

export interface EncodeOptions {
  quality?: Quality;
  /** WAV only. AIFF takes 16 or 24 (32 becomes 24). */
  bitDepth?: WavDepth;
}

const MP3_VBR: Record<Quality, number> = { high: 0, standard: 2, small: 5 };
const OGG_VBR: Record<Quality, number> = { high: 7, standard: 5, small: 3 };
const OPUS_KBPS: Record<Quality, number> = { high: 160, standard: 128, small: 96 };
const AAC_KBPS: Record<Quality, number> = { high: 256, standard: 192, small: 128 };

type WasmEncoder = {
  configure(options: { sampleRate: number; channels: number; vbrQuality?: number }): void;
  encode(samples: Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
};
const encoders = new Map<string, Promise<WasmEncoder>>();

async function wasmEncoder(kind: "mp3" | "ogg"): Promise<WasmEncoder> {
  let encoder = encoders.get(kind);
  if (!encoder) {
    const module = await import("wasm-media-encoders");
    encoder = (kind === "mp3" ? module.createMp3Encoder() : module.createOggEncoder()) as Promise<WasmEncoder>;
    encoders.set(kind, encoder);
  }
  return encoder;
}

async function encodeLossy(kind: "mp3" | "ogg", channels: readonly Float32Array[], sampleRate: number, quality: Quality) {
  const encoder = await wasmEncoder(kind);
  // Configure, encode and finalise with no await in between: the shared encoder is never interleaved.
  encoder.configure({ sampleRate, channels: channels.length, vbrQuality: kind === "mp3" ? MP3_VBR[quality] : OGG_VBR[quality] });
  const parts: Uint8Array[] = [];
  const block = sampleRate;
  const frames = channels[0]!.length;
  for (let from = 0; from < frames; from += block) {
    const to = Math.min(frames, from + block);
    // The encoder owns its output buffer: copy before the next call overwrites it.
    parts.push(encoder.encode(channels.map((channel) => channel.subarray(from, to))).slice());
  }
  parts.push(encoder.finalize().slice());
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface Encoded {
  bytes: Uint8Array;
  sampleRate: number;
  notes: string[];
}

/** Encode to bytes. FLAC, Opus and M4A go through ffmpeg; see `writeAudio`. */
async function encodeBuiltIn(audio: Audio, format: Format, options: EncodeOptions): Promise<Encoded> {
  const quality = options.quality ?? "standard";
  const notes: string[] = [];
  let { channels, sampleRate } = audio;
  if (channels.length > 2 && (format === "mp3" || format === "ogg")) {
    throw new Error(`${format.toUpperCase()} here takes mono or stereo; this audio has ${channels.length} channels. Ask for channels: "stereo" or "mono".`);
  }
  if (format === "mp3" && sampleRate > 48000) {
    channels = resample(channels, sampleRate, 48000);
    sampleRate = 48000;
    notes.push("resampled to 48 kHz for MP3");
  }
  switch (format) {
    case "wav":
      return { bytes: encodeWav(channels, sampleRate, options.bitDepth ?? 24), sampleRate, notes };
    case "aiff":
      return { bytes: encodeAiff(channels, sampleRate, options.bitDepth === 16 ? 16 : 24), sampleRate, notes };
    case "mp3":
    case "ogg":
      return { bytes: await encodeLossy(format, channels, sampleRate, quality), sampleRate, notes };
    default:
      throw new Error(`${format} is not built in.`);
  }
}

async function encodeWithFfmpeg(audio: Audio, format: Format, options: EncodeOptions, target: string, signal?: AbortSignal) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || !ffmpeg.writes.includes(format)) {
    const have = ffmpeg ? `The ffmpeg found (${ffmpeg.path}) cannot write ${format}.` : "There is no ffmpeg on this machine.";
    throw new Error(`${format.toUpperCase()} needs ffmpeg. ${have} Built in: ${BUILT_IN_WRITE.join(", ")}.`);
  }
  const quality = options.quality ?? "standard";
  const dir = await mkdtemp(path.join(os.tmpdir(), "takebox-"));
  try {
    const source = path.join(dir, "in.wav");
    await writeFile(source, encodeWav(audio.channels, audio.sampleRate, 32));
    const opus = ffmpeg.encoders.opus ?? "libopus";
    const aac = ffmpeg.encoders.m4a ?? "aac";
    const codec: string[] =
      format === "flac"
        ? ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-f", "flac"]
        : format === "opus"
          ? ["-c:a", opus, ...(opus === "opus" ? ["-strict", "-2"] : []), "-b:a", `${OPUS_KBPS[quality]}k`, "-f", "ogg"]
          : ["-c:a", aac, "-b:a", `${AAC_KBPS[quality]}k`, "-f", "ipod"];
    const result = await capture(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-y", "-i", source, ...codec, target], undefined, signal);
    if (result.code !== 0) throw new Error(`ffmpeg could not write ${format}: ${result.err.slice(-300).trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write one file atomically: a half-written file never carries the real name, and the working
 * name is this writer's alone, so two writers never share a temporary file (finding 4).
 */
export async function writeAudio(file: string, audio: Audio, format: Format, options: EncodeOptions = {}, signal?: AbortSignal): Promise<string[]> {
  const working = workingName(file);
  try {
    let notes: string[] = [];
    if (BUILT_IN_WRITE.includes(format)) {
      const encoded = await encodeBuiltIn(audio, format, options);
      notes = encoded.notes;
      await writeFile(working, encoded.bytes, { mode: 0o644 });
    } else {
      await encodeWithFfmpeg(audio, format, options, working, signal);
    }
    await rename(working, file);
    return notes;
  } catch (error) {
    await rm(working, { force: true });
    throw error;
  }
}
