/**
 * The planner's eyes: read a game's code and list what in it makes, or should make, a sound.
 *
 * Code finds facts — `onJump` on line 40, `"sfx/coin.ogg"` referenced and missing, Howler already
 * imported — and the AI judges what the game needs, with the guide in `guide.ts`. Nothing here
 * decides taste. A keyword match is evidence for the agent to read, never a verdict.
 *
 * Suggested prompts come from TAKEBOX's game templates (`shared/gameTemplates.ts`), the prompts
 * researched for the desktop app, so the MCP and the app make the same sounds from the same words.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getGameTemplate, type GameTemplate } from "../../shared/gameTemplates.js";
import type { Role } from "./audio/level.js";
import type { Kind } from "./project.js";
import { templatePrompt } from "./styles.js";

const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".html", ".gd", ".tscn", ".cs", ".cpp", ".cc", ".h", ".hpp", ".lua", ".py", ".rs", ".go",
]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".vercel", ".godot", ".import", "Library", "Temp", "Logs",
  "obj", "bin", ".takebox", "vendor", "coverage", "Intermediate", "Saved", "DerivedDataCache", "Binaries", ".venv", "venv", "__pycache__",
  "target", ".cache", ".idea", ".vscode",
]);
/** Source and text files read. Art, meshes and .meta files do not count against it (finding 10). */
const MAX_FILES = 3000;
/** Every entry looked at, so a huge asset tree cannot make the walk run forever. */
const MAX_ENTRIES = 250_000;
const MAX_BYTES = 512 * 1024;

export interface Suggestion {
  name: string;
  prompt: string;
  kind: Kind;
  role: Role;
  duration_s: number;
  influence: number;
  variations: number;
  split_preset?: string;
}

export interface Cue {
  cue: string;
  /** "path:line  code" — what made the scanner think of it. */
  evidence: string[];
  mentions: number;
  suggestion: Suggestion;
  alreadyMade?: string[];
}

export interface ScanResult {
  filesScanned: number;
  styleHints: { word: string; mentions: number }[];
  cues: Cue[];
  missingAudio: { reference: string; at: string }[];
  referencedAudio: number;
  playback: { library: string; at: string }[];
  truncated: boolean;
}

// ── What to look for ─────────────────────────────────────────────────────────────────

interface CueRule {
  cue: string;
  words: string[];
  /** Words that mean the match is something else: castRay is physics, not a spell (finding 17). */
  unless?: string[];
  template?: string;
  retro?: string;
  custom?: Omit<Suggestion, "name">;
}

const RULES: CueRule[] = [
  { cue: "ui_click", template: "ui-click", words: ["click", "button", "btn", "tap", "hover"] },
  { cue: "ui_confirm", template: "ui-confirm", words: ["confirm", "accept", "submit"] },
  { cue: "ui_back", template: "ui-back", words: ["cancel", "goback"] },
  { cue: "ui_error", template: "ui-error", words: ["error", "invalid", "denied", "wrong"] },
  { cue: "ui_notify", template: "ui-notify", words: ["notify", "notification", "toast", "achievement"] },
  { cue: "menu_open", template: "ui-open", words: ["menu", "pause", "inventory", "modal"] },
  { cue: "dialogue_blip", template: "ui-blips", words: ["dialog", "dialogue", "typewriter", "textbox"] },
  { cue: "jump", template: "pl-jump", retro: "rt-jump", words: ["jump"] },
  { cue: "land", template: "pl-land", words: ["land", "landed", "landing", "grounded"] },
  { cue: "footsteps", template: "pl-steps", words: ["footstep", "footsteps", "walk", "walking"] },
  { cue: "dash", template: "pl-dash", words: ["dash", "dodge"] },
  { cue: "player_hurt", template: "pl-hurt", words: ["hurt", "damage", "takedamage", "injured"] },
  { cue: "coin_pickup", template: "rw-coin", retro: "rt-coin", words: ["coin", "coins", "gold", "money", "gem", "gems"] },
  { cue: "item_pickup", template: "rw-item", words: ["pickup", "collect", "collectible", "loot"] },
  { cue: "power_up", template: "rw-powerup", retro: "rt-powerup", words: ["powerup", "buff"] },
  { cue: "level_up", template: "rw-levelup", words: ["levelup", "xp"] },
  { cue: "unlock", template: "rw-unlock", words: ["unlock", "unlocked"] },
  { cue: "chest_open", template: "rw-chest", words: ["chest", "treasure"] },
  { cue: "sword_swing", template: "cb-swing", words: ["swing", "slash", "sword", "melee", "attack"] },
  { cue: "blade_hit", template: "cb-blade", words: ["stab", "blade", "parry"] },
  { cue: "punch", template: "cb-punch", words: ["punch", "kick"] },
  { cue: "gunshot", template: "cb-shot", retro: "rt-laser", words: ["shoot", "gun", "bullet", "pistol", "rifle", "laser"] },
  { cue: "reload", template: "cb-reload", words: ["reload", "ammo"] },
  { cue: "explosion", template: "cb-explosion", retro: "rt-explosion", words: ["explode", "explosion", "bomb", "grenade"] },
  {
    cue: "spell_cast", template: "cb-spell", words: ["spell", "cast", "magic", "mana", "fireball"],
    unless: ["castray", "raycast", "shapecast", "spherecast", "boxcast", "capsulecast", "linecast", "castshadow", "castshadows", "staticcast", "dynamiccast", "reinterpretcast", "constcast", "typecast", "upcast", "downcast"],
  },
  { cue: "bow_shot", template: "cb-bow", words: ["bow", "arrow"] },
  { cue: "door_open", template: "wd-door", words: ["door", "gate"] },
  { cue: "lever", template: "wd-lever", words: ["lever", "pressureplate"] },
  { cue: "glass_break", template: "wd-glass", words: ["glass", "shatter"] },
  { cue: "crate_break", template: "wd-crate", words: ["crate", "barrel", "breakable", "destructible"] },
  { cue: "splash", template: "wd-splash", words: ["splash", "water", "swim"] },
  { cue: "amb_forest", template: "am-forest", words: ["forest", "woods", "jungle"] },
  { cue: "amb_night", template: "am-night", words: ["night"] },
  { cue: "amb_rain", template: "am-rain", words: ["rain", "storm", "thunder"] },
  { cue: "amb_wind", template: "am-wind", words: ["wind", "blizzard"] },
  { cue: "amb_cave", template: "am-cave", words: ["cave", "dungeon", "crypt"] },
  { cue: "amb_city", template: "am-city", words: ["city", "street", "town"] },
  { cue: "amb_ocean", template: "am-ocean", words: ["ocean", "sea", "beach", "shore"] },
  { cue: "amb_campfire", template: "am-fire", words: ["campfire", "bonfire", "fireplace", "torch"] },
  { cue: "amb_machine", template: "am-machine", words: ["factory", "machinery", "spaceship", "engineroom"] },
  {
    cue: "hit_impact", words: ["hit", "enemyhit", "takehit"],
    custom: { prompt: "A short punchy body hit for a video game when an attack lands on an enemy, a dense thud with a quick sharp snap. Isolated one-shot sound effect, close-up and dry.", kind: "one-shot", role: "impact", duration_s: 0.8, influence: 0.45, variations: 4 },
  },
  {
    cue: "heal", words: ["heal", "healing", "potion", "restore"],
    custom: { prompt: "A gentle healing sound for a video game, a soft warm rising chime with a light sparkle as health returns. Isolated one-shot sound effect.", kind: "one-shot", role: "sfx", duration_s: 1.5, influence: 0.5, variations: 2 },
  },
  {
    cue: "teleport", words: ["teleport", "portal", "warp", "respawn"],
    custom: { prompt: "A quick teleport sound for a video game, a short swirling whoosh that collapses into a soft bright pop. Isolated one-shot sound effect.", kind: "one-shot", role: "sfx", duration_s: 1.2, influence: 0.5, variations: 2 },
  },
  {
    cue: "countdown_tick", words: ["countdown", "timer"],
    custom: { prompt: "A single clean countdown tick for a video game timer, a short wooden tock with a tiny bright click on top. Isolated one-shot sound effect, close-up and dry.", kind: "one-shot", role: "ui", duration_s: 0.5, influence: 0.6, variations: 1 },
  },
  {
    cue: "victory", words: ["victory", "win", "levelcomplete", "stageclear", "youwin"],
    custom: { prompt: "A short triumphant victory sting for a video game level complete, bright rising notes landing on a warm final chord. A complete musical sting, about three seconds.", kind: "one-shot", role: "music", duration_s: 3.5, influence: 0.45, variations: 2 },
  },
  {
    cue: "game_over", retro: "rt-gameover", words: ["gameover", "death", "die", "dead", "defeat", "youlose"],
    custom: { prompt: "A short game over sting for a video game, a few slow falling notes ending on a soft low unresolved chord. A complete musical sting, about three seconds.", kind: "one-shot", role: "music", duration_s: 3.5, influence: 0.45, variations: 2 },
  },
];

const STYLE_WORDS = [
  "retro", "pixel", "8bit", "16bit", "chiptune", "arcade", "horror", "cozy", "cute", "kawaii", "scifi", "space", "cyberpunk", "fantasy",
  "medieval", "dungeon", "platformer", "rpg", "roguelike", "shooter", "puzzle", "racing", "farming", "survival", "zombie", "ninja",
  "pirate", "underwater", "western", "steampunk", "lowpoly", "voxel", "idle", "clicker", "match3", "tower", "defense",
];
/**
 * Retro *audio*, not retro art: a pixel-art game is as likely to want soft foley as chiptune. The
 * direction decides when there is one; without one, only "chiptune" in the project does.
 */
const RETRO_AUDIO = /chiptune|\b(8|16)[- ]?bit\b|\bretro\b|square[- ]wave/i;

const PLAYBACK: [RegExp, string][] = [
  [/\bnew Audio\(/, "HTML Audio element"],
  [/\bnew Howl\(|from ["']howler["']/, "Howler.js"],
  [/\.sound\.(add|play)\(/, "Phaser sound manager"],
  [/\bAudioContext\b|decodeAudioData/, "Web Audio API"],
  [/\bAudioStreamPlayer(2D|3D)?\b/, "Godot AudioStreamPlayer"],
  [/\bAudioStreamRandomizer\b/, "Godot AudioStreamRandomizer"],
  [/\bAudioSource\b|PlayOneShot\(/, "Unity AudioSource"],
  [/UGameplayStatics::PlaySound|PlaySoundAtLocation|PlaySound2D/, "Unreal PlaySound"],
  [/pygame\.mixer/, "pygame.mixer"],
  [/love\.audio/, "LÖVE love.audio"],
  [/\bPIXI\.sound\b|@pixi\/sound/, "PixiJS sound"],
  [/\bTone\.(Player|Synth)/, "Tone.js"],
];

const AUDIO_REFERENCE = /["'`]([^"'`\s]{1,200}?\.(?:wav|ogg|mp3|m4a|opus|flac|aiff?|webm))["'`]/gi;

// ── Tokens ───────────────────────────────────────────────────────────────────────────

/** Identifier words, lowercased, plus adjacent pairs joined: onPowerUp → on, power, up, onpower, powerup. */
export function tokens(line: string): string[] {
  const words = line.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [];
  const lower = words.map((w) => w.toLowerCase());
  const out = [...lower];
  for (let i = 0; i + 1 < lower.length; i++) out.push(lower[i]! + lower[i + 1]!);
  return out;
}

/** Visit files breadth-first; `visit` says whether a file counted against the budget. */
async function walk(root: string, visit: (file: string) => Promise<boolean>, limit: number): Promise<boolean> {
  let counted = 0;
  let seen = 0;
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return true;
      if (entry.name.startsWith(".") && entry.name !== ".") {
        if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        if (counted >= limit) return true;
        if (await visit(full)) counted += 1;
      }
    }
  }
  return false;
}

function suggestionFor(rule: CueRule, retro: boolean, direction: string): Suggestion {
  const templateId = retro && rule.retro ? rule.retro : rule.template;
  const template: GameTemplate | undefined = templateId ? getGameTemplate(templateId) : undefined;
  if (template) {
    const kind: Kind = template.post === "loop" ? "loop" : template.post === "split" ? "sequence" : "one-shot";
    const role: Role =
      template.group === "UI" ? "ui"
      : template.group === "Ambience" ? "ambience"
      : template.id === "pl-steps" ? "foley"
      : template.group === "Combat" && template.id !== "cb-swing" && template.id !== "cb-reload" ? "impact"
      : "sfx";
    return {
      name: rule.cue,
      prompt: templatePrompt(template, direction),
      kind,
      role,
      duration_s: template.durationS,
      influence: template.influence,
      variations: template.variations,
      ...(template.splitPreset ? { split_preset: template.splitPreset } : {}),
    };
  }
  const custom = rule.custom!;
  const prompt = direction ? `${custom.prompt.replace(/\.$/, "")}. Style: ${direction}.` : custom.prompt;
  return { name: rule.cue, ...custom, prompt: prompt.slice(0, 450) };
}

function resolveReference(root: string, fromFile: string, reference: string): boolean {
  if (/^(https?:|data:|blob:)/i.test(reference)) return true;
  const clean = reference.replace(/^res:\/\//, "").replace(/[?#].*$/, "");
  const tries = clean.startsWith("/")
    ? [path.join(root, "public", clean), path.join(root, clean)]
    : [path.resolve(path.dirname(fromFile), clean), path.join(root, clean), path.join(root, "public", clean), path.join(root, "Assets", clean)];
  return tries.some((candidate) => existsSync(candidate));
}

export async function scanProject(root: string, options: { direction?: string; made?: Record<string, string[]>; audioFolder?: string } = {}): Promise<ScanResult> {
  const hits = new Map<string, { mentions: number; evidence: string[] }>();
  const style = new Map<string, number>();
  const missing: { reference: string; at: string }[] = [];
  const playback: { library: string; at: string }[] = [];
  const seenPlayback = new Set<string>();
  let referenced = 0;
  let scanned = 0;

  const truncated = await walk(
    root,
    async (file) => {
      const ext = path.extname(file).toLowerCase();
      const isCode = CODE_EXTENSIONS.has(ext);
      if (!isCode && !TEXT_EXTENSIONS.has(ext)) return false;
      if (ext === ".json" && !/package\.json$/.test(file)) return false;
      try {
        if ((await stat(file)).size > MAX_BYTES) return false;
      } catch {
        return false;
      }
      scanned += 1;
      const rel = path.relative(root, file).split(path.sep).join("/");
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.length > 2000) return;
        const words = tokens(line);
        for (const word of words) if (STYLE_WORDS.includes(word)) style.set(word, (style.get(word) ?? 0) + 1);
        if (!isCode) return;
        const at = `${rel}:${index + 1}`;
        const set = new Set(words);
        for (const rule of RULES) {
          if (!rule.words.some((word) => set.has(word))) continue;
          if (rule.unless?.some((word) => set.has(word))) continue;
          const hit = hits.get(rule.cue) ?? { mentions: 0, evidence: [] };
          hit.mentions += 1;
          if (hit.evidence.length < 3) hit.evidence.push(`${at}  ${line.trim().slice(0, 100)}`);
          hits.set(rule.cue, hit);
        }
        for (const match of line.matchAll(AUDIO_REFERENCE)) {
          referenced += 1;
          if (!resolveReference(root, file, match[1]!) && missing.length < 50) missing.push({ reference: match[1]!, at });
        }
        for (const [pattern, library] of PLAYBACK) {
          if (pattern.test(line) && !seenPlayback.has(library + rel) && playback.length < 12) {
            seenPlayback.add(library + rel);
            playback.push({ library, at });
          }
        }
      });
      return true;
    },
    MAX_FILES,
  );

  const direction = options.direction ?? "";
  const retro = direction ? RETRO_AUDIO.test(direction) : (style.get("chiptune") ?? 0) > 0;
  const cues: Cue[] = [];
  for (const rule of RULES) {
    const hit = hits.get(rule.cue);
    if (!hit) continue;
    const cue: Cue = { cue: rule.cue, evidence: hit.evidence, mentions: hit.mentions, suggestion: suggestionFor(rule, retro, direction) };
    const made = options.made?.[rule.cue];
    if (made?.length) cue.alreadyMade = made;
    cues.push(cue);
  }
  cues.sort((a, b) => b.mentions - a.mentions);

  return {
    filesScanned: scanned,
    styleHints: [...style.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, mentions]) => ({ word, mentions })),
    cues,
    missingAudio: missing,
    referencedAudio: referenced,
    playback,
    truncated,
  };
}
