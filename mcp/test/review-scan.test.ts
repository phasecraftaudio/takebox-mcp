import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProject } from "../src/scan.js";
import { tempDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("review: planning a real game folder", () => {
  it("does not exhaust its source-file budget on a Unity art folder before reading game scripts", async () => {
    const root = await tempDir("takebox-review-scan-");
    dirs.push(root);
    const art = path.join(root, "Assets", "Art");
    const scripts = path.join(root, "Assets", "Scripts");
    await mkdir(art, { recursive: true });
    await mkdir(scripts);
    await writeFile(path.join(scripts, "Player.cs"), "class Player { void OnJump() { } }");
    // An ordinary art-heavy game can have many thousands of .meta files. These
    // contain no audio or source and need no real game assets in the fixture.
    for (let start = 0; start < 3000; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(art, `texture_${start + i}.png.meta`), "")));
    }

    const scan = await scanProject(root);
    expect({ filesScanned: scan.filesScanned, cues: scan.cues.map((cue) => cue.cue), truncated: scan.truncated })
      .toEqual({ filesScanned: 1, cues: ["jump"], truncated: false });
  });

  it("does not propose a magic spell for a physics ray cast", async () => {
    const root = await tempDir("takebox-review-scan-");
    dirs.push(root);
    await writeFile(path.join(root, "collision.ts"), [
      'import RAPIER from "@dimforge/rapier3d";',
      "const ray = new RAPIER.Ray(origin, direction);",
      "const collision = world.castRay(ray, 100, true);",
    ].join("\n"));

    const scan = await scanProject(root);
    expect(scan.cues.map((cue) => cue.cue)).not.toContain("spell_cast");
  });
});
