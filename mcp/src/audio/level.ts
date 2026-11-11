/**
 * Levels: one gain per file, so a game's sounds sit together without anyone opening a meter.
 *
 * ── What it does ─────────────────────────────────────────────────────────────────────────
 *
 * A single gain moves the file to a loudness target, and is held back if that would push the
 * true peak over the ceiling. Nothing else: no compressor, no limiter, no EQ. A sound designer can
 * still trust that the shape of the sound is what was made, and a held-back file says so.
 *
 * ── Which loudness ───────────────────────────────────────────────────────────────────────
 *
 * One-shots are matched on their loudest 400 ms (LUFS-M max), because a click, a coin and a punch
 * are mostly attack and decay, and their integrated reading says more about their tails than their
 * hits. Loops, ambience, music and voice are matched on integrated loudness (LUFS-I), the standard
 * for anything that plays for a while. See `shared/dsp/loudness.ts`.
 *
 * ── The role targets ─────────────────────────────────────────────────────────────────────
 *
 * Starting points, not rules. The idea a game mixer works from: the more often a sound plays, the
 * further it sits back; the bigger the moment, the further forward; beds sit under everything.
 * ⚠️ Draft values until Ryu has listened to a full set in a real game.
 */

import { measureLoudness, type Loudness } from "../../../shared/dsp/loudness.js";

export const ROLES = ["ui", "foley", "sfx", "impact", "ambience", "music", "voice"] as const;
export type Role = (typeof ROLES)[number];

export type LevelMeasure = "momentary" | "integrated";

export interface LevelTarget {
  lufs: number;
  measure: LevelMeasure;
}

export const ROLE_TARGETS: Record<Role, LevelTarget> = {
  /** Clicks, confirms, menu moves: heard constantly, never in the way. */
  ui: { lufs: -20, measure: "momentary" },
  /** Footsteps, cloth, small handling: the most frequent sounds in a game. */
  foley: { lufs: -21, measure: "momentary" },
  /** Pickups, doors, jumps: the general middle. */
  sfx: { lufs: -18, measure: "momentary" },
  /** Hits, shots, explosions: the moments that should land. */
  impact: { lufs: -14, measure: "momentary" },
  /** Room tone, weather, places: a bed under everything. */
  ambience: { lufs: -27, measure: "integrated" },
  music: { lufs: -20, measure: "integrated" },
  voice: { lufs: -20, measure: "integrated" },
};

/** True-peak ceiling. Lossy encoding (OGG, MP3) can overshoot by a fraction of a dB; −1 dBTP leaves room. */
export const CEILING_DBTP = -1;

export interface LevelResult {
  gainDb: number;
  before: Loudness;
  /** The reading the target was matched on, before and after. */
  measure: LevelMeasure;
  targetLufs: number;
  reachedLufs: number;
  /** True when the ceiling stopped the file short of its target. */
  heldByPeak: boolean;
  notice: string;
}

function readingOf(loudness: Loudness, measure: LevelMeasure): { value: number; used: LevelMeasure } {
  if (measure === "integrated" && loudness.integrated !== null) return { value: loudness.integrated, used: "integrated" };
  // Shorter than one 400 ms block, or silent after gating: the loudest block is all there is.
  return { value: loudness.momentaryMax, used: "momentary" };
}

/** Measure, decide the gain, apply it in place. Returns null for a silent file. */
export function applyLevel(channels: Float32Array[], sampleRate: number, target: LevelTarget): LevelResult | null {
  const before = measureLoudness(channels, sampleRate);
  const { value, used } = readingOf(before, target.measure);
  if (value <= -100) return null;

  const wanted = target.lufs - value;
  const room = CEILING_DBTP - before.truePeak;
  const gainDb = Math.min(wanted, room);
  const heldByPeak = room < wanted - 0.05;
  const gain = Math.pow(10, gainDb / 20);
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * gain;

  const reached = value + gainDb;
  const label = used === "momentary" ? "LUFS-M max" : "LUFS-I";
  const notice = heldByPeak
    ? `Level ${reached.toFixed(1)} ${label}, ${(target.lufs - reached).toFixed(1)} dB short of ${target.lufs} because its peaks would pass ${CEILING_DBTP} dBTP`
    : `Level ${reached.toFixed(1)} ${label} (${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB)`;
  return { gainDb, before, measure: used, targetLufs: target.lufs, reachedLufs: reached, heldByPeak, notice };
}

/**
 * One gain for several pieces cut from one take: the loudest reaches the target, the rest keep
 * their distance from it, and no piece passes the ceiling. Returns null when every piece is silent.
 *
 * ⚠️ A split is levelled this way, not piece by piece. Levelled one by one, a soft step comes out
 * as loud as a hard one, and a faint stray near the room was turned up 36–39 dB until it was
 * *louder* than the steps (Ryu's real footstep take, 2026-11-11). Together, a soft tier stays soft
 * and a stray stays faint. The gain depends only on the take, so rejecting a cut never moves it.
 */
export function levelTogether(pieces: Float32Array[][], sampleRate: number, target: LevelTarget): (LevelResult | null)[] | null {
  const measured = pieces.map((channels) => {
    const before = measureLoudness(channels, sampleRate);
    return { before, ...readingOf(before, target.measure) };
  });
  const audible = measured.filter((piece) => piece.value > -100);
  if (audible.length === 0) return null;

  const loudest = audible.reduce((a, b) => (b.value > a.value ? b : a));
  const wanted = target.lufs - loudest.value;
  const room = CEILING_DBTP - Math.max(...audible.map((piece) => piece.before.truePeak));
  const gainDb = Math.min(wanted, room);
  const heldByPeak = room < wanted - 0.05;
  const gain = Math.pow(10, gainDb / 20);
  for (const channels of pieces) for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * gain;

  const reached = loudest.value + gainDb;
  const label = loudest.used === "momentary" ? "LUFS-M max" : "LUFS-I";
  const together = `one gain for all ${pieces.length} cuts (${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB), so softer cuts stay softer`;
  const notice = heldByPeak
    ? `Level ${reached.toFixed(1)} ${label} on the loudest cut, ${(target.lufs - reached).toFixed(1)} dB short of ${target.lufs} because a peak would pass ${CEILING_DBTP} dBTP · ${together}`
    : `Level ${reached.toFixed(1)} ${label} on the loudest cut · ${together}`;
  return measured.map((piece) =>
    piece.value > -100
      ? { gainDb, before: piece.before, measure: piece.used, targetLufs: target.lufs, reachedLufs: piece.value + gainDb, heldByPeak, notice }
      : null,
  );
}

/** The target for a role, or an explicit LUFS value measured the way the sound's kind calls for. */
export function targetFor(level: "role" | number, role: Role, isLoop: boolean): LevelTarget {
  if (level === "role") return ROLE_TARGETS[role];
  return { lufs: level, measure: isLoop || role === "ambience" || role === "music" || role === "voice" ? "integrated" : "momentary" };
}
