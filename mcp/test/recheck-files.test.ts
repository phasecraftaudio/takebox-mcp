import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as codecs from "../src/audio/codecs.js";
import { encodeWav } from "../src/audio/pcm.js";
import { finishSounds, makeSounds, type Context } from "../src/make.js";
import { defaultSettings, loadManifest, Namer } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { resolveTake, setDisposition, takeId } from "../src/takes.js";
import { burst, mono, RATE, tempDir } from "./helpers.js";

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function context(): Promise<Context> {
  const root = await tempDir("takebox-recheck-files-");
  folders.push(root);
  let call = 0;
  const provider: Provider = {
    id: "synthetic", label: "Synthetic", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
    estimateCredits: () => 20,
    account: async () => ({ tier: "test", creditsUsed: 0, creditsLimit: 2000, resetsAt: null }),
    generate: async () => {
      const audio = mono(burst(0.5, 0.3, 0.06, ++call));
      return { audio, raw: encodeWav(audio.channels, RATE, 24), rawExtension: "wav" };
    },
  };
  return { root, settings: defaultSettings(root), provider, ledger: new SpendLedger(path.join(root, "spend.json")), limits: { dailyCap: 2000, askAbove: 300 } };
}

const specs = [{ name: "click", prompt: "A dry wooden click.", duration_s: 0.5 }];

describe("recheck: file recovery after the review fixes", () => {
  it("can move a made sound to a new output folder without losing its current deliverable", async () => {
    const ctx = await context();
    await makeSounds(ctx, specs, { formats: ["wav"] });
    const before = (await loadManifest(ctx.root)).sounds.click!.files[0]!;
    const bytes = await readFile(path.join(ctx.root, before));
    const result = await finishSounds(ctx, { names: ["click"], folder: "Assets/NewAudio", formats: ["aiff"] }, (await loadManifest(ctx.root)).sounds).catch(() => null);
    const after = (await loadManifest(ctx.root)).sounds.click!;
    // Either successful publication or preserving the previous take is safe. A new output
    // directory is a normal supported finish_sounds input, not a simulated disk failure.
    if (result?.status === "finished") {
      expect(after.files).toHaveLength(1);
      expect(after.files[0]).toMatch(/^Assets\/NewAudio\/.*\.aif$/);
      expect(existsSync(path.join(ctx.root, after.files[0]!))).toBe(true);
    } else {
      expect(existsSync(path.join(ctx.root, before)), "failed publication must retain the old deliverable").toBe(true);
      expect(await readFile(path.join(ctx.root, before))).toEqual(bytes);
    }
  });

  it("remakes a paid original for free after its first output encoding failed", async () => {
    const ctx = await context();
    const write = vi.spyOn(codecs, "writeAudio").mockRejectedValueOnce(new Error("encoder failed"));
    const made = await makeSounds(ctx, specs, { formats: ["wav"] });
    const sound = made.sounds[0]!;
    expect("files" in sound ? sound.files : undefined).toHaveLength(0);
    expect((await loadManifest(ctx.root)).sounds.click!.originals).toHaveLength(1);
    write.mockRestore();
    const finished = await finishSounds(ctx, { names: ["click"], formats: ["wav"] }, (await loadManifest(ctx.root)).sounds);
    expect(finished.status, "the advertised name-based free retry must process the saved paid original").toBe("finished");
    const record = (await loadManifest(ctx.root)).sounds.click!;
    expect(record.files).toHaveLength(1);
    expect(existsSync(path.join(ctx.root, record.files[0]!))).toBe(true);
    expect(await ctx.ledger.spentToday()).toBe(20);
  });

  it("keeps a board redo tracked while the agent re-finishes the same sound", async () => {
    const ctx = await context();
    await makeSounds(ctx, specs, { formats: ["wav"] });
    const before = await loadManifest(ctx.root);
    const folder = path.join(ctx.root, ctx.settings.folder);
    const actualTake = Namer.prototype.take;
    let pauseNextPublication = true;
    let entered!: () => void;
    let resume!: () => void;
    const atPublication = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(Namer.prototype, "take").mockImplementation(async function (this: Namer, target, stem) {
      if (pauseNextPublication && target === folder && stem === "click") {
        pauseNextPublication = false;
        entered();
        // Model ordinary filesystem scheduling at the final publication boundary. Bound the
        // pause so an eventual fix that serializes the whole sound cannot deadlock this test.
        await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 300))]);
      }
      return actualTake.call(this, target, stem);
    });
    const finished = finishSounds(ctx, { names: ["click"], formats: ["aiff"] }, before.sounds);
    await Promise.race([atPublication, new Promise((resolve) => setTimeout(resolve, 300))]);
    const redo = makeSounds(ctx, specs, { formats: ["wav"] });
    await Promise.race([redo, new Promise((resolve) => setTimeout(resolve, 300))]);
    resume();
    await Promise.all([finished, redo]);
    const after = (await loadManifest(ctx.root)).sounds.click!;
    expect(after.files, "both the re-finished take and the new paid board take must stay tracked").toHaveLength(2);
    const outputs = await readdir(folder);
    expect(outputs.filter((file) => !after.files.includes(`${ctx.settings.folder}/${file}`))).toEqual([]);
  });

  it("does not resurrect a board-rejected take while the agent re-finishes it", async () => {
    const ctx = await context();
    await makeSounds(ctx, specs, { formats: ["wav"] });
    const before = await loadManifest(ctx.root);
    const originalStem = before.sounds.click!.files[0]!.replace(/\.[^.]+$/, "");
    const take = resolveTake(before, takeId(originalStem))!;
    const actualWrite = codecs.writeAudio;
    let pauseStage = true;
    let entered!: () => void;
    let resume!: () => void;
    const atStaging = new Promise<void>((resolve) => { entered = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(codecs, "writeAudio").mockImplementation(async (...args) => {
      if (pauseStage && args[0].includes(`${path.sep}.takebox${path.sep}staging${path.sep}`)) {
        pauseStage = false;
        entered();
        await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 300))]);
      }
      return actualWrite(...args);
    });
    const finished = finishSounds(ctx, { names: ["click"], formats: ["aiff"] }, before.sounds);
    await Promise.race([atStaging, new Promise((resolve) => setTimeout(resolve, 300))]);
    const rejected = setDisposition(ctx, take, "reject").then(() => true, () => false);
    await Promise.race([rejected, new Promise((resolve) => setTimeout(resolve, 300))]);
    resume();
    const [, rejectionSucceeded] = await Promise.all([finished, rejected]);
    // Explicitly reporting a stale/conflicting reject is safe; accepting it and silently
    // bringing its audio back is not. The bound also permits a future per-sound transaction.
    if (rejectionSucceeded) {
      expect((await loadManifest(ctx.root)).sounds.click!.files, "an acknowledged board rejection must survive concurrent re-finishing").toEqual([]);
    }
  });
});
