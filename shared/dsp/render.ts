/**
 * Turning analysis into audio: cut a span out of a take, with fades at the cut points only.
 *
 * ⚠️ **Fades go where a cut was made, and nowhere else.** TAKEBOX promises no processing, so a
 * take whose head was not trimmed keeps its first sample exactly as it was. A cut, though, lands
 * mid-waveform, and a cut without a fade is a click in somebody's game every time the sound
 * plays. That is the one change made, and the result reports how long each fade was.
 *
 * No zero-crossing snap. A fade that ends at exactly zero gain makes it unnecessary, and in
 * stereo the two channels do not cross zero together anyway.
 */

export interface Span {
  /** Seconds into the source. */
  start: number;
  end: number;
  /** Fade lengths in seconds. Zero means the sample at that edge is left untouched. */
  fadeInS: number;
  fadeOutS: number;
}

/** Half-cosine. Smoother onset than linear, and still exactly 0 and 1 at the ends. */
function fadeInGain(index: number, length: number): number {
  return 0.5 - 0.5 * Math.cos((Math.PI * index) / length);
}

export function renderSpan(
  channels: readonly Float32Array[],
  sampleRate: number,
  span: Span,
): Float32Array[] {
  const total = channels[0]?.length ?? 0;
  const from = Math.max(0, Math.min(total, Math.round(span.start * sampleRate)));
  const to = Math.max(from, Math.min(total, Math.round(span.end * sampleRate)));
  const length = to - from;

  let fadeIn = Math.max(0, Math.round(span.fadeInS * sampleRate));
  let fadeOut = Math.max(0, Math.round(span.fadeOutS * sampleRate));
  if (fadeIn + fadeOut > length) {
    const scale = length / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * scale);
    fadeOut = Math.floor(fadeOut * scale);
  }

  return channels.map((source) => {
    const out = source.slice(from, to);
    // Fade in: the first sample is exactly silent.
    for (let i = 0; i < fadeIn; i++) out[i] = out[i]! * fadeInGain(i, fadeIn);
    // Fade out: the last sample is exactly silent.
    for (let j = 0; j < fadeOut; j++) {
      const i = length - fadeOut + j;
      out[i] = out[i]! * fadeInGain(fadeOut - 1 - j, fadeOut);
    }
    return out;
  });
}

/** Largest absolute sample across every channel. */
export function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const value = Math.abs(channel[i]!);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/** Just under full scale, so a 24-bit integer never wraps. */
const CEILING = 0.999;

/**
 * Turn the whole result down — never clip it — if a render went over full scale.
 *
 * Only a loop crossfade can do this: summing two uncorrelated passages with equal-power gains
 * keeps the *average* level, but individual peaks can stack. Returns the gain applied (1 when
 * nothing was needed) so the caller can tell the user rather than change their level silently.
 */
export function applySafetyGain(channels: Float32Array[]): number {
  const peak = peakOf(channels);
  if (peak <= CEILING) return 1;
  const gain = CEILING / peak;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * gain;
  return gain;
}
