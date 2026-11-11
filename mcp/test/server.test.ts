import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { createServer } from "../src/server.js";
import { SpendLedger } from "../src/spend.js";
import { burst, concat, silence, tempDir } from "./helpers.js";

async function connect(env: Record<string, string>, fetchImpl?: typeof fetch) {
  const home = await tempDir("takebox-home-");
  const server = createServer({ env, ledger: new SpendLedger(path.join(home, "spend.json")), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = result.content[0]!.text;
    return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
  };
  return { client, call };
}

async function webGame() {
  const root = await tempDir("takebox-game-");
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(root, "game.js"), "function onJump() {}\nfunction collectCoin() {}\n");
  return root;
}

describe("the MCP server", () => {
  it("lists eight tools, the guide and the sound pass", async () => {
    const { client } = await connect({});
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["analyze_sounds", "audition_styles", "finish_sounds", "make_sounds", "open_board", "plan_sounds", "search_sounds", "setup"]);
    const guide = await client.readResource({ uri: "takebox://guide" });
    expect((guide.contents[0] as { text: string }).text).toMatch(/Frequency decides everything/);
    const prompt = await client.getPrompt({ name: "sound_pass" });
    expect(JSON.stringify(prompt.messages)).toMatch(/plan_sounds/);
  });

  it("sets up a web game, saves a direction and refuses an unwritable format", async () => {
    const root = await webGame();
    const { call } = await connect({ TAKEBOX_PROJECT: root });
    const first = await call("setup");
    expect(first.data).toMatchObject({ project: root, engine: { using: "web" }, settings: { folder: "audio", one_shot_formats: ["ogg"] } });
    expect(String(first.data.provider)).toMatch(/no ELEVENLABS_API_KEY/);

    const set = await call("setup", { set: { direction: "soft wooden toy-like", one_shot_formats: ["ogg", "mp3"] } });
    expect(set.data.settings).toMatchObject({ direction: "soft wooden toy-like", one_shot_formats: ["ogg", "mp3"] });
    expect(JSON.parse(await readFile(path.join(root, "takebox.json"), "utf8")).settings.direction).toBe("soft wooden toy-like");
    // Changing only the direction must not pin the engine's format defaults into takebox.json.
    const fresh = await webGame();
    const second = await connect({ TAKEBOX_PROJECT: fresh });
    await second.call("setup", { set: { direction: "glass" } });
    expect(JSON.parse(await readFile(path.join(fresh, "takebox.json"), "utf8")).settings.formats).toBeUndefined();

    const bad = await call("setup", { set: { one_shot_formats: ["opus"] } });
    if (bad.isError) expect(bad.text).toMatch(/cannot write opus/);
  });

  it("refuses to treat the home folder as a game", async () => {
    const { call } = await connect({ TAKEBOX_PROJECT: os.homedir() });
    const result = await call("plan_sounds");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a game project/);
  });

  it("plans from the code, in the saved direction, with the guide", async () => {
    const root = await webGame();
    const { call } = await connect({ TAKEBOX_PROJECT: root });
    await call("setup", { set: { direction: "glassy crystal" } });
    const plan = await call("plan_sounds");
    const cues = plan.data.moments_found.map((m: { cue: string }) => m.cue);
    expect(cues).toEqual(expect.arrayContaining(["jump", "coin_pickup"]));
    expect(plan.data.moments_found[0].draft.prompt).toMatch(/glassy crystal/);
    expect(plan.data.guide).toMatch(/One direction for the whole game/);
  });

  it("estimates, asks, then makes through the real ElevenLabs adapter against a mocked API", async () => {
    const root = await webGame();
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return new Response(encodeWav([concat(silence(0.1), burst(0.4, 0.3, 0.05, calls), silence(1))], 48000, 16), { status: 200 });
    }) as unknown as typeof fetch;
    const { call } = await connect({ TAKEBOX_PROJECT: root, ELEVENLABS_API_KEY: "sk_test", TAKEBOX_ASK_ABOVE: "100" }, fake);
    const sounds = [{ name: "jump", prompt: "A light springy jump for a video game, close-up and dry.", duration_s: 1, variations: 3 }];

    expect((await call("make_sounds", { sounds, dry_run: true })).data).toMatchObject({ status: "estimate", estimate_credits: 120 });
    expect((await call("make_sounds", { sounds })).data).toMatchObject({ status: "needs_confirmation" });
    expect(calls).toBe(0);
    const made = await call("make_sounds", { sounds, confirm_credits: 120 });
    expect(made.data).toMatchObject({ status: "made", credits_used: 120 });
    expect(made.data.sounds[0].files).toEqual(["audio/jump_01.ogg", "audio/jump_02.ogg", "audio/jump_03.ogg"]);
    expect(calls).toBe(3);

    const analysis = await call("analyze_sounds", { all: true });
    expect(analysis.data.files).toHaveLength(3);
    expect(analysis.data.files[0].headSilenceS).toBeLessThan(0.01);

    const found = await call("search_sounds", { query: "springy jump" });
    expect(found.data.hits[0]).toMatchObject({ where: "made", name: "jump" });

    const refinished = await call("finish_sounds", { names: ["jump"], formats: ["wav"], level: -16 });
    expect(refinished.data.sounds[0].files).toEqual(["audio/jump_01.wav", "audio/jump_02.wav", "audio/jump_03.wav"]);
    expect(calls).toBe(3);
  });
});
