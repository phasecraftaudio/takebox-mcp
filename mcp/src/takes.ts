/**
 * Takes, as the board sees them: one card per take, whatever formats it was written in.
 *
 * A take is the files that share a stem — `public/audio/coin_02.ogg` and `coin_02.mp3` are one
 * take. Its id is the stem in base64url, so the board never sends a raw path, and only stems
 * listed in takebox.json resolve: the board can read and change nothing else on the machine.
 *
 * The card is TAKEBOX desktop's own `WaveformCard`; these functions answer the routes it calls.
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { rename } from "node:fs/promises";
import path from "node:path";
import { renderSpan } from "../../shared/dsp/render.js";
import { decodeFile, EXTENSION, FORMATS, type Format } from "./audio/codecs.js";
import type { Audio } from "./audio/pcm.js";
import { processTake, writePieces, type FinishOptions } from "./finish.js";
import type { Context } from "./make.js";
import {
  ensureDir, inside, loadManifest, Namer, ProjectError, REJECTED_DIR, toProjectPath, updateManifest, withSoundLock,
  type Manifest, type SoundRecord, type TakeInfo,
} from "./project.js";

export interface TakeRef {
  /** The sound it belongs to, or null for an audition take. */
  sound: string | null;
  audition: string | null;
  /** Project-relative, no extension. */
  stem: string;
  files: string[];
}

/** What the desktop card expects (`src/types.ts` AudioResult), for a board take. */
export interface CardResult {
  id: string;
  filename: string;
  duration: number;
  sampleRate: number;
  kind: "sfx";
  label: string;
  notice?: string;
  loopable?: boolean;
  disposition?: "new" | "keep" | "reject";
}

export const stemOf = (file: string) => file.replace(/\.[^./]+$/, "");
export const takeId = (stem: string) => Buffer.from(stem, "utf8").toString("base64url");

export function groupTakes(files: readonly string[]): { stem: string; files: string[] }[] {
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const stem = stemOf(file);
    if (!groups.has(stem)) {
      groups.set(stem, []);
      order.push(stem);
    }
    groups.get(stem)!.push(file);
  }
  return order.map((stem) => ({ stem, files: groups.get(stem)! }));
}

export function resolveTake(manifest: Manifest, id: string): TakeRef | null {
  let stem: string;
  try {
    stem = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
  for (const [name, record] of Object.entries(manifest.sounds)) {
    const files = record.files.filter((file) => stemOf(file) === stem);
    if (files.length) return { sound: name, audition: null, stem, files };
  }
  for (const [key, audition] of Object.entries(manifest.auditions ?? {})) {
    const files = audition.files.filter((file) => stemOf(file) === stem);
    if (files.length) return { sound: null, audition: key, stem, files };
  }
  return null;
}

// ── Reading ──────────────────────────────────────────────────────────────────────────

const info = new Map<string, { at: number; size: number; duration: number; sampleRate: number }>();

async function durationOf(file: string): Promise<{ duration: number; sampleRate: number }> {
  const facts = await stat(file);
  const cached = info.get(file);
  if (cached && cached.at === facts.mtimeMs && cached.size === facts.size) return cached;
  const audio = await decodeFile(file);
  const entry = { at: facts.mtimeMs, size: facts.size, duration: (audio.channels[0]?.length ?? 0) / audio.sampleRate, sampleRate: audio.sampleRate };
  info.set(file, entry);
  return entry;
}

export async function cardFor(root: string, take: { stem: string; files: string[] }, label: string, options: { loopable?: boolean; kept?: boolean }): Promise<CardResult | null> {
  const first = path.resolve(root, take.files[0]!);
  try {
    const { duration, sampleRate } = await durationOf(first);
    return {
      id: takeId(take.stem),
      filename: path.basename(first),
      duration,
      sampleRate,
      kind: "sfx",
      label,
      ...(take.files.length > 1 ? { notice: take.files.map((file) => path.extname(file).slice(1)).join(" · ") } : {}),
      ...(options.loopable ? { loopable: true } : {}),
      disposition: options.kept ? "keep" : "new",
    };
  } catch {
    // A file deleted outside TAKEBOX: leave its card out rather than fail the board.
    return null;
  }
}

export const MIME: Record<string, string> = {
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".opus": "audio/ogg",
  ".m4a": "audio/mp4", ".aif": "audio/aiff", ".aiff": "audio/aiff",
};

/** The file a card plays: the first one the browser can play. */
/** The take's file to listen to: one every browser plays first, by this order, not by its place in the list. */
const LISTEN_ORDER = [".wav", ".mp3", ".m4a", ".ogg", ".opus", ".flac"];

export function playable(root: string, take: TakeRef): string {
  for (const ext of LISTEN_ORDER) {
    const file = take.files.find((candidate) => path.extname(candidate).toLowerCase() === ext);
    if (file) return path.resolve(root, file);
  }
  return path.resolve(root, take.files[0]!);
}

// ── Changing ─────────────────────────────────────────────────────────────────────────

/**
 * Change a take under its sound's lock, reading it fresh: the board's view may be older than an
 * agent's re-finish or redo of the same sound (Codex recheck 2026-11-10, R2).
 */
function withTake<T>(ctx: Context, take: TakeRef, run: (manifest: Manifest, take: TakeRef) => Promise<T>): Promise<T> {
  const lock = take.sound ?? `audition-${take.audition}`;
  return withSoundLock(ctx.root, lock, async () => {
    const manifest = await loadManifest(ctx.root);
    const current = resolveTake(manifest, takeId(take.stem));
    if (!current || current.sound !== take.sound || current.audition !== take.audition) {
      throw new ProjectError("That take was just remade or removed. Look at the board again and choose from what is there now.");
    }
    return run(manifest, current);
  });
}

const formatOf = (file: string): Format | null => {
  const ext = path.extname(file).slice(1).toLowerCase();
  return FORMATS.find((format) => EXTENSION[format] === ext) ?? null;
};

function soundFor(manifest: Manifest, take: TakeRef): SoundRecord {
  if (!take.sound) throw new ProjectError("That is a style audition. Pick the style, then make the game's sounds in it.");
  const record = manifest.sounds[take.sound];
  if (!record) throw new ProjectError("That take is no longer in takebox.json.");
  return record;
}

async function appendTakes(ctx: Context, sound: string, files: string[], takes: Record<string, TakeInfo>) {
  const now = new Date().toISOString();
  await updateManifest(ctx.root, (manifest) => {
    const record = manifest.sounds[sound];
    if (!record) return;
    record.files = [...record.files, ...files];
    record.takes = { ...record.takes, ...takes };
    record.updated = now;
  });
}

async function writeNewTakes(ctx: Context, take: TakeRef, record: SoundRecord, audio: Audio, options: Omit<FinishOptions, "formats" | "encode" | "role" | "channels">) {
  const formats = take.files.map(formatOf).filter((f): f is Format => f !== null);
  const finish: FinishOptions = {
    ...options,
    role: record.role,
    channels: "keep",
    formats: formats.length ? formats : ctx.settings.formats.oneShot,
    encode: { quality: ctx.settings.quality, bitDepth: ctx.settings.bitDepth },
  };
  const pieces = processTake(audio, finish, record.role === "music" ? "music" : "sfx");
  const folder = path.dirname(path.resolve(ctx.root, take.files[0]!));
  inside(ctx.root, toProjectPath(ctx.root, folder));
  const written = await writePieces(pieces, folder, take.sound!, finish, new Namer(), ctx.signal);
  const files = written.flatMap((piece) => piece.files.map((file) => toProjectPath(ctx.root, file)));
  // An edit of a take: no original of its own, remade from its file; loopable as it came out.
  const takes = Object.fromEntries(
    written.map((piece) => [stemOf(toProjectPath(ctx.root, piece.files[0]!)), { derived: true, loopable: piece.loopable } satisfies TakeInfo]),
  );
  await appendTakes(ctx, take.sound!, files, takes);
  return {
    written: written.map((piece) => ({
      stem: stemOf(toProjectPath(ctx.root, piece.files[0]!)),
      files: piece.files.map((f) => toProjectPath(ctx.root, f)),
      notice: piece.notices.join(" · "),
      loopable: piece.loopable,
    })),
  };
}

/** Tighten, Split or Make loop on a take: new takes, levelled like the rest of the sound. */
export async function takeTool(ctx: Context, given: Manifest, givenTake: TakeRef, tool: "tighten" | "split" | "loop", preset?: string): Promise<CardResult[]> {
  soundFor(given, givenTake);
  return withTake(ctx, givenTake, (manifest, take) => runTool(ctx, manifest, take, tool, preset));
}

async function runTool(ctx: Context, manifest: Manifest, take: TakeRef, tool: "tighten" | "split" | "loop", preset?: string): Promise<CardResult[]> {
  const record = soundFor(manifest, take);
  const audio = await decodeFile(path.resolve(ctx.root, take.files[0]!), ctx.signal);
  const shape = tool === "tighten" ? "trim" : tool;
  const { written } = await writeNewTakes(ctx, take, record, audio, { shape, level: "role", ...(preset ? { splitPreset: preset } : {}) });
  const cards = await Promise.all(
    written.map(async (piece): Promise<CardResult | null> => {
      const card = await cardFor(ctx.root, piece, piece.stem.split("_").pop() ?? "", { loopable: piece.loopable });
      return card ? { ...card, notice: piece.notice } : null;
    }),
  );
  return cards.filter((card): card is CardResult => card !== null);
}

/** A region of a take, as a new take, with fades only at the cuts. Level is left as it is. */
export async function exportRegion(ctx: Context, given: Manifest, givenTake: TakeRef, start: number, end: number): Promise<CardResult> {
  soundFor(given, givenTake);
  if (!(end > start)) throw new ProjectError("Select a region first.");
  return withTake(ctx, givenTake, (manifest, take) => runRegion(ctx, manifest, take, start, end));
}

async function runRegion(ctx: Context, manifest: Manifest, take: TakeRef, start: number, end: number): Promise<CardResult> {
  const record = soundFor(manifest, take);
  const audio = await decodeFile(path.resolve(ctx.root, take.files[0]!), ctx.signal);
  const length = end - start;
  const channels = renderSpan(audio.channels, audio.sampleRate, { start, end, fadeInS: 0.002, fadeOutS: Math.min(0.01, length * 0.1) });
  const { written } = await writeNewTakes(ctx, take, record, { channels, sampleRate: audio.sampleRate }, { shape: "none", level: "off" });
  const piece = written[0]!;
  const card = await cardFor(ctx.root, piece, piece.stem.split("_").pop() ?? "", {});
  if (!card) throw new ProjectError("The region could not be written.");
  return { ...card, notice: `Region ${start.toFixed(2)}–${end.toFixed(2)} s` };
}

/**
 * Keep marks a take for the AI to wire in. Reject moves its files to .takebox/rejected, out of the
 * game and out of takebox.json, never deleted: a wrong click is one move back.
 */
export async function setDisposition(ctx: Context, givenTake: TakeRef, value: "keep" | "reject") {
  if (value === "keep" && !givenTake.sound) throw new ProjectError("Audition takes are for listening; pick the style instead.");
  await withTake(ctx, givenTake, (_manifest, take) => dispose(ctx, take, value));
}

async function dispose(ctx: Context, take: TakeRef, value: "keep" | "reject") {
  if (value === "keep") {
    await updateManifest(ctx.root, (manifest) => {
      const record = manifest.sounds[take.sound!];
      if (!record) return;
      record.kept = [...new Set([...(record.kept ?? []), take.stem])];
      record.updated = new Date().toISOString();
    });
    return;
  }
  const into = inside(ctx.root, path.join(REJECTED_DIR, take.sound ?? `audition-${take.audition}`));
  await ensureDir(into);
  // Move every file of the take, or none: a move that fails puts back the ones already moved and
  // leaves takebox.json alone, so a take is never hidden while still in the game (finding 12).
  const moved: { from: string; to: string }[] = [];
  try {
    for (const file of take.files) {
      const from = path.resolve(ctx.root, file);
      let to = path.join(into, path.basename(file));
      for (let n = 2; await stat(to).then(() => true, () => false); n++) to = path.join(into, `${path.basename(stemOf(file))}-${n}${path.extname(file)}`);
      await rename(from, to);
      moved.push({ from, to });
    }
  } catch (error) {
    for (const { from, to } of moved.reverse()) await rename(to, from).catch(() => undefined);
    throw new ProjectError(`Could not move ${path.basename(take.files[0]!)} out of the game (${(error as Error).message}); nothing was rejected.`);
  }
  await updateManifest(ctx.root, (manifest) => {
    if (take.sound) {
      const record = manifest.sounds[take.sound];
      if (!record) return;
      record.files = record.files.filter((file) => stemOf(file) !== take.stem);
      record.kept = (record.kept ?? []).filter((stem) => stem !== take.stem);
      if (record.takes) delete record.takes[take.stem];
      record.updated = new Date().toISOString();
    } else if (take.audition && manifest.auditions?.[take.audition]) {
      const audition = manifest.auditions[take.audition]!;
      audition.files = audition.files.filter((file) => stemOf(file) !== take.stem);
    }
  });
}

/** Show a take in Finder / Explorer / the file manager. */
export function reveal(file: string) {
  const command =
    process.platform === "darwin" ? ["open", ["-R", file]]
    : process.platform === "win32" ? ["explorer", [`/select,${file}`]]
    : ["xdg-open", [path.dirname(file)]];
  const child = spawn(command[0] as string, command[1] as string[], { detached: true, stdio: "ignore" });
  // No file manager helper (headless Linux without xdg-open) must not take the server down (finding 20).
  child.on("error", () => undefined);
  child.unref();
}
