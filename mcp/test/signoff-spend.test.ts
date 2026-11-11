import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpendLedger } from "../src/spend.js";
import { tempDir } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("signoff: accounting stays reserved during a successful response", () => {
  it("keeps an in-flight ticket counted while settlement waits behind another reservation", async () => {
    const dir = await tempDir("takebox-signoff-spend-");
    directories.push(dir);
    const file = path.join(dir, "spend.json");
    const ledger = new SpendLedger(file);
    const batch = await ledger.reserve(80, 120);
    expect(batch).not.toBeNull();
    const ticket = await ledger.send(batch!, 80);
    expect(ticket).not.toBeNull();

    const actualRead = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile;
    let entered!: () => void;
    let proceed!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const continued = new Promise<void>((resolve) => { proceed = resolve; });
    let pauseNextLedgerRead = true;
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      if (pauseNextLedgerRead && String(args[0]) === file) {
        pauseNextLedgerRead = false;
        entered();
        // The board's reservation has the real file lock but its read is still
        // pending when the agent receives a successful provider response.
        await Promise.race([continued, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
      return actualRead(...args as Parameters<typeof actualRead>);
    }) as typeof readFile);

    const boardBatch = ledger.reserve(80, 120);
    await reading;
    // settle currently removes the ticket from its process-local running set
    // before taking the lock, so the board's read calls it orphaned and erases it.
    const settled = ledger.settle(batch!, ticket!, 80, "synthetic", "jump");
    proceed();
    const [approved] = await Promise.all([boardBatch, settled]);
    try {
      expect.soft(approved, "the first paid response must still count until its settlement commits").toBeNull();
      if (approved) {
        // makeSounds has no further cap check after reserve; send can now start
        // the board request, and a successful synthetic response is bookable.
        const next = await ledger.send(approved, 80);
        expect(next).not.toBeNull();
        await ledger.settle(approved, next!, 80, "synthetic", "coin");
      }
      expect(await ledger.spentToday(), "both approved successful requests must fit the daily cap").toBeLessThanOrEqual(120);
    } finally {
      if (approved) await ledger.release(approved);
      await ledger.release(batch!);
    }
  });
});
