import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Audio } from "../src/audio/pcm.js";

export const RATE = 48000;

export function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function sine(seconds: number, frequency: number, amplitude: number, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / rate);
  return out;
}

/** A decaying noise burst: a footstep, a hit, a click. */
export function burst(seconds: number, amplitude: number, decayS: number, seed = 1, rate = RATE): Float32Array {
  const random = prng(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * amplitude * Math.exp(-i / (decayS * rate));
  return out;
}

export function noise(seconds: number, amplitude: number, seed = 7, rate = RATE): Float32Array {
  const random = prng(seed);
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * amplitude;
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const silence = (seconds: number, rate = RATE) => new Float32Array(Math.round(seconds * rate));

export const mono = (channel: Float32Array, rate = RATE): Audio => ({ channels: [channel], sampleRate: rate });

export function rmsOf(signal: Float32Array, from = 0, to = signal.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i]! * signal[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

export const tempDir = (prefix = "takebox-test-") => mkdtemp(path.join(os.tmpdir(), prefix));
