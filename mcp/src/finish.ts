/**
 * Finishing: turn one take into the file(s) a game uses.
 *
 *   channels → sample rate → shape (trim / loop / split) → level → every requested format
 *
 * Shape uses TAKEBOX's take tools as they are (`server/takeTools.ts`): the same Tighten, Split and
 * Make loop the desktop app runs, already reviewed. Level is one gain per file, or one gain for all
 * the cuts of a split (`audio/level.ts`).
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { loopTake, splitTake, tightenTake } from "../../server/takeTools.js";
import { analyze, type Analysis } from "./audio/analyze.js";
import { EXTENSION, writeAudio, type EncodeOptions, type Format } from "./audio/codecs.js";
import { applyLevel, levelTogether, targetFor, type Role } from "./audio/level.js";
import type { Audio } from "./audio/pcm.js";
import { resample } from "./audio/resample.js";
import { ensureDir, type ChannelMode, type Namer } from "./project.js";

export const SHAPES = ["trim", "loop", "split", "none"] as const;
export type Shape = (typeof SHAPES)[number];
export const SPLIT_PRESETS = ["footsteps", "cloth", "impacts", "dense"] as const;

export interface FinishOptions {
  shape: Shape;
  splitPreset?: string;
  level: "role" | "off" | number;
  role: Role;
  channels: ChannelMode;
  sampleRate?: number;
  formats: Format[];
  encode: EncodeOptions;
}

export interface FinishedPiece {
  audio: Audio;
  notices: string[];
  loopable: boolean;
  /** Warnings about this piece, reported on its own file with its analysis, never cut short. */
  flags?: string[];
}

/**
 * A faint cut may be a stray or a deliberate soft take, and only listening tells which (Codex
 * footstep review, 2026-11-11). So it is kept and named on its own file. The notices of a whole
 * sound are capped at eight, and that cap once hid two of three faint cuts (Codex recheck, R1).
 */
export const FAINT_CUT = "Faint cut: it sat near the room in the take. It may be a stray rather than a sound. Ask the person to listen, and reject it if so.";

function setChannels(audio: Audio, mode: ChannelMode): { audio: Audio; notice?: string } {
  const count = audio.channels.length;
  if (mode === "mono" && count > 1) {
    const frames = audio.channels[0]!.length;
    const mono = new Float32Array(frames);
    for (const channel of audio.channels) for (let i = 0; i < frames; i++) mono[i] = mono[i]! + channel[i]! / count;
    return { audio: { channels: [mono], sampleRate: audio.sampleRate }, notice: `folded ${count} channels to mono` };
  }
  if (mode === "stereo" && count === 1) {
    return { audio: { channels: [audio.channels[0]!, audio.channels[0]!.slice()], sampleRate: audio.sampleRate }, notice: "mono copied to both channels" };
  }
  if (mode === "stereo" && count > 2) {
    return { audio: { channels: audio.channels.slice(0, 2), sampleRate: audio.sampleRate }, notice: `kept the first 2 of ${count} channels` };
  }
  if (count > 2) {
    throw new Error(`This file has ${count} channels. Ask for channels: "stereo" or "mono" to bring it into a game.`);
  }
  return { audio };
}

/** Everything but the writing: returns one piece per output file set (a split returns several). */
export function processTake(source: Audio, options: FinishOptions, kind: "sfx" | "music" = "sfx"): FinishedPiece[] {
  const prep: string[] = [];
  const shaped = setChannels(source, options.channels);
  let audio = shaped.audio;
  if (shaped.notice) prep.push(shaped.notice);
  if (options.sampleRate && options.sampleRate !== audio.sampleRate) {
    prep.push(`resampled ${audio.sampleRate / 1000} → ${options.sampleRate / 1000} kHz`);
    audio = { channels: resample(audio.channels, audio.sampleRate, options.sampleRate), sampleRate: options.sampleRate };
  }

  let pieces: FinishedPiece[];
  switch (options.shape) {
    case "trim": {
      const out = tightenTake(audio);
      pieces = [{ audio: out ? { channels: out.channels, sampleRate: audio.sampleRate } : audio, notices: [out?.notice ?? "Nothing to trim"], loopable: false }];
      break;
    }
    case "loop": {
      const out = loopTake(audio, kind);
      pieces = out
        ? [{ audio: { channels: out.channels, sampleRate: audio.sampleRate }, notices: [out.notice], loopable: true }]
        : [{ audio, notices: ["No steady part long enough to loop: kept as it is, it will not repeat seamlessly. Generate it longer (15 s or more) or with an even, continuous prompt."], loopable: false }];
      break;
    }
    case "split": {
      const outs = splitTake(audio, options.splitPreset);
      if (outs.length > 0) {
        pieces = outs.map((out) => ({
          audio: { channels: out.channels, sampleRate: audio.sampleRate },
          notices: [out.notice],
          loopable: false,
          ...(out.faint ? { flags: [FAINT_CUT] } : {}),
        }));
      } else {
        const out = tightenTake(audio);
        pieces = [{ audio: out ? { channels: out.channels, sampleRate: audio.sampleRate } : audio, notices: ["Found no separate sounds to split; trimmed it as one"], loopable: false }];
      }
      break;
    }
    default:
      pieces = [{ audio, notices: [], loopable: false }];
  }

  for (const piece of pieces) piece.notices.unshift(...prep);
  if (options.level === "off") return pieces;
  const target = targetFor(options.level, options.role, options.shape === "loop");
  // The cuts of one take share one gain (see `levelTogether`); anything else is levelled alone.
  const results = options.shape === "split" && pieces.length > 1
    ? levelTogether(pieces.map((piece) => piece.audio.channels), audio.sampleRate, target) ?? pieces.map(() => null)
    : pieces.map((piece) => applyLevel(piece.audio.channels, piece.audio.sampleRate, target));
  for (const [i, piece] of pieces.entries()) piece.notices.push(results[i]?.notice ?? "Silent: level left alone");
  return pieces;
}

export interface WrittenPiece {
  /** Absolute paths, one per format. */
  files: string[];
  notices: string[];
  analysis: Analysis;
  /** Whether processing actually made a seamless loop. */
  loopable: boolean;
  /** Which piece of the take this is (a split's cut number, else 0). */
  cut: number;
}

/**
 * Write each piece in every format, under the next free number for `stem`.
 *
 * All or nothing: if any format of any piece fails, every file this call wrote is removed and the
 * error is thrown, so no finished file is ever left in the game untracked (Codex review
 * 2026-11-09, finding 8). Each number is claimed before writing and released after.
 */
export async function writePieces(
  pieces: FinishedPiece[],
  folder: string,
  stem: string,
  options: FinishOptions,
  namer: Namer,
  signal?: AbortSignal,
): Promise<WrittenPiece[]> {
  await ensureDir(folder);
  const written: WrittenPiece[] = [];
  const all: string[] = [];
  try {
    for (const [cut, piece] of pieces.entries()) {
      const base = await namer.take(folder, stem);
      try {
        const files: string[] = [];
        const notices = [...piece.notices];
        for (const format of options.formats) {
          const file = path.join(folder, `${base}.${EXTENSION[format]}`);
          notices.push(...(await writeAudio(file, piece.audio, format, options.encode, signal)));
          files.push(file);
          all.push(file);
        }
        if (piece.loopable && options.formats.includes("mp3")) {
          notices.push("MP3 adds a few ms of silence at the start, so an MP3 loop may tick on each repeat; use the OGG or WAV for looping.");
        }
        const analysis = analyze(piece.audio, { expectLoop: piece.loopable || options.shape === "loop" });
        written.push({
          files,
          notices,
          analysis: { ...analysis, flags: [...(piece.flags ?? []), ...analysis.flags] },
          loopable: piece.loopable,
          cut,
        });
      } finally {
        await namer.release(folder, base);
      }
    }
  } catch (error) {
    await Promise.all(all.map((file) => rm(file, { force: true })));
    throw error;
  }
  return written;
}
