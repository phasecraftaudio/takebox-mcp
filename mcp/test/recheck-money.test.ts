import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { makeSounds, type Context } from "../src/make.js";
import { defaultSettings } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { burst, mono, RATE, tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

async function context(generate: Provider["generate"], clock: () => Date, dailyCap: number): Promise<Context> {
  const root = await tempDir("takebox-recheck-money-");
  dirs.push(root);
  const provider: Provider = {
    id: "synthetic", label: "Synthetic only", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
    estimateCredits: (request) => Math.round(40 * request.durationS), generate,
    async account() { throw new Error("No account calls in this test"); },
  };
  return {
    root, settings: defaultSettings(root), provider,
    ledger: new SpendLedger(path.join(root, "state", "spend.json"), clock),
    limits: { dailyCap, askAbove: 300 },
  };
}

const samples = burst(0.5, 0.2, 0.05);
const generated = () => ({ audio: mono(samples.slice()), raw: encodeWav([samples], RATE), rawExtension: "wav" });

describe("recheck: running reservations across real clock boundaries", () => {
  it("keeps daily spend within the cap when pending requests finish after midnight", async () => {
    let now = new Date(2026, 10, 10, 23, 59, 50);
    const firstStarted = gate();
    const secondStarted = gate();
    const complete = gate();
    let calls = 0;
    const ctx = await context(async () => {
      if (++calls === 1) firstStarted.release();
      else secondStarted.release();
      await complete.promise;
      return generated();
    }, () => now, 120);
    const first = makeSounds(ctx, [{ name: "jump", prompt: "A springy jump.", duration_s: 2 }], {});
    await firstStarted.promise;
    now = new Date(2026, 10, 11, 0, 0, 10);
    // One game batch is still running when the board starts another after midnight.
    const second = makeSounds(ctx, [{ name: "coin", prompt: "A coin pickup.", duration_s: 2 }], {});
    try {
      // A cap refusal can finish without entering the provider; a serialization fix
      // may wait for the first batch. Keep that corrected implementation bounded.
      await Promise.race([secondStarted.promise, second.then(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))]);
      complete.release();
      await Promise.all([first, second]);
      expect(await ctx.ledger.spentToday(), "pending previous-day work must not make today's meter exceed its cap").toBeLessThanOrEqual(120);
    } finally {
      complete.release();
    }
  });

  it("does not keep starting paid requests from an expired reservation after the Mac wakes", async () => {
    let now = new Date(2026, 10, 10, 10, 0);
    const twoRequestsStarted = gate();
    const newBatchStarted = gate();
    const wake = gate();
    let firstBatchCalls = 0;
    const ctx = await context(async (request) => {
      if (request.prompt === "A springy jump.") {
        const call = ++firstBatchCalls;
        if (call === 2) twoRequestsStarted.release();
        if (call <= 2) {
          await wake.promise;
          // A laptop sleeps while the first two HTTP requests run. They time out,
          // but the rest of the approved queue remains in the same live process.
          throw new Error("Request timed out while the Mac slept");
        }
      } else newBatchStarted.release();
      return generated();
    }, () => now, 2000);
    const first = makeSounds(ctx, [{ name: "jump", prompt: "A springy jump.", duration_s: 5, variations: 8 }], { confirmCredits: 1600 });
    await twoRequestsStarted.promise;
    now = new Date(2026, 10, 10, 12, 0, 1);
    const second = makeSounds(ctx, [{ name: "coin", prompt: "A coin pickup.", duration_s: 5, variations: 8 }], { confirmCredits: 1600 });
    try {
      await Promise.race([newBatchStarted.promise, second.then(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))]);
      wake.release();
      await Promise.all([first, second]);
      expect(await ctx.ledger.spentToday(), "an expired hold cannot authorize the rest of a running paid queue").toBeLessThanOrEqual(2000);
    } finally {
      wake.release();
    }
  });
});
