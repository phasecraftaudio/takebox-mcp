/**
 * Tighten: take the dead air off the head and tail of one take.
 *
 * A game plays a sound the frame it is triggered. Twenty milliseconds of silence at the front
 * is twenty milliseconds of latency between the button press and the click, and a second of
 * silence at the end is a voice slot held for nothing. Every generated take has some — at the
 * very least the MP3 decoder's own delay at the front — and the people TAKEBOX is for do not
 * know how to remove it.
 *
 * ⚠️ **Conservative on purpose.** This removes *silence*, never a quiet tail that is still part
 * of the sound. A reverb tail fading out is the sound; a hiss bed with nothing on it is not. The
 * line is drawn at whichever is higher of 60 dB under the peak and 6 dB over the measured noise
 * floor — but never higher than 45 dB under the peak, so a dense take whose "floor" estimate
 * lands inside the sound cannot have its tail eaten.
 */

import { fromDb } from "./level.js";
import { ENVELOPE_HOP as HOP, ENVELOPE_WINDOW as WINDOW, measure } from "./segment.js";
import type { Span } from "./render.js";

/** Anything this far under the peak is silence, whatever the room is doing. */
const SILENCE_BELOW_PEAK_DB = -60;
/** Room tone counts as silence up to this far above the measured floor. */
const OVER_FLOOR_DB = 6;
/** …but the silence line is never drawn higher than this, relative to the peak. */
const CEILING_BELOW_PEAK_DB = -45;

/** Kept ahead of the first sound, so a soft attack is never clipped. */
const PRE_ROLL_S = 0.005;
/** Kept after the last sound falls below the line. */
const TAIL_PAD_S = 0.02;
const FADE_IN_S = 0.002;
const FADE_OUT_MAX_S = 0.05;
/** Less than this off either end is not worth a new file. */
const NOTHING_TO_DO_S = 0.001;

export interface Tightened extends Span {
  /** Seconds removed from each end. */
  headS: number;
  tailS: number;
  /** False when neither end had anything worth removing. */
  changed: boolean;
}

/** Returns null for a take with no signal at all. */
export function findTighten(mono: Float32Array, sampleRate: number): Tightened | null {
  const measured = measure(mono, sampleRate);
  if (measured.peak <= 0) return null;
  const env = measured.env;

  const line = Math.min(
    measured.peak * fromDb(CEILING_BELOW_PEAK_DB),
    Math.max(measured.peak * fromDb(SILENCE_BELOW_PEAK_DB), measured.floor * fromDb(OVER_FLOOR_DB)),
  );

  let first = -1;
  let last = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i]! > line) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;

  const duration = mono.length / sampleRate;
  // Frame i measures samples [i·HOP, i·HOP + WINDOW). The sound can begin anywhere in that
  // window, so the frame's own start is the safe edge, and the window's end is the safe tail.
  const start = Math.max(0, (first * HOP) / sampleRate - PRE_ROLL_S);
  const end = Math.min(duration, (last * HOP + WINDOW) / sampleRate + TAIL_PAD_S);

  const headS = start;
  const tailS = duration - end;
  const trimHead = headS >= NOTHING_TO_DO_S;
  const trimTail = tailS >= NOTHING_TO_DO_S;

  return {
    start: trimHead ? start : 0,
    end: trimTail ? end : duration,
    fadeInS: trimHead ? FADE_IN_S : 0,
    fadeOutS: trimTail ? Math.min(FADE_OUT_MAX_S, (end - start) * 0.1) : 0,
    headS: trimHead ? headS : 0,
    tailS: trimTail ? tailS : 0,
    changed: trimHead || trimTail,
  };
}
