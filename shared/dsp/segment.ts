/**
 * Cutting one long recording into regions.
 *
 * A Foley pass is not a folder of one-shots. It is three minutes of someone walking, and
 * turning that into a playable bank by hand is an afternoon in a DAW. This is the part that
 * makes "bring your own library" mean "own a recorder" rather than "own Soundly".
 *
 * ── The split that makes the UI feel live ────────────────────────────────────────────
 *
 * `measure()` walks the samples once and is the expensive half. `segment()` reads only the
 * envelope it produced and is microseconds. Every threshold in the trim view re-runs
 * `segment()` alone, so markers move *under* a dragged slider instead of after a spinner —
 * which is the whole difference between a tool people trust and one they fight.
 *
 * ── ⚠️ Offsets are the hard problem, not onsets ──────────────────────────────────────
 *
 * Finding where an event *starts* is a solved threshold crossing. Finding where it *ends*
 * is not: cloth and gravel have long soft tails that fade into the room, and the next event
 * usually begins before the last has finished. Cut tight and you clip the tail; cut loose
 * and you swallow the next attack. What this does is keep the tail when there is room for
 * it and truncate when there is not — flagging the region either way, because a truncated
 * take is a real defect and the user should be told rather than left to hear it later.
 */

// Carried over from PHASEFLOW's `src/audio/segment.ts` (commit e6c84ad), where its trim view
// lives. Only change: the two envelope constants are exported, so tighten reads the same frames. PHASECRAFT wrote both and releases this copy under Apache-2.0 with
// the rest of TAKEBOX. ⚠️ Until the two products share one package, a fix here belongs there
// too — `test/segment.test.ts` is the same suite in both repos, so run it in both.
import { envelope, toDb } from "./level.js";

export type RegionFlag =
  /** The noise floor sits close to the impact, so the onset may be wrong. */
  | "low-contrast"
  /** The next event started before this one finished decaying — the tail is cut short. */
  | "truncated"
  /** Shorter than a plausible event. Often a detector artefact rather than a take. */
  | "very-short";

/** Envelope resolution. ~1.3 ms a frame at 48 kHz — fine enough for a footstep attack. */
export const ENVELOPE_WINDOW = 256;
export const ENVELOPE_HOP = 64;

/**
 * Noise-floor estimation: the **median of local minima**, not a quantile of the envelope.
 *
 * A plain low quantile fails exactly where it matters. In a dense pass — fast cloth, a run
 * cycle — events and their tails occupy most of the recording, so even the 10th percentile
 * lands inside a decaying tail and the floor comes back 15 dB high. Every threshold derived
 * from it is then too high, and the quiet takes vanish: measured on a synthetic pass with a
 * 30 dB spread of force, that lost five events in nine.
 *
 * Taking the quietest frame in each short window and then the median of those is robust to
 * both problems at once — a single digital-silent frame cannot drag it down, and continuous
 * signal cannot drag it up, as long as the recording goes quiet *somewhere* in most windows.
 *
 * ⚠️ Material with no gaps at all still defeats it, and nothing else would work either:
 * there is no room tone to find. That is what the sensitivity control is for.
 */
const FLOOR_WINDOW_S = 0.12;

/**
 * How far below the peak the floor is allowed to sit, whatever the estimate says.
 *
 * ⚠️ **Without this, a cleanly edited library file detects nothing at all.** Commercial
 * material — the Soundly file this was first tested against — has *true digital silence*
 * between events, not room tone. More than half the windows are then exactly zero, the
 * median of their minima is zero, and every threshold derived from it collapses. Detection
 * returned zero regions at every sensitivity, on a file with a dozen obvious events in it.
 *
 * Falling back to a peak-relative floor is the same move `detectOnset` already makes for the
 * same reason: with no room tone to measure against, the peak is the only reference there is.
 */
const SILENT_FLOOR_DB = -72;

/** Hysteresis. Regions close lower than they open, or one wobble splits an event in two. */
const CLOSE_BELOW_DB = 6;

/**
 * How far above the local trough a rise has to be to count as a *new* event rather than
 * part of the one still decaying.
 *
 * ⚠️ Without this the segmenter cannot cut fast material at all. A region closes after
 * `tailS` of quiet, so any two events closer together than the tail merge — and 250 ms of
 * tail against a 150 ms gap is an ordinary fast walk, or cloth movement, which is most of
 * what anyone actually records. A new transient has to be able to interrupt a decay.
 *
 * ~10 dB over the trough: high enough that the ripple in a decaying tail never triggers it,
 * low enough to catch a soft step landing on the tail of a loud one.
 */
const RISE_RATIO = 3.2;

/** Below this margin over the floor, onset detection is documented to be unreliable. */
const LOW_CONTRAST_DB = 30;

/** Shorter than this is a detector artefact rather than a take. */
const VERY_SHORT_S = 0.04;

export interface TrimSettings {
  /** How far above the noise floor counts as an event. The main control. */
  sensitivityDb: number;
  /** Onsets closer together than this are one event, not two. */
  minGapS: number;
  /** How much tail to keep after the level falls away, when the next event leaves room. */
  tailS: number;
  /** Kept before the transient, so an attack is never clipped. */
  preRollS: number;
  /**
   * A hit landing this soon after a louder one, and `attachBelowDb` or more below it, is part of
   * that event, not a new one. Absent or 0: off.
   */
  attachS?: number;
  attachBelowDb?: number;
}

/**
 * ⚠️ A footstep is not one transient. Heel then toe, or a step then its scuff: measured on a real
 * generated walk (TAKEBOX listening pass, 2026-11-10), each of nine steps peaking at −13 to −19 dB
 * had a second hit 80–180 ms later and at least 9.9 dB quieter (later ones, at 250 ms, sat near
 * the room and stay as faint cuts, flagged). At an 80 ms `minGapS` each became its own
 * region, so the bank alternated step, scrap, step, scrap, and nine steps came out as 21 pieces.
 * No `minGapS` fixes it: 300 ms gets near, and also halves a run cycle. What separates the scrap
 * from a step is level, so a quieter hit soon after a louder one joins it. A run's steps are about
 * equally loud and stay apart. The window stops at 200 ms because a session that alternates loud
 * and soft takes 300 ms apart must keep its soft tier (`recheck-10-19.test.ts`).
 */
export const DEFAULT_TRIM: TrimSettings = {
  sensitivityDb: 18,
  minGapS: 0.08,
  tailS: 0.25,
  preRollS: 0.005,
  attachS: 0.2,
  attachBelowDb: 8,
};

/**
 * Starting points per material — a place to land, not an answer.
 *
 * ⚠️ **`minGapS` is the one that actually changes the result**, and it is material-specific
 * in a way sensitivity is not. Measured against a real Soundly cloth take: at the footstep
 * default of 80 ms the detector found seven regions, splitting each of the four gestures in
 * two, because a cloth rustle contains several transients and a footstep contains one. At
 * 300 ms it found exactly four. Neither setting is wrong — they describe different material,
 * which is why this is a control and not a constant.
 */
export const TRIM_PRESETS: { id: string; label: string; settings: TrimSettings }[] = [
  { id: "footsteps", label: "Footsteps", settings: DEFAULT_TRIM },
  {
    id: "cloth",
    label: "Cloth / movement",
    settings: { sensitivityDb: 14, minGapS: 0.3, tailS: 0.35, preRollS: 0.008 },
  },
  {
    id: "impacts",
    label: "Impacts / hard",
    settings: { sensitivityDb: 22, minGapS: 0.12, tailS: 0.4, preRollS: 0.004 },
  },
  {
    id: "dense",
    label: "Fast / dense",
    settings: { sensitivityDb: 16, minGapS: 0.05, tailS: 0.12, preRollS: 0.004 },
  },
];

export interface Measured {
  /** RMS per frame. */
  env: Float64Array;
  sampleRate: number;
  secondsPerFrame: number;
  duration: number;
  floor: number;
  floorDb: number;
  peak: number;
  peakDb: number;
}

/** Quietest frame per window, then the median across windows. */
function estimateFloor(env: Float64Array, windowFrames: number): number {
  if (env.length === 0) return 0;

  const minima: number[] = [];
  for (let from = 0; from < env.length; from += windowFrames) {
    let lowest = Infinity;
    const to = Math.min(env.length, from + windowFrames);
    for (let i = from; i < to; i++) if (env[i]! < lowest) lowest = env[i]!;
    if (lowest < Infinity) minima.push(lowest);
  }
  if (minima.length === 0) return 0;

  minima.sort((a, b) => a - b);
  return minima[Math.floor(minima.length / 2)]!;
}

export interface DetectedRegion {
  start: number;
  end: number;
  /** Absolute seconds into the source. */
  onset: number;
  peakDb: number;
  /** 0..1. How far clear of the noise floor this event sits. */
  confidence: number;
  flags: RegionFlag[];
}

/** The expensive half: one pass over the samples. Re-run only when the audio changes. */
export function measure(mono: Float32Array, sampleRate: number): Measured {
  const env = envelope(mono, ENVELOPE_WINDOW, ENVELOPE_HOP);

  const secondsPerFrame = ENVELOPE_HOP / sampleRate;

  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > peak) peak = env[i]!;

  const estimated = estimateFloor(env, Math.max(1, Math.round(FLOOR_WINDOW_S / secondsPerFrame)));
  const floor = Math.max(estimated, peak * Math.pow(10, SILENT_FLOOR_DB / 20));

  return {
    env,
    sampleRate,
    secondsPerFrame,
    duration: mono.length / sampleRate,
    floor,
    floorDb: toDb(floor),
    peak,
    peakDb: toDb(peak),
  };
}

/**
 * The cheap half: threshold the envelope. Safe to call on every pointer move.
 *
 * Deliberately not clever. A learned or spectral onset detector would do better on
 * overlapping material, and it is also the thing that cannot be explained to the person
 * whose recording it just cut wrong. This can be read, predicted, and argued with.
 */
export function segment(measured: Measured, settings: TrimSettings = DEFAULT_TRIM): DetectedRegion[] {
  const { env, secondsPerFrame, floor, floorDb, duration } = measured;
  if (env.length === 0 || floor <= 0) return [];

  const open = floor * Math.pow(10, settings.sensitivityDb / 20);
  const close = floor * Math.pow(10, (settings.sensitivityDb - CLOSE_BELOW_DB) / 20);
  const tailFrames = Math.max(1, Math.round(settings.tailS / secondsPerFrame));
  const minGapFrames = Math.max(1, Math.round(settings.minGapS / secondsPerFrame));

  interface Raw {
    onsetFrame: number;
    peakFrame: number;
    peakValue: number;
    dropFrame: number;
  }

  const raw: Raw[] = [];
  let current: Raw | null = null;
  let belowFor = 0;
  /** Lowest the envelope has been since the current event's peak, and where. */
  let trough = Infinity;
  let troughFrame = 0;

  /** Where the rise into `frame` began — walk back while the level is still falling. */
  const riseStart = (frame: number): number => {
    let at = frame;
    while (at > 0 && env[at - 1]! < env[at]!) at--;
    return at;
  };

  for (let i = 0; i < env.length; i++) {
    const value = env[i]!;

    if (current === null) {
      if (value <= open) continue;
      let onsetFrame = i;
      // Walk back to where the rise actually began rather than to where it crossed the
      // threshold: on a soft attack those are tens of milliseconds apart, and starting at
      // the crossing clips the front of the take.
      while (onsetFrame > 0 && env[onsetFrame - 1]! > close) onsetFrame--;

      const previous = raw[raw.length - 1];
      if (previous && onsetFrame - previous.onsetFrame < minGapFrames) {
        // Same event, detected twice. Extend the previous one instead of splitting it.
        current = previous;
        raw.pop();
      } else {
        current = { onsetFrame, peakFrame: i, peakValue: value, dropFrame: i };
      }
      belowFor = 0;
      trough = value;
      troughFrame = i;
      continue;
    }

    // A new transient landing on the tail of the last one. Close the old region at the
    // trough between them and open a new one, rather than swallowing both.
    //
    // ⚠️ Tested against the trough as it stood *before* this frame. Updating the peak first
    // let a second impact louder than the first reset the trough to itself, so the rise
    // test compared the frame with its own value and two events merged into one (Codex
    // review of TAKEBOX, 2026-10-19, finding 5).
    if (
      value > open &&
      trough > 0 &&
      value > trough * RISE_RATIO &&
      i - current.onsetFrame >= minGapFrames
    ) {
      current.dropFrame = Math.max(current.peakFrame, troughFrame);
      raw.push(current);

      const onsetFrame = riseStart(i);
      current = { onsetFrame, peakFrame: i, peakValue: value, dropFrame: i };
      belowFor = 0;
      trough = value;
      troughFrame = i;
      continue;
    }

    if (value > current.peakValue) {
      current.peakValue = value;
      current.peakFrame = i;
      trough = value;
      troughFrame = i;
    } else if (value < trough) {
      trough = value;
      troughFrame = i;
    }

    if (value > close) {
      belowFor = 0;
      current.dropFrame = i;
    } else {
      belowFor++;
      if (belowFor >= tailFrames) {
        raw.push(current);
        current = null;
        belowFor = 0;
      }
    }
  }
  if (current !== null) raw.push(current);

  // ── a quieter hit soon after a louder one is part of it (see DEFAULT_TRIM) ─────────────
  const events: Raw[] = [];
  const attachFrames = (settings.attachS ?? 0) / secondsPerFrame;
  const attachRatio = Math.pow(10, -(settings.attachBelowDb ?? 0) / 20);
  for (const event of raw) {
    const owner = events[events.length - 1];
    if (owner && attachFrames > 0 && event.onsetFrame - owner.onsetFrame <= attachFrames && event.peakValue <= owner.peakValue * attachRatio) {
      owner.dropFrame = Math.max(owner.dropFrame, event.dropFrame);
      continue;
    }
    events.push(event);
  }

  // ── turn raw events into regions ────────────────────────────────────────────────────
  const regions: DetectedRegion[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const next = events[i + 1];

    const onset = event.onsetFrame * secondsPerFrame;
    const start = Math.max(0, onset - settings.preRollS);

    // Keep the tail if the next event leaves room for it; otherwise stop where the next
    // one begins. Truncating is sometimes the only option — it is never silent.
    const wanted = event.dropFrame * secondsPerFrame + settings.tailS;
    const limit = next ? next.onsetFrame * secondsPerFrame - settings.preRollS : duration;
    const end = Math.min(Math.max(wanted, onset + VERY_SHORT_S), Math.max(limit, onset + 0.005), duration);

    const peakDb = toDb(event.peakValue);
    const margin = peakDb - floorDb;

    const flags: RegionFlag[] = [];
    if (margin < LOW_CONTRAST_DB) flags.push("low-contrast");
    if (wanted > limit && next) flags.push("truncated");
    if (end - start < VERY_SHORT_S) flags.push("very-short");

    regions.push({
      start,
      end,
      onset,
      peakDb,
      // Full confidence at 40 dB clear of the room, none at 12. Those bounds are judgement
      // against synthetic material and want re-checking against a real pass.
      confidence: Math.max(0, Math.min(1, (margin - 12) / 28)),
      flags,
    });
  }

  return regions;
}
