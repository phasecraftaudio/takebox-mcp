/**
 * Style: how someone with no sound vocabulary picks a direction. By ear, not by words.
 *
 * A style audition makes the same three sounds — a jump, a coin and a hit — in each chosen
 * direction, one take each, so they can be heard side by side. The person picks the one that
 * sounds like their game, and that line becomes the direction every later prompt carries.
 *
 * The presets are starting points written as directions (materials and character), the form the
 * guide asks for. Any free text works too. ⚠️ Draft wording until Ryu has heard them.
 */

import { buildTemplatePrompt, getGameTemplate, type GameTemplate } from "../../shared/gameTemplates.js";
import type { SoundSpec } from "./make.js";

export interface StylePreset {
  id: string;
  name: string;
  /** The line saved as the direction. */
  direction: string;
  /** One line for the person choosing. */
  about: string;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  { id: "cozy-wooden", name: "Cozy wooden", direction: "soft wooden toy-like, warm and rounded", about: "Farming, puzzle and cozy games. Gentle, tactile, never harsh." },
  { id: "cartoon", name: "Bouncy cartoon", direction: "bouncy cartoon, rubbery and playful, bright", about: "Platformers and party games. Springy and exaggerated." },
  { id: "chiptune", name: "8-bit chiptune", direction: "bright 8-bit chiptune, square waves", about: "Retro and arcade. Synthesised blips, no real-world sound." },
  { id: "realistic", name: "Gritty realistic", direction: "gritty realistic foley, heavy and physical", about: "Action, survival, shooters. Real materials with weight." },
  { id: "sci-fi", name: "Glassy sci-fi", direction: "clean glassy sci-fi, digital shimmer", about: "Space and tech. Synthetic, precise, a little cold." },
  { id: "dark-fantasy", name: "Dark fantasy", direction: "dark fantasy, stone, iron and old magic", about: "RPGs and dungeons. Weighty, ancient, a little ominous." },
  { id: "horror", name: "Horror", direction: "cold horror, scraping metal, breathy and unsettling", about: "Horror and tension. Uncomfortable on purpose." },
  { id: "cute-magic", name: "Cute magic", direction: "cute sparkly magic, bells and soft chimes", about: "Cute and kids' games. Twinkly and kind." },
  { id: "arcade-punch", name: "Punchy arcade", direction: "punchy modern arcade, snappy and loud", about: "Fast action and mobile. Bold, short, satisfying." },
  { id: "natural", name: "Calm natural", direction: "calm natural sounds, wood, water and leaves", about: "Exploration and relaxing games. Soft and organic." },
];

/**
 * A template's prompt in a game's direction. The direction goes on as a closing style note, never
 * into the template's material slot: "landing on {the ground}" must not become "landing on soft
 * wooden toy-like, warm and rounded" (caught on the board's first render, 2026-11-09).
 */
export function templatePrompt(template: GameTemplate, direction: string): string {
  const base = buildTemplatePrompt(template, "");
  const style = direction.trim().replace(/[.;,\s]+$/, "");
  return (style ? `${base} Style: ${style}.` : base).slice(0, 450);
}

const RETRO_AUDIO = /chiptune|\b(8|16)[- ]?bit\b|\bretro\b|square[- ]wave/i;

export const slugOf = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "style";

/** Resolve a preset id, or take free text as a direction of its own. */
export function resolveStyle(idOrDirection: string): { key: string; label: string; direction: string } {
  const preset = STYLE_PRESETS.find((p) => p.id === idOrDirection);
  if (preset) return { key: preset.id, label: preset.name, direction: preset.direction };
  const direction = idOrDirection.trim().replace(/\s+/g, " ").slice(0, 120);
  return { key: slugOf(direction), label: direction, direction };
}

/** The three audition sounds, written in one direction from TAKEBOX's templates. */
export function auditionSpecs(direction: string): SoundSpec[] {
  const retro = RETRO_AUDIO.test(direction);
  const picks: [string, string][] = retro
    ? [["jump", "rt-jump"], ["coin", "rt-coin"], ["hit", "rt-explosion"]]
    : [["jump", "pl-jump"], ["coin", "rw-coin"], ["hit", "cb-punch"]];
  return picks.map(([name, id]) => {
    const template = getGameTemplate(id)!;
    return {
      name,
      prompt: templatePrompt(template, direction),
      kind: "one-shot",
      role: name === "hit" ? "impact" : "sfx",
      variations: 1,
      duration_s: template.durationS,
      influence: template.influence,
    };
  });
}
