import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/audio/analyze.js";
import { decodeFile, findFfmpeg, sniff, writableFormats, writeAudio } from "../src/audio/codecs.js";
import { applyLevel, levelTogether, ROLE_TARGETS } from "../src/audio/level.js";
import { FAINT_CUT, processTake, type FinishOptions } from "../src/finish.js";
import { synthLongTake } from "../../test/helpers/synth.js";
import { decodeAiff, decodeWav, encodeAiff, encodeWav } from "../src/audio/pcm.js";
import { resample } from "../src/audio/resample.js";
import { measureLoudness } from "../../shared/dsp/loudness.js";
import { burst, concat, mono, noise, RATE, rmsOf, silence, sine, tempDir } from "./helpers.js";

const maxDiff = (a: Float32Array, b: Float32Array) => {
  let max = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
};

describe("WAV and AIFF", () => {
  const left = sine(0.25, 440, 0.5);
  const right = sine(0.25, 660, 0.25);

  it.each([16, 24, 32] as const)("round-trips %i-bit WAV in stereo", (depth) => {
    const decoded = decodeWav(encodeWav([left, right], RATE, depth));
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.channels).toHaveLength(2);
    expect(decoded.channels[0]!.length).toBe(left.length);
    const tolerance = depth === 16 ? 2 / 32768 + 1e-6 : depth === 24 ? 1e-6 : 1e-7;
    expect(maxDiff(decoded.channels[0]!, left)).toBeLessThanOrEqual(tolerance);
    expect(maxDiff(decoded.channels[1]!, right)).toBeLessThanOrEqual(tolerance);
  });

  it("writes mono WAV with an odd data size word-aligned", () => {
    const odd = sine(0.001, 440, 0.5).subarray(0, 47);
    const bytes = encodeWav([odd], RATE, 24);
    expect(bytes.length % 2).toBe(0);
    expect(decodeWav(bytes).channels[0]!.length).toBe(47);
  });

  it("reads a WAV whose sizes were never filled in (written to a pipe)", () => {
    const bytes = encodeWav([left], RATE, 32);
    const view = new DataView(bytes.buffer);
    // data chunk size sits after the fact chunk for float: find "data".
    const text = String.fromCharCode(...bytes.subarray(0, 80));
    const at = text.indexOf("data");
    view.setUint32(4, 0xffffffff, true);
    view.setUint32(at + 4, 0xffffffff, true);
    expect(decodeWav(bytes).channels[0]!.length).toBe(left.length);
  });

  it("reads WAVE_FORMAT_EXTENSIBLE float", () => {
    // Build an extensible header by hand around float samples.
    const frames = 100;
    const data = new Float32Array(frames).map((_, i) => Math.sin(i / 5) * 0.3);
    const bytes = new Uint8Array(68 + frames * 4);
    const view = new DataView(bytes.buffer);
    const put = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    put(0, "RIFF");
    view.setUint32(4, 60 + frames * 4, true);
    put(8, "WAVE");
    put(12, "fmt ");
    view.setUint32(16, 40, true);
    view.setUint16(20, 0xfffe, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 32, true);
    view.setUint16(36, 22, true);
    view.setUint16(38, 32, true);
    view.setUint32(40, 4, true);
    view.setUint16(44, 3, true); // sub-format: IEEE float
    put(60, "data");
    view.setUint32(64, frames * 4, true);
    for (let i = 0; i < frames; i++) view.setFloat32(68 + i * 4, data[i]!, true);
    const decoded = decodeWav(bytes);
    expect(maxDiff(decoded.channels[0]!, data)).toBeLessThan(1e-7);
  });

  it.each([44100, 48000, 96000, 22050])("round-trips AIFF at %i Hz with the exact rate", (rate) => {
    const tone = sine(0.1, 440, 0.5, rate);
    const decoded = decodeAiff(encodeAiff([tone, tone], rate, 24));
    expect(decoded.sampleRate).toBe(rate);
    expect(maxDiff(decoded.channels[1]!, tone)).toBeLessThan(1e-6);
  });

  it("sniffs formats by their bytes, not their names", () => {
    expect(sniff(encodeWav([left], RATE))).toBe("wav");
    expect(sniff(encodeAiff([left], RATE))).toBe("aiff");
    expect(sniff(new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0]))).toBe("flac");
    expect(sniff(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");
    expect(sniff(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe("other"); // AAC in ADTS
  });
});

describe("compressed formats without ffmpeg", () => {
  it.each(["mp3", "ogg"] as const)("writes and reads back %s", async (format) => {
    const dir = await tempDir();
    const file = path.join(dir, `tone.${format}`);
    const tone = sine(1, 1000, 0.5);
    await writeAudio(file, { channels: [tone, tone], sampleRate: RATE }, format);
    const decoded = await decodeFile(file);
    expect(decoded.channels).toHaveLength(2);
    expect(decoded.sampleRate).toBe(RATE);
    // Lossy and with codec delay, so compare level, not samples.
    const level = rmsOf(decoded.channels[0]!, 4800, 43200);
    expect(level).toBeGreaterThan(0.33);
    expect(level).toBeLessThan(0.38);
  });

  it("resamples to 48 kHz for MP3 when the source is higher", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "hi.mp3");
    const notes = await writeAudio(file, mono(sine(0.5, 1000, 0.5, 96000), 96000), "mp3");
    expect(notes.join(" ")).toMatch(/48 kHz/);
    expect((await decodeFile(file)).sampleRate).toBe(48000);
  });

  it("never leaves a half-written file under the real name", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "bad.mp3");
    const six = Array.from({ length: 6 }, () => sine(0.1, 440, 0.5));
    await expect(writeAudio(file, { channels: six, sampleRate: RATE }, "mp3")).rejects.toThrow(/mono or stereo/);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);
  });

  it("reports the formats this machine can write, built-ins always included", async () => {
    const formats = await writableFormats();
    for (const format of ["wav", "aiff", "mp3", "ogg"]) expect(formats).toContain(format);
  });
});

describe("with ffmpeg, when this machine has one", () => {
  it("writes FLAC and reads it back losslessly at 24-bit", async () => {
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg?.writes.includes("flac")) return;
    const dir = await tempDir();
    const file = path.join(dir, "tone.flac");
    const tone = sine(0.5, 440, 0.5);
    await writeAudio(file, mono(tone), "flac");
    const decoded = await decodeFile(file);
    expect(maxDiff(decoded.channels[0]!, tone)).toBeLessThan(2e-6);
  });

  it("refuses a format the ffmpeg cannot write, naming what it can", async () => {
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg || ffmpeg.writes.includes("m4a")) return;
    const dir = await tempDir();
    await expect(writeAudio(path.join(dir, "x.m4a"), mono(sine(0.1, 440, 0.5)), "m4a")).rejects.toThrow(/M4A needs ffmpeg/);
  });
});

describe("resample", () => {
  it("keeps a 1 kHz tone's pitch and level going 44.1 → 48 kHz", () => {
    const tone = sine(0.5, 1000, 0.5, 44100);
    const [out] = resample([tone], 44100, 48000);
    expect(out!.length).toBe(Math.round(tone.length * 48000 / 44100));
    let crossings = 0;
    for (let i = 4800; i < 19200; i++) if (out![i - 1]! < 0 && out![i]! >= 0) crossings += 1;
    expect(crossings).toBeGreaterThanOrEqual(299);
    expect(crossings).toBeLessThanOrEqual(301);
    expect(rmsOf(out!, 4800, 19200)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it("removes what would alias going down: 15 kHz into 22.05 kHz", () => {
    const tone = sine(0.5, 15000, 0.5);
    const [out] = resample([tone], 48000, 22050);
    expect(rmsOf(out!, 2000, out!.length - 2000)).toBeLessThan(0.005);
  });
});

describe("levels", () => {
  it("brings a one-shot to its role's target on the loudest 400 ms", () => {
    const hit = concat(burst(0.4, 0.05, 0.08), silence(0.3));
    const result = applyLevel([hit], RATE, ROLE_TARGETS.sfx)!;
    expect(result.heldByPeak).toBe(false);
    expect(measureLoudness([hit], RATE).momentaryMax).toBeCloseTo(ROLE_TARGETS.sfx.lufs, 1);
  });

  it("holds back rather than push a peak past −1 dBTP, and says so", () => {
    // A spiky, quiet-on-average file: reaching −14 LUFS would need far more than the peak allows.
    const spike = concat(silence(0.2), new Float32Array([0.5, -0.5]), silence(0.6));
    const result = applyLevel([spike], RATE, ROLE_TARGETS.impact)!;
    expect(result.heldByPeak).toBe(true);
    expect(measureLoudness([spike], RATE).truePeak).toBeLessThanOrEqual(-0.99);
    expect(result.notice).toMatch(/short of/);
  });

  it("matches loops on integrated loudness", () => {
    const bed = noise(5, 0.2);
    applyLevel([bed], RATE, ROLE_TARGETS.ambience);
    expect(measureLoudness([bed], RATE).integrated!).toBeCloseTo(ROLE_TARGETS.ambience.lufs, 1);
  });

  it("levels the cuts of one take together: the loudest reaches the target, the rest keep their distance", () => {
    const hard = concat(burst(0.4, 0.2, 0.08, 1), silence(0.3));
    const soft = concat(burst(0.4, 0.02, 0.08, 2), silence(0.3));
    const gap = measureLoudness([hard], RATE).momentaryMax - measureLoudness([soft], RATE).momentaryMax;
    const quiet = silence(0.5);
    const results = levelTogether([[hard], [soft], [quiet]], RATE, ROLE_TARGETS.sfx)!;
    expect(results[0]!.gainDb).toBe(results[1]!.gainDb);
    expect(results[2]).toBeNull();
    expect(measureLoudness([hard], RATE).momentaryMax).toBeCloseTo(ROLE_TARGETS.sfx.lufs, 1);
    expect(measureLoudness([hard], RATE).momentaryMax - measureLoudness([soft], RATE).momentaryMax).toBeCloseTo(gap, 1);
    expect(results[0]!.notice).toMatch(/one gain for all 3 cuts/);
  });

  it("holds the shared gain back for the peakiest cut, so no cut passes −1 dBTP", () => {
    const body = concat(burst(0.4, 0.05, 0.3, 1), silence(0.3));
    const spike = concat(silence(0.2), new Float32Array([0.5, -0.5]), silence(0.6));
    const results = levelTogether([[body], [spike]], RATE, ROLE_TARGETS.impact)!;
    expect(results[0]!.heldByPeak).toBe(true);
    for (const piece of [body, spike]) expect(measureLoudness([piece], RATE).truePeak).toBeLessThanOrEqual(-0.99);
  });
});

describe("split: one take, one gain", () => {
  it("keeps a mixed-force session's soft tier soft, and flags each faint cut on its own piece", () => {
    // Codex footstep review, 2026-11-11: ten takes alternating hard and soft, the soft ones
    // 24–26 dB above the room. Levelled one by one, every soft cut came out as loud as a hard one.
    const at = Array.from({ length: 10 }, (_, i) => 0.4 + i * 0.9);
    const { samples } = synthLongTake({ sampleRate: RATE, at, levels: [0.5, 0.03], decayMs: 60 });
    const options = { shape: "split", splitPreset: "footsteps", level: "role", role: "foley", channels: "keep", formats: ["wav"], encode: {} } as FinishOptions;
    const pieces = processTake({ channels: [samples], sampleRate: RATE }, options);
    expect(pieces).toHaveLength(10);
    const loudness = pieces.map((piece) => measureLoudness(piece.audio.channels, RATE).momentaryMax);
    for (let i = 0; i < 10; i += 2) expect(loudness[i]! - loudness[i + 1]!).toBeGreaterThan(18);
    expect(Math.max(...loudness)).toBeLessThanOrEqual(ROLE_TARGETS.foley.lufs + 0.1);
    expect(pieces.map((piece) => piece.flags?.includes(FAINT_CUT) ?? false)).toEqual(at.map((_, i) => i % 2 === 1));
  });
});

describe("analyze", () => {
  it("flags a late start, a long tail and a stereo file that is really mono", () => {
    const sound = concat(silence(0.12), burst(0.3, 0.5, 0.05), silence(0.8));
    const analysis = analyze({ channels: [sound, sound.slice()], sampleRate: RATE });
    expect(analysis.headSilenceS).toBeGreaterThan(0.1);
    expect(analysis.flags.join("\n")).toMatch(/lag behind/);
    expect(analysis.flags.join("\n")).toMatch(/voice slot/);
    expect(analysis.flags.join("\n")).toMatch(/save it as mono/);
  });

  it("flags clipping", () => {
    const clipped = sine(0.5, 100, 1.4).map((v) => Math.max(-1, Math.min(1, v)));
    expect(analyze(mono(clipped)).flags.join("\n")).toMatch(/clipped/);
  });

  it("hears a loop that clicks at the wrap", () => {
    // Ends mid-cycle at a high value, starts at zero.
    const tone = sine(2.0123, 220, 0.5);
    expect(analyze(mono(tone), { expectLoop: true }).loop!.wrapClick).toBe(true);
  });

  it("writes analysis numbers a person can read", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "a.wav");
    await writeFile(file, encodeWav([sine(1, 440, 0.5)], RATE));
    const analysis = analyze(await decodeFile(file));
    expect(analysis.durationS).toBe(1);
    expect(analysis.flags).toEqual([]);
    expect(analysis.samplePeakDbfs).toBeCloseTo(-6, 0);
    expect((await readFile(file)).length).toBeGreaterThan(0);
  });
});
