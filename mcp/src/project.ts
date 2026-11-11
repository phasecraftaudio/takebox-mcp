/**
 * The game project TAKEBOX is working in: where it is, what engine it uses, where sounds go, what
 * format they take, and `takebox.json`, the list of every sound TAKEBOX has made or brought in.
 *
 * `takebox.json` is for the AI as much as for the person: it says which file is which sound, so
 * the agent can wire `coin_pickup_02.ogg` into the code without guessing, and it records the
 * settings so the next session sounds like this one.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock, writeAtomic } from "./lock.js";
import { AUDIO_EXTENSIONS, FORMATS, QUALITIES, type Format, type Quality } from "./audio/codecs.js";
import type { Role } from "./audio/level.js";
import type { WavDepth } from "./audio/pcm.js";

export const ENGINES = ["web", "godot", "unity", "unreal", "other"] as const;
export type Engine = (typeof ENGINES)[number];
export const KINDS = ["one-shot", "sequence", "loop"] as const;
export type Kind = (typeof KINDS)[number];
export const CHANNEL_MODES = ["keep", "mono", "stereo"] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

export interface Settings {
  engine: Engine;
  /** Relative to the project root. */
  folder: string;
  formats: { oneShot: Format[]; loop: Format[] };
  /** The game's sound direction: one line of material and character every prompt shares. */
  direction: string;
  quality: Quality;
  bitDepth: WavDepth;
  channels: ChannelMode;
}

export interface SoundRecord {
  kind: Kind;
  role: Role;
  source: "generated" | "file";
  prompt?: string;
  provider?: string;
  /** Where a brought-in file came from. */
  from?: string[];
  /** Finished files, relative to the project root. */
  files: string[];
  /** Generated originals, kept so a sound can be re-finished without paying again. */
  originals?: string[];
  /**
   * Paid originals no finished file came from yet: finishing failed when they were made. A
   * re-finish by name makes them (Codex recheck 2026-11-10, R3). A rejected take is never here.
   */
  pending?: string[];
  durationS?: number;
  credits?: number;
  /** Takes the person kept on the board, by file stem (`public/audio/coin_02`). The AI wires these in. */
  kept?: string[];
  /** What each take is, by file stem: where it came from and whether it loops. */
  takes?: Record<string, TakeInfo>;
  created: string;
  updated: string;
}

/**
 * One take's history. `original` + `cut` say which paid original (and which split cut of it) made
 * the take, so re-finishing remakes exactly the takes still in the game and never one that was
 * rejected. `derived` marks an edit of another take (a tool or a region): it has no original and
 * is remade from its own file. `loopable` is what processing actually achieved, not the kind asked
 * for (Codex review 2026-11-09, findings 2 and 11).
 */
export interface TakeInfo {
  original?: string;
  cut?: number;
  derived?: boolean;
  loopable?: boolean;
}

/** One style auditioned on the board: the same few sounds made in one direction. */
export interface Audition {
  label: string;
  direction: string;
  files: string[];
  credits?: number;
  created: string;
}

export interface Manifest {
  takebox: 1;
  settings?: Partial<Settings>;
  sounds: Record<string, SoundRecord>;
  auditions?: Record<string, Audition>;
}

export const MANIFEST = "takebox.json";
/** Generated originals live here, inside the project, out of the game's own folders. */
export const ORIGINALS_DIR = ".takebox/originals";
/** Style auditions and rejected takes: kept out of the game's folder, never deleted. */
export const AUDITIONS_DIR = ".takebox/auditions";
export const REJECTED_DIR = ".takebox/rejected";

// ── Where the project is ─────────────────────────────────────────────────────────────

export class ProjectError extends Error {}

export function checkRoot(root: string): string {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new ProjectError(
      `TAKEBOX would be working in ${resolved}, which is not a game project. Pass project: "<path to the game folder>", or set TAKEBOX_PROJECT in the MCP config.`,
    );
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ProjectError(`The project folder ${resolved} does not exist.`);
  }
  return resolved;
}

/** Resolve a path the user gave, relative to the project, and refuse anything that escapes it. */
export function inside(root: string, relative: string): string {
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ProjectError(`${relative} is outside the project. TAKEBOX only writes inside ${root}.`);
  }
  return full;
}

export const toProjectPath = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

// ── What engine, and the defaults that follow ───────────────────────────────────────

const has = (root: string, name: string) => existsSync(path.join(root, name));

export function detectEngine(root: string): Engine {
  if (has(root, "project.godot")) return "godot";
  if (has(root, "Assets") && has(root, "ProjectSettings")) return "unity";
  try {
    if (readdirSync(root).some((name) => name.endsWith(".uproject"))) return "unreal";
  } catch {
    // unreadable: fall through
  }
  if (has(root, "package.json") || has(root, "index.html")) return "web";
  return "other";
}

const EXISTING_AUDIO_DIRS = [
  "public/audio", "public/sounds", "public/sfx", "public/assets/audio", "src/assets/audio", "src/assets/sounds",
  "static/audio", "assets/audio", "assets/sounds", "assets/sfx", "Assets/Audio", "Assets/Sounds", "audio", "sounds", "sfx",
];

function defaultFolder(root: string, engine: Engine): string {
  const existing = EXISTING_AUDIO_DIRS.find((dir) => has(root, dir));
  if (existing) return existing;
  switch (engine) {
    case "web":
      return has(root, "public") ? "public/audio" : has(root, "assets") ? "assets/audio" : "audio";
    case "unity":
      return "Assets/Audio";
    case "unreal":
      // Unreal imports from here into Content; raw files inside Content are not assets.
      return "SourceAudio";
    default:
      return "audio";
  }
}

/**
 * Formats per engine. Web: OGG plays in every current browser (Safari since 18.4); add MP3 for
 * older iPhones. Godot: WAV for short sounds, OGG for loops, as Godot's own docs advise. Unity and
 * Unreal compress on import, so they get uncompressed WAV.
 */
const ENGINE_FORMATS: Record<Engine, Settings["formats"]> = {
  web: { oneShot: ["ogg"], loop: ["ogg"] },
  godot: { oneShot: ["wav"], loop: ["ogg"] },
  unity: { oneShot: ["wav"], loop: ["wav"] },
  unreal: { oneShot: ["wav"], loop: ["wav"] },
  other: { oneShot: ["wav"], loop: ["wav"] },
};

export function defaultSettings(root: string, engine = detectEngine(root)): Settings {
  return {
    engine,
    folder: defaultFolder(root, engine),
    formats: ENGINE_FORMATS[engine],
    direction: "",
    quality: "standard",
    bitDepth: engine === "unreal" ? 16 : 24,
    channels: "keep",
  };
}

export function resolveSettings(root: string, manifest: Manifest): Settings {
  const stored = manifest.settings ?? {};
  const engine = stored.engine && ENGINES.includes(stored.engine) ? stored.engine : detectEngine(root);
  const base = defaultSettings(root, engine);
  const pick = (list: unknown, fallback: Format[]) =>
    Array.isArray(list) && list.length > 0 && list.every((f) => FORMATS.includes(f as Format)) ? (list as Format[]) : fallback;
  return {
    engine,
    folder: typeof stored.folder === "string" && stored.folder ? stored.folder : base.folder,
    formats: {
      oneShot: pick(stored.formats?.oneShot, base.formats.oneShot),
      loop: pick(stored.formats?.loop, base.formats.loop),
    },
    direction: typeof stored.direction === "string" ? stored.direction : "",
    quality: stored.quality && QUALITIES.includes(stored.quality) ? stored.quality : base.quality,
    bitDepth: stored.bitDepth === 16 || stored.bitDepth === 24 || stored.bitDepth === 32 ? stored.bitDepth : base.bitDepth,
    channels: stored.channels && CHANNEL_MODES.includes(stored.channels) ? stored.channels : "keep",
  };
}

// ── takebox.json ─────────────────────────────────────────────────────────────────────

export async function loadManifest(root: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")) as Partial<Manifest>;
    return { takebox: 1, settings: parsed.settings ?? {}, sounds: parsed.sounds ?? {}, ...(parsed.auditions ? { auditions: parsed.auditions } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { takebox: 1, settings: {}, sounds: {} };
    throw new ProjectError(`${MANIFEST} could not be read: ${(error as Error).message}. Fix or remove it.`);
  }
}

async function saveManifest(root: string, manifest: Manifest) {
  await writeAtomic(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Read, change and write takebox.json with nothing else in between — in this process (a promise
 * chain) and in any other TAKEBOX process on the same game (a lock file in .takebox), so the AI's
 * server and a standalone board never overwrite each other (Codex review 2026-11-09, finding 6).
 */
export function updateManifest<T>(root: string, change: (manifest: Manifest) => T | Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  const next = previous.then(() =>
    withFileLock(path.join(root, ".takebox", "manifest.lock"), async () => {
      const manifest = await loadManifest(root);
      const result = await change(manifest);
      await saveManifest(root, manifest);
      return result;
    }),
  );
  locks.set(root, next.catch(() => undefined));
  return next;
}

/**
 * Everything that changes one sound's files holds its lock, from choosing what to change to
 * recording it: making, re-finishing, the board's tools, keep and reject. Each reads the sound
 * fresh inside the lock. Without it a re-finish working from an old reading dropped a board redo
 * made meanwhile, or brought back a take the board had just rejected (Codex recheck 2026-11-10, R2).
 *
 * Locks are taken sound first, then takebox.json — never the other way round.
 */
export function withSoundLock<T>(root: string, name: string, run: () => Promise<T>): Promise<T> {
  // Generous: a paid take waiting here should wait out a long re-finish, not fail.
  return withFileLock(path.join(root, ".takebox", "locks", `${sanitizeName(name)}.lock`), run, { timeoutMs: 10 * 60_000 });
}

// ── Names ────────────────────────────────────────────────────────────────────────────

/** Engine-safe: lowercase letters, digits and underscores, never empty. */
export function sanitizeName(value: string): string {
  const clean = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
  return clean || "sound";
}

/**
 * Hands out file numbers: `coin_01`, `coin_02`… after whatever is already on disk, in any audio
 * format, so nothing is ever overwritten.
 *
 * ⚠️ Every number is *claimed* before it is used: an exclusive-create claim file, shared by every
 * Namer in every TAKEBOX process on the machine. Two calls making the same sound at once used to
 * pick the same number and overwrite a paid take (Codex review 2026-11-09, finding 4); the in-memory
 * counter alone could not see another call's choice. Claims live in the system temp folder, not
 * the game, and are released once the files exist; a claim left by a crash goes stale.
 */
const CLAIM_STALE_MS = 30 * 60 * 1000;

function claimsFor(folder: string): string {
  const key = createHash("sha1").update(path.resolve(folder)).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "takebox-claims", key);
}

export class Namer {
  private next = new Map<string, number>();
  private loading = new Map<string, Promise<void>>();

  private load(key: string, folder: string, stem: string): Promise<void> {
    let pending = this.loading.get(key);
    if (!pending) {
      pending = (async () => {
        let number = 1;
        const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)\\.(${AUDIO_EXTENSIONS.join("|")})$`, "i");
        try {
          for (const name of await readdir(folder)) {
            const match = name.match(pattern);
            if (match) number = Math.max(number, Number(match[1]) + 1);
          }
        } catch {
          // folder not made yet
        }
        if (!this.next.has(key)) this.next.set(key, number);
      })();
      this.loading.set(key, pending);
    }
    return pending;
  }

  private async claim(folder: string, base: string): Promise<boolean> {
    const dir = claimsFor(folder);
    const file = path.join(dir, base);
    await mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, "wx");
        await handle.close();
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const facts = await stat(file).catch(() => null);
        if (!facts || Date.now() - facts.mtimeMs < CLAIM_STALE_MS) return false;
        await rm(file, { force: true });
      }
    }
    return false;
  }

  /**
   * Claim the next free name for `stem` in `folder`. Release it once its files are written.
   * `prefer`: a name to take back if it is free (a remade take keeps its number). `avoid`: names
   * never to hand out, though free (a retired take's number, which a stale board card may still
   * point at — Codex recheck 2026-11-11, S1).
   */
  async take(folder: string, stem: string, want: { prefer?: string; avoid?: ReadonlySet<string> } = {}): Promise<string> {
    const onDisk = (base: string) => AUDIO_EXTENSIONS.some((ext) => existsSync(path.join(folder, `${base}.${ext}`)));
    if (want.prefer && !onDisk(want.prefer) && (await this.claim(folder, want.prefer))) {
      if (!onDisk(want.prefer)) return want.prefer;
      await this.release(folder, want.prefer);
    }
    const key = path.join(folder, stem);
    if (!this.next.has(key)) await this.load(key, folder, stem);
    for (;;) {
      // Reserve the number in memory first, with no await in between, then claim it on disk.
      const number = this.next.get(key)!;
      this.next.set(key, number + 1);
      const base = `${stem}_${String(number).padStart(2, "0")}`;
      if (want.avoid?.has(base) || onDisk(base)) continue;
      if (await this.claim(folder, base)) {
        // Written between the existence check and the claim by a process that never claimed:
        // give the number up rather than overwrite.
        if (onDisk(base)) {
          await this.release(folder, base);
          continue;
        }
        return base;
      }
    }
  }

  /** The files for `base` exist now (or were rolled back): let the number go. */
  async release(folder: string, base: string): Promise<void> {
    await rm(path.join(claimsFor(folder), base), { force: true });
  }
}

export async function ensureDir(dir: string) {
  await mkdir(dir, { recursive: true });
}
