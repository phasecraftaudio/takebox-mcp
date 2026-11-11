import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFile } from "../src/audio/codecs.js";
import { encodeWav } from "../src/audio/pcm.js";
import { processTake, type FinishOptions } from "../src/finish.js";
import { finishSounds, makeSounds, type Context } from "../src/make.js";
import { defaultSettings, loadManifest, sanitizeName } from "../src/project.js";
import { ElevenLabs } from "../src/providers/elevenlabs.js";
import { FatalProviderError, type GenerateRequest, type Provider } from "../src/providers/types.js";
import { checkSpend, limitsFromEnv, SpendLedger } from "../src/spend.js";
import { measureLoudness } from "../../shared/dsp/loudness.js";
import { burst, concat, mono, noise, RATE, silence, tempDir } from "./helpers.js";

/** A take the way a model returns it: dead air, the sound, a long silent tail. */
const oneShotTake = (seed = 1) => concat(silence(0.15), burst(0.5, 0.3, 0.06, seed), silence(1.2));
const stepsTake = () => concat(...Array.from({ length: 4 }, (_, i) => concat(silence(0.35), burst(0.25, 0.4, 0.03, i + 2))), silence(0.5));

class FakeProvider implements Provider {
  readonly id = "fake";
  readonly label = "Fake";
  readonly promptMax = 450;
  readonly minDurationS = 0.5;
  readonly maxDurationS = 30;
  calls: GenerateRequest[] = [];
  constructor(private readonly make: (request: GenerateRequest, call: number) => Float32Array | Error = () => oneShotTake()) {}
  estimateCredits(request: GenerateRequest) {
    return Math.round(40 * request.durationS);
  }
  async generate(request: GenerateRequest) {
    this.calls.push(request);
    const out = this.make(request, this.calls.length);
    if (out instanceof Error) throw out;
    const raw = encodeWav([out], RATE, 24);
    return { audio: mono(out), raw, rawExtension: "wav" };
  }
  async account() {
    return { tier: "free", creditsUsed: 100, creditsLimit: 10000, resetsAt: null };
  }
}

async function context(provider: Provider | null, env: Record<string, string> = {}) {
  const root = await tempDir("takebox-game-");
  await writeFile(path.join(root, "package.json"), "{}");
  const home = await tempDir("takebox-home-");
  const ledger = new SpendLedger(path.join(home, "spend.json"));
  const ctx: Context = { root, settings: defaultSettings(root), provider, ledger, limits: limitsFromEnv(env) };
  return ctx;
}

describe("finishing a take", () => {
  const options = (shape: FinishOptions["shape"]): FinishOptions => ({ shape, level: "role", role: "sfx", channels: "keep", formats: ["wav"], encode: {} });

  it("trims a one-shot so it fires at once, then levels it", () => {
    const [piece] = processTake(mono(oneShotTake()), options("trim"));
    expect(piece!.audio.channels[0]!.length / RATE).toBeLessThan(1.0);
    expect(piece!.notices.join(" ")).toMatch(/Tightened/);
    expect(measureLoudness(piece!.audio.channels, RATE).momentaryMax).toBeCloseTo(-18, 0);
  });

  it("splits a run of footsteps into separate files, each levelled", () => {
    const pieces = processTake(mono(stepsTake()), { ...options("split"), splitPreset: "footsteps", role: "foley" });
    expect(pieces).toHaveLength(4);
    for (const piece of pieces) expect(measureLoudness(piece.audio.channels, RATE).momentaryMax).toBeCloseTo(-21, 0);
  });

  it("makes an ambience seamless, and says when it cannot", () => {
    const [loop] = processTake(mono(noise(16, 0.2)), { ...options("loop"), role: "ambience" });
    expect(loop!.loopable).toBe(true);
    const [notLoop] = processTake(mono(oneShotTake()), { ...options("loop"), role: "ambience" });
    expect(notLoop!.loopable).toBe(false);
    expect(notLoop!.notices.join(" ")).toMatch(/No steady part/);
  });

  it("folds to mono when asked", () => {
    const take = oneShotTake();
    const [piece] = processTake({ channels: [take, take.slice()], sampleRate: RATE }, { ...options("trim"), channels: "mono" });
    expect(piece!.audio.channels).toHaveLength(1);
  });
});

describe("spend guard", () => {
  it("reads limits from the environment, with off meaning no cap", () => {
    expect(limitsFromEnv({})).toEqual({ dailyCap: 2000, askAbove: 300 });
    expect(limitsFromEnv({ TAKEBOX_DAILY_CREDITS: "off", TAKEBOX_ASK_ABOVE: "50" })).toEqual({ dailyCap: Infinity, askAbove: 50 });
  });

  it("refuses past the cap and asks above the line", () => {
    const limits = { dailyCap: 1000, askAbove: 300 };
    expect(checkSpend(200, 900, limits, undefined)).toMatchObject({ ok: false, reason: "cap" });
    expect(checkSpend(400, 0, limits, undefined)).toMatchObject({ ok: false, reason: "confirm" });
    expect(checkSpend(400, 0, limits, 399)).toMatchObject({ ok: false, reason: "confirm" });
    expect(checkSpend(400, 0, limits, 400)).toEqual({ ok: true });
    expect(checkSpend(200, 0, limits, undefined)).toEqual({ ok: true });
  });

  it("keeps a running total per day", async () => {
    const dir = await tempDir();
    let now = new Date(2026, 10, 9, 10);
    const ledger = new SpendLedger(path.join(dir, "spend.json"), () => now);
    await Promise.all([ledger.record(80, "x", "a"), ledger.record(40, "x", "b")]);
    expect(await ledger.spentToday()).toBe(120);
    now = new Date(2026, 10, 10, 9);
    expect(await ledger.spentToday()).toBe(0);
  });
});

describe("make_sounds", () => {
  const coin = { name: "Coin Pickup", prompt: "A bright gold coin pickup chime for a video game, close-up and dry.", duration_s: 1, variations: 3 };

  it("estimates without generating", async () => {
    const provider = new FakeProvider();
    const ctx = await context(provider);
    const result = await makeSounds(ctx, [coin], { dryRun: true });
    expect(result).toMatchObject({ status: "estimate", estimate_credits: 120 });
    expect(provider.calls).toHaveLength(0);
  });

  it("stops above the ask line until the person confirms the amount", async () => {
    const provider = new FakeProvider();
    const ctx = await context(provider, { TAKEBOX_ASK_ABOVE: "100" });
    expect(await makeSounds(ctx, [coin], {})).toMatchObject({ status: "needs_confirmation" });
    expect(provider.calls).toHaveLength(0);
    expect(await makeSounds(ctx, [coin], { confirmCredits: 120 })).toMatchObject({ status: "made", credits_used: 120 });
  });

  it("stops at the daily cap, even when confirmed", async () => {
    const provider = new FakeProvider();
    const ctx = await context(provider, { TAKEBOX_DAILY_CREDITS: "100" });
    expect(await makeSounds(ctx, [coin], { confirmCredits: 120 })).toMatchObject({ status: "over_daily_cap" });
    expect(provider.calls).toHaveLength(0);
  });

  it("makes trimmed, levelled, numbered files, keeps originals, records takebox.json and the spend", async () => {
    const provider = new FakeProvider();
    const ctx = await context(provider);
    const result = (await makeSounds(ctx, [coin], {})) as { sounds: { name: string; files: string[] }[] };
    expect(result.sounds[0]!.name).toBe("coin_pickup");
    expect(result.sounds[0]!.files).toEqual(["public/audio/coin_pickup_01.ogg", "public/audio/coin_pickup_02.ogg", "public/audio/coin_pickup_03.ogg"].map((f) => f.replace("public/audio", ctx.settings.folder)));
    for (const file of result.sounds[0]!.files) {
      const audio = await decodeFile(path.join(ctx.root, file));
      expect(audio.channels[0]!.length / audio.sampleRate).toBeLessThan(1);
    }
    const manifest = await loadManifest(ctx.root);
    expect(manifest.sounds.coin_pickup!.originals).toHaveLength(3);
    for (const original of manifest.sounds.coin_pickup!.originals!) expect(existsSync(path.join(ctx.root, original))).toBe(true);
    expect(await ctx.ledger.spentToday()).toBe(120);
    expect(provider.calls[0]).toMatchObject({ durationS: 1, influence: 0.4 });

    // The same name again adds new takes after the old ones: nothing is overwritten.
    const again = (await makeSounds(ctx, [{ ...coin, variations: 1 }], {})) as { sounds: { files: string[] }[] };
    expect(again.sounds[0]!.files[0]).toMatch(/coin_pickup_04\.ogg$/);
    expect((await loadManifest(ctx.root)).sounds.coin_pickup!.files).toHaveLength(4);
  });

  it("splits a sequence into numbered one-shots and loops an ambience", async () => {
    const provider = new FakeProvider((request) => (request.durationS > 10 ? noise(request.durationS, 0.2) : stepsTake()));
    const ctx = await context(provider);
    const result = (await makeSounds(
      ctx,
      [
        { name: "footsteps", prompt: "Footsteps on gravel, a steady walk.", kind: "sequence" },
        { name: "amb_forest", prompt: "A calm forest ambience.", kind: "loop", duration_s: 16 },
      ],
      { confirmCredits: 10_000 },
    )) as { sounds: { name: string; files: string[]; notices: string[] }[] };
    expect(result.sounds[0]!.files).toHaveLength(4);
    expect(result.sounds[1]!.files).toHaveLength(1);
    expect(result.sounds[1]!.notices.join(" ")).toMatch(/Loop/);
  });

  it("stops the whole batch on an error every request would hit, and keeps what was made", async () => {
    const provider = new FakeProvider((_, call) => (call >= 2 ? new FatalProviderError("out of credits") : oneShotTake()));
    const ctx = await context(provider);
    const result = (await makeSounds(ctx, [{ ...coin, variations: 6 }], { confirmCredits: 1000 })) as unknown as { status: string; stopped: string; sounds: { files: string[] }[] };
    expect(result.stopped).toMatch(/out of credits/);
    expect(provider.calls.length).toBeLessThan(6);
    expect(result.sounds[0]!.files.length).toBeGreaterThanOrEqual(1);
    expect(await ctx.ledger.spentToday()).toBe(result.sounds[0]!.files.length * 40);
  });

  it("refuses a prompt over the limit and duplicate names", async () => {
    const ctx = await context(new FakeProvider());
    await expect(makeSounds(ctx, [{ name: "x", prompt: "a".repeat(451) }], {})).rejects.toThrow(/limit is 450/);
    await expect(makeSounds(ctx, [{ name: "Coin", prompt: "a coin" }, { name: "coin", prompt: "another" }], {})).rejects.toThrow(/both named coin/);
  });

  it("explains that generating needs a key, but still estimates", async () => {
    const ctx = await context(null);
    expect(await makeSounds(ctx, [coin], { dryRun: true })).toMatchObject({ estimate_credits: 120 });
    await expect(makeSounds(ctx, [coin], {})).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe("finish_sounds", () => {
  it("re-finishes made sounds from their originals into a new format, free, replacing the old files", async () => {
    const provider = new FakeProvider();
    const ctx = await context(provider);
    await makeSounds(ctx, [{ name: "click", prompt: "A click.", duration_s: 1, variations: 2 }], {});
    const before = (await loadManifest(ctx.root)).sounds.click!.files;
    const result = await finishSounds(ctx, { names: ["click"], formats: ["wav", "mp3"] }, (await loadManifest(ctx.root)).sounds);
    expect(provider.calls).toHaveLength(2);
    const after = (await loadManifest(ctx.root)).sounds.click!.files;
    expect(after).toHaveLength(4);
    expect(after.filter((f) => f.endsWith(".mp3"))).toHaveLength(2);
    for (const old of before) expect(existsSync(path.join(ctx.root, old))).toBe(false);
    expect(result.sounds[0]!.removed).toEqual(before);
  });

  it("brings library files in under one name, in the project's format, leaving the originals alone", async () => {
    const ctx = await context(null);
    const library = await tempDir("library-");
    const a = path.join(library, "FOLYFeet_Gravel_Walk_01.wav");
    const b = path.join(library, "FOLYFeet_Gravel_Walk_02.aif");
    await writeFile(a, encodeWav([oneShotTake(3)], 44100));
    const { encodeAiff } = await import("../src/audio/pcm.js");
    await writeFile(b, encodeAiff([oneShotTake(4), oneShotTake(5)], 96000));
    const before = await readFile(a);
    const result = await finishSounds(ctx, { files: [library], name: "Gravel Step", role: "foley", channels: "mono", sample_rate: 48000 }, {});
    expect(result.sounds[0]!.files).toHaveLength(2);
    expect(result.sounds[0]!.files[0]).toMatch(/gravel_step_01\.ogg$/);
    const audio = await decodeFile(path.join(ctx.root, result.sounds[0]!.files[1]!));
    expect(audio.channels).toHaveLength(1);
    expect(audio.sampleRate).toBe(48000);
    expect((await readFile(a)).equals(before)).toBe(true);
    const record = (await loadManifest(ctx.root)).sounds.gravel_step!;
    expect(record).toMatchObject({ source: "file", kind: "one-shot", role: "foley" });
    expect(record.from).toEqual([a, b]);
  });

  it("will not write outside the project", async () => {
    const ctx = await context(null);
    const library = await tempDir("library-");
    await writeFile(path.join(library, "x.wav"), encodeWav([oneShotTake()], RATE));
    await expect(finishSounds(ctx, { files: [library], folder: "../escape" }, {})).rejects.toThrow(/outside the project/);
  });
});

describe("ElevenLabs adapter", () => {
  const wavBody = () => encodeWav([oneShotTake()], 48000, 16);

  it("asks for 48 kHz WAV with no loop flag, and decodes it", async () => {
    const seen: { url: string; body: Record<string, unknown>; key: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)), key: (init.headers as Record<string, string>)["xi-api-key"]! });
      return new Response(wavBody(), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ElevenLabs("sk_test_1234", fake);
    const result = await provider.generate({ prompt: "a coin", durationS: 1, influence: 0.5 });
    expect(seen[0]!.url).toBe("https://api.elevenlabs.io/v1/sound-generation?output_format=wav_48000");
    expect(seen[0]!.body).toEqual({ text: "a coin", duration_seconds: 1, prompt_influence: 0.5, loop: false });
    expect(seen[0]!.key).toBe("sk_test_1234");
    expect(result.rawExtension).toBe("wav");
    expect(result.audio.sampleRate).toBe(48000);
    expect(provider.estimateCredits({ prompt: "", durationS: 1.5, influence: 0 })).toBe(60);
  });

  it("falls back to MP3 once if the plan refuses WAV", async () => {
    const formats: string[] = [];
    const { createMp3Encoder } = await import("wasm-media-encoders");
    const encoder = await createMp3Encoder();
    encoder.configure({ sampleRate: 44100, channels: 1, vbrQuality: 2 });
    const mp3 = new Uint8Array([...encoder.encode([oneShotTake()]), ...encoder.finalize()]);
    const fake = (async (url: string) => {
      const format = new URL(url).searchParams.get("output_format")!;
      formats.push(format);
      if (format === "wav_48000") return new Response(JSON.stringify({ detail: { status: "invalid_output_format", message: "output_format not allowed on your tier" } }), { status: 403 });
      return new Response(mp3, { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ElevenLabs("sk_x", fake);
    expect((await provider.generate({ prompt: "a", durationS: 1, influence: 0.3 })).rawExtension).toBe("mp3");
    await provider.generate({ prompt: "b", durationS: 1, influence: 0.3 });
    expect(formats).toEqual(["wav_48000", "mp3_44100_128", "mp3_44100_128"]);
  });

  it("treats a bad key and an empty account as fatal, and never repeats the key", async () => {
    const key = "sk_secret_value_9999";
    const bad = (async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: `key ${key} is invalid` } }), { status: 401 })) as unknown as typeof fetch;
    const error = await new ElevenLabs(key, bad).generate({ prompt: "a", durationS: 1, influence: 0.3 }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(FatalProviderError);
    expect(String((error as Error).message)).not.toContain(key);
    const empty = (async () => new Response(JSON.stringify({ detail: { status: "quota_exceeded", message: "You have 0 credits remaining" } }), { status: 401 })) as unknown as typeof fetch;
    await expect(new ElevenLabs("k", empty).generate({ prompt: "a", durationS: 1, influence: 0.3 })).rejects.toThrow(/out of credits/);
  });
});

describe("file numbers", () => {
  it("never hands the same number to takes claimed at the same moment", async () => {
    const { Namer } = await import("../src/project.js");
    const dir = await tempDir();
    await writeFile(path.join(dir, "coin_01.ogg"), "x");
    const namer = new Namer();
    const names = await Promise.all(Array.from({ length: 8 }, () => namer.take(dir, "coin")));
    expect(new Set(names).size).toBe(8);
    expect(names.sort()[0]).toBe("coin_02");
  });

  it("skips a number another process wrote meanwhile", async () => {
    const { Namer } = await import("../src/project.js");
    const dir = await tempDir();
    const namer = new Namer();
    expect(await namer.take(dir, "jump")).toBe("jump_01");
    await writeFile(path.join(dir, "jump_02.wav"), "x");
    expect(await namer.take(dir, "jump")).toBe("jump_03");
  });
});

describe("names", () => {
  it("makes engine-safe names", () => {
    expect(sanitizeName("Coin Pickup!")).toBe("coin_pickup");
    expect(sanitizeName("onPlayerJump")).toBe("on_player_jump");
    expect(sanitizeName("Café Door #2")).toBe("cafe_door_2");
    expect(sanitizeName("???")).toBe("sound");
  });
});
