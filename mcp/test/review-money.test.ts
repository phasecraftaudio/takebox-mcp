import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { makeSounds, type Context } from "../src/make.js";
import { defaultSettings } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger } from "../src/spend.js";
import { burst, mono, RATE, tempDir } from "./helpers.js";

const dirs: string[] = [];
async function temporary() {
  const dir = await tempDir("takebox-review-money-");
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("review: the daily cap under overlapping work", () => {
  it("reserves credits before overlapping batches can both pass the daily cap", async () => {
    const root = await temporary();
    const home = await temporary();
    let calls = 0;
    const samples = burst(0.5, 0.2, 0.05);
    const provider: Provider = {
      id: "synthetic", label: "Synthetic only", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
      estimateCredits: (request) => Math.round(request.durationS * 40),
      async generate() {
        calls += 1;
        // Both requests can be in flight during ordinary provider latency. A fixed
        // delay also lets a corrected implementation serialize them without deadlock.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { audio: mono(samples), raw: encodeWav([samples], RATE), rawExtension: "wav" };
      },
      async account() { throw new Error("This test must never inspect a real account"); },
    };
    const settings = defaultSettings(root);
    settings.formats = { oneShot: ["wav"], loop: ["wav"] };
    const ctx: Context = {
      root, settings, provider, ledger: new SpendLedger(path.join(home, "spend.json")),
      limits: { dailyCap: 120, askAbove: 300 },
    };
    const results = await Promise.all([
      makeSounds(ctx, [{ name: "jump", prompt: "A springy jump.", duration_s: 2 }], {}),
      makeSounds(ctx, [{ name: "coin", prompt: "A coin pickup.", duration_s: 2 }], {}),
    ]);

    // Either one 80-credit batch fits; two do not. MCP and the board share this context.
    expect({ calls, spent: await ctx.ledger.spentToday(), statuses: results.map((r) => r.status).sort() })
      .toEqual({ calls: 1, spent: 80, statuses: ["made", "over_daily_cap"] });
  });

  it("merges concurrent ledger writes from independent MCP or standalone board sessions", async () => {
    const dir = await temporary();
    const file = path.join(dir, "spend.json");
    const first = new SpendLedger(file);
    const second = new SpendLedger(file);
    await first.record(20, "synthetic", "earlier");

    const writes = await Promise.allSettled([
      first.record(80, "synthetic", "jump"),
      second.record(40, "synthetic", "coin"),
    ]);
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect({ statuses: writes.map((r) => r.status), spent: await first.spentToday(), entries: stored.log.length })
      .toEqual({ statuses: ["fulfilled", "fulfilled"], spent: 140, entries: 3 });
  });
});
