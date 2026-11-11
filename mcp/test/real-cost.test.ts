import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { makeSounds } from "../src/make.js";
import { loadManifest } from "../src/project.js";
import { CREDITS_PER_SECOND, ElevenLabs } from "../src/providers/elevenlabs.js";
import { contextFor, createServices } from "../src/services.js";
import { SpendLedger } from "../src/spend.js";
import { burst, concat, RATE, silence, tempDir } from "./helpers.js";

// Ryu's first paid batch (2026-11-10): TAKEBOX booked 96 credits for three 0.8 s takes at the
// published 40 a second; ElevenLabs charged 24, and says so in a `character-cost` header.

const take = () => encodeWav([concat(silence(0.05), burst(0.4, 0.3, 0.05), silence(0.3))], RATE, 16);

/** An ElevenLabs that charges `perSecond` and says so, the way the real API does. */
function charging(perSecond: number | null) {
  const calls: number[] = [];
  const fake = (async (_url: string, init: RequestInit) => {
    const { duration_seconds } = JSON.parse(String(init.body)) as { duration_seconds: number };
    calls.push(duration_seconds);
    const headers: Record<string, string> = { "content-type": "audio/wav" };
    if (perSecond !== null) headers["character-cost"] = String(Math.round(perSecond * duration_seconds));
    return new Response(take(), { status: 200, headers });
  }) as unknown as typeof fetch;
  return { fake, calls };
}

async function game() {
  const root = await tempDir("takebox-cost-game-");
  await writeFile(path.join(root, "package.json"), "{}");
  return root;
}

describe("real cost: book what ElevenLabs charged, and learn its rate", () => {
  it("reads the charge from the character-cost header, and leaves it out when there is none", async () => {
    const said = await new ElevenLabs("sk_test", charging(10).fake).generate({ prompt: "a coin", durationS: 0.8, influence: 0.4 });
    expect(said.credits).toBe(8);
    const silent = await new ElevenLabs("sk_test", charging(null).fake).generate({ prompt: "a coin", durationS: 0.8, influence: 0.4 });
    expect(silent.credits).toBeUndefined();
  });

  it("estimates at the published rate until it has seen a real charge, then at that rate plus a margin", () => {
    const provider = new ElevenLabs("sk_test", charging(10).fake);
    expect(provider.estimateCredits({ prompt: "", durationS: 0.8, influence: 0 })).toBe(Math.ceil(CREDITS_PER_SECOND * 0.8));
    provider.learnRate(10);
    expect(provider.estimateCredits({ prompt: "", durationS: 0.8, influence: 0 })).toBe(9); // 0.8 s × 10 × 1.1, rounded up
    expect(provider.estimateCredits({ prompt: "", durationS: 2, influence: 0 })).toBe(22);
  });

  it("books each take at its real charge, so the ledger matches the ElevenLabs bill", async () => {
    const root = await game();
    const home = await tempDir("takebox-cost-home-");
    const ledger = new SpendLedger(path.join(home, "spend.json"));
    const services = createServices({ env: { ELEVENLABS_API_KEY: "sk_test" }, fetch: charging(10).fake, ledger });
    const ctx = await contextFor(services, root);

    const result = (await makeSounds(ctx, [{ name: "coin", prompt: "A heavy old coin.", duration_s: 0.8, variations: 3 }], {})) as {
      status: string;
      credits_used: number;
    };
    expect(result.status).toBe("made");
    expect(result.credits_used).toBe(24);
    expect(await ledger.spentToday()).toBe(24);
    expect((await loadManifest(root)).sounds.coin!.credits).toBe(24);
    const saved = JSON.parse(await readFile(path.join(home, "spend.json"), "utf8")) as { reservations: object; sent: object };
    expect(saved.reservations).toEqual({});
    expect(saved.sent).toEqual({});
  });

  it("teaches every later estimate on the machine, through the ledger, without a restart", async () => {
    const home = await tempDir("takebox-cost-home-");
    const ledger = new SpendLedger(path.join(home, "spend.json"));
    const first = createServices({ env: { ELEVENLABS_API_KEY: "sk_test" }, fetch: charging(10).fake, ledger });
    await makeSounds(await contextFor(first, await game()), [{ name: "coin", prompt: "A coin.", duration_s: 1, variations: 1 }], {});
    expect(await ledger.rate("elevenlabs")).toBe(10);

    // Another TAKEBOX process on the same machine (the board, a second agent) reads the same ledger.
    const second = createServices({ env: { ELEVENLABS_API_KEY: "sk_test" }, fetch: charging(10).fake, ledger: new SpendLedger(path.join(home, "spend.json")) });
    const ctx = await contextFor(second, await game());
    const dry = (await makeSounds(ctx, [{ name: "hit", prompt: "A hit.", duration_s: 2, variations: 2 }], { dryRun: true })) as { estimate_credits: number };
    expect(dry.estimate_credits).toBe(44); // 2 × ceil(2 s × 10 × 1.1), not 2 × 80
  });

  it("follows a price rise at once: the cap check uses the highest recent rate", async () => {
    const ledger = new SpendLedger(path.join(await tempDir("takebox-cost-home-"), "spend.json"));
    await ledger.learn("elevenlabs", 10);
    await ledger.learn("elevenlabs", 30);
    await ledger.learn("elevenlabs", 10);
    expect(await ledger.rate("elevenlabs")).toBe(30);
  });

  it("books the estimate when the provider does not say what it charged", async () => {
    const root = await game();
    const ledger = new SpendLedger(path.join(await tempDir("takebox-cost-home-"), "spend.json"));
    const services = createServices({ env: { ELEVENLABS_API_KEY: "sk_test" }, fetch: charging(null).fake, ledger });
    const result = (await makeSounds(await contextFor(services, root), [{ name: "coin", prompt: "A coin.", duration_s: 0.8, variations: 1 }], {})) as {
      credits_used: number;
    };
    expect(result.credits_used).toBe(Math.ceil(CREDITS_PER_SECOND * 0.8));
    expect(await ledger.rate("elevenlabs")).toBeNull();
  });
});
