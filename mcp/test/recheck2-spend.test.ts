import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { makeSounds, type Context } from "../src/make.js";
import { defaultSettings } from "../src/project.js";
import type { Provider } from "../src/providers/types.js";
import { SpendLedger, today } from "../src/spend.js";
import { burst, mono, RATE, tempDir } from "./helpers.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Two actual TAKEBOX processes, not two ledger objects sharing the running-hold set. */
async function inFlightOwner(root: string, ledgerFile: string, now: Date) {
  const makeUrl = new URL("../src/make.ts", import.meta.url).href;
  const projectUrl = new URL("../src/project.ts", import.meta.url).href;
  const spendUrl = new URL("../src/spend.ts", import.meta.url).href;
  const pcmUrl = new URL("../src/audio/pcm.ts", import.meta.url).href;
  const helpersUrl = new URL("./helpers.ts", import.meta.url).href;
  const code = `
    import { makeSounds } from ${JSON.stringify(makeUrl)};
    import { defaultSettings } from ${JSON.stringify(projectUrl)};
    import { SpendLedger } from ${JSON.stringify(spendUrl)};
    import { encodeWav } from ${JSON.stringify(pcmUrl)};
    import { burst, mono, RATE } from ${JSON.stringify(helpersUrl)};
    let now = new Date(${JSON.stringify(now.toISOString())});
    let wake;
    const sleeping = new Promise(resolve => { wake = resolve; });
    process.stdin.once('data', data => { now = new Date(JSON.parse(data.toString()).now); wake(); process.stdin.pause(); });
    let calls = 0;
    const samples = burst(0.5, 0.2, 0.05);
    const provider = {
      id:'synthetic', label:'Synthetic only', promptMax:450, minDurationS:0.5, maxDurationS:30,
      estimateCredits: request => Math.round(40 * request.durationS),
      generate: async () => {
        if (++calls === 2) process.stdout.write('READY\\n');
        // These requests already reached the provider before the laptop slept.
        // Their completed synthetic responses are received after it wakes.
        await sleeping;
        return { audio:mono(samples.slice()), raw:encodeWav([samples], RATE), rawExtension:'wav' };
      },
      account: async () => { throw new Error('No account calls'); },
    };
    const ctx = { root:${JSON.stringify(root)}, settings:defaultSettings(${JSON.stringify(root)}), provider,
      ledger:new SpendLedger(${JSON.stringify(ledgerFile)}, () => now), limits:{dailyCap:2000,askAbove:300} };
    const result = await makeSounds(ctx, [{name:'jump',prompt:'A springy jump.',duration_s:10,variations:2}], {confirmCredits:800});
    process.stdout.write('DONE ' + JSON.stringify({used:result.credits_used}) + '\\n');
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  let ready!: () => void;
  let rejectReady!: (reason: Error) => void;
  const began = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Owner exited ${code}: ${stderr}`)));
  });
  child.stdout!.on("data", (data) => { stdout += data; if (stdout.includes("READY\n")) ready(); });
  child.stderr!.on("data", (data) => { stderr += data; });
  child.once("error", rejectReady);
  child.once("exit", () => { if (!stdout.includes("READY\n")) rejectReady(new Error(`Owner did not start: ${stderr}`)); });
  // Avoid an unhandled child-error promise while waiting for the ready message.
  void done.catch(() => undefined);
  await began;
  return { wake: (at: Date) => child.stdin!.end(JSON.stringify({ now: at.toISOString() })), done };
}

async function fixture(initial: Date) {
  const dir = await tempDir("takebox-recheck2-spend-");
  directories.push(dir);
  const gameRoot = path.join(dir, "game");
  await mkdir(gameRoot);
  const file = path.join(dir, "spend.json");
  const owner = await inFlightOwner(gameRoot, file, initial);
  let now = initial;
  const samples = burst(0.5, 0.2, 0.05);
  const provider: Provider = {
    id: "synthetic", label: "Synthetic only", promptMax: 450, minDurationS: 0.5, maxDurationS: 30,
    estimateCredits: (request) => Math.round(40 * request.durationS),
    async generate() { return { audio: mono(samples.slice()), raw: encodeWav([samples], RATE), rawExtension: "wav" }; },
    async account() { throw new Error("No account calls"); },
  };
  const ledger = new SpendLedger(file, () => now);
  const ctx: Context = { root: gameRoot, settings: defaultSettings(gameRoot), provider, ledger, limits: { dailyCap: 2000, askAbove: 300 } };
  return { owner, file, ctx, setTime: (at: Date) => { now = at; } };
}

describe("recheck 2: another process must not forget paid requests still in flight", () => {
  it("keeps in-flight spend reserved across a long sleep in a second TAKEBOX process", async () => {
    const app = await fixture(new Date(2026, 10, 10, 10));
    const afterSleep = new Date(2026, 10, 10, 12, 0, 1);
    app.setTime(afterSleep);
    // The board can use the full cap only if it has forgotten the still-running
    // agent's 800-credit hold. With a valid hold, this batch must be refused.
    await makeSounds(app.ctx, [{ name: "coin", prompt: "A coin pickup.", duration_s: 10, variations: 5 }], { confirmCredits: 2000 });
    app.owner.wake(afterSleep);
    await app.owner.done;
    expect(await app.ctx.ledger.spentToday(), "in-flight paid requests remain part of the cap after a foreign process expires their hold").toBeLessThanOrEqual(2000);
  });

  it("retains the approval day when a foreign process cleans an old in-flight hold", async () => {
    const approved = new Date(2026, 10, 10, 23, 59);
    const app = await fixture(approved);
    const afterSleep = new Date(2026, 10, 11, 2, 0, 1);
    app.setTime(afterSleep);
    await makeSounds(app.ctx, [{ name: "coin", prompt: "A coin pickup.", duration_s: 0.5 }], {});
    app.owner.wake(afterSleep);
    await app.owner.done;
    const stored = JSON.parse(await readFile(app.file, "utf8")) as { days: Record<string, number> };
    expect({ approved: stored.days[today(approved)] ?? 0, nextDay: stored.days[today(afterSleep)] ?? 0 })
      .toEqual({ approved: 800, nextDay: 20 });
  });
});
