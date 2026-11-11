import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { startBoard, type Board } from "../src/board/http.js";
import { updateManifest } from "../src/project.js";
import { createServices } from "../src/services.js";
import { SpendLedger } from "../src/spend.js";
import { burst, tempDir } from "./helpers.js";

const boards: Board[] = [];
const directories: string[] = [];
afterEach(async () => {
  while (boards.length) await boards.pop()!.close();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("review: actual cost rises above the approved estimate", () => {
  it("stops queued takes once higher real charges would exceed the approved amount and cap", async () => {
    const root = await tempDir("takebox-review-cost-cap-");
    const home = await tempDir("takebox-review-cost-state-");
    directories.push(root, home);
    await writeFile(path.join(root, "package.json"), "{}");
    await updateManifest(root, (manifest) => {
      manifest.settings = { formats: { oneShot: ["wav"], loop: ["wav"] } };
      for (const name of ["coin", "hit"]) manifest.sounds[name] = {
        kind: "one-shot", role: "sfx", source: "generated", prompt: `A dry ${name}.`,
        durationS: 0.5, files: [], created: "test", updated: "test",
      };
    });
    const ledger = new SpendLedger(path.join(home, "spend.json"));
    await ledger.learn("elevenlabs", 10); // Ryu's observed rate, before this batch.
    let calls = 0;
    const services = createServices({
      env: { ELEVENLABS_API_KEY: "review-placeholder", TAKEBOX_DAILY_CREDITS: "50" }, ledger,
      fetch: (async () => {
        calls++;
        // A later response charges the published 40 credits/s: 20 for 0.5 s.
        // No real provider traffic and no unusual audio are needed.
        return new Response(encodeWav([burst(0.5, 0.2, 0.05)], 48000, 16), { headers: { "character-cost": "20" } });
      }) as typeof fetch,
    });
    const board = await startBoard(services, root, { open: false });
    boards.push(board);
    const post = async (body: unknown) => {
      const response = await fetch(new URL("/api/redo-many", board.url), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return await response.json() as { estimate_credits: number; credits_used?: number };
    };
    const batch = { sounds: [{ name: "coin", variations: 4 }, { name: "hit", variations: 4 }] };
    const estimate = await post({ ...batch, dry_run: true });
    expect(estimate.estimate_credits).toBe(48); // eight × ceil(0.5 × 10 × 1.1)
    expect(calls).toBe(0);
    await post({ ...batch, confirm_credits: estimate.estimate_credits });

    // Two already-in-flight surprises can total 40 and still fit the agreed48/cap50.
    // Starting the remaining queue after observing that price is avoidable overspend.
    expect.soft(calls, "do not keep sending from a stale per-take estimate after a higher real charge is known").toBeLessThanOrEqual(2);
    expect(await ledger.spentToday(), "record actual charges honestly while preventing further avoidable spend").toBeLessThanOrEqual(50);
  });
});
