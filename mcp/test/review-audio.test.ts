import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyze } from "../src/audio/analyze.js";
import { findFfmpeg, resetFfmpegLookup, writeAudio } from "../src/audio/codecs.js";
import { decodeWav, encodeWav } from "../src/audio/pcm.js";
import { mono, sine } from "./helpers.js";

const folders: string[] = [];
const previousFfmpeg = process.env.TAKEBOX_FFMPEG;

afterEach(async () => {
  if (previousFfmpeg === undefined) delete process.env.TAKEBOX_FFMPEG;
  else process.env.TAKEBOX_FFMPEG = previousFfmpeg;
  resetFfmpegLookup();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function temporaryFolder() {
  const folder = await mkdtemp(path.join(os.tmpdir(), "takebox-review-audio-"));
  folders.push(folder);
  return folder;
}

describe("review: PCM float headroom", () => {
  it("preserves above-full-scale samples when exporting a 32-bit float WAV", () => {
    // A floating-point library render may exceed 0 dBFS without being clipped. A level:off
    // re-export must keep that recoverable headroom; integer export may saturate it.
    const source = sine(0.25, 440, 1.25);
    const decoded = decodeWav(encodeWav([source], 48000, 32));
    let error = 0;
    for (let i = 0; i < source.length; i++) error = Math.max(error, Math.abs(source[i]! - decoded.channels[0]![i]!));
    expect(error).toBeLessThan(1e-7);
  });
});

describe("review: ffmpeg capability selection", () => {
  it.each([
    { format: "opus" as const, encoder: "opus", muxer: "ogg" },
    { format: "m4a" as const, encoder: "libfdk_aac", muxer: "ipod" },
  ])("uses the encoder it discovered when only $encoder can write $format", async ({ format, encoder, muxer }) => {
    const folder = await temporaryFolder();
    const executable = path.join(folder, "ffmpeg");
    const argumentsFile = path.join(folder, "arguments.json");
    // This fake executable reports a valid alternative encoder. It accepts writes only with
    // that encoder, matching a system build lacking libopus / the native AAC encoder.
    await writeFile(executable, `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `if (args.includes("-encoders")) { process.stdout.write(" A..... ${encoder} test encoder\\n"); }\n` +
      `else if (args.includes("-muxers")) { process.stdout.write(" E ${muxer} test muxer\\n"); }\n` +
      `else {\n` +
      `  fs.writeFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(args));\n` +
      `  if (args[args.indexOf("-c:a") + 1] !== ${JSON.stringify(encoder)}) { process.stderr.write("Unknown encoder"); process.exit(1); }\n` +
      `  fs.writeFileSync(args[args.length - 1], "synthetic encoded fixture");\n` +
      `}\n`);
    await chmod(executable, 0o755);
    process.env.TAKEBOX_FFMPEG = executable;
    resetFfmpegLookup();
    expect((await findFfmpeg())?.writes).toContain(format);
    const result = await writeAudio(path.join(folder, `effect.${format}`), mono(sine(0.1, 440, 0.2)), format).catch((error: Error) => error);
    const args = JSON.parse(await readFile(argumentsFile, "utf8")) as string[];
    expect(args[args.indexOf("-c:a") + 1]).toBe(encoder);
    expect(result).toEqual([]);
  });
});

describe("review: stereo analysis", () => {
  it("does not call a left-only stereo effect identical audio in both channels", () => {
    // A deliberately panned sound is common in games and in library stereo files. Folding it
    // to mono changes its placement and level; the silent right channel is not a duplicate.
    const left = sine(0.5, 440, 0.2);
    const result = analyze({ channels: [left, new Float32Array(left.length)], sampleRate: 48000 });
    expect(result.flags.join("\n")).not.toContain("same audio in both channels");
  });
});
