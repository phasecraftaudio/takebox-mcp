import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as codecs from "../src/audio/codecs.js";
import { encodeWav } from "../src/audio/pcm.js";
import { finishSounds, makeSounds, type Context, type SoundSpec } from "../src/make.js";
import { defaultSettings, loadManifest } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { groupTakes, resolveTake, setDisposition, takeId } from "../src/takes.js";
import { burst, concat, mono, RATE, silence, tempDir } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function context(sequence: boolean): Promise<Context> {
  const root = await tempDir("takebox-recheck2-files-");
  roots.push(root);
  let call = 0;
  const provider: Provider = {
    id: "synthetic", label: "Synthetic", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
    estimateCredits: () => 20,
    account: async () => ({ tier: "test", creditsUsed: 0, creditsLimit: 2000, resetsAt: null }),
    generate: async () => {
      ++call;
      const samples = sequence
        ? concat(...Array.from({ length: 4 }, (_, cut) => concat(silence(0.35), burst(0.25, 0.4, 0.03, cut + 2))), silence(0.5))
        : burst(0.5, 0.3, 0.06, call);
      const audio = mono(samples);
      return { audio, raw: encodeWav(audio.channels, RATE, 24), rawExtension: "wav" };
    },
  };
  return { root, settings: defaultSettings(root), provider, ledger: new SpendLedger(path.join(root, "spend.json")), limits: { dailyCap: 2000, askAbove: 300 } };
}

describe("recheck 2: board take identity across replacement", () => {
  it.each([
    { label: "variation", sequence: false },
    { label: "split cut", sequence: true },
  ])("does not apply a queued reject to a different $label after filling a rejected numbering gap", async ({ sequence }) => {
    const ctx = await context(sequence);
    const sound: SoundSpec = { name: "click", prompt: "A dry wooden click.", duration_s: sequence ? 4 : 0.5, variations: sequence ? 1 : 3, ...(sequence ? { kind: "sequence" } : {}) };
    await makeSounds(ctx, [sound], { formats: ["wav"] });
    const first = await loadManifest(ctx.root);
    const takes = groupTakes(first.sounds.click!.files);
    expect(takes.length).toBeGreaterThanOrEqual(3);
    // The person already discarded take 1. Their board still displays take 2 while an agent
    // starts converting the remaining sound; that older card's id is the queued operation.
    await setDisposition(ctx, resolveTake(first, takeId(takes[0]!.stem))!, "reject");
    const before = await loadManifest(ctx.root);
    const wanted = resolveTake(before, takeId(takes[1]!.stem))!;
    const wantedInfo = before.sounds.click!.takes![wanted.stem]!;
    const identity = (info: { original?: string; cut?: number }) => `${info.original}:${info.cut ?? "whole"}`;
    const wantedIdentity = identity(wantedInfo);
    const actualWrite = codecs.writeAudio;
    let pauseStage = true;
    let entered!: () => void;
    let resume!: () => void;
    const staged = new Promise<void>((resolve) => { entered = resolve; });
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
    await Promise.race([staged, new Promise((resolve) => setTimeout(resolve, 300))]);
    const rejected = setDisposition(ctx, wanted, "reject").then(() => true, () => false);
    resume();
    const [, rejectionSucceeded] = await Promise.all([finished, rejected]);
    if (rejectionSucceeded) {
      const after = (await loadManifest(ctx.root)).sounds.click!;
      expect(Object.values(after.takes ?? {}).map(identity), "a successful reject must remove the take the person selected, not whichever take inherited its stem").not.toContain(wantedIdentity);
      expect(after.files).toHaveLength(before.sounds.click!.files.length - wanted.files.length);
      const outputs = await readdir(path.join(ctx.root, ctx.settings.folder));
      expect(outputs).toHaveLength(after.files.length);
    }
  });
});
