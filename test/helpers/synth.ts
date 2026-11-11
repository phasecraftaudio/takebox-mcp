/**
 * Synthesised material.
 *
 * **The repo contains no audio, and this is how it stays that way.** Every fixture the
 * tests use and every take in the demo bank is generated here, deterministically, from a
 * seed. No licensed library content ever enters version control, nothing has to be
 * redistributed, and the whole demo weighs a few hundred lines rather than a few hundred
 * megabytes.
 *
 * ⚠️ **This is deliberately not good-sounding, and it must not become the product's voice.**
 * It is filtered noise with an envelope: enough to prove the engine works and to let someone
 * play PHASEFLOW in the first ten seconds, nowhere near enough to ship as content. The
 * recorded bank replaces it as *material*; this stays as *fixtures*.
 */


/** mulberry32 — small, fast, deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StepOptions {
  sampleRate?: number;
  level?: number;
  /** 0 = dull thud, 1 = bright slap. Drives the one-pole lowpass. */
  brightness?: number;
  decayMs?: number;
  leadingSilenceMs?: number;
  totalMs?: number;
  seed?: number;
  /** Absolute room-tone amplitude. Defaults to `0.001 * level`. */
  noiseFloor?: number;
}

/**
 * A filtered noise burst with a fast attack and exponential decay. Crude, but it has the
 * two properties the analysis depends on: a clear transient to find, and a timbre that
 * moves with `brightness`.
 */
export function synthStep(options: StepOptions = {}): Float32Array {
  const sampleRate = options.sampleRate ?? 48000;
  const level = options.level ?? 0.5;
  const brightness = options.brightness ?? 0.5;
  const decayMs = options.decayMs ?? 120;
  const leadingSilenceMs = options.leadingSilenceMs ?? 50;
  const totalMs = options.totalMs ?? 400;
  const random = prng(options.seed ?? 1);

  const total = Math.round((totalMs / 1000) * sampleRate);
  const onset = Math.round((leadingSilenceMs / 1000) * sampleRate);
  const tau = (decayMs / 1000) * sampleRate;
  const out = new Float32Array(total);

  const coefficient = 0.02 + 0.95 * brightness;
  let filtered = 0;

  for (let i = 0; i < total; i++) {
    if (i < onset) {
      // Room tone scales with level, because a quieter take in the same room is the same
      // signal at lower gain. A fixed floor would turn this into an SNR test by accident.
      out[i] = (random() * 2 - 1) * (options.noiseFloor ?? 0.001 * level);
      continue;
    }
    const noise = random() * 2 - 1;
    filtered = filtered + coefficient * (noise - filtered);
    out[i] = filtered * Math.exp(-(i - onset) / tau) * level;
  }

  return out;
}

export interface DragOptions {
  sampleRate?: number;
  level?: number;
  /** 0 = dull rumble, 1 = harsh scrape. Drives the one-pole lowpass. */
  brightness?: number;
  /** How far the body wanders in level, 0..1. Real scrapes are never steady. */
  wander?: number;
  leadingSilenceMs?: number;
  totalMs?: number;
  seed?: number;
  noiseFloor?: number;
}

/**
 * A sustained scrape: filtered noise with a body that wanders instead of holding still.
 *
 * The Sustain node reads short overlapping grains from the body of a take, so it needs
 * material with a *body* — a 120 ms impact gives it nothing to hold. This is that material.
 *
 * Two properties matter and both are deliberate:
 *
 * - **The body wanders.** A steady noise bed granulates into something obviously static,
 *   which would make the Sustain node look worse than it is. Real scrapes modulate.
 * - **The attack is scaled from the body level.** ⚠️ That is a property of *this generator*,
 *   not of real drags, and it is worth being honest about: it means the demo tiers correctly
 *   through `impactDb`, which measures the attack. A real drag library does not have that
 *   courtesy — its energy lives in the sustain, its attacks are near-identical, and tiering
 *   it by attack sorts takes by how sharply each one started. That is exactly the gap the
 *   `sustained` tier mode exists to close, and this file must not be read as evidence that
 *   the gap is closed.
 */
export function synthDrag(options: DragOptions = {}): Float32Array {
  const sampleRate = options.sampleRate ?? 48000;
  const level = options.level ?? 0.5;
  const brightness = options.brightness ?? 0.45;
  const wander = options.wander ?? 0.5;
  const leadingSilenceMs = options.leadingSilenceMs ?? 50;
  const totalMs = options.totalMs ?? 1600;
  const random = prng(options.seed ?? 1);

  const total = Math.round((totalMs / 1000) * sampleRate);
  const onset = Math.round((leadingSilenceMs / 1000) * sampleRate);
  const body = Math.max(1, total - onset);
  const out = new Float32Array(total);

  const coefficient = 0.02 + 0.95 * brightness;
  // Attack and release long enough that a grain reader never lands on a click, short
  // enough that the onset detector still sees an edge to find.
  const attack = Math.min(Math.round(sampleRate * 0.012), Math.floor(body / 4));
  const release = Math.min(Math.round(sampleRate * 0.09), Math.floor(body / 3));

  // Three detuned slow oscillators, so the wander never settles into an audible period.
  const rates = [0.7, 1.9, 3.3].map((r) => (r * 2 * Math.PI) / sampleRate);
  const phases = [random(), random(), random()].map((p) => p * 2 * Math.PI);

  let filtered = 0;

  for (let i = 0; i < total; i++) {
    if (i < onset) {
      out[i] = (random() * 2 - 1) * (options.noiseFloor ?? 0.001 * level);
      continue;
    }
    const t = i - onset;

    const noise = random() * 2 - 1;
    filtered = filtered + coefficient * (noise - filtered);

    let modulation = 0;
    for (let k = 0; k < rates.length; k++) modulation += Math.sin(phases[k]! + rates[k]! * t);
    // /3 brings the three-oscillator sum back to -1..1 before it is scaled by `wander`.
    const envelope = 1 + wander * (modulation / 3);

    const fadeIn = t < attack ? t / attack : 1;
    const fadeOut = t > body - release ? Math.max(0, (body - t) / release) : 1;

    out[i] = filtered * envelope * fadeIn * fadeOut * level;
  }

  return out;
}

export interface LongTakeOptions {
  sampleRate?: number;
  /** Seconds at which each event begins. */
  at: number[];
  /** Per-event level, 0..1. Cycled if shorter than `at`. */
  levels?: number[];
  brightness?: number;
  decayMs?: number;
  /** Room tone for the whole recording, absolute amplitude. */
  noiseFloor?: number;
  totalMs?: number;
  seed?: number;
}

/**
 * A long recording with events at known times — the ground truth the segmenter is scored
 * against.
 *
 * ⭐ Almost nobody building this kind of tool has this. Precision and recall against real
 * material means someone sitting with a waveform and an opinion; here the answer is known
 * before detection runs, so a regression in `segment()` is a failing number rather than a
 * thing somebody notices weeks later in a session.
 *
 * Returns the samples and the true onsets, so a test can assert both that every event was
 * found and that nothing was invented.
 */
export function synthLongTake(options: LongTakeOptions): {
  samples: Float32Array;
  onsets: number[];
} {
  const sampleRate = options.sampleRate ?? 48000;
  const levels = options.levels ?? [0.5];
  const decayMs = options.decayMs ?? 120;
  const noiseFloor = options.noiseFloor ?? 0.0008;
  const random = prng(options.seed ?? 7);

  const last = options.at.length > 0 ? Math.max(...options.at) : 0;
  const totalMs = options.totalMs ?? (last + 1) * 1000;
  const total = Math.round((totalMs / 1000) * sampleRate);

  const out = new Float32Array(total);
  // Room tone across the whole recording — the thing the floor estimate has to survive.
  for (let i = 0; i < total; i++) out[i] = (random() * 2 - 1) * noiseFloor;

  options.at.forEach((seconds, index) => {
    const level = levels[index % levels.length]!;
    const event = synthStep({
      sampleRate,
      level,
      brightness: options.brightness ?? 0.4,
      decayMs,
      leadingSilenceMs: 0,
      totalMs: decayMs * 6,
      // Silent bed: the room tone is already written above, and adding a second copy per
      // event would raise the floor under the loud parts only.
      noiseFloor: 0,
      seed: (options.seed ?? 7) + index * 31 + 1,
    });
    const at = Math.round(seconds * sampleRate);
    for (let i = 0; i < event.length && at + i < total; i++) out[at + i] = out[at + i]! + event[i]!;
  });

  return { samples: out, onsets: [...options.at] };
}
