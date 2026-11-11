import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFile } from "../src/audio/codecs.js";
import { encodeWav } from "../src/audio/pcm.js";
import { finishSounds, makeSounds, type Context } from "../src/make.js";
import { defaultSettings, loadManifest, Namer } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { burst, mono, RATE, tempDir } from "./helpers.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<Context> {
  const root = await tempDir("takebox-recheck2-import-");
  directories.push(root);
  const audio = mono(burst(0.5, 0.3, 0.06));
  const provider: Provider = {
    id: "synthetic", label: "Synthetic", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
    estimateCredits: () => 20,
    account: async () => ({ tier: "test", creditsUsed: 0, creditsLimit: 2000, resetsAt: null }),
    generate: async () => ({ audio, raw: encodeWav(audio.channels, RATE, 24), rawExtension: "wav" }),
  };
  return {
    root, settings: defaultSettings(root), provider,
    ledger: new SpendLedger(path.join(root, "spend.json")), limits: { dailyCap: 2000, askAbove: 300 },
  };
}

describe("recheck2: every sound-file writer joins the sound transaction", () => {
  it("keeps a same-name library import tracked when it overlaps re-finishing a generated sound", async () => {
    const ctx = await fixture();
    await makeSounds(ctx, [{ name: "click", prompt: "A dry wooden click.", duration_s: 0.5 }], { formats: ["wav"] });
    const before = await loadManifest(ctx.root);
    const library = await tempDir("takebox-recheck2-library-");
    directories.push(library);
    const source = path.join(library, "alternate.wav");
    const sourceBytes = encodeWav([burst(0.5, 0.2, 0.08, 19)], RATE, 24);
    await writeFile(source, sourceBytes);
    const output = path.join(ctx.root, ctx.settings.folder);
    const actualTake = Namer.prototype.take;
    let entered!: () => void;
    let resume!: () => void;
    const atPublication = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let firstPublication = true;
    vi.spyOn(Namer.prototype, "take").mockImplementation(async function (this: Namer, folder, stem) {
      if (firstPublication && folder === output && stem === "click") {
        firstPublication = false;
        entered();
        // Pause where the old takes have been parked but their replacement names are
        // not yet claimed. A corrected shared sound lock can safely wait this out.
        await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
      return actualTake.call(this, folder, stem);
    });

    const refinish = finishSounds(ctx, { names: ["click"], formats: ["aiff"] }, before.sounds);
    await Promise.race([atPublication, new Promise((_, reject) => setTimeout(() => reject(new Error("did not reach publication")), 2000))]);
    const imported = finishSounds(ctx, { files: [source], name: "click", formats: ["wav"] }, before.sounds);
    try {
      await Promise.race([imported, new Promise((resolve) => setTimeout(resolve, 200))]);
    } finally {
      resume();
    }
    const [converted, added] = await Promise.all([refinish, imported]);
    expect(converted.status).toBe("finished");
    expect(added.status).toBe("finished");
    const addedFiles = added.sounds[0]!.files;
    expect(addedFiles).toHaveLength(1);
    expect((await decodeFile(path.join(ctx.root, addedFiles[0]!))).channels[0]!.length).toBeGreaterThan(0);
    expect(new Uint8Array(await readFile(source))).toEqual(sourceBytes);

    const record = (await loadManifest(ctx.root)).sounds.click!;
    // Both requests succeeded: each resulting take must remain tracked. A later
    // re-finish must not discard the library take that was added while it staged.
    expect.soft(record.files).toHaveLength(2);
    expect.soft(record.files).toContain(addedFiles[0]);
    const diskFiles = (await readdir(output)).map((name) => path.posix.join(ctx.settings.folder, name)).sort();
    expect(record.files.slice().sort()).toEqual(diskFiles);
  });
});
