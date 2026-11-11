import { execFile } from "node:child_process";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../src/lock.js";
import { tempDir } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), rm: vi.fn(actual.rm) };
});

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("recheck: lock ownership after sleep or crash", () => {
  it("does not take a live holder's aged lock while its transaction is still running", async () => {
    const dir = await tempDir("takebox-recheck-lock-");
    dirs.push(dir);
    const file = path.join(dir, "manifest.lock");
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let active = 0;
    let overlap = false;
    const first = withFileLock(file, async () => {
      active++;
      entered();
      await pending;
      active--;
    });
    await ready;
    // Exactly the lock-file state seen after closing a MacBook for over a minute:
    // the pid still lives and the callback has not finished, but mtime is old.
    const beforeSleep = new Date(Date.now() - 61_000);
    await utimes(file, beforeSleep, beforeSleep);
    const second = withFileLock(file, async () => {
      overlap ||= active > 0;
    }, { timeoutMs: 1000 });
    const timer = setTimeout(finish, 100);
    try {
      await Promise.all([first, second]);
      expect(overlap, "age alone does not prove that a live process abandoned its transaction").toBe(false);
    } finally {
      clearTimeout(timer);
      finish();
    }
  });

  it("serializes two waiters reclaiming the same dead-process lock", async () => {
    const dir = await tempDir("takebox-recheck-lock-");
    dirs.push(dir);
    const file = path.join(dir, "spend.json.lock");
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", "console.log(process.pid)"], { env: { PATH: "" } });
    const deadPid = Number(stdout.trim());
    await writeFile(file, `${deadPid} ${Date.now()}`);
    const actualRead = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile;
    const actualRm = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;
    let releaseReads!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let reads = 0;
    let removals = 0;
    // Both waiters observe the abandoned lock before either reclaims it. Delay
    // the second unlink until its peer has acquired the successor lock. Those
    // are ordinary async filesystem interleavings, coordinated to avoid a flaky
    // race test; the real file and pid contents are never fabricated by a mock.
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const value = await actualRead(...args as Parameters<typeof actualRead>);
      if (String(args[0]) === file && reads < 2) {
        reads++;
        if (reads === 2) releaseReads();
        await Promise.race([readGate, delay(100)]);
      }
      return value;
    }) as typeof readFile);
    vi.mocked(rm).mockImplementation(async (...args) => {
      if (String(args[0]) === file && ++removals === 2) {
        await Promise.race([entered, delay(100)]);
      }
      return actualRm(...args);
    });
    let active = 0;
    let overlap = false;
    const transaction = () => withFileLock(file, async () => {
      overlap ||= active > 0;
      active++;
      firstEntered();
      await delay(30);
      active--;
    });
    await Promise.all([transaction(), transaction()]);
    expect(overlap, "a stale observer must not delete a replacement lock acquired by its peer").toBe(false);
  });
});
