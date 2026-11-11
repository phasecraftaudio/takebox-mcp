import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as codecs from "../src/audio/codecs.js";
import { encodeWav } from "../src/audio/pcm.js";
import { finishSounds, makeSounds, type Context } from "../src/make.js";
import { defaultSettings, loadManifest, updateManifest, type SoundRecord } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { resolveTake, setDisposition, takeId } from "../src/takes.js";
import { burst, mono, RATE, tempDir } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function context(): Promise<Context> {
  const root = await tempDir("takebox-review-files-");
  folders.push(root);
  return {
    root, settings: defaultSettings(root), provider: null,
    ledger: new SpendLedger(path.join(root, "spend.json")),
    limits: { dailyCap: 2000, askAbove: 300 },
  };
}

function syntheticProvider(): Provider {
  let call = 0;
  return {
    id: "synthetic", label: "Synthetic", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
    estimateCredits: () => 20,
    account: async () => ({ tier: "test", creditsUsed: 0, creditsLimit: 2000, resetsAt: null }),
    generate: async () => {
      const audio = mono(burst(0.5, 0.3, 0.06, ++call));
      return { audio, raw: encodeWav(audio.channels, RATE, 24), rawExtension: "wav" };
    },
  };
}

async function existingSound(ctx: Context) {
  await mkdir(path.join(ctx.root, "audio"), { recursive: true });
  await mkdir(path.join(ctx.root, ".takebox/originals/click"), { recursive: true });
  const file = "audio/click_01.wav";
  const original = ".takebox/originals/click/click_take_01.wav";
  const bytes = encodeWav([burst(0.5, 0.3, 0.06)], RATE, 24);
  await writeFile(path.join(ctx.root, file), bytes);
  await writeFile(path.join(ctx.root, original), bytes);
  const now = new Date().toISOString();
  const record: SoundRecord = {
    kind: "one-shot", role: "sfx", source: "generated", files: [file], originals: [original],
    kept: ["audio/click_01"], created: now, updated: now,
  };
  await updateManifest(ctx.root, (manifest) => { manifest.sounds.click = record; });
  return { file, original, bytes };
}

describe("review: preserve finished sounds on failures", () => {
  it("retains the current finished files when a kept original is missing", async () => {
    const ctx = await context();
    const { file, original, bytes } = await existingSound(ctx);
    await rm(path.join(ctx.root, original));
    await finishSounds(ctx, { names: ["click"], formats: ["wav"] }, (await loadManifest(ctx.root)).sounds);
    expect(existsSync(path.join(ctx.root, file)), "the playable take must survive a missing original").toBe(true);
    // Byte comparison: vitest treats a Buffer and a Uint8Array with equal bytes as unequal (Claude, 11-09).
    expect(new Uint8Array(await readFile(path.join(ctx.root, file)))).toEqual(bytes);
    expect((await loadManifest(ctx.root)).sounds.click!.files).toEqual([file]);
  });

  it("retains the current finished files when the replacement encoder fails", async () => {
    const ctx = await context();
    const { file, bytes } = await existingSound(ctx);
    // A missing codec, full disk or cancelled ffmpeg must not destroy a working take.
    vi.spyOn(codecs, "writeAudio").mockRejectedValueOnce(new Error("encoder failed"));
    await finishSounds(ctx, { names: ["click"], formats: ["wav"] }, (await loadManifest(ctx.root)).sounds);
    expect(existsSync(path.join(ctx.root, file)), "replace must commit only after encoding succeeds").toBe(true);
    // Byte comparison: vitest treats a Buffer and a Uint8Array with equal bytes as unequal (Claude, 11-09).
    expect(new Uint8Array(await readFile(path.join(ctx.root, file)))).toEqual(bytes);
    expect((await loadManifest(ctx.root)).sounds.click!.files).toEqual([file]);
  });

  it("keeps a rejected file in the manifest if moving it to rejected fails", async () => {
    const ctx = await context();
    const { file } = await existingSound(ctx);
    const manifest = await loadManifest(ctx.root);
    const take = resolveTake(manifest, takeId("audio/click_01"))!;
    // Mock an ordinary permissions error independently of the account running the suite.
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await setDisposition(ctx, take, "reject").catch(() => undefined);
    expect(existsSync(path.join(ctx.root, file))).toBe(true);
    expect((await loadManifest(ctx.root)).sounds.click!.files, "failed reject must stay visible and recoverable").toContain(file);
  });

  it("does not leave an untracked finished file when a later requested format fails", async () => {
    const ctx = await context();
    ctx.provider = syntheticProvider();
    const actualWrite = codecs.writeAudio;
    vi.spyOn(codecs, "writeAudio").mockImplementation(async (...args) => {
      if (args[2] === "mp3") throw new Error("encoder failed");
      return actualWrite(...args);
    });
    await makeSounds(ctx, [{ name: "click", prompt: "A dry wooden click.", duration_s: 0.5 }], { formats: ["wav", "mp3"] });
    const manifest = await loadManifest(ctx.root);
    const tracked = Object.values(manifest.sounds).flatMap((record) => record.files);
    const outputs = await readdir(path.join(ctx.root, "audio"));
    expect(outputs.filter((name) => !tracked.includes(`audio/${name}`)), "successful formats must be recorded or rolled back if another format fails").toEqual([]);
    // The paid original must also remain discoverable for a free retry.
    expect(manifest.sounds.click?.originals).toHaveLength(1);
  });

  it("does not resurrect a rejected take when re-finishing the remaining kept take", async () => {
    const ctx = await context();
    const { file } = await existingSound(ctx);
    const secondFile = "audio/click_02.wav";
    const secondOriginal = ".takebox/originals/click/click_take_02.wav";
    const bytes = encodeWav([burst(0.5, 0.3, 0.06, 2)], RATE, 24);
    await writeFile(path.join(ctx.root, secondFile), bytes);
    await writeFile(path.join(ctx.root, secondOriginal), bytes);
    await updateManifest(ctx.root, (manifest) => {
      const record = manifest.sounds.click!;
      record.files.push(secondFile);
      record.originals!.push(secondOriginal);
      record.kept = ["audio/click_02"];
    });
    const manifest = await loadManifest(ctx.root);
    await setDisposition(ctx, resolveTake(manifest, takeId("audio/click_01"))!, "reject");
    expect((await loadManifest(ctx.root)).sounds.click!.files).toEqual([secondFile]);
    expect(existsSync(path.join(ctx.root, ".takebox/rejected/click", path.basename(file)))).toBe(true);
    await finishSounds(ctx, { names: ["click"], formats: ["aiff"] }, (await loadManifest(ctx.root)).sounds);
    const after = (await loadManifest(ctx.root)).sounds.click!;
    expect(after.files, "format conversion must not bring discarded alternatives back into the game").toHaveLength(1);
    expect(after.files[0]).toMatch(/\.aif$/);
  });
});

describe("review: concurrent project writers", () => {
  it("preserves both same-name takes made by overlapping make_sounds calls", async () => {
    const ctx = await context();
    ctx.provider = syntheticProvider();
    const actualWrite = codecs.writeAudio;
    // Encoding has real latency. Open that window without a barrier that could deadlock
    // after the production code is fixed by serializing writes.
    vi.spyOn(codecs, "writeAudio").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return actualWrite(...args);
    });
    const specs = [{ name: "click", prompt: "A dry wooden click.", duration_s: 0.5 }];
    await Promise.all([makeSounds(ctx, specs, { formats: ["wav"] }), makeSounds(ctx, specs, { formats: ["wav"] })]);
    const record = (await loadManifest(ctx.root)).sounds.click!;
    expect(record.files).toHaveLength(2);
    expect(new Set(record.files).size, "two paid takes must not share and overwrite one filename").toBe(2);
    expect(new Set(record.originals).size, "the kept originals must not overwrite one another").toBe(2);
    for (const file of record.files) expect(existsSync(path.join(ctx.root, file))).toBe(true);
  });

  it("keeps both manifest updates from separate TAKEBOX processes", async () => {
    const ctx = await context();
    const projectModule = fileURLToPath(new URL("../src/project.ts", import.meta.url));
    const gate = path.join(ctx.root, "release");
    const workers = ["alpha", "beta"].map((name) => {
      const code = `
        import { updateManifest } from ${JSON.stringify(projectModule)};
        import { existsSync } from 'node:fs';
        import { writeFile } from 'node:fs/promises';
        await updateManifest(${JSON.stringify(ctx.root)}, async manifest => {
          await writeFile(${JSON.stringify(path.join(ctx.root, `${name}-ready`))}, 'ready');
          const until = Date.now() + 2000;
          while (!existsSync(${JSON.stringify(gate)}) && Date.now() < until) await new Promise(r => setTimeout(r, 10));
          manifest.sounds[${JSON.stringify(name)}] = { kind:'one-shot', role:'sfx', source:'file', files:[], created:'test', updated:'test' };
        });
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "" },
      });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (exitCode) => resolve({ code: exitCode, stderr }));
      });
    });
    // A filesystem lock fix may let only one process reach its callback. Release it after
    // a bounded wait so that the second writer can acquire the lock and finish normally.
    const until = Date.now() + 1200;
    while (Date.now() < until && !["alpha", "beta"].every((name) => existsSync(path.join(ctx.root, `${name}-ready`)))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(gate, "go");
    const results = await Promise.all(workers);
    expect(results, "separate processes must not race on takebox.json.part").toEqual([
      { code: 0, stderr: "" }, { code: 0, stderr: "" },
    ]);
    expect(Object.keys((await loadManifest(ctx.root)).sounds).sort()).toEqual(["alpha", "beta"]);
  });
});
