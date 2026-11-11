/**
 * Locks and writes that hold across processes.
 *
 * Two TAKEBOX processes can work on one machine at once: the AI's MCP server and a standalone
 * board, or two AI clients. A lock that lives in one process's memory protects nothing then
 * (Codex review 2026-11-09, findings 5 and 6). These use the filesystem:
 *
 * - `withFileLock`: an exclusive-create lock file (`open(…, "wx")`), so exactly one process holds
 *   it. The file says who holds it: `<pid> <token> <time>`, the token unique to that one hold.
 * - `writeAtomic`: write to a name no other writer can share, then rename over the target.
 *
 * ⚠️ Taking a lock from its holder (Codex recheck 2026-11-10, R7):
 * - Never from a live process, however old the lock. A Mac that sleeps for an hour mid-write
 *   leaves an old lock whose holder is still running; taking it gave two owners.
 * - From a dead process, one taker at a time (a short `.reclaim` lock), and only if the file still
 *   holds the dead holder's token — so a slow taker can never delete the lock its peer just made.
 * - A holder removes the lock only while it still holds its own token.
 * - The same pid as this process with a token this process does not hold is a previous process
 *   that had the same pid and crashed: its lock is taken like a dead one.
 * - An empty lock or guard older than 10 s is a holder that died between creating and naming it.
 * - The wait's timeout holds on every path, recovery included.
 */

import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
}

/** Writing the holder's name takes microseconds; an empty lock this old lost its holder. */
const UNNAMED_STALE_MS = 10_000;

/** Tokens of the locks this process holds right now. */
const held = new Set<string>();

/** A lock file whose holder is gone: a dead pid, or this pid with a token this process never made. */
function abandoned(text: string): boolean {
  const [pidText, token] = text.split(" ");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !token) return false;
  if (pid === process.pid) return !held.has(token);
  return !alive(pid);
}

/** Exclusive create; true if this call made it. */
async function create(file: string, text: string): Promise<boolean> {
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(text);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await mkdir(path.dirname(file), { recursive: true });
      return create(file, text);
    }
    if (code === "EEXIST") return false;
    throw error;
  }
}

const readText = (file: string) => readFile(file, "utf8").catch(() => null);

/** Holder gone: named and dead, or never named and older than a name takes to write. */
async function lost(file: string, text: string): Promise<boolean> {
  if (text !== "") return abandoned(text);
  const facts = await stat(file).catch(() => null);
  return facts !== null && Date.now() - facts.mtimeMs > UNNAMED_STALE_MS;
}

/** Remove a lock whose holder died, if it is still that holder's — one taker at a time. */
async function reclaim(lockPath: string, seen: string) {
  const guard = `${lockPath}.reclaim`;
  const token = randomBytes(8).toString("hex");
  if (!(await create(guard, `${process.pid} ${token} ${Date.now()}`))) {
    // Another taker is at it. A taker that died mid-reclaim leaves its guard, named or empty
    // (recheck S4): clear it if so.
    const other = await readText(guard);
    if (other !== null && (await lost(guard, other)) && (await readText(guard)) === other) await rm(guard, { force: true });
    return;
  }
  held.add(token);
  try {
    if ((await readText(lockPath)) === seen) await rm(lockPath, { force: true });
  } finally {
    held.delete(token);
    await rm(guard, { force: true });
  }
}

export async function withFileLock<T>(lockPath: string, run: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeout = options.timeoutMs ?? 20_000;
  const started = Date.now();
  const token = randomBytes(8).toString("hex");
  const mine = `${process.pid} ${token} ${Date.now()}`;
  let wait = 4;
  for (;;) {
    // Marked held before the file exists, so a peer in this process that reads it at once never
    // takes it for a crashed process's lock.
    held.add(token);
    if (await create(lockPath, mine)) break;
    held.delete(token);
    // Null: released between our attempt and the look. Lost: its holder is gone, take it back.
    const text = await readText(lockPath);
    const retryNow = text === null || (await lost(lockPath, text));
    if (text !== null && retryNow) await reclaim(lockPath, text);
    // The timeout holds on every path, a stuck recovery included (recheck S4).
    if (Date.now() - started > timeout) {
      throw new Error(`Another TAKEBOX is holding ${path.basename(lockPath)} and has not let go. If no TAKEBOX is running, delete ${lockPath}.`);
    }
    if (retryNow) continue;
    await sleep(wait);
    wait = Math.min(100, wait * 2);
  }
  try {
    return await run();
  } finally {
    // Only our own lock: never one a later holder made.
    if ((await readText(lockPath)) === mine) await rm(lockPath, { force: true });
    held.delete(token);
  }
}

/** A temporary name no other writer, in this process or another, will pick. */
export const workingName = (file: string) => `${file}.${process.pid}.${randomBytes(4).toString("hex")}.part`;

export async function writeAtomic(file: string, data: string | Uint8Array, mode = 0o644) {
  const working = workingName(file);
  try {
    await writeFile(working, data, { mode });
    await rename(working, file);
  } catch (error) {
    await rm(working, { force: true });
    throw error;
  }
}
