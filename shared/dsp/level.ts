/**
 * Level measurement shared by tighten, split and loop.
 *
 * ⭐ **Everything in `shared/dsp/` is pure TypeScript with no Node or browser dependency.**
 * It runs in TAKEBOX's service and in PHASEFLOW's browser build alike, and it is small enough
 * to port line for line to C++ when PHASEFLOW moves to JUCE. Keep it that way: no imports from
 * outside this folder, no `AudioBuffer`, no `fs`.
 *
 * `envelope`, `rms` and `toDb` are carried over from PHASEFLOW's `src/audio/analyze.ts`.
 * PHASECRAFT wrote both and releases this copy under Apache-2.0 with the rest of TAKEBOX.
 */

export const MIN_DB = -120;

export function rms(signal: Float32Array, start: number, length: number): number {
  const from = Math.max(0, start);
  const to = Math.min(signal.length, from + length);
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i]! * signal[i]!;
  return Math.sqrt(sum / (to - from));
}

export function envelope(signal: Float32Array, windowSize: number, hopSize: number): Float64Array {
  const count = Math.max(1, Math.ceil(signal.length / hopSize));
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = rms(signal, i * hopSize, windowSize);
  return out;
}

export function toDb(amplitude: number): number {
  if (amplitude <= 0) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(amplitude));
}

export function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * How much is happening at each sample across every channel: the root of the mean square.
 * Level analysis — where a sound starts and ends, where the steady part is — runs on this.
 *
 * ⚠️ **Never on (L + R) / 2.** A sum cancels whatever is out of phase between the channels: a
 * side-only sound, an inverted channel, a wide stereo effect. The tools would then cut away audio
 * the listener plainly hears (Codex review 2026-10-19, finding 1). Energy cannot cancel. Anything
 * that needs the waveform's sign — correlation — works channel by channel, and rendering always
 * uses the real channels.
 */
export function activity(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) out[i] = out[i]! + channel[i]! * channel[i]!;
  const scale = 1 / Math.max(1, channels.length);
  for (let i = 0; i < length; i++) out[i] = Math.sqrt(out[i]! * scale);
  return out;
}
