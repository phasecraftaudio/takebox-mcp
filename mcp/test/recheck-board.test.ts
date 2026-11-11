import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { startBoard, type Board } from "../src/board/http.js";
import { finishSounds } from "../src/make.js";
import { loadManifest, updateManifest } from "../src/project.js";
import { contextFor, createServices } from "../src/services.js";
import { SpendLedger } from "../src/spend.js";
import { takeId } from "../src/takes.js";
import { noise, tempDir } from "./helpers.js";

const directories: string[] = [];
const boards: Board[] = [];
afterEach(async () => {
  while (boards.length) await boards.pop()!.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("recheck: actual loop metadata survives free format changes", () => {
  it("preserves a successful board Make loop take when re-finishing the sound into another format", async () => {
    const root = await tempDir("takebox-recheck-loop-");
    const home = await tempDir("takebox-recheck-loop-ledger-");
    directories.push(root, home);
    await writeFile(path.join(root, "package.json"), "{}");
    await mkdir(path.join(root, "audio"));
    const file = "audio/forest_01.wav";
    const original = ".takebox/originals/forest/forest_take_01.wav";
    const audio = encodeWav([noise(16, 0.1)], 48000, 24);
    await mkdir(path.dirname(path.join(root, original)), { recursive: true });
    await writeFile(path.join(root, file), audio);
    await writeFile(path.join(root, original), audio);
    await updateManifest(root, (manifest) => {
      manifest.settings = { formats: { oneShot: ["wav"], loop: ["wav"] } };
      manifest.sounds.forest = {
        kind: "one-shot", role: "ambience", source: "generated", files: [file], originals: [original],
        takes: { "audio/forest_01": { original, loopable: false } },
        created: new Date().toISOString(), updated: new Date().toISOString(),
      };
    });
    // No provider/key: all work is local processing of synthetic audio.
    const services = createServices({ env: {}, ledger: new SpendLedger(path.join(home, "spend.json")) });
    const board = await startBoard(services, root, { open: false });
    boards.push(board);
    const loop = await fetch(new URL(`/api/audio/${takeId("audio/forest_01")}/loop`, board.url), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(loop.status).toBe(200);
    const made = await loop.json() as { results: { loopable?: boolean }[] };
    expect(made.results[0]!.loopable).toBe(true);
    const before = (await loadManifest(root)).sounds.forest!;
    expect(Object.values(before.takes!).filter((take) => take.loopable)).toHaveLength(1);

    const ctx = await contextFor(services, root);
    const result = await finishSounds(ctx, { names: ["forest"], formats: ["aiff"] }, { forest: before });
    expect(result.sounds[0]!.errors).toBeUndefined();
    const after = (await loadManifest(root)).sounds.forest!;
    expect(after.files.every((name) => name.endsWith(".aif"))).toBe(true);
    // Changing the container should retain which actual take is a seamless loop,
    // including a loop created from a sound whose overall kind is one-shot.
    expect.soft(Object.values(after.takes!).filter((take) => take.loopable)).toHaveLength(1);
    const state = await (await fetch(new URL("/api/board", board.url))).json() as { sounds: { takes: { loopable?: boolean }[] }[] };
    expect(state.sounds[0]!.takes.filter((take) => take.loopable)).toHaveLength(1);
  });
});
