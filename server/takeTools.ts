/**
 * The three take tools — Tighten, Split, Make loop — between a file on disk and `shared/dsp/`.
 *
 * ffmpeg only moves audio in and out: it decodes whatever the take is into 32-bit float, and the
 * DSP and the WAV encoder do the rest. Every tool writes new files and never touches its input.
 */

import { spawn } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { activity, toDb } from "../shared/dsp/level.js";
import { findLoop, renderLoop } from "../shared/dsp/loop.js";
import { applySafetyGain, renderSpan } from "../shared/dsp/render.js";
import { DEFAULT_TRIM, measure, segment, TRIM_PRESETS } from "../shared/dsp/segment.js";
import { findTighten } from "../shared/dsp/tighten.js";
import { encodeWav24 } from "../shared/dsp/wav.js";

/** Every take TAKEBOX writes is 48 kHz, so the tools work there too. */
export const TOOL_RATE = 48000;

export interface Decoded {
  channels: Float32Array[];
  sampleRate: number;
}

export interface ToolOutput {
  channels: Float32Array[];
  /** One line for the take card: what the tool did. */
  notice: string;
  /** A seamless loop: the card previews it gaplessly. */
  loopable?: boolean;
  /** A split cut near the room: a stray or a soft take, and only listening tells which. */
  faint?: boolean;
}

/** Decode any file ffmpeg can read into float channels at 48 kHz, keeping its channel count. */
export function decodeAudio(
  ffmpeg: string,
  file: string,
  channelCount: number,
  signal?: AbortSignal,
): Promise<Decoded> {
  const count = Math.max(1, Math.floor(channelCount) || 1);
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le",
        "-ar", String(TOOL_RATE), "-ac", String(count), "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"], signal },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg could not decode the take: ${stderr.slice(-400)}`));
        return;
      }
      // Copied into a fresh buffer: a pooled Buffer can start at an offset a Float32Array
      // cannot view.
      const bytes = new Uint8Array(size - (size % (4 * count)));
      let offset = 0;
      for (const chunk of chunks) {
        const take = Math.min(chunk.length, bytes.length - offset);
        if (take <= 0) break;
        bytes.set(chunk.subarray(0, take), offset);
        offset += take;
      }
      const interleaved = new Float32Array(bytes.buffer);
      const frames = interleaved.length / count;
      const channels = Array.from({ length: count }, () => new Float32Array(frames));
      for (let frame = 0; frame < frames; frame++) {
        for (let c = 0; c < count; c++) channels[c]![frame] = interleaved[frame * count + c]!;
      }
      resolve({ channels, sampleRate: TOOL_RATE });
    });
  });
}

/** Write a 48 kHz / 24-bit WAV, atomically: a half-written file never carries the real name. */
export async function writeWav(filePath: string, channels: readonly Float32Array[]) {
  const working = `${filePath}.part`;
  try {
    await writeFile(working, encodeWav24(channels, TOOL_RATE), { mode: 0o644 });
    await rename(working, filePath);
  } catch (error) {
    await rm(working, { force: true });
    throw error;
  }
}

const seconds = (value: number) => `${value.toFixed(value < 1 ? 3 : 2)} s`;

/** Null when there was no silence worth removing. */
export function tightenTake(decoded: Decoded): ToolOutput | null {
  const span = findTighten(activity(decoded.channels), decoded.sampleRate);
  if (!span || !span.changed) return null;
  return {
    channels: renderSpan(decoded.channels, decoded.sampleRate, span),
    notice: `Tightened · ${seconds(span.headS)} off the head · ${seconds(span.tailS)} off the tail`,
  };
}

/**
 * One output per detected sound. Empty when nothing separate was found.
 *
 * ⚠️ **Every detected cut is kept, however faint.** A faint cut is flagged, never dropped. Level
 * cannot tell a stray from a soft take. Measured: the strays in the real footstep take (TAKEBOX
 * listening pass, 2026-11-10) sit 18.6–22.2 dB above the room, and a deliberate soft tier in a
 * mixed-force session sits 24–26 dB above it (Codex footstep review, 2026-11-11). Both are about
 * 30 dB under the loud cuts. A filter that dropped the strays silently took the soft tier with
 * them, five takes of ten, with nothing said. A stray left in can be rejected; a soft take
 * dropped is gone from the bank.
 */
export function splitTake(decoded: Decoded, presetId?: string): ToolOutput[] {
  const settings = TRIM_PRESETS.find((preset) => preset.id === presetId)?.settings ?? DEFAULT_TRIM;
  const regions = segment(measure(activity(decoded.channels), decoded.sampleRate), settings);
  return regions.map((region, index) => {
    const length = region.end - region.start;
    const notes = [`Cut ${index + 1} of ${regions.length}`, seconds(length)];
    if (region.flags.includes("truncated")) notes.push("tail cut short by the next sound");
    const faint = region.flags.includes("low-contrast");
    if (faint) notes.push("faint, check it");
    return {
      ...(faint ? { faint } : {}),
      channels: renderSpan(decoded.channels, decoded.sampleRate, {
        start: region.start,
        end: region.end,
        fadeInS: 0.002,
        // A region that ends where the next sound starts is cut mid-tail: it needs the fade most.
        fadeOutS: Math.min(0.03, length * 0.25),
      }),
      notice: notes.join(" · "),
    };
  });
}

/** Null when the take has no steady part long enough to loop. */
export function loopTake(decoded: Decoded, kind: "sfx" | "tts" | "music"): ToolOutput | null {
  const points = findLoop(decoded.channels, decoded.sampleRate, {
    // Music hides a longer join better; anything else keeps the one-second default.
    maxCrossfadeS: kind === "music" ? 2 : 1,
  });
  if (!points) return null;
  const channels = renderLoop(decoded.channels, decoded.sampleRate, points);
  const gain = applySafetyGain(channels);
  const notes = [`Loop ${seconds(points.end - points.start)}`, `join ${seconds(points.crossfadeS)}`];
  if (Math.abs(points.levelDifferenceDb) > 1.5) {
    notes.push(`join level differs by ${Math.abs(points.levelDifferenceDb).toFixed(1)} dB, listen to it`);
  }
  if (gain < 1) notes.push(`turned down ${Math.abs(toDb(gain)).toFixed(1)} dB so the join does not clip`);
  return { channels, notice: notes.join(" · "), loopable: true };
}
