import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { splitTake } from "../../server/takeTools.js";
import { synthLongTake } from "../../test/helpers/synth.js";
import { encodeWav } from "../src/audio/pcm.js";
import { makeSounds, type Context } from "../src/make.js";
import { defaultSettings } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { tempDir } from "./helpers.js";

it("identifies every faint cut after making and levelling a split sequence", async () => {
  const sampleRate = 48000;
  // A five-second walk with nine steps and three faint isolated sounds, matching the
  // measured real-take layout: faint cuts 1, 7 and 12. No real audio or provider is used.
  const { samples } = synthLongTake({
    sampleRate,
    at: [0.05, 0.4, 0.9, 1.4, 1.9, 2.4, 2.65, 2.9, 3.4, 3.9, 4.4, 4.75],
    levels: [0.016, 0.9, 0.65, 0.55, 0.8, 0.75, 0.020, 0.9, 0.65, 0.7, 0.85, 0.014],
    decayMs: 25, noiseFloor: 0.0007, totalMs: 5200,
  });
  const cuts = splitTake({ channels: [samples], sampleRate }, "footsteps");
  expect(cuts).toHaveLength(12);
  const faintCuts = cuts.flatMap((cut, index) => /faint/i.test(cut.notice) ? [index + 1] : []);
  expect(faintCuts).toEqual([1, 7, 12]);

  const root = await tempDir("takebox-review-faint-notices-");
  try {
    const raw = encodeWav([samples], sampleRate, 24);
    const provider: Provider = {
      id: "synthetic", label: "Synthetic", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
      estimateCredits: () => 20,
      generate: async () => ({ audio: { channels: [samples], sampleRate }, raw, rawExtension: "wav" }),
      account: async () => ({ tier: "test", creditsUsed: 0, creditsLimit: 2000, resetsAt: null }),
    };
    const ctx: Context = {
      root, settings: defaultSettings(root), provider,
      ledger: new SpendLedger(path.join(root, "spend.json")), limits: { dailyCap: 2000, askAbove: 300 },
    };
    const made = await makeSounds(ctx, [{ name: "footsteps", prompt: "A steady walk of footsteps.", kind: "sequence", duration_s: 5.2 }], { formats: ["wav"] });
    expect(made.status).toBe("made");
    const sound = made.sounds[0] as { files: string[]; notices: string[]; measured: { file: string; flags: string[] }[] };
    expect(sound.files).toHaveLength(12);
    const expected = faintCuts.map((cut) => sound.files[cut - 1]!);
    // Accept either structured per-file flags or an explicit file/cut warning. A generic
    // "check it" cannot tell an agent which delivered sounds need the person's decision.
    const identified = faintCuts.flatMap((cut) => {
      const file = sound.files[cut - 1]!;
      const flagged = sound.measured.find((row) => row.file === file)?.flags.some((flag) => /faint|low[- ]contrast/i.test(flag));
      const notice = sound.notices.some((line) => /faint|low[- ]contrast/i.test(line) &&
        (line.includes(file) || line.includes(path.basename(file)) || new RegExp(`\\bCut ${cut} of ${cuts.length}\\b`, "i").test(line)));
      return flagged || notice ? [file] : [];
    });
    expect(identified, "the agent must be able to identify all three faint outputs after they are levelled").toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
