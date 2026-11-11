import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { startBoard, type Board } from "../src/board/http.js";
import { loadManifest } from "../src/project.js";
import { createServer } from "../src/server.js";
import { createServices } from "../src/services.js";
import { SpendLedger } from "../src/spend.js";
import { auditionSpecs, resolveStyle, STYLE_PRESETS } from "../src/styles.js";
import { burst, concat, silence, tempDir } from "./helpers.js";

const boards: Board[] = [];
afterEach(async () => {
  while (boards.length) await boards.pop()!.close();
});

async function setup() {
  const root = await tempDir("takebox-board-");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "moss-hop" }));
  await writeFile(path.join(root, "game.js"), "function onJump() {}\nfunction collectCoin() {}\n");
  const home = await tempDir("takebox-home-");
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return new Response(encodeWav([concat(silence(0.12), burst(0.5, 0.3, 0.06, calls), silence(1))], 48000, 16), { status: 200 });
  }) as unknown as typeof fetch;
  const services = createServices({ env: { ELEVENLABS_API_KEY: "sk_test" }, fetch: fake, ledger: new SpendLedger(path.join(home, "spend.json")) });
  const board = await startBoard(services, root, { open: false });
  boards.push(board);
  const get = async (route: string, headers: Record<string, string> = {}) => fetch(new URL(route, board.url), { headers });
  const post = async <T = Record<string, unknown>>(route: string, body: unknown) => {
    const response = await fetch(new URL(route, board.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: (await response.json()) as T };
  };
  return { root, board, get, post, calls: () => calls };
}

type BoardJson = {
  sounds: { name: string; kept: number; takes: { id: string; filename: string; duration: number; disposition: string }[] }[];
  auditions: { key: string; chosen: boolean; takes: { id: string }[] }[];
  styles: unknown[];
  settings: { direction: string };
};

describe("the sound board server", () => {
  it("serves the board state and the built page", async () => {
    const { get } = await setup();
    const state = (await (await get("/api/board")).json()) as BoardJson & { name: string };
    expect(state.name).toBe("moss-hop");
    expect(state.sounds).toEqual([]);
    expect(state.styles).toHaveLength(STYLE_PRESETS.length);
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/<div id="root">|board page has not been built/);
  });

  it("refuses a foreign Host, a non-JSON post, unknown takes and path escapes", async () => {
    const { board, get } = await setup();
    const port = new URL(board.url).port;
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/api/board", headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(403);
    const form = await fetch(new URL("/api/make", board.url), { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
    expect((await get(`/api/audio/${Buffer.from("../../etc/passwd").toString("base64url")}`)).status).toBe(404);
    expect((await get("/..%2f..%2fpackage.json")).status).toBe(404);
  });

  it("prices, makes, plays, measures, trims, exports, keeps and rejects", async () => {
    const { root, get, post } = await setup();
    const sounds = [{ name: "jump", prompt: "A light springy jump.", duration_s: 1, variations: 2 }];
    expect((await post("/api/make", { sounds, dry_run: true })).data).toMatchObject({ status: "estimate", estimate_credits: 80 });
    expect((await post("/api/make", { sounds, confirm_credits: 80 })).data).toMatchObject({ status: "made" });

    let state = (await (await get("/api/board")).json()) as BoardJson;
    const takes = state.sounds[0]!.takes;
    expect(takes.map((t) => t.filename)).toEqual(["jump_01.ogg", "jump_02.ogg"]);

    const whole = await get(`/api/audio/${takes[0]!.id}`);
    expect(whole.status).toBe(200);
    // An OGG take is played from a WAV copy: Safari cannot play Ogg Vorbis (listening pass, 11-10).
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await whole.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("RIFF");
    const part = await get(`/api/audio/${takes[0]!.id}`, { Range: "bytes=0-99" });
    expect(part.status).toBe(206);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const loud = (await (await get(`/api/audio/${takes[0]!.id}/loudness`)).json()) as { loudness: { momentaryMax: number } };
    expect(loud.loudness.momentaryMax).toBeLessThan(-10);

    const looped = await post<{ results: { filename: string; loopable?: boolean }[] }>(`/api/audio/${takes[0]!.id}/tighten`, {});
    expect(looped.data.results[0]!.filename).toBe("jump_03.ogg");
    const region = await post<{ result: { filename: string } }>(`/api/audio/${takes[0]!.id}/export`, { start: 0, end: 0.2 });
    expect(region.data.result.filename).toBe("jump_04.ogg");

    await post(`/api/audio/${takes[1]!.id}/disposition`, { value: "keep" });
    await post(`/api/audio/${takes[0]!.id}/disposition`, { value: "reject" });
    state = (await (await get("/api/board")).json()) as BoardJson;
    expect(state.sounds[0]!.kept).toBe(1);
    expect(state.sounds[0]!.takes.map((t) => t.filename)).toEqual(["jump_02.ogg", "jump_03.ogg", "jump_04.ogg"]);
    expect(state.sounds[0]!.takes[0]!.disposition).toBe("keep");
    expect(existsSync(path.join(root, "audio/jump_01.ogg"))).toBe(false);
    expect(await readdir(path.join(root, ".takebox/rejected/jump"))).toEqual(["jump_01.ogg"]);
    expect((await loadManifest(root)).sounds.jump!.kept).toEqual(["audio/jump_02"]);
  });

  it("redoes a sound with an edited prompt, asking first", async () => {
    const { get, post, calls } = await setup();
    await post("/api/make", { sounds: [{ name: "coin", prompt: "A coin.", duration_s: 1 }], confirm_credits: 40 });
    const priced = await post("/api/redo", { name: "coin", prompt: "A softer wooden coin.", variations: 2, dry_run: true });
    expect(priced.data).toMatchObject({ status: "estimate", estimate_credits: 80 });
    expect(calls()).toBe(1);
    await post("/api/redo", { name: "coin", prompt: "A softer wooden coin.", variations: 2, confirm_credits: 80 });
    const state = (await (await get("/api/board")).json()) as BoardJson;
    expect(state.sounds[0]!.takes).toHaveLength(3);
  });

  it("auditions styles side by side, outside the game, and sets the chosen direction", async () => {
    const { root, get, post } = await setup();
    const priced = await post<{ estimate_credits: number }>("/api/audition", { styles: ["cozy-wooden", "chiptune"], dry_run: true });
    const made = await post<{ status: string }>("/api/audition", { styles: ["cozy-wooden", "chiptune"], confirm_credits: priced.data.estimate_credits });
    expect(made.data.status).toBe("made");
    let state = (await (await get("/api/board")).json()) as BoardJson;
    expect(state.auditions.map((a) => a.key)).toEqual(["cozy-wooden", "chiptune"]);
    expect(state.auditions[0]!.takes).toHaveLength(3);
    expect(state.sounds).toEqual([]);
    expect(existsSync(path.join(root, ".takebox/auditions/cozy-wooden"))).toBe(true);
    expect(existsSync(path.join(root, "audio"))).toBe(false);

    // Audition takes are for listening: they cannot be kept.
    const keep = await post(`/api/audio/${state.auditions[0]!.takes[0]!.id}/disposition`, { value: "keep" });
    expect(keep.status).toBe(400);

    await post("/api/direction", { direction: resolveStyle("chiptune").direction });
    state = (await (await get("/api/board")).json()) as BoardJson;
    expect(state.auditions.find((a) => a.key === "chiptune")!.chosen).toBe(true);
    expect(state.settings.direction).toBe("bright 8-bit chiptune, square waves");
  });

  it("reads the plan from the game", async () => {
    const { get } = await setup();
    const plan = (await (await get("/api/plan")).json()) as { cues: { cue: string }[] };
    expect(plan.cues.map((c) => c.cue)).toEqual(expect.arrayContaining(["jump", "coin_pickup"]));
  });
});

describe("styles", () => {
  it("auditions three sounds per style, retro templates for a retro direction", () => {
    expect(auditionSpecs("soft wooden toy-like").map((s) => s.name)).toEqual(["jump", "coin", "hit"]);
    expect(auditionSpecs("soft wooden toy-like")[0]!.prompt).toMatch(/soft wooden toy-like/);
    expect(auditionSpecs("bright 8-bit chiptune")[0]!.prompt).toMatch(/8-bit/);
    expect(resolveStyle("squishy slime and bubbles")).toEqual({ key: "squishy-slime-and-bubbles", label: "squishy slime and bubbles", direction: "squishy slime and bubbles" });
  });
});

describe("open_board over MCP", () => {
  it("starts one board per project and hands back its address", async () => {
    const root = await tempDir("takebox-board-");
    await writeFile(path.join(root, "package.json"), "{}");
    const home = await tempDir("takebox-home-");
    const server = createServer({ env: { TAKEBOX_PROJECT: root }, ledger: new SpendLedger(path.join(home, "s.json")), openBrowser: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(b), client.connect(a)]);
    const first = JSON.parse(((await client.callTool({ name: "open_board", arguments: {} })) as { content: { text: string }[] }).content[0]!.text);
    const second = JSON.parse(((await client.callTool({ name: "open_board", arguments: {} })) as { content: { text: string }[] }).content[0]!.text);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(second.url).toBe(first.url);
    const state = (await (await fetch(new URL("/api/board", first.url))).json()) as { provider: string | null };
    expect(state.provider).toBeNull();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["open_board", "audition_styles"]));
  });
});
