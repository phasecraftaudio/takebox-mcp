/**
 * Sample-rate conversion with a Blackman-windowed sinc.
 *
 * Only used when someone asks for a rate the source does not have (a 44.1 kHz library file going
 * into a 48 kHz project, say). Generated takes arrive at 48 kHz and never pass through here.
 *
 * Going down, the cutoff drops to the new Nyquist so nothing above it folds back as aliasing.
 * The cutoff sits at 95 % of Nyquist: the last 5 % is the filter's transition band.
 */

const ZERO_CROSSINGS = 24;
const CUTOFF = 0.95;

function blackman(x: number): number {
  // x in [-1, 1]
  return 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
}

export function resample(channels: readonly Float32Array[], fromRate: number, toRate: number): Float32Array[] {
  if (fromRate === toRate) return channels.map((channel) => channel.slice());
  if (fromRate <= 0 || toRate <= 0) throw new Error("Sample rates must be positive.");
  const ratio = toRate / fromRate;
  // Fraction of the input Nyquist to keep.
  const cutoff = Math.min(1, ratio) * CUTOFF;
  const halfWidth = Math.ceil(ZERO_CROSSINGS / cutoff);

  return channels.map((input) => {
    const outLength = Math.round(input.length * ratio);
    const out = new Float32Array(outLength);
    for (let n = 0; n < outLength; n++) {
      const t = n / ratio;
      const centre = Math.floor(t);
      let sum = 0;
      for (let k = centre - halfWidth + 1; k <= centre + halfWidth; k++) {
        if (k < 0 || k >= input.length) continue;
        const d = t - k;
        const arg = cutoff * d;
        const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
        sum += input[k]! * cutoff * sinc * blackman(d / halfWidth);
      }
      out[n] = sum;
    }
    return out;
  });
}
