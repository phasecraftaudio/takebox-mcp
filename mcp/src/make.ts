/**
 * Making and re-finishing sounds: the two jobs that write files.
 *
 * make: spend check → generate (two at a time) → keep the original → finish → write → takebox.json
 * finish: decode an original or any file → finish → write → takebox.json, with no provider call
 */

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareSet, type Analysis } from "./audio/analyze.js";
import { AUDIO_EXTENSIONS, decodeFile, EXTENSION, writableFormats, type EncodeOptions, type Format, type Quality } from "./audio/codecs.js";
import type { Role } from "./audio/level.js";
import type { WavDepth } from "./audio/pcm.js";
import { processTake, writePieces, type FinishOptions, type Shape, type WrittenPiece } from "./finish.js";
import {
  AUDITIONS_DIR, ensureDir, inside, loadManifest, Namer, ORIGINALS_DIR, ProjectError, sanitizeName, toProjectPath, updateManifest,
  withSoundLock, type ChannelMode, type Kind, type Manifest, type Settings, type SoundRecord, type TakeInfo,
} from "./project.js";
import { CREDITS_PER_SECOND } from "./providers/elevenlabs.js";
import { FatalProviderError, type Provider } from "./providers/types.js";
import { checkSpend, type Reservation, type SpendLedger, type SpendLimits } from "./spend.js";
import { groupTakes, stemOf } from "./takes.js";

export interface SoundSpec {
  name: string;
  prompt: string;
  kind?: Kind;
  role?: Role;
  variations?: number;
  duration_s?: number;
  influence?: number;
  split_preset?: string;
}

export interface Context {
  root: string;
  settings: Settings;
  provider: Provider | null;
  ledger: SpendLedger;
  limits: SpendLimits;
  signal?: AbortSignal;
  progress?: (done: number, total: number, message: string) => void;
}

const DEFAULT_DURATION: Record<Kind, number> = { "one-shot": 2, sequence: 6, loop: 15 };
const DEFAULT_ROLE: Record<Kind, Role> = { "one-shot": "sfx", sequence: "foley", loop: "ambience" };
const SHAPE_FOR: Record<Kind, Shape> = { "one-shot": "trim", sequence: "split", loop: "loop" };
const KIND_FOR: Record<Shape, Kind> = { trim: "one-shot", split: "sequence", loop: "loop", none: "one-shot" };
const MAX_VARIATIONS = 8;

export interface Brief {
  file: string;
  durationS: number;
  lufs: number | null;
  truePeakDbtp: number | null;
  flags: string[];
}

/** One line per file: loops are read on LUFS-I, one-shots on their loudest 400 ms. */
const brief = (root: string, file: string, analysis: Analysis, isLoop: boolean): Brief => ({
  file: toProjectPath(root, file),
  durationS: analysis.durationS,
  lufs: isLoop ? (analysis.lufsIntegrated ?? analysis.lufsMomentaryMax) : analysis.lufsMomentaryMax,
  truePeakDbtp: analysis.truePeakDbtp,
  flags: analysis.flags,
});

function finishOptions(kind: Kind, role: Role, settings: Settings, formats: Format[] | undefined, splitPreset?: string): FinishOptions {
  return {
    shape: SHAPE_FOR[kind],
    ...(kind === "sequence" ? { splitPreset: splitPreset ?? "footsteps" } : {}),
    level: "role",
    role,
    channels: settings.channels,
    formats: formats ?? (kind === "loop" ? settings.formats.loop : settings.formats.oneShot),
    encode: { quality: settings.quality, bitDepth: settings.bitDepth },
  };
}

async function pool<T>(items: T[], size: number, run: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await run(items[index]!, index);
      }
    }),
  );
}

const unique = (lines: string[]) => [...new Set(lines)];

// ── make_sounds ──────────────────────────────────────────────────────────────────────

interface Normalised {
  name: string;
  prompt: string;
  kind: Kind;
  role: Role;
  variations: number;
  durationS: number;
  influence: number;
  splitPreset?: string;
  credits: number;
  /** One take's estimate, fixed when the batch was checked, so every request draws exactly that from the hold. */
  perTake: number;
}

function normalise(specs: SoundSpec[], provider: Provider | null): Normalised[] {
  const promptMax = provider?.promptMax ?? 450;
  const minS = provider?.minDurationS ?? 0.5;
  const maxS = provider?.maxDurationS ?? 30;
  const seen = new Set<string>();
  const finite = (value: unknown, what: string, name: string) => {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new ProjectError(`${name}: ${what} must be a number.`);
    }
  };
  return specs.map((spec) => {
    if (typeof spec?.name !== "string" || typeof spec.prompt !== "string") throw new ProjectError("Every sound needs a name and a prompt.");
    const name = sanitizeName(spec.name);
    // The board's HTTP input is not the MCP's typed input: a duration of "auto" once became NaN
    // and every bound and cap check failed open (Codex review 2026-11-09, finding 7).
    finite(spec.duration_s, "duration_s", name);
    finite(spec.variations, "variations", name);
    finite(spec.influence, "influence", name);
    if (seen.has(name)) throw new ProjectError(`Two sounds in this batch are both named ${name}. Use variations for more takes of one sound.`);
    seen.add(name);
    const prompt = spec.prompt.trim().replace(/\s+/g, " ");
    if (!prompt) throw new ProjectError(`${name} has no prompt.`);
    if (prompt.length > promptMax) throw new ProjectError(`${name}'s prompt is ${prompt.length} characters; the limit is ${promptMax}.`);
    const kind = spec.kind ?? "one-shot";
    const durationS = Math.round((spec.duration_s ?? DEFAULT_DURATION[kind]) * 10) / 10;
    if (durationS < minS || durationS > maxS) throw new ProjectError(`${name}: duration must be ${minS} to ${maxS} seconds.`);
    const variations = Math.max(1, Math.min(MAX_VARIATIONS, Math.round(spec.variations ?? 1)));
    const influence = Math.max(0, Math.min(1, spec.influence ?? (kind === "loop" ? 0.3 : 0.4)));
    const perTake = provider ? provider.estimateCredits({ prompt, durationS, influence }) : Math.round(CREDITS_PER_SECOND * durationS);
    return {
      name, prompt, kind, role: spec.role ?? DEFAULT_ROLE[kind], variations, durationS, influence,
      ...(spec.split_preset ? { splitPreset: spec.split_preset } : {}),
      credits: perTake * variations,
      perTake,
    };
  });
}

export interface MakeOptions {
  dryRun?: boolean;
  confirmCredits?: number;
  formats?: Format[];
  model?: string;
  /** Make a style audition instead: files go to .takebox/auditions/<key>, recorded under auditions. */
  audition?: { key: string; label: string; direction: string };
  /** The board: every spend waits for an explicit yes, however small (Codex review, finding 15). */
  alwaysConfirm?: boolean;
  /** Spend from a reservation the caller already holds and will release (an audition's styles). */
  reservation?: Reservation;
}

/** The formats a batch will write: asked for, or the project's for each kind in it. */
function formatsNeeded(items: Normalised[], settings: Settings, options: MakeOptions): Format[] {
  if (options.audition) return ["wav"];
  if (options.formats) return options.formats;
  return [...new Set(items.flatMap((item) => (item.kind === "loop" ? settings.formats.loop : settings.formats.oneShot)))];
}

/** Add one paid take to its sound in takebox.json, creating the sound on its first take. */
function recordTake(
  manifest: Manifest, item: Normalised, provider: Provider,
  take: { files: string[]; original: string; takes: Record<string, TakeInfo>; pending: boolean; credits: number },
) {
  const existing = manifest.sounds[item.name];
  const now = new Date().toISOString();
  const pending = [...(existing?.pending ?? []), ...(take.pending ? [take.original] : [])];
  manifest.sounds[item.name] = {
    kind: item.kind,
    role: item.role,
    source: "generated",
    prompt: item.prompt,
    provider: provider.id,
    files: [...(existing?.files ?? []), ...take.files],
    originals: [...(existing?.originals ?? []), take.original],
    ...(pending.length ? { pending } : {}),
    takes: { ...existing?.takes, ...take.takes },
    durationS: item.durationS,
    credits: (existing?.credits ?? 0) + take.credits,
    ...(existing?.kept?.length ? { kept: existing.kept } : {}),
    created: existing?.created ?? now,
    updated: now,
  };
}

export async function makeSounds(ctx: Context, specs: SoundSpec[], options: MakeOptions) {
  if (!Array.isArray(specs) || specs.length === 0) throw new ProjectError("No sounds in the request.");
  const items = normalise(specs, ctx.provider);
  const estimate = items.reduce((sum, item) => sum + item.credits, 0);
  const limits = options.alwaysConfirm ? { ...ctx.limits, askAbove: 0 } : ctx.limits;
  const spent = await ctx.ledger.spentToday();
  // The cap counts work other batches are already running, not only what has finished.
  const committed = await ctx.ledger.committedToday();
  const decision: ReturnType<typeof checkSpend> = options.reservation ? { ok: true } : checkSpend(estimate, committed, limits, options.confirmCredits);
  const costLines = items.map((item) => ({
    name: item.name, kind: item.kind, role: item.role, variations: item.variations, duration_s: item.durationS, credits: item.credits,
  }));
  const spend = { estimate_credits: estimate, spent_today: spent, daily_cap: limits.dailyCap, ask_above: limits.askAbove };

  // Check the formats before any money moves: a project set up for Opus on another machine must
  // not reach the provider on one that cannot write Opus (Codex review, finding 9).
  const needed = formatsNeeded(items, ctx.settings, options);
  const writable = await writableFormats();
  const cannotWrite = needed.filter((format) => !writable.includes(format));

  if (options.dryRun) {
    return {
      status: "estimate",
      ...spend,
      sounds: costLines,
      would_need: decision.ok ? "nothing: it can run as it is" : decision.reason === "cap" ? "a higher daily cap" : `the person's yes, then confirm_credits: ${estimate}`,
      ...(cannotWrite.length ? { cannot_write: `This machine cannot write ${cannotWrite.join(", ")}; change the formats before making.` } : {}),
      note: "Estimates use the provider's published rate for a fixed duration. Nothing was generated.",
    };
  }
  if (!decision.ok) return { status: decision.reason === "cap" ? "over_daily_cap" : "needs_confirmation", ...spend, sounds: costLines, message: decision.message };
  if (cannotWrite.length) {
    throw new ProjectError(`This machine cannot write ${cannotWrite.join(", ")}, so nothing was made. It can write: ${writable.join(", ")}. Change the formats with setup.`);
  }
  if (!ctx.provider) {
    throw new ProjectError("No ELEVENLABS_API_KEY is set in the MCP config, so nothing can be generated. Library files can still be brought in with finish_sounds.");
  }
  const provider = ctx.provider;

  // A bad output folder fails here, before any credit is held (sign-off "later" list).
  const audition = options.audition;
  const folder = inside(ctx.root, audition ? path.join(AUDITIONS_DIR, audition.key) : ctx.settings.folder);

  // Hold the whole estimate before the first paid request; give back what is unused at the end.
  const reservation = options.reservation ?? (await ctx.ledger.reserve(estimate, limits.dailyCap));
  if (!reservation) {
    return {
      status: "over_daily_cap",
      ...spend,
      sounds: costLines,
      message: `Other batches running now already hold most of today's cap of ${limits.dailyCap}. Wait for them to finish, or make fewer sounds.`,
    };
  }

  const namer = new Namer();
  type Result = { files: string[]; originals: string[]; takes: Record<string, TakeInfo>; notices: string[]; briefs: Brief[]; errors: string[]; credits: number; analyses: Analysis[] };
  const results = new Map<string, Result>();
  for (const item of items) results.set(item.name, { files: [], originals: [], takes: {}, notices: [], briefs: [], errors: [], credits: 0, analyses: [] });

  const tasks = items.flatMap((item) => Array.from({ length: item.variations }, (_, take) => ({ item, take })));
  let done = 0;
  let fatal: string | null = null;
  let used = 0;
  // What this batch may spend, and what it has spent or has on its way (Codex review 2026-11-10,
  // board/cost finding 1). A real charge above the estimate reprices every take still to come and
  // every take in flight; the next request starts only if all of it still fits what was approved.
  const approved = estimate;
  let rate = 0; // the highest per-second charge ElevenLabs has reported in this batch
  const inflight = new Map<number, { durationS: number; perTake: number }>();
  let nextId = 0;
  const expected = (take: { durationS: number; perTake: number }) => Math.max(take.perTake, Math.ceil(rate * take.durationS - 1e-9));

  try {
    await pool(tasks, 2, async ({ item }) => {
      const result = results.get(item.name)!;
      if (fatal || ctx.signal?.aborted) return;
      const request = { prompt: item.prompt, durationS: item.durationS, influence: item.influence, ...(options.model ? { model: options.model } : {}) };
      // The estimate the batch was approved at, not one made now (the learned rate can move while
      // it runs), unless this batch has already been charged more than that.
      const cost = expected(item);
      const owed = used + [...inflight.values()].reduce((sum, take) => sum + expected(take), 0);
      if (owed + cost > approved) {
        fatal =
          `ElevenLabs charged more than TAKEBOX estimated (about ${Math.round(rate)} credits a second), so the rest of this batch would pass ` +
          `the ${approved} credits approved. What was made is kept. Ask again for what is missing at the new price.`;
        return;
      }
      // Counted before the first await, so the other worker sees it.
      const local = nextId++;
      inflight.set(local, { durationS: item.durationS, perTake: item.perTake });
      // Every paid request draws on the hold first, so it counts against the cap until it is
      // settled, whatever happens to the hold meanwhile (rechecks R5, S3).
      const ticket = await ctx.ledger.send(reservation, cost).catch(() => null);
      if (!ticket) {
        inflight.delete(local);
        fatal = fatal ?? "TAKEBOX's hold on today's credits ended while this batch ran (the computer may have slept), so the rest was not made. Ask again for what is missing.";
        return;
      }
      try {
        let generated;
        try {
          generated = await provider.generate(request, ctx.signal);
        } catch (error) {
          inflight.delete(local);
          await ctx.ledger.unsend(reservation, ticket).catch(() => undefined);
          throw error;
        }
        // Booked at what ElevenLabs says it charged; the estimate only when it does not say.
        const charged = generated.credits ?? cost;
        inflight.delete(local);
        if (generated.credits !== undefined) rate = Math.max(rate, generated.credits / request.durationS);
        used += charged;
        result.credits += charged;
        await ctx.ledger.settle(reservation, ticket, charged, provider.id, item.name);
        if (generated.credits !== undefined) await ctx.ledger.learn(provider.id, generated.credits / request.durationS).catch(() => undefined);

        // The paid original is saved and recorded before finishing, so a finishing failure never
        // loses it: finish_sounds can remake the take later for free.
        const originalsDir = inside(ctx.root, audition ? path.join(AUDITIONS_DIR, audition.key, "originals") : path.join(ORIGINALS_DIR, item.name));
        await ensureDir(originalsDir);
        const originalBase = await namer.take(originalsDir, `${item.name}_take`);
        const originalFile = path.join(originalsDir, `${originalBase}.${generated.rawExtension}`);
        try {
          await writeFile(originalFile, generated.raw);
        } finally {
          await namer.release(originalsDir, originalBase);
        }
        const original = toProjectPath(ctx.root, originalFile);
        result.originals.push(original);

        const finish = finishOptions(item.kind, item.role, ctx.settings, audition ? ["wav"] : options.formats, item.splitPreset);
        const take = (written: WrittenPiece[]) => {
          const takes: Record<string, TakeInfo> = {};
          const files: string[] = [];
          for (const piece of written) {
            const own = piece.files.map((file) => toProjectPath(ctx.root, file));
            files.push(...own);
            takes[stemOf(own[0]!)] = { original, ...(item.kind === "sequence" ? { cut: piece.cut } : {}), loopable: piece.loopable };
          }
          return { files, takes };
        };
        const report = (written: WrittenPiece[], made: ReturnType<typeof take>) => {
          result.files.push(...made.files);
          Object.assign(result.takes, made.takes);
          for (const piece of written) {
            result.notices.push(...piece.notices);
            result.briefs.push(brief(ctx.root, piece.files[0]!, piece.analysis, item.kind === "loop"));
            result.analyses.push(piece.analysis);
          }
        };
        const write = () => writePieces(processTake(generated.audio, finish, item.role === "music" ? "music" : "sfx"), folder, item.name, finish, namer, ctx.signal);

        if (audition) {
          const written = await write();
          report(written, take(written));
          return;
        }
        // Written and recorded together under the sound's lock, take by take: a re-finish of the same
        // sound can never act on a reading that misses this take (recheck R2), and a crash later in
        // the batch never leaves a paid take in the game untracked.
        await withSoundLock(ctx.root, item.name, async () => {
          let written: WrittenPiece[] = [];
          let failure: unknown = null;
          try {
            written = await write();
          } catch (error) {
            failure = error;
          }
          const made = take(written);
          try {
            await updateManifest(ctx.root, (manifest) => recordTake(manifest, item, provider, { ...made, original, pending: failure !== null, credits: charged }));
          } catch (error) {
            await Promise.all(written.flatMap((piece) => piece.files).map((file) => rm(file, { force: true })));
            throw error;
          }
          report(written, made);
          if (failure) throw failure;
        });
      } catch (error) {
        if (error instanceof FatalProviderError) fatal = error.message;
        result.errors.push((error as Error).message);
      } finally {
        done += 1;
        ctx.progress?.(done, tasks.length, `${item.name}: ${done} of ${tasks.length} takes`);
      }
    });
  } finally {
    if (!options.reservation) await ctx.ledger.release(reservation);
  }

  // A game sound's takes are already recorded, one by one. An audition is recorded as a whole.
  const auditionFiles = audition ? items.flatMap((item) => results.get(item.name)!.files) : [];
  if (audition && auditionFiles.length) {
    const now = new Date().toISOString();
    await updateManifest(ctx.root, (manifest) => {
      const existing = manifest.auditions?.[audition.key];
      manifest.auditions = {
        ...manifest.auditions,
        [audition.key]: {
          label: audition.label,
          direction: audition.direction,
          files: [...(existing?.files ?? []), ...auditionFiles],
          credits: (existing?.credits ?? 0) + used,
          created: existing?.created ?? now,
        },
      };
    });
  }

  const sounds = items.map((item) => {
    const result = results.get(item.name)!;
    return {
      name: item.name,
      files: result.files,
      credits: result.credits,
      notices: unique(result.notices).slice(0, 8),
      measured: result.briefs,
      ...(result.errors.length ? { errors: unique(result.errors) } : {}),
      ...(result.files.length === 0 && result.originals.length ? { recover: `The paid original is kept: finish_sounds with names: ["${item.name}"] remakes it for free.` } : {}),
    };
  });
  const madeCount = sounds.filter((s) => s.files.length > 0).length;
  const setNotes = compareSet(
    items.flatMap((item) => results.get(item.name)!.analyses.map((analysis, i) => ({ name: `${item.name} #${i + 1}`, analysis, isLoop: item.kind === "loop" }))),
  );
  return {
    status: madeCount === items.length ? "made" : madeCount === 0 ? "nothing_made" : "partly_made",
    credits_used: used,
    spent_today: spent + used,
    daily_cap: limits.dailyCap,
    sounds,
    ...(setNotes.length ? { set_notes: setNotes } : {}),
    ...(fatal ? { stopped: fatal } : {}),
    next: "Ask the person to listen and say what they hear. Redo a sound by calling make_sounds with the same name and a changed prompt. Wire files in from takebox.json.",
  };
}

// ── finish_sounds ────────────────────────────────────────────────────────────────────

export interface FinishInput {
  files?: string[];
  names?: string[];
  shape?: "auto" | Shape;
  level?: "role" | "off" | number;
  role?: Role;
  channels?: ChannelMode;
  sample_rate?: number;
  formats?: Format[];
  quality?: Quality;
  bit_depth?: WavDepth;
  name?: string;
  folder?: string;
  split_preset?: string;
  replace?: boolean;
}

const MAX_FILES_PER_CALL = 200;

async function expand(root: string, given: string[]): Promise<string[]> {
  const out: string[] = [];
  const audio = new Set(AUDIO_EXTENSIONS.map((ext) => `.${ext}`));
  for (const entry of given) {
    const full = path.isAbsolute(entry) ? entry : path.resolve(root, entry);
    if (!existsSync(full)) throw new ProjectError(`${entry} does not exist.`);
    if (statSync(full).isDirectory()) {
      for (const name of (await readdir(full)).sort()) if (audio.has(path.extname(name).toLowerCase())) out.push(path.join(full, name));
    } else out.push(full);
  }
  if (out.length > MAX_FILES_PER_CALL) throw new ProjectError(`That is ${out.length} files; finish at most ${MAX_FILES_PER_CALL} per call.`);
  return out;
}

type FinishReport = { name: string; files: string[]; removed?: string[]; kept_as_is?: string[]; notices: string[]; measured: Brief[]; errors?: string[] };

function optionsFor(ctx: Context, input: FinishInput, kind: Kind, role: Role): FinishOptions {
  const shape: Shape = input.shape && input.shape !== "auto" ? input.shape : SHAPE_FOR[kind];
  return {
    shape,
    ...(shape === "split" ? { splitPreset: input.split_preset ?? "footsteps" } : {}),
    level: input.level ?? "role",
    role,
    channels: input.channels ?? ctx.settings.channels,
    ...(input.sample_rate ? { sampleRate: input.sample_rate } : {}),
    formats: input.formats ?? (KIND_FOR[shape] === "loop" ? ctx.settings.formats.loop : ctx.settings.formats.oneShot),
    encode: { quality: input.quality ?? ctx.settings.quality, bitDepth: input.bit_depth ?? ctx.settings.bitDepth } satisfies EncodeOptions,
  };
}

/**
 * Re-finish a made sound from its originals: a new format, level, shape or folder, at no cost.
 *
 * One transaction under the sound's lock, reading the sound fresh inside it (Codex recheck
 * 2026-11-10, R1–R4):
 *
 * 1. Plan. Only takes still in the game are remade, each from its own original (and only its own
 *    cuts of a split); a rejected take stays out. Paid originals that never got a finished file
 *    (`pending`) are made too. An edit (a tool result or a region) is remade from its own file and,
 *    unless a shape is asked for, keeps its shape and level: a format change re-encodes it, so a
 *    loop made on the board stays a loop.
 * 2. Stage. Everything new is built in `.takebox/staging/<id>`.
 * 3. Publish. The old files are moved into the staging folder (not deleted), the new ones moved in,
 *    takebox.json updated. If any step fails the new files come out and the old ones go back. A
 *    remade take keeps its number when it is the same take (same original and cut, or the same
 *    edit); a number whose take is gone is never reused, so a stale board card cannot hit another.
 * 4. Only then is the staging folder, with the old files in it, removed.
 *
 * A missing original, a codec that fails, a new folder, a full disk or a cancel leaves the game as
 * it was (Codex review 2026-11-09, findings 1 and 2).
 */
async function refinishMade(ctx: Context, name: string, input: FinishInput, folder: string): Promise<FinishReport> {
  return withSoundLock(ctx.root, name, async () => {
    const record = (await loadManifest(ctx.root)).sounds[name];
    if (!record) return { name, files: [], notices: [], measured: [], errors: [`${name} is no longer in takebox.json; nothing was changed.`] };
    const role = input.role ?? record.role;
    const options = optionsFor(ctx, input, record.kind, role);
    // An edit is already shaped and levelled: unless asked, only its format, channels or rate change.
    const asked = input.shape !== undefined && input.shape !== "auto";
    const { splitPreset: _unused, ...unshaped } = options;
    const editOptions: FinishOptions = asked ? options : { ...unshaped, shape: "none", level: input.level ?? "off" };
    const kindAfter = KIND_FOR[options.shape];
    const replace = input.replace ?? true;
    const fail = (errors: string[]): FinishReport => ({ name, files: record.files, notices: [], measured: [], errors });

    // Which source remakes each take.
    type Source = { original?: string; cuts: Set<number> | null; edit?: { loopable: boolean; stem: string } };
    const sources = new Map<string, Source>();
    const retired = new Set<string>();
    // A take is the same take after a re-finish when it comes from the same original and cut (or is
    // the same edit): it keeps its number, so a board card still showing it acts on it. A number
    // whose take is gone is never given to another, so a stale card finds nothing (recheck S1).
    const identity = (from: string, cut: number | undefined) => `${from}\n${cut === undefined ? "whole" : `cut ${cut}`}`;
    const numberOf = new Map<string, string>();
    const inFolder = (stem: string) => path.dirname(path.resolve(ctx.root, stem)) === folder;
    const untouched: string[] = [];
    const originals = record.originals ?? [];
    const plan = (source: string, entry: Omit<Source, "cuts">, cut?: number) => {
      const full = path.resolve(ctx.root, source);
      const current = sources.get(full) ?? { ...entry, cuts: new Set<number>() };
      if (cut === undefined || options.shape !== "split") current.cuts = null;
      else current.cuts?.add(cut);
      sources.set(full, current);
    };
    for (const take of groupTakes(record.files)) {
      const info = record.takes?.[take.stem];
      // Takes made before take records existed: name_07 came from name_take_07.
      const number = /_(\d+)$/.exec(take.stem)?.[1];
      const original = info?.original ?? (info?.derived ? undefined : number ? originals.find((file) => stemOf(path.basename(file)) === `${name}_take_${number}`) : undefined);
      if (original) plan(original, { original }, info?.cut);
      else if (info?.derived) plan(take.files[0]!, { edit: { loopable: info.loopable ?? false, stem: take.stem } });
      else {
        untouched.push(take.stem);
        continue;
      }
      retired.add(take.stem);
      if (inFolder(take.stem)) numberOf.set(identity(original ?? take.stem, info?.cut), path.basename(take.stem));
    }
    const pending = new Set(record.pending ?? []);
    for (const original of pending) if (!sources.has(path.resolve(ctx.root, original))) plan(original, { original });
    if (sources.size === 0) return fail(["No take of this sound has an original to remake it from; nothing was changed."]);
    const missing = [...sources.keys()].filter((file) => !existsSync(file)).map((file) => toProjectPath(ctx.root, file));
    if (missing.length) return fail([`Missing original${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Nothing was changed.`]);

    const stage = inside(ctx.root, path.join(".takebox", "staging", randomBytes(6).toString("hex")));
    let keepStage = false;
    try {
      // ── Stage ──
      const stageNamer = new Namer();
      type Staged = { files: string[]; info: TakeInfo; notices: string[]; analysis: Analysis; identity: string };
      const staged: Staged[] = [];
      try {
        for (const [source, selection] of sources) {
          const audio = await decodeFile(source, ctx.signal);
          const shaping = selection.edit ? editOptions : options;
          const pieces = processTake(audio, shaping, role === "music" ? "music" : "sfx");
          for (const [cut, piece] of pieces.entries()) {
            if (selection.cuts && !selection.cuts.has(cut)) continue;
            // Left unshaped, an edit loops exactly as well as it did.
            if (selection.edit && shaping.shape === "none") piece.loopable = selection.edit.loopable;
            const [written] = await writePieces([piece], stage, "stage", shaping, stageNamer, ctx.signal);
            staged.push({
              files: written!.files,
              info: {
                ...(selection.original ? { original: selection.original } : { derived: true }),
                ...(selection.original && kindAfter === "sequence" ? { cut } : {}),
                loopable: written!.loopable,
              },
              notices: written!.notices,
              analysis: written!.analysis,
              identity: identity(selection.original ?? selection.edit!.stem, shaping.shape === "split" ? cut : undefined),
            });
          }
        }
      } catch (error) {
        return fail([`${(error as Error).message} Nothing was changed.`]);
      }

      // ── Publish ──
      const parked: { from: string; to: string }[] = [];
      const published: string[] = [];
      const files: string[] = [];
      const takes: Record<string, TakeInfo> = {};
      const measured: Brief[] = [];
      const notices: string[] = [];
      try {
        if (replace) {
          const old = path.join(stage, "old");
          await ensureDir(old);
          for (const take of groupTakes(record.files)) {
            if (!retired.has(take.stem)) continue;
            for (const file of take.files) {
              let from: string;
              try {
                from = inside(ctx.root, file);
              } catch {
                continue; // outside the project: leave it
              }
              if (!existsSync(from)) continue;
              const to = path.join(old, `${parked.length}${path.extname(file)}`);
              await rename(from, to);
              parked.push({ from, to });
            }
          }
        }
        await ensureDir(folder);
        const namer = new Namer();
        const avoid = new Set([...retired].filter(inFolder).map((stem) => path.basename(stem)));
        for (const piece of staged) {
          const prefer = numberOf.get(piece.identity);
          const base = await namer.take(folder, name, { ...(prefer ? { prefer } : {}), avoid });
          try {
            const moved = [];
            for (const file of piece.files) {
              const target = path.join(folder, `${base}${path.extname(file)}`);
              await rename(file, target);
              published.push(target);
              moved.push(toProjectPath(ctx.root, target));
            }
            files.push(...moved);
            takes[stemOf(moved[0]!)] = piece.info;
            notices.push(...piece.notices);
            measured.push(brief(ctx.root, path.resolve(ctx.root, moved[0]!), piece.analysis, kindAfter === "loop"));
          } finally {
            await namer.release(folder, base);
          }
        }
        const made = new Set(staged.map((piece) => piece.info.original).filter((file): file is string => file !== undefined));
        await updateManifest(ctx.root, (manifest) => {
          const current = manifest.sounds[name];
          if (!current) throw new ProjectError(`${name} left takebox.json while it was being remade.`);
          const gone = replace ? retired : new Set<string>();
          current.files = [...current.files.filter((file) => !gone.has(stemOf(file))), ...files];
          current.takes = { ...Object.fromEntries(Object.entries(current.takes ?? {}).filter(([stem]) => !gone.has(stem))), ...takes };
          // A remade take is new audio: a keep made on the board for the old one no longer applies.
          if (current.kept) current.kept = current.kept.filter((stem) => !gone.has(stem));
          const stillPending = (current.pending ?? []).filter((file) => !made.has(file));
          if (stillPending.length) current.pending = stillPending;
          else delete current.pending;
          current.kind = kindAfter;
          current.role = role;
          current.updated = new Date().toISOString();
        });
      } catch (error) {
        // Put the game back as it was: the new files out, the old ones back where they were.
        await Promise.all(published.map((file) => rm(file, { force: true })));
        for (const { from, to } of parked.reverse()) {
          try {
            await rename(to, from);
          } catch {
            keepStage = true;
          }
        }
        const kept = keepStage ? ` Some old files could not be put back: they are in ${toProjectPath(ctx.root, path.join(stage, "old"))}.` : "";
        return fail([`${(error as Error).message} Nothing was changed.${kept}`]);
      }

      return {
        name, files,
        ...(parked.length ? { removed: parked.map(({ from }) => toProjectPath(ctx.root, from)) } : {}),
        ...(untouched.length ? { kept_as_is: untouched } : {}),
        notices: unique(notices).slice(0, 8), measured,
      };
    } finally {
      if (!keepStage) await rm(stage, { recursive: true, force: true });
    }
  });
}

export async function finishSounds(ctx: Context, input: FinishInput, manifestSounds: Record<string, SoundRecord>) {
  const problems: string[] = [];
  const report: FinishReport[] = [];
  const folder = inside(ctx.root, input.folder ?? ctx.settings.folder);
  const now = new Date().toISOString();

  // Bring files in: from the person's library or project, or a file-made sound's own sources.
  const imports: { stem: string; sources: string[]; kind: Kind; role: Role }[] = [];
  for (const raw of input.names ?? []) {
    const name = sanitizeName(raw);
    const record = manifestSounds[name];
    if (!record) {
      problems.push(`${name} is not in takebox.json.`);
      continue;
    }
    if (record.originals?.length) {
      report.push(await refinishMade(ctx, name, input, folder));
      continue;
    }
    const sources = (record.from?.length ? record.from : record.files.map((file) => path.resolve(ctx.root, file))).filter((file) => existsSync(file));
    const kind = input.shape && input.shape !== "auto" ? KIND_FOR[input.shape] : record.kind;
    imports.push({ stem: name, sources, kind, role: input.role ?? record.role });
  }
  if (input.files?.length) {
    const files = await expand(ctx.root, input.files);
    const kind = input.shape && input.shape !== "auto" ? KIND_FOR[input.shape] : "one-shot";
    const role = input.role ?? (kind === "loop" ? "ambience" : "sfx");
    if (input.name) imports.push({ stem: sanitizeName(input.name), sources: files, kind, role });
    else for (const file of files) imports.push({ stem: sanitizeName(path.basename(file, path.extname(file))), sources: [file], kind, role });
  }
  if (report.length === 0 && imports.length === 0) throw new ProjectError(problems.join(" ") || "Give files (paths or folders) or names from takebox.json.");

  const namer = new Namer();
  for (const job of imports) {
    // Written and recorded under the sound's lock like every other writer of it: a re-finish of the
    // same name running meanwhile would otherwise drop the import from takebox.json (recheck S2).
    await withSoundLock(ctx.root, job.stem, async () => {
      const options = optionsFor(ctx, input, job.kind, job.role);
      const kindAfter = KIND_FOR[options.shape];
      const files: string[] = [];
      const takes: Record<string, TakeInfo> = {};
      const notices: string[] = [];
      const measured: Brief[] = [];
      const errors: string[] = [];
      for (const source of job.sources) {
        try {
          const audio = await decodeFile(source, ctx.signal);
          const pieces = processTake(audio, options, job.role === "music" ? "music" : "sfx");
          for (const piece of await writePieces(pieces, folder, job.stem, options, namer, ctx.signal)) {
            const written = piece.files.map((file) => toProjectPath(ctx.root, file));
            files.push(...written);
            takes[stemOf(written[0]!)] = { loopable: piece.loopable };
            notices.push(...piece.notices);
            measured.push(brief(ctx.root, piece.files[0]!, piece.analysis, kindAfter === "loop"));
          }
        } catch (error) {
          errors.push(`${path.basename(source)}: ${(error as Error).message}`);
        }
      }
      if (files.length) {
        try {
          await updateManifest(ctx.root, (manifest) => {
            const record: SoundRecord = manifest.sounds[job.stem] ?? { kind: kindAfter, role: job.role, source: "file", files: [], created: now, updated: now };
            record.files = [...record.files, ...files];
            record.takes = { ...record.takes, ...takes };
            record.from = [...new Set([...(record.from ?? []), ...job.sources])];
            record.kind = kindAfter;
            record.role = job.role;
            record.updated = now;
            manifest.sounds[job.stem] = record;
          });
        } catch (error) {
          // Never leave a file in the game that takebox.json does not list.
          await Promise.all(files.map((file) => rm(path.resolve(ctx.root, file), { force: true })));
          report.push({ name: job.stem, files: [], notices: [], measured: [], errors: [`${(error as Error).message} Nothing was brought in.`] });
          return;
        }
      }
      report.push({ name: job.stem, files, notices: unique(notices).slice(0, 8), measured, ...(errors.length ? { errors } : {}) });
    });
  }

  return { status: report.some((r) => r.files.length && !r.errors) ? "finished" : "nothing_finished", sounds: report, ...(problems.length ? { problems } : {}) };
}

/** Formats written for each file, for the summary line: "ogg, mp3". */
export const describeFormats = (formats: Format[]) => formats.map((format) => EXTENSION[format]).join(", ");
