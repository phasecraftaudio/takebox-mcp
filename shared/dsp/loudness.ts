/**
 * Loudness and true peak, after ITU-R BS.1770-4 / EBU R 128.
 *
 * TAKEBOX shows these so a game's sounds can be balanced against each other by number instead of
 * by ear across forty files. It measures; it never changes the audio.
 *
 * ── Three numbers, and which one to compare ─────────────────────────────────────────────
 *
 * - **Integrated (LUFS-I)**: the whole take, gated so silence does not drag it down. The standard
 *   for music, voice and ambience. Undefined below 400 ms, because the standard measures in
 *   400 ms blocks.
 * - **Momentary max (LUFS-M)**: the loudest 400 ms. ⚠️ **This is the one to compare between
 *   one-shots**: a click, a coin and a punch are shorter than a block, or are mostly decay, and
 *   their integrated reading says more about their tails than their hits. A sound shorter than
 *   400 ms is padded with silence to one block *before* K-weighting, so the filter's own ring-out
 *   counts, exactly as a meter would see the sound followed by silence.
 * - **True peak (dBTP)**: the highest point of the reconstructed waveform, from 4× oversampling,
 *   which can sit above the highest sample. Over −1 dBTP risks clipping once a game mixes it.
 *
 * The K-weighting filter coefficients are computed for any rate from the formulas libebur128
 * uses; at 48 kHz they reproduce the table printed in BS.1770 (a test pins that).
 *
 * ⚠️ **Mono and stereo only.** BS.1770 weights surround channels by speaker and leaves the LFE
 * out, and a bare array of channels does not say which is which. TAKEBOX only ever makes mono
 * and stereo takes, so anything wider is refused rather than measured on a guessed layout.
 */

import { MIN_DB } from "./level.js";

export interface Loudness {
  /** LUFS, or null for a take shorter than one 400 ms block or silent throughout. */
  integrated: number | null;
  /** LUFS: the loudest 400 ms. */
  momentaryMax: number;
  /** dBTP. */
  truePeak: number;
}

const BLOCK_S = 0.4;
const HOP_S = 0.1;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** BS.1770's two K-weighting stages for a sample rate: the head shelf, then the high-pass. */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: a high shelf modelling the acoustic effect of the head.
  let f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  // Stage 2: the RLB high-pass.
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highPass: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  return [shelf, highPass];
}

function filter(input: Float32Array, stages: readonly Biquad[]): Float64Array {
  let signal: Float64Array = Float64Array.from(input);
  for (const { b0, b1, b2, a1, a2 } of stages) {
    const out = new Float64Array(signal.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let n = 0; n < signal.length; n++) {
      const x = signal[n]!;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[n] = y;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
    }
    signal = out;
  }
  return signal;
}

const toLufs = (energy: number) => (energy > 0 ? -0.691 + 10 * Math.log10(energy) : MIN_DB);

/** Tap count either side of each interpolated point. ±12 keeps the error well under 0.1 dB. */
const TRUE_PEAK_TAPS = 12;

/**
 * 4× oversampled peak, with a Hann-windowed sinc.
 *
 * Each interpolated point is Σ x[n + j]·h[j], so it can be no larger than the loudest sample under
 * the kernel times Σ|h|. An interval whose bound cannot beat the peak found so far is skipped —
 * a bound over every tap, never a guess from the two neighbouring samples, which can sit far
 * below a peak the outer taps build (Codex review 2026-10-19, finding 2).
 */
function truePeakOf(channels: readonly Float32Array[]): number {
  let samplePeak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) samplePeak = Math.max(samplePeak, Math.abs(channel[i]!));
  }
  if (samplePeak === 0) return 0;

  const phases = [0.25, 0.5, 0.75].map((fraction) => {
    const taps = new Float64Array(2 * TRUE_PEAK_TAPS);
    for (let j = -TRUE_PEAK_TAPS + 1; j <= TRUE_PEAK_TAPS; j++) {
      const t = j - fraction;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * t) / (TRUE_PEAK_TAPS + 1));
      taps[j + TRUE_PEAK_TAPS - 1] = sinc * window;
    }
    return taps;
  });

  const gain = Math.max(...phases.map((taps) => taps.reduce((sum, tap) => sum + Math.abs(tap), 0)));
  // Loudest sample in each run of 2·TAPS samples: one kernel's reach always spans at most two runs.
  const run = 2 * TRUE_PEAK_TAPS;
  let peak = samplePeak;
  for (const channel of channels) {
    const runMax = new Float64Array(Math.ceil(channel.length / run));
    for (let i = 0; i < channel.length; i++) {
      const at = Math.floor(i / run);
      runMax[at] = Math.max(runMax[at]!, Math.abs(channel[i]!));
    }
    for (let n = 0; n < channel.length - 1; n++) {
      const first = Math.max(0, Math.floor((n - TRUE_PEAK_TAPS + 1) / run));
      const last = Math.min(runMax.length - 1, Math.floor((n + TRUE_PEAK_TAPS) / run));
      let reach = 0;
      for (let r = first; r <= last; r++) reach = Math.max(reach, runMax[r]!);
      if (reach * gain <= peak) continue;
      // Points between n and n + 1.
      for (const taps of phases) {
        let value = 0;
        for (let j = -TRUE_PEAK_TAPS + 1; j <= TRUE_PEAK_TAPS; j++) {
          const index = n + j;
          if (index >= 0 && index < channel.length) value += channel[index]! * taps[j + TRUE_PEAK_TAPS - 1]!;
        }
        peak = Math.max(peak, Math.abs(value));
      }
    }
  }
  return peak;
}

export function measureLoudness(channels: readonly Float32Array[], sampleRate: number): Loudness {
  if (channels.length < 1 || channels.length > 2) {
    throw new Error(
      `Loudness is measured for mono and stereo takes; this one has ${channels.length} channels and no known speaker layout.`,
    );
  }
  const originalLength = channels[0]?.length ?? 0;
  const block = Math.round(BLOCK_S * sampleRate);
  const hop = Math.round(HOP_S * sampleRate);
  // A sound shorter than a block is padded before filtering, so the filter's decay is measured.
  const padded =
    originalLength < block
      ? channels.map((channel) => {
          const out = new Float32Array(block);
          out.set(channel);
          return out;
        })
      : channels;
  const length = padded[0]!.length;
  const stages = kWeighting(sampleRate);
  const weighted = padded.map((channel) => filter(channel, stages));

  // Prefix sums of squared weighted samples, per channel: each block is then O(1).
  const sums = weighted.map((signal) => {
    const prefix = new Float64Array(signal.length + 1);
    for (let n = 0; n < signal.length; n++) prefix[n + 1] = prefix[n]! + signal[n]! * signal[n]!;
    return prefix;
  });
  const blockEnergy = (from: number) => {
    const to = Math.min(length, from + block);
    let energy = 0;
    // Left and right both weigh 1 in BS.1770.
    for (const prefix of sums) energy += (prefix[to]! - prefix[from]!) / block;
    return energy;
  };

  const energies: number[] = [];
  for (let from = 0; from + block <= length; from += hop) energies.push(blockEnergy(from));

  const momentaryMax = toLufs(Math.max(0, ...energies));

  let integrated: number | null = null;
  if (originalLength >= block) {
    const aboveAbsolute = energies.filter((energy) => toLufs(energy) > ABSOLUTE_GATE);
    if (aboveAbsolute.length > 0) {
      const mean = aboveAbsolute.reduce((sum, energy) => sum + energy, 0) / aboveAbsolute.length;
      const relative = toLufs(mean) + RELATIVE_GATE;
      const gated = aboveAbsolute.filter((energy) => toLufs(energy) > relative);
      if (gated.length > 0) integrated = toLufs(gated.reduce((sum, energy) => sum + energy, 0) / gated.length);
    }
  }

  const peak = truePeakOf(channels);
  return {
    integrated,
    momentaryMax,
    truePeak: peak > 0 ? 20 * Math.log10(peak) : MIN_DB,
  };
}
