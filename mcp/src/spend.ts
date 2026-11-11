/**
 * The spend guard. An agent in a loop can burn a month of credits in minutes; this is what stops
 * it, and the one thing in TAKEBOX the agent cannot talk its way around.
 *
 * Two lines, both set in the MCP config by the person, never by a tool call:
 *   TAKEBOX_DAILY_CREDITS   hard cap per day, across every project on this machine (default 2000)
 *   TAKEBOX_ASK_ABOVE       a batch estimated above this needs the person's yes (default 300)
 *
 * ── Hold, send, settle ───────────────────────────────────────────────────────────────────
 *
 * A batch *holds* its whole estimate before the first paid request, and the cap counts what is
 * spent, held and sent. Two batches started together therefore cannot both pass a cap only one
 * fits (Codex review 2026-11-09, finding 3).
 *
 * Before each paid request the batch moves that request's cost from its hold to a *sent* entry
 * (`send`). A request that fails gives its credits back to the hold (`unsend`); one that succeeds
 * is booked as spent (`settle`). Whatever the batch did not use is let go at the end (`release`).
 *
 * ⚠️ What a sleep, a crash or midnight may and may not undo (Codex rechecks 2026-11-10, R5/R6, S3):
 * - A **hold** is permission to start more requests. In its own process it stands while the batch
 *   runs. Another process drops it when the owner's pid is dead or it has not been renewed for two
 *   hours (a Mac that slept). A dropped hold stops the rest of the queue before it spends.
 * - A **sent** request is money that may already be spent. It counts against the cap until it is
 *   settled or its process is gone, never for age alone — a response that arrives after the Mac
 *   wakes is still paid for. Only a day-old entry from a reused pid is dropped.
 * - Every cost is booked to the day the batch was approved, carried by the batch itself, so a
 *   batch approved at 23:59 counts against the day it was checked against even if its hold is gone.
 *
 * The ledger is one file shared by every TAKEBOX process on the machine — the AI's server and a
 * standalone board alike — and every change happens under a file lock (finding 5).
 *
 * Holds and sent requests count the estimate. A request that succeeded is booked at what the
 * provider says it charged (ElevenLabs' `character-cost` header), or the estimate if it does not
 * say. Each real charge also teaches the estimate (`learn`, `rate`): the published ElevenLabs rate
 * was four times what it charged on 2026-11-10. The cap is an approval budget per day, not the
 * provider's own billing day.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { alive, withFileLock, writeAtomic } from "./lock.js";

export interface SpendLimits {
  dailyCap: number;
  askAbove: number;
}

const DEFAULT_DAILY = 2000;
const DEFAULT_ASK = 300;
/** A hold not renewed for this long, in a process that is not this one, has lost its batch. */
const HOLD_TTL_MS = 2 * 60 * 60 * 1000;
/** A sent request this old belongs to a pid that was reused, not to a request still running. */
const SENT_TTL_MS = 24 * 60 * 60 * 1000;
/** This process, as distinct from an earlier one that had the same pid. */
const PROCESS = randomBytes(8).toString("hex");
/** Holds and sent requests this process made and has not finished. */
const running = new Set<string>();
/**
 * Stop treating an entry as live only after the write that removed it has committed. A read
 * already waiting for the lock would otherwise drop it as orphaned and approve money that is
 * spent (Codex sign-off 2026-11-10, B1). If that write fails, the entry keeps counting until this
 * process exits: closed, not open.
 */
const finished = (id: string) => running.delete(id);

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (/^(off|none|unlimited)$/i.test(value.trim())) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): SpendLimits {
  return {
    dailyCap: readNumber(env.TAKEBOX_DAILY_CREDITS, DEFAULT_DAILY),
    askAbove: readNumber(env.TAKEBOX_ASK_ABOVE, DEFAULT_ASK),
  };
}

interface Owned {
  credits: number;
  /** The day the batch was approved, which its spend is booked to. */
  day: string;
  pid?: number;
  process?: string;
}

interface Hold extends Owned {
  expires: number;
}

interface Sent extends Owned {
  at: number;
}

interface Ledger {
  days: Record<string, number>;
  log: { at: string; credits: number; provider: string; what: string }[];
  /** Batches still allowed to start requests, by id. */
  reservations: Record<string, Hold>;
  /** Paid requests started and not yet settled, by id. */
  sent: Record<string, Sent>;
  /** Per provider, what its last requests really cost per second, newest last. */
  rates: Record<string, number[]>;
}

/** A batch's hold. The day is kept here too, so it survives the ledger entry being dropped. */
export interface Reservation {
  id: string;
  day: string;
}

/** One paid request on its way. */
export interface Ticket {
  id: string;
  credits: number;
}

/** Whether another process's entry has lost its owner: a dead pid, or older than `ttl`. */
function orphaned(entry: Owned, since: number, ttl: number, now: number): boolean {
  if (entry.pid !== undefined && entry.pid !== process.pid && !alive(entry.pid)) return true;
  return since + ttl < now;
}

const holdStands = (id: string, hold: Hold, now: number) =>
  hold.process === PROCESS ? running.has(id) : !orphaned(hold, hold.expires - HOLD_TTL_MS, HOLD_TTL_MS, now);
const sentStands = (id: string, sent: Sent, now: number) =>
  sent.process === PROCESS ? running.has(id) : !orphaned(sent, sent.at, SENT_TTL_MS, now);

export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Spent, held and sent against `day`. */
function committed(ledger: Ledger, day: string): number {
  const held = Object.values(ledger.reservations).filter((r) => r.day === day).reduce((sum, r) => sum + r.credits, 0);
  const sent = Object.values(ledger.sent).filter((r) => r.day === day).reduce((sum, r) => sum + r.credits, 0);
  return (ledger.days[day] ?? 0) + held + sent;
}

const owner = () => ({ pid: process.pid, process: PROCESS });

export class SpendLedger {
  constructor(
    private readonly file = path.join(process.env.TAKEBOX_HOME || path.join(os.homedir(), ".takebox"), "mcp", "spend.json"),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async read(): Promise<Ledger> {
    let parsed: Partial<Ledger> = {};
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<Ledger>;
    } catch {
      // no ledger yet
    }
    const ledger = { days: parsed.days ?? {}, log: parsed.log ?? [], reservations: parsed.reservations ?? {}, sent: parsed.sent ?? {}, rates: parsed.rates ?? {} };
    const now = this.clock().getTime();
    for (const [id, hold] of Object.entries(ledger.reservations)) if (!holdStands(id, hold, now)) delete ledger.reservations[id];
    for (const [id, sent] of Object.entries(ledger.sent)) if (!sentStands(id, sent, now)) delete ledger.sent[id];
    return ledger;
  }

  /** Read, change and write the ledger with no other process in between. */
  private change<T>(edit: (ledger: Ledger) => T): Promise<T> {
    return withFileLock(`${this.file}.lock`, async () => {
      const ledger = await this.read();
      const result = edit(ledger);
      ledger.log = ledger.log.slice(-500);
      const keys = Object.keys(ledger.days).sort();
      for (const key of keys.slice(0, Math.max(0, keys.length - 62))) delete ledger.days[key];
      await writeAtomic(this.file, JSON.stringify(ledger, null, 2));
      return result;
    });
  }

  async spentToday(): Promise<number> {
    return (await this.read()).days[today(this.clock())] ?? 0;
  }

  /** Spent today plus what running batches hold or have sent. */
  async committedToday(): Promise<number> {
    return committed(await this.read(), today(this.clock()));
  }

  /** Hold credits for a batch, or null if spent + held + sent + this would pass the cap. */
  reserve(credits: number, cap: number): Promise<Reservation | null> {
    if (!Number.isFinite(credits) || credits < 0) return Promise.resolve(null);
    return this.change((ledger) => {
      const day = today(this.clock());
      if (committed(ledger, day) + credits > cap) return null;
      const id = randomBytes(8).toString("hex");
      ledger.reservations[id] = { credits, day, expires: this.clock().getTime() + HOLD_TTL_MS, ...owner() };
      running.add(id);
      return { id, day };
    });
  }

  /**
   * Before a paid request: move its cost from the batch's hold to a sent entry, and renew the hold.
   * Null means the batch must not start it — the hold is gone, its credits perhaps someone else's.
   */
  send(reservation: Reservation, credits: number): Promise<Ticket | null> {
    if (!Number.isFinite(credits) || credits < 0) return Promise.resolve(null);
    return this.change((ledger) => {
      const hold = ledger.reservations[reservation.id];
      if (!hold || hold.credits + 1e-6 < credits) return null;
      hold.credits = Math.max(0, hold.credits - credits);
      hold.expires = this.clock().getTime() + HOLD_TTL_MS;
      const id = randomBytes(8).toString("hex");
      ledger.sent[id] = { credits, day: reservation.day, at: this.clock().getTime(), ...owner() };
      running.add(id);
      return { id, credits };
    });
  }

  /** The request failed and cost nothing: its credits go back to the hold, if there still is one. */
  async unsend(reservation: Reservation, ticket: Ticket): Promise<void> {
    await this.change((ledger) => {
      delete ledger.sent[ticket.id];
      const hold = ledger.reservations[reservation.id];
      if (hold) hold.credits += ticket.credits;
    });
    finished(ticket.id);
  }

  /**
   * The request succeeded: book what it really cost to the day the batch was approved. Paid is
   * paid. A charge above what was sent comes out of the batch's hold, so spent + held still
   * matches what the batch was allowed (Codex review 2026-11-10, board/cost finding 1).
   */
  async settle(reservation: Reservation, ticket: Ticket, credits: number, provider: string, what: string): Promise<void> {
    await this.change((ledger) => {
      delete ledger.sent[ticket.id];
      this.add(ledger, credits, provider, what, reservation.day);
      const over = credits - ticket.credits;
      const hold = ledger.reservations[reservation.id];
      if (over > 0 && hold) hold.credits = Math.max(0, hold.credits - over);
    });
    finished(ticket.id);
  }

  /** The batch is over: let go of whatever it did not use. */
  async release(reservation: Reservation): Promise<void> {
    await this.change((ledger) => {
      delete ledger.reservations[reservation.id];
    });
    finished(reservation.id);
  }

  /** The highest per-second rate the provider really charged in its last 20 requests, or null before the first. */
  async rate(provider: string): Promise<number | null> {
    const seen = ((await this.read()).rates[provider] ?? []).filter((value) => Number.isFinite(value) && value > 0);
    return seen.length ? Math.max(...seen) : null;
  }

  /** Remember what one request really cost per second. */
  learn(provider: string, perSecond: number): Promise<void> {
    if (!Number.isFinite(perSecond) || perSecond <= 0) return Promise.resolve();
    return this.change((ledger) => {
      ledger.rates[provider] = [...(ledger.rates[provider] ?? []), perSecond].slice(-20);
    });
  }

  /** Record spend that was not reserved (kept for callers outside a batch). */
  record(credits: number, provider: string, what: string): Promise<void> {
    return this.change((ledger) => this.add(ledger, credits, provider, what));
  }

  private add(ledger: Ledger, credits: number, provider: string, what: string, day = today(this.clock())) {
    if (!Number.isFinite(credits) || credits < 0) throw new Error(`Refusing to record a cost of ${credits}.`);
    ledger.days[day] = (ledger.days[day] ?? 0) + credits;
    ledger.log.push({ at: this.clock().toISOString(), credits, provider, what });
  }
}

export type SpendDecision =
  | { ok: true }
  | { ok: false; reason: "cap"; message: string }
  | { ok: false; reason: "confirm"; message: string };

export function checkSpend(estimate: number, spent: number, limits: SpendLimits, confirmed: number | undefined): SpendDecision {
  // Fail closed: a cost that is not a number can never be under a cap.
  if (!Number.isFinite(estimate) || estimate < 0 || !Number.isFinite(spent)) {
    return { ok: false, reason: "cap", message: "The cost of this batch could not be worked out, so nothing was made. Check every duration and variation count is a number." };
  }
  if (spent + estimate > limits.dailyCap) {
    return {
      ok: false,
      reason: "cap",
      message:
        `This batch is about ${estimate} credits and ${spent} are spent or running today; the daily cap is ${limits.dailyCap}. ` +
        `Make fewer sounds or variations, shorten durations, or the person can raise TAKEBOX_DAILY_CREDITS in the MCP config.`,
    };
  }
  if (estimate > limits.askAbove && (confirmed ?? 0) < estimate) {
    return {
      ok: false,
      reason: "confirm",
      message:
        `This batch is about ${estimate} credits (asks above ${limits.askAbove}). Show the person the list and the cost, ` +
        `and only if they say yes, call make_sounds again with confirm_credits: ${estimate}.`,
    };
  }
  return { ok: true };
}
