/**
 * Auto-loop: turn a take into a file that plays seamlessly when a game engine repeats it.
 *
 * ── The method: the old studio way, done automatically ──────────────────────────────────
 *
 * By hand, an editor loops a sound like this: cut it in the middle, at a steady spot; swap the
 * halves, so the second half plays first; crossfade the join where the old end now meets the old
 * start. The file now begins and ends on the two sides of the middle cut — two neighbouring
 * samples of the original recording — so the wrap from end to start is no join at all. The only
 * splice left is the crossfade, sitting inside the file where it is spread over a second or so.
 *
 * Here the steps are the same, in this order:
 *
 *  1. **Find the steady part.** Silence, a fade-in at the front and a fade-out at the end are not
 *     part of the loop: blending a fade-out into a fade-in dips the level once per cycle.
 *  2. **Choose the join.** The end of the steady part is blended into its start over `F`. The
 *     exact end point is searched for the passage that best matches the start: in phase for a
 *     pitched sound (a hum, a drone), at the same level for noise (rain, wind).
 *  3. **Choose the cut.** In the middle half of the loop, the steadiest spot — where the level
 *     changes least, so a footstep, a bird or a gust never lands on it — then the quietest sample
 *     within 10 ms, so the very first play starts from silence, not a click.
 *  4. **Render** the steady part with the join crossfaded, starting at the cut.
 *
 * With `a` the loop start, `b` the loop end, `F` the crossfade, and the loop running `b − a`:
 *
 *     y[n] = gIn(n/F) · x[a + n] + gOut(n/F) · x[b + n]   for 0 ≤ n < F     (the join)
 *     y[n] = x[a + n]                                    for F ≤ n < b − a
 *
 * and the file is `y` rotated to start at the cut `m`: x[m] … x[b − 1], the join, x[a + F] … x[m − 1].
 * The wrap plays x[m − 1] then x[m]: exactly what the original recording did.
 *
 * ⚠️ **No fades at the head and tail.** The wrap is already continuous, so a fade there would
 * put a short dip — an audible tick on rain or wind — into every repeat. The snap to the quietest
 * sample is what protects the first play instead.
 *
 * ── The gain law ─────────────────────────────────────────────────────────────────────────
 *
 * Equal-power gains keep the level flat when the two passages are uncorrelated, and bump it
 * +3 dB in the middle when they are identical. Equal-gain is the reverse. So the gains are
 * equal-power shapes rescaled by the measured correlation `r`:
 *
 *     k = 1 / sqrt(pIn² + pOut² + 2·r·pIn·pOut),   gIn = k·pIn,   gOut = k·pOut
 *
 * which keeps the expected power constant for any `r` in 0..1 — equal-power at 0, equal-gain at 1.
 *
 * ⚠️ **Music gets the same treatment for now, and it is not musical.** A music loop should land
 * on a bar line in a matching chord. That needs tempo and harmony analysis, which is a later
 * release; until then a music loop is seamless in level and phase, not in harmony.
 */

import { activity, envelope, fromDb, toDb } from "./level.js";

export interface LoopOptions {
  /** Crossfade length. Default: a fifth of the steady part, at most `maxCrossfadeS`. */
  crossfadeS?: number;
  /** Longest automatic crossfade. Default one second; longer suits music. */
  maxCrossfadeS?: number;
  /** Shortest loop worth making. Default one second. */
  minLoopS?: number;
}

export interface LoopPoints {
  /** Seconds into the source: where the loop begins. */
  start: number;
  /** Seconds into the source: where the loop ends and the crossfade material begins. */
  end: number;
  crossfadeS: number;
  /** Seconds into the source: where the file starts, between `start + crossfadeS` and `end`. */
  cut: number;
  /** Normalised correlation of the two crossfaded passages, −1..1. */
  correlation: number;
  /** Level difference between the two crossfaded passages. Under ~1.5 dB is inaudible. */
  levelDifferenceDb: number;
}

/** Coarse envelope for finding the steady part: ~21 ms windows, ~5 ms hops at 48 kHz. */
const BODY_WINDOW = 1024;
const BODY_HOP = 256;
/** Smoothing over the envelope, so a gust or a crackle does not read as the sound ending. */
const BODY_SMOOTH_S = 0.25;
/** The steady part is where the smoothed level is within this of its median. */
const BODY_BELOW_MEDIAN_DB = -3;
/** Frames this far under the peak are silence and do not count towards the median. */
const CONTENT_BELOW_PEAK_DB = -40;

/** How far back from the latest possible end the search looks. */
const SEARCH_MAX_S = 1;
/** Rate the coarse search runs at. */
const COARSE_RATE = 8000;
/** Correlation window for the coarse and fine passes. */
const COARSE_WINDOW_S = 0.2;
const FINE_WINDOW_S = 0.05;
/** One dB of level mismatch costs as much as this much correlation. */
const DB_PENALTY = 1 / 6;

/** Half-width of the window the cut's steadiness is measured over. */
const STEADY_RADIUS_S = 0.05;
/** The cut keeps at least this far from the join and from the loop end. */
const CUT_GUARD_S = 0.05;
/** How far the cut may move to land on the quietest sample. */
const SNAP_S = 0.01;

const DEFAULT_MIN_LOOP_S = 1;
const DEFAULT_MAX_CROSSFADE_S = 1;
const MIN_CROSSFADE_S = 0.02;

function movingAverage(values: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(values.length);
  let sum = 0;
  let count = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < values.length; i++) {
    const wantLo = Math.max(0, i - radius);
    const wantHi = Math.min(values.length - 1, i + radius);
    while (hi < wantHi) {
      hi++;
      sum += values[hi]!;
      count++;
    }
    while (lo < wantLo) {
      sum -= values[lo]!;
      count--;
      lo++;
    }
    out[i] = sum / count;
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Normalised cross-correlation of two equal-length windows, summed over every channel. Per
 * channel, so a hum whose channels are out of phase with each other still matches itself.
 */
function ncc(channels: readonly Float32Array[], a: number, b: number, length: number): number {
  let dot = 0;
  let energyA = 0;
  let energyB = 0;
  for (const signal of channels) {
    for (let i = 0; i < length; i++) {
      const x = signal[a + i]!;
      const y = signal[b + i]!;
      dot += x * y;
      energyA += x * x;
      energyB += y * y;
    }
  }
  const norm = Math.sqrt(energyA * energyB);
  return norm > 0 ? dot / norm : 0;
}

/** Box-filtered decimation: crude, but enough to stop the coarse search scoring aliases. */
function decimate(signal: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(signal.length / factor));
  for (let k = 0; k < out.length; k++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += signal[k * factor + j]!;
    out[k] = sum / factor;
  }
  return out;
}

interface Body {
  /** Samples: the steady part is [from, to). */
  from: number;
  to: number;
  /** The coarse envelope it was found on, reused to place the cut. */
  env: Float64Array;
}

function measureBody(level: Float32Array, sampleRate: number): Body | null {
  const env = envelope(level, BODY_WINDOW, BODY_HOP);
  let peak = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > peak) peak = env[i]!;
  if (peak <= 0) return null;

  const radius = Math.max(1, Math.round((BODY_SMOOTH_S / 2) * (sampleRate / BODY_HOP)));
  const smooth = movingAverage(env, radius);

  const content: number[] = [];
  const contentLine = peak * fromDb(CONTENT_BELOW_PEAK_DB);
  for (let i = 0; i < smooth.length; i++) if (smooth[i]! > contentLine) content.push(smooth[i]!);
  const steady = median(content) * fromDb(BODY_BELOW_MEDIAN_DB);
  if (steady <= 0) return null;

  let first = -1;
  let last = -1;
  for (let i = 0; i < smooth.length; i++) {
    if (smooth[i]! >= steady) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;

  return {
    from: first * BODY_HOP,
    to: Math.min(level.length, last * BODY_HOP + BODY_WINDOW),
    env,
  };
}

/** The steady part of the take, skipping silence, a fade-in at the front and a fade-out at the end. */
export function findBody(level: Float32Array, sampleRate: number): { from: number; to: number } | null {
  const body = measureBody(level, sampleRate);
  return body ? { from: body.from, to: body.to } : null;
}

/**
 * The steadiest spot in [lo, hi), preferring the middle: the frame whose level changes least
 * over ±50 ms, relative to the level itself, so a quiet passage and a loud one compete fairly.
 */
function steadiestSample(env: Float64Array, sampleRate: number, lo: number, hi: number): number {
  const radius = Math.max(1, Math.round((STEADY_RADIUS_S * sampleRate) / BODY_HOP));
  const centre = (lo + hi) / 2;
  const half = Math.max(1, (hi - lo) / 2);

  let best = Math.round(centre);
  let bestScore = Infinity;
  const firstFrame = Math.max(radius, Math.ceil((lo - BODY_WINDOW / 2) / BODY_HOP));
  const lastFrame = Math.min(env.length - radius - 1, Math.floor((hi - BODY_WINDOW / 2) / BODY_HOP));
  for (let frame = firstFrame; frame <= lastFrame; frame++) {
    let change = 0;
    let level = 0;
    for (let j = frame - radius; j < frame + radius; j++) {
      change += Math.abs(env[j + 1]! - env[j]!);
      level += env[j]!;
    }
    const sample = frame * BODY_HOP + BODY_WINDOW / 2;
    const steadiness = level > 0 ? change / level : 0;
    // A gentle pull towards the middle: among equally steady spots, the central one wins.
    const score = steadiness * (1 + Math.abs(sample - centre) / half);
    if (score < bestScore) {
      bestScore = score;
      best = sample;
    }
  }
  return Math.max(lo, Math.min(hi - 1, best));
}

/** The quietest sample, summed over every channel, within `radius` of `around` and inside [lo, hi). */
function quietestSample(
  channels: readonly Float32Array[],
  around: number,
  radius: number,
  lo: number,
  hi: number,
): number {
  let best = around;
  let bestLevel = Infinity;
  const from = Math.max(lo, around - radius);
  const to = Math.min(hi - 1, around + radius);
  for (let n = from; n <= to; n++) {
    let level = 0;
    for (const channel of channels) level += Math.abs(channel[n]!);
    // Ties go to the sample nearest the steady spot.
    if (level < bestLevel || (level === bestLevel && Math.abs(n - around) < Math.abs(best - around))) {
      bestLevel = level;
      best = n;
    }
  }
  return best;
}

/** Returns null when the take has no steady part long enough to loop. */
export function findLoop(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: LoopOptions = {},
): LoopPoints | null {
  // Level from energy, so out-of-phase channels cannot cancel (see `activity`).
  const level = activity(channels);
  const body = measureBody(level, sampleRate);
  if (!body) return null;

  const minLoop = Math.round((options.minLoopS ?? DEFAULT_MIN_LOOP_S) * sampleRate);
  const usable = body.to - body.from;
  const fade = Math.round(
    Math.max(
      MIN_CROSSFADE_S * sampleRate,
      options.crossfadeS !== undefined
        ? options.crossfadeS * sampleRate
        : Math.min((options.maxCrossfadeS ?? DEFAULT_MAX_CROSSFADE_S) * sampleRate, usable / 5),
    ),
  );

  const a = body.from;
  // The crossfade reads F samples after b, all of which must still be steady.
  const latest = body.to - fade;
  // The two crossfaded passages must not overlap, and the loop must be long enough to matter.
  const earliestAllowed = a + Math.max(minLoop, 2 * fade);
  const earliest = Math.max(earliestAllowed, latest - Math.round(SEARCH_MAX_S * sampleRate));
  if (latest < earliest) return null;

  // ── Level of each candidate's crossfade passage, in O(1) from a prefix sum ────────────
  const squares = new Float64Array(level.length + 1);
  for (let i = 0; i < level.length; i++) squares[i + 1] = squares[i]! + level[i]! * level[i]!;
  const levelDb = (from: number) => toDb(Math.sqrt((squares[from + fade]! - squares[from]!) / fade));
  const levelA = levelDb(a);

  // ── Coarse pass at ~8 kHz ─────────────────────────────────────────────────────────────
  const factor = Math.max(1, Math.round(sampleRate / COARSE_RATE));
  const coarse = channels.map((channel) => decimate(channel, factor));
  const coarseWindow = Math.max(1, Math.round(Math.min(fade, COARSE_WINDOW_S * sampleRate) / factor));
  // Compare the middle of each crossfade passage, where the blend is most even.
  const centre = (from: number) => from + Math.floor(fade / 2) - Math.floor((coarseWindow * factor) / 2);
  const coarseA = Math.max(0, Math.floor(centre(a) / factor));

  let best = earliest;
  let bestScore = -Infinity;
  for (let b = earliest; b <= latest; b += factor) {
    const coarseB = Math.floor(centre(b) / factor);
    if (coarseB + coarseWindow > coarse[0]!.length) break;
    const score = ncc(coarse, coarseA, coarseB, coarseWindow) - Math.abs(levelDb(b) - levelA) * DB_PENALTY;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }

  // ── Fine pass at the full rate, a coarse step either side ────────────────────────────
  const fineWindow = Math.max(1, Math.min(fade, Math.round(FINE_WINDOW_S * sampleRate)));
  const fineCentre = (from: number) => from + Math.floor(fade / 2) - Math.floor(fineWindow / 2);
  let b = best;
  let refinedScore = -Infinity;
  for (let candidate = Math.max(earliest, best - factor); candidate <= Math.min(latest, best + factor); candidate++) {
    const score = ncc(channels, fineCentre(a), fineCentre(candidate), fineWindow);
    if (score > refinedScore) {
      refinedScore = score;
      b = candidate;
    }
  }

  // ── The cut: steadiest spot in the middle half of the untouched stretch, then the quietest sample ─
  const untouchedFrom = a + fade;
  const span = b - untouchedFrom;
  const guard = Math.min(Math.round(CUT_GUARD_S * sampleRate), Math.floor(span / 4));
  const lo = untouchedFrom + Math.max(guard, Math.floor(span / 4));
  const hi = Math.max(lo + 1, b - Math.max(guard, Math.floor(span / 4)));
  const steady = steadiestSample(body.env, sampleRate, lo, hi);
  const cut = quietestSample(channels, steady, Math.round(SNAP_S * sampleRate), untouchedFrom + 1, b);

  return {
    start: a / sampleRate,
    end: b / sampleRate,
    crossfadeS: fade / sampleRate,
    cut: cut / sampleRate,
    correlation: ncc(channels, a, b, fade),
    levelDifferenceDb: levelDb(b) - levelA,
  };
}

/** Crossfade gains for position t in 0..1, given the correlation of the two passages. */
export function crossfadeGains(t: number, correlation: number): { gIn: number; gOut: number } {
  const r = Math.max(0, Math.min(1, correlation));
  const pIn = Math.sin((Math.PI / 2) * t);
  const pOut = Math.cos((Math.PI / 2) * t);
  const k = 1 / Math.sqrt(pIn * pIn + pOut * pOut + 2 * r * pIn * pOut);
  return { gIn: k * pIn, gOut: k * pOut };
}

/** Sample positions of a set of loop points, checked against the take they came from. */
export function loopSamples(points: LoopPoints, sampleRate: number, total: number) {
  const a = Math.round(points.start * sampleRate);
  const b = Math.round(points.end * sampleRate);
  const fade = Math.round(points.crossfadeS * sampleRate);
  const cut = Math.round(points.cut * sampleRate);
  if (b - a <= 0 || fade <= 0 || 2 * fade > b - a || b + fade > total || cut <= a + fade || cut >= b) {
    throw new Error("These loop points do not fit inside the take.");
  }
  return { a, b, fade, cut, length: b - a };
}

export function renderLoop(
  channels: readonly Float32Array[],
  sampleRate: number,
  points: LoopPoints,
): Float32Array[] {
  const { a, b, fade, cut, length } = loopSamples(points, sampleRate, channels[0]?.length ?? 0);
  const rotation = cut - a;

  return channels.map((x) => {
    // The loop in source order, join first…
    const loop = x.slice(a, b);
    for (let n = 0; n < fade; n++) {
      const { gIn, gOut } = crossfadeGains(n / fade, points.correlation);
      loop[n] = gIn * x[a + n]! + gOut * x[b + n]!;
    }
    // …then rotated to start at the cut.
    const out = new Float32Array(length);
    out.set(loop.subarray(rotation), 0);
    out.set(loop.subarray(0, rotation), length - rotation);
    return out;
  });
}
