/**
 * The analyst: what a sound designer checks before a file goes into a game, measured.
 *
 * It reports facts and flags the ones that cause trouble in an engine. It never says a sound is
 * good. That is the listener's call, and the AI agent is told to ask rather than claim.
 */

import { activity, toDb } from "../../../shared/dsp/level.js";
import { findLoop } from "../../../shared/dsp/loop.js";
import { measureLoudness } from "../../../shared/dsp/loudness.js";
import { measure } from "../../../shared/dsp/segment.js";
import { findTighten } from "../../../shared/dsp/tighten.js";
import type { Audio } from "./pcm.js";

export interface Analysis {
  durationS: number;
  sampleRate: number;
  channels: number;
  /** null for a file wider than stereo, which BS.1770 needs a speaker layout to measure. */
  lufsIntegrated: number | null;
  lufsMomentaryMax: number | null;
  truePeakDbtp: number | null;
  samplePeakDbfs: number;
  /** Silence that could come off each end (latency at the head, a held voice at the tail). */
  headSilenceS: number;
  tailSilenceS: number;
  noiseFloorDb: number;
  clippedSamples: number;
  dcOffset: number;
  /** Stereo only: 1 = the same signal in both channels. */
  stereoCorrelation?: number;
  /** For a file meant to repeat: does it wrap without a click or a level jump? */
  loop?: { wrapLevelJumpDb: number; wrapClick: boolean; couldLoop: boolean };
  flags: string[];
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

function wrapCheck(channels: readonly Float32Array[], sampleRate: number) {
  // Level either side of the wrap, over 20 ms.
  const span = Math.max(1, Math.round(0.02 * sampleRate));
  const level = activity(channels);
  const n = level.length;
  let head = 0;
  let tail = 0;
  for (let i = 0; i < Math.min(span, n); i++) head += level[i]! * level[i]!;
  for (let i = Math.max(0, n - span); i < n; i++) tail += level[i]! * level[i]!;
  const jump = Math.abs(toDb(Math.sqrt(head / span)) - toDb(Math.sqrt(tail / span)));
  // A click: the step from the last sample to the first is far bigger than the steps around it.
  let click = false;
  for (const channel of channels) {
    if (channel.length < 64) continue;
    let typical = 0;
    for (let i = 1; i < 32; i++) typical += Math.abs(channel[i]! - channel[i - 1]!) + Math.abs(channel[n - i]! - channel[n - i - 1]!);
    typical /= 62;
    const wrap = Math.abs(channel[0]! - channel[n - 1]!);
    if (wrap > Math.max(4 * typical, 0.01)) click = true;
  }
  return { jump, click };
}

export function analyze(audio: Audio, options: { expectLoop?: boolean } = {}): Analysis {
  const { channels, sampleRate } = audio;
  const frames = channels[0]?.length ?? 0;
  const durationS = frames / sampleRate;
  const flags: string[] = [];

  let lufsIntegrated: number | null = null;
  let lufsMomentaryMax: number | null = null;
  let truePeakDbtp: number | null = null;
  if (channels.length <= 2 && frames > 0) {
    const loudness = measureLoudness(channels, sampleRate);
    lufsIntegrated = loudness.integrated;
    lufsMomentaryMax = loudness.momentaryMax;
    truePeakDbtp = loudness.truePeak;
  }

  let peak = 0;
  let clipped = 0;
  let dc = 0;
  for (const channel of channels) {
    let sum = 0;
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i]!);
      if (value > peak) peak = value;
      if (value >= 0.9999) clipped += 1;
      sum += channel[i]!;
    }
    dc = Math.max(dc, Math.abs(sum / Math.max(1, channel.length)));
  }

  const level = activity(channels);
  const measured = frames > 0 ? measure(level, sampleRate) : null;
  const tighten = frames > 0 ? findTighten(level, sampleRate) : null;
  const headSilenceS = tighten?.headS ?? 0;
  const tailSilenceS = tighten?.tailS ?? 0;

  let stereoCorrelation: number | undefined;
  let oneSided = false;
  let balanced = false;
  if (channels.length === 2) {
    const [l, r] = channels as [Float32Array, Float32Array];
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < frames; i++) {
      lr += l[i]! * r[i]!;
      ll += l[i]! * l[i]!;
      rr += r[i]! * r[i]!;
    }
    // One silent channel is a hard pan, not two copies of one signal (Codex review, finding 18).
    stereoCorrelation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : ll === 0 && rr === 0 ? 1 : 0;
    oneSided = (ll === 0) !== (rr === 0);
    // Correlation ignores gain: a mono source panned off centre correlates fully too. Two copies of
    // one signal also match in level, within about 0.1 dB (Codex recheck 2026-11-10, R8).
    balanced = ll > 0 && rr > 0 && Math.min(ll, rr) / Math.max(ll, rr) > 0.977;
  }

  // ── Flags, in the words a game developer needs ──────────────────────────────────────
  if (frames === 0 || peak === 0) flags.push("Silent: there is no audio in this file.");
  if (headSilenceS >= 0.01) {
    flags.push(`Starts with ${Math.round(headSilenceS * 1000)} ms of silence: the sound will lag behind whatever triggers it. Trim it.`);
  }
  if (tailSilenceS >= 0.25 && !options.expectLoop) {
    flags.push(`Ends with ${tailSilenceS.toFixed(2)} s of silence: it holds a voice slot for nothing. Trim it.`);
  }
  if (clipped > 0) flags.push(`${clipped} samples at full scale: probably clipped. Regenerate or turn the source down.`);
  else if (truePeakDbtp !== null && truePeakDbtp > -1) {
    flags.push(`True peak ${truePeakDbtp.toFixed(1)} dBTP: over −1, it can distort once encoded or mixed.`);
  }
  if (dc > 0.01) flags.push(`DC offset ${dc.toFixed(3)}: the waveform sits off centre, which can thump when it starts or stops.`);
  if (oneSided && peak > 0) {
    flags.push("One channel is silent: the sound plays from one side only. Intended? If not, save it as mono.");
  } else if (stereoCorrelation !== undefined && stereoCorrelation > 0.995 && balanced && peak > 0) {
    flags.push("Stereo file with the same audio in both channels: save it as mono and it costs half the memory.");
  }
  if (stereoCorrelation !== undefined && stereoCorrelation < -0.3) {
    flags.push("Channels largely out of phase: it may vanish on a mono speaker (phones, some laptops).");
  }
  if (lufsMomentaryMax !== null && peak > 0 && lufsMomentaryMax < -40) {
    flags.push(`Very quiet (${lufsMomentaryMax.toFixed(1)} LUFS-M max): it will need a lot of gain.`);
  }

  let loop: Analysis["loop"];
  if (options.expectLoop && frames > 0) {
    const wrap = wrapCheck(channels, sampleRate);
    const couldLoop = findLoop(channels, sampleRate) !== null;
    loop = { wrapLevelJumpDb: round(wrap.jump), wrapClick: wrap.click, couldLoop };
    if (wrap.click) flags.push("Loop wraps with a click: the last sample does not meet the first. Run it through finish_sounds with shape: loop.");
    else if (wrap.jump > 1.5) flags.push(`Loop wraps with a ${wrap.jump.toFixed(1)} dB level jump: audible on every repeat.`);
  }

  return {
    durationS: round(durationS, 3),
    sampleRate,
    channels: channels.length,
    lufsIntegrated: lufsIntegrated === null ? null : round(lufsIntegrated, 1),
    lufsMomentaryMax: lufsMomentaryMax === null ? null : round(lufsMomentaryMax, 1),
    truePeakDbtp: truePeakDbtp === null ? null : round(truePeakDbtp, 1),
    samplePeakDbfs: round(toDb(peak), 1),
    headSilenceS: round(headSilenceS, 3),
    tailSilenceS: round(tailSilenceS, 3),
    noiseFloorDb: round(measured?.floorDb ?? -120, 1),
    clippedSamples: clipped,
    dcOffset: round(dc, 4),
    ...(stereoCorrelation !== undefined ? { stereoCorrelation: round(stereoCorrelation, 3) } : {}),
    ...(loop ? { loop } : {}),
    flags,
  };
}

/**
 * Across a set: which files stand out from their neighbours. Compares like with like, on the
 * reading each kind of sound is matched on.
 */
export function compareSet(items: { name: string; analysis: Analysis; isLoop: boolean }[]): string[] {
  const notes: string[] = [];
  const groups: [string, { name: string; value: number }[]][] = [
    ["one-shots (LUFS-M max)", items.filter((i) => !i.isLoop && i.analysis.lufsMomentaryMax !== null).map((i) => ({ name: i.name, value: i.analysis.lufsMomentaryMax! }))],
    ["loops (LUFS-I)", items.filter((i) => i.isLoop && i.analysis.lufsIntegrated !== null).map((i) => ({ name: i.name, value: i.analysis.lufsIntegrated! }))],
  ];
  for (const [label, values] of groups) {
    if (values.length < 3) continue;
    const sorted = values.map((v) => v.value).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    for (const { name, value } of values) {
      const off = value - median;
      if (Math.abs(off) >= 4) {
        notes.push(`${name} is ${Math.abs(off).toFixed(1)} dB ${off > 0 ? "louder" : "quieter"} than the middle of the ${label}. Intended? If not, run finish_sounds on it.`);
      }
    }
  }
  return notes;
}
