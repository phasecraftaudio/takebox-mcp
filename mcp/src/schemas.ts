/**
 * Input shapes shared by the MCP tools and the board's HTTP routes, so a paid request is checked
 * the same way whichever door it comes through (Codex review 2026-11-09, finding 7).
 */

import { z } from "zod";
import { FORMATS } from "./audio/codecs.js";
import { ROLE_TARGETS, ROLES } from "./audio/level.js";
import { SPLIT_PRESETS } from "./finish.js";
import { KINDS } from "./project.js";

export const formatList = z.array(z.enum(FORMATS)).min(1).max(4);

export const soundSpec = z.object({
  name: z.string().min(1).max(80).describe("File name stem, engine-safe: coin_pickup → coin_pickup_01.ogg. Same name again adds new takes."),
  prompt: z.string().min(3).max(450).describe("Source + action + context + quality, 10–60 words, ending with the game's direction. See the guide."),
  kind: z.enum(KINDS).default("one-shot").describe("one-shot (trimmed), sequence (several hits split into files: footsteps), loop (seamless ambience)."),
  role: z.enum(ROLES).optional().describe(`Sets the level: ${Object.entries(ROLE_TARGETS).map(([r, t]) => `${r} ${t.lufs}`).join(", ")} LUFS. Default by kind.`),
  variations: z.number().int().min(1).max(8).default(1).describe("Takes to generate. 3–6 for sounds that repeat often."),
  duration_s: z.number().finite().min(0.5).max(30).optional().describe("Seconds generated (and paid for). Defaults: one-shot 2, sequence 6, loop 15."),
  influence: z.number().finite().min(0).max(1).optional().describe("How literally to follow the prompt: 0.5–0.6 UI/digital, 0.3–0.45 organic."),
  split_preset: z.enum(SPLIT_PRESETS).optional().describe("Sequences only: how to find each hit. footsteps (default), cloth, impacts, dense."),
});

const credits = z.number().int().nonnegative().optional();

export const boardMake = z.object({ sounds: z.array(soundSpec).min(1).max(40), dry_run: z.boolean().optional(), confirm_credits: credits });
export const boardRedo = z.object({
  name: z.string().min(1).max(80),
  prompt: z.string().max(450).optional(),
  variations: z.number().int().min(1).max(8).optional(),
  dry_run: z.boolean().optional(),
  confirm_credits: credits,
});
/** Several sounds' new takes as one batch: one estimate, one yes (Ryu, 11-10). */
export const boardRedoMany = z.object({
  sounds: z
    .array(z.object({ name: z.string().min(1).max(80), prompt: z.string().max(450).optional(), variations: z.number().int().min(1).max(8).optional() }))
    .min(1)
    .max(40),
  dry_run: z.boolean().optional(),
  confirm_credits: credits,
});
export const boardAudition = z.object({ styles: z.array(z.string().min(2).max(120)).min(1).max(4), dry_run: z.boolean().optional(), confirm_credits: credits });
export const boardDirection = z.object({ direction: z.string().max(200) });
export const boardDisposition = z.object({ value: z.enum(["keep", "reject"]) });
export const boardRegion = z.object({ start: z.number().finite().min(0), end: z.number().finite().min(0) });
export const boardTool = z.object({ preset: z.enum(SPLIT_PRESETS).optional() });
export const boardReveal = z.object({ id: z.string().min(1).max(400) });
