import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { startBoard, type Board } from "../src/board/http.js";
import { loadManifest, updateManifest } from "../src/project.js";
import { createServices } from "../src/services.js";
import { SpendLedger } from "../src/spend.js";
import { burst, concat, silence, tempDir } from "./helpers.js";

// Ryu, 11-10: tick several sounds on the board and make new takes of all of them with one yes.

const boards: Board[] = [];
const directories: string[] = [];
afterEach(async () => {
  while (boards.length) await boards.pop()!.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await tempDir("takebox-redo-many-");
  const home = await tempDir("takebox-redo-many-ledger-");
  directories.push(root, home);
  await writeFile(path.join(root, "package.json"), "{}");
  const now = new Date().toISOString();
  await updateManifest(root, (manifest) => {
    manifest.settings = { formats: { oneShot: ["wav"], loop: ["wav"] } };
    manifest.sounds.coin = { kind: "one-shot", role: "sfx", source: "generated", prompt: "A soft wooden coin.", durationS: 1, files: [], created: now, updated: now };
    manifest.sounds.hit = { kind: "one-shot", role: "impact", source: "generated", prompt: "A dull hit.", durationS: 0.5, files: [], created: now, updated: now };
    manifest.sounds.step = { kind: "one-shot", role: "foley", source: "file", files: [], created: now, updated: now };
  });
  const prompts: string[] = [];
  const services = createServices({
    env: { ELEVENLABS_API_KEY: "test-placeholder" },
    ledger: new SpendLedger(path.join(home, "spend.json")),
    fetch: (async (_url: string, init: RequestInit) => {
      prompts.push((JSON.parse(String(init.body)) as { text: string }).text);
      return new Response(encodeWav([concat(silence(0.05), burst(0.4, 0.3, 0.04), silence(0.1))], 48000, 16), { headers: { "character-cost": "7" } });
    }) as unknown as typeof fetch,
  });
  const board = await startBoard(services, root, { open: false });
  boards.push(board);
  const post = (route: string, body: unknown) =>
    fetch(new URL(route, board.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { root, services, post, prompts };
}

const both = { sounds: [{ name: "coin", variations: 2 }, { name: "hit", prompt: "A heavier, duller hit." }] };

describe("board: new takes of several sounds with one yes", () => {
  it("prices the ticked sounds together, and spends nothing without the yes", async () => {
    const { post, prompts, services } = await fixture();
    const priced = (await (await post("/api/redo-many", { ...both, dry_run: true })).json()) as { estimate_credits: number; sounds: { name: string }[] };
    expect(priced.sounds.map((s) => s.name)).toEqual(["coin", "hit"]);
    expect(priced.estimate_credits).toBe(2 * 40 + 20); // published rate: nothing charged on this machine yet

    const unconfirmed = (await (await post("/api/redo-many", both)).json()) as { status: string };
    expect(unconfirmed.status).toBe("needs_confirmation");
    expect(prompts).toEqual([]);
    expect(await services.ledger.spentToday()).toBe(0);
  });

  it("makes every ticked sound, each from its own prompt and take count, after one confirmation", async () => {
    const { post, prompts, root, services } = await fixture();
    const result = (await (await post("/api/redo-many", { ...both, confirm_credits: 100 })).json()) as { status: string; credits_used: number };
    expect(result.status).toBe("made");
    expect(prompts.filter((p) => p.startsWith("A soft wooden coin."))).toHaveLength(2);
    expect(prompts.filter((p) => p.startsWith("A heavier, duller hit."))).toHaveLength(1);
    expect(result.credits_used).toBe(21); // three takes at the 7 the provider said it charged
    expect(await services.ledger.spentToday()).toBe(21);
    const sounds = (await loadManifest(root)).sounds;
    expect(sounds.coin!.files).toHaveLength(2);
    expect(sounds.hit!.files).toHaveLength(1);
  });

  it("refuses the whole batch, spending nothing, if a ticked sound has no prompt", async () => {
    const { post, prompts, services } = await fixture();
    const response = await post("/api/redo-many", { sounds: [{ name: "coin" }, { name: "step" }], confirm_credits: 100 });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/step came from a file/);
    expect(prompts).toEqual([]);
    expect(await services.ledger.spentToday()).toBe(0);
  });
});
