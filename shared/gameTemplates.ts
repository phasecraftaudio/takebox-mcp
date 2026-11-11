/**
 * Game-ready templates: complete sounds for people who make games but do not edit audio.
 *
 * The layer presets in `sourcePresets.ts` are for sound designers — one isolated component per
 * request, to stack by hand. These are the opposite: each template asks for a finished sound and
 * names the step that makes it usable in an engine, so the person never opens a waveform tool.
 *
 * ── How the prompts are written (researched 2026-10-19) ───────────────────────────────────
 *
 * - **One sound per prompt.** ElevenLabs' own guidance: sequences work, but generating each sound
 *   separately gives better results. The exceptions are footsteps and dialogue blips, where the
 *   natural recording *is* a sequence, and Split turns it into one-shots.
 *   https://elevenlabs.io/docs/eleven-creative/playground/sound-effects
 * - **Source + action + context + quality**, 10–60 words: name the material, say what it does,
 *   then the character. Concrete beats adjectives.
 * - **Dry and close for one-shots.** A game adds its own space; a reverb tail baked into a click
 *   cannot be taken out again.
 * - **Set the duration for short sounds.** Automatic duration runs long on UI sounds, and every
 *   generated second costs credits, so short sounds get short fixed lengths.
 * - **Prompt influence** 0.5–0.6 for UI and digital sounds (precise), 0.3–0.45 for organic and
 *   natural ones (variation is the point).
 * - **Ambience is generated plain and looped by TAKEBOX**, not with ElevenLabs' loop flag, so it can
 *   come back as lossless audio and the loop is ours to judge. ⚠️ Worth an A/B listen against
 *   the flag before release.
 *
 * ⚠️ **Every prompt here is a draft until it has had a listening pass** — generate, judge, rewrite.
 */

export const GAME_GROUPS = ["UI", "Player", "Rewards", "Combat", "World", "Ambience", "Retro"] as const;
export type GameGroup = (typeof GAME_GROUPS)[number];

/** What happens to each take after it is generated. */
export type PostStep = "tighten" | "split" | "loop";

export interface GameTemplate {
  id: string;
  group: GameGroup;
  name: string;
  /**
   * The request. `{detail}` marks where the user's detail goes; a template without it takes the
   * detail as a closing style note instead.
   */
  prompt: string;
  /** Fills `{detail}` when the user leaves the detail empty. */
  detailDefault?: string;
  /** Placeholder for the detail field. */
  detailHint: string;
  durationS: number;
  influence: number;
  variations: number;
  post: PostStep;
  /** Split preset, for templates that split (see `TRIM_PRESETS` in dsp/segment.ts). */
  splitPreset?: string;
  /** Base filename: engine-friendly, no spaces. */
  filename: string;
}

/** ElevenLabs bills 40 credits per generated second when a duration is set (docs, 2026-10-19). */
export const CREDITS_PER_SECOND = 40;

/** The longest detail a user can add. Keeps every prompt under ElevenLabs' 450 characters. */
export const DETAIL_MAX = 120;
const PROMPT_MAX = 450;

const AMBIENCE_S = 15;

function oneShot(
  id: string,
  group: GameGroup,
  name: string,
  prompt: string,
  detailHint: string,
  durationS: number,
  influence: number,
  filename: string,
  extra: Partial<GameTemplate> = {},
): GameTemplate {
  return { id, group, name, prompt, detailHint, durationS, influence, variations: 4, post: "tighten", filename, ...extra };
}

function ambience(id: string, name: string, prompt: string, detailHint: string, filename: string): GameTemplate {
  return {
    id,
    group: "Ambience",
    name,
    prompt,
    detailHint,
    durationS: AMBIENCE_S,
    influence: 0.3,
    variations: 1,
    post: "loop",
    filename,
  };
}

export const GAME_TEMPLATES: readonly GameTemplate[] = [
  // ── UI ──────────────────────────────────────────────────────────────────────────────
  oneShot("ui-click", "UI", "Button click",
    "A short crisp user interface button click for a video game menu, a single tight tick with a soft low body.",
    "e.g. wooden, glassy, sci-fi, cute", 0.5, 0.6, "UI_Click"),
  oneShot("ui-confirm", "UI", "Confirm",
    "A positive user interface confirm sound for a video game menu, two quick bright rising tones, clean and satisfying.",
    "e.g. soft marimba, digital, magical", 0.8, 0.6, "UI_Confirm"),
  oneShot("ui-back", "UI", "Back / cancel",
    "A user interface cancel sound for a video game menu, two quick soft falling tones, gentle and clean.",
    "e.g. soft marimba, digital, magical", 0.7, 0.6, "UI_Back"),
  oneShot("ui-error", "UI", "Error",
    "A user interface error sound for a video game, a short low double buzz, clearly negative but not harsh.",
    "e.g. retro, soft, robotic", 0.7, 0.6, "UI_Error"),
  oneShot("ui-notify", "UI", "Notification",
    "A friendly notification chime for a video game, a short bright bell-like ping with a quick natural decay.",
    "e.g. crystal, wooden, sci-fi", 1.2, 0.55, "UI_Notify"),
  oneShot("ui-open", "UI", "Menu open",
    "A quick soft whoosh with a light click as a video game menu panel slides open, smooth and modern.",
    "e.g. paper, holographic, stone", 0.8, 0.5, "UI_MenuOpen"),
  oneShot("ui-page", "UI", "Page turn",
    "A single paper page turning in a book, a crisp flick of the page.",
    "e.g. old parchment, thick card, magazine", 1, 0.45, "UI_PageTurn"),
  {
    id: "ui-blips",
    group: "UI",
    name: "Dialogue blips",
    prompt:
      "A quick series of short soft beeps, like text appearing letter by letter in a video game dialogue box, evenly spaced with tiny gaps between them.",
    detailHint: "e.g. high and cute, low and robotic, wooden",
    durationS: 3,
    influence: 0.5,
    variations: 1,
    post: "split",
    splitPreset: "dense",
    filename: "UI_TextBlip",
  },

  // ── Player ──────────────────────────────────────────────────────────────────────────
  oneShot("pl-jump", "Player", "Jump",
    "A video game character jump, a quick light whoosh with a soft springy lift, short and punchy.",
    "e.g. heavy armoured, tiny cute creature", 0.6, 0.5, "Player_Jump"),
  oneShot("pl-land", "Player", "Land",
    "A video game character landing on {detail}, a soft thud with a little gritty scuff.",
    "surface, e.g. grass, metal floor, wood", 0.7, 0.45, "Player_Land", { detailDefault: "the ground" }),
  {
    id: "pl-steps",
    group: "Player",
    name: "Footsteps",
    prompt:
      "Footsteps of one person walking at an even pace on {detail}, about eight separate steps with short gaps between them.",
    detailDefault: "a stone floor",
    detailHint: "surface and shoes, e.g. gravel in boots, wooden floor barefoot",
    durationS: 5,
    influence: 0.45,
    variations: 1,
    post: "split",
    splitPreset: "footsteps",
    filename: "Player_Footstep",
  },
  oneShot("pl-dash", "Player", "Dash",
    "A fast short whoosh of a video game character dashing forward, a sharp burst of air.",
    "e.g. magical, heavy, sci-fi thruster", 0.6, 0.5, "Player_Dash"),
  oneShot("pl-hurt", "Player", "Take damage",
    "A video game player taking damage, a short punchy hit with a soft crunch.",
    "e.g. robot, slime creature, armoured knight", 0.7, 0.5, "Player_Hurt"),

  // ── Rewards ─────────────────────────────────────────────────────────────────────────
  oneShot("rw-coin", "Rewards", "Coin pickup",
    "A video game coin pickup, a bright short metallic chime with two quick rising notes, clean and rewarding.",
    "e.g. gem, heavy gold, cute", 0.6, 0.6, "Reward_Coin"),
  oneShot("rw-item", "Rewards", "Item pickup",
    "A video game item pickup, a quick soft pop followed by a short sparkle, cheerful and clean.",
    "e.g. potion, weapon, key", 0.8, 0.55, "Reward_Item"),
  oneShot("rw-powerup", "Rewards", "Power-up",
    "A video game power-up, a fast rising shimmering sweep that ends on a bright chime, energetic.",
    "e.g. magical, electric, cute", 1.5, 0.5, "Reward_PowerUp"),
  oneShot("rw-levelup", "Rewards", "Level up",
    "A short triumphant level-up fanfare for a video game, a quick rising arpeggio ending on a bright held chord.",
    "e.g. orchestral brass, synth, music box", 2.5, 0.5, "Reward_LevelUp", { variations: 3 }),
  oneShot("rw-unlock", "Rewards", "Unlock",
    "A satisfying unlock sound for a video game, a solid mechanical click followed by a bright sparkle.",
    "e.g. magical seal, sci-fi door, padlock", 1.2, 0.5, "Reward_Unlock"),
  oneShot("rw-chest", "Rewards", "Chest open",
    "An old wooden treasure chest creaking open, followed by a short magical sparkle.",
    "e.g. iron chest, cursed, golden", 2, 0.5, "Reward_ChestOpen", { variations: 3 }),

  // ── Combat ──────────────────────────────────────────────────────────────────────────
  oneShot("cb-swing", "Combat", "Sword swing",
    "A fast sword swing whooshing through the air, a single sharp and clean swing.",
    "e.g. heavy greatsword, light dagger, energy blade", 0.7, 0.5, "Combat_SwordSwing"),
  oneShot("cb-blade", "Combat", "Blade hit",
    "A steel sword striking metal armour, a sharp metallic clang with a short ring.",
    "e.g. on wood shield, on stone, parry", 1.2, 0.5, "Combat_BladeHit"),
  oneShot("cb-punch", "Combat", "Punch",
    "A heavy punch landing on a body, a deep thump with a slap, a punchy fighting game hit.",
    "e.g. light jab, super-powered, cartoon", 0.7, 0.5, "Combat_Punch"),
  oneShot("cb-shot", "Combat", "Gunshot",
    "A single pistol gunshot, sharp and punchy with a short tail.",
    "e.g. shotgun, silenced pistol, laser rifle", 1.5, 0.5, "Combat_Gunshot"),
  oneShot("cb-reload", "Combat", "Reload",
    "A handgun reload, the magazine sliding out and back in, then the slide racking, crisp mechanical clicks.",
    "e.g. rifle, shotgun, sci-fi energy cell", 1.8, 0.5, "Combat_Reload", { variations: 3 }),
  oneShot("cb-explosion", "Combat", "Explosion",
    "A large explosion with a deep boom, crackling debris and a rumbling tail.",
    "e.g. distant, sci-fi plasma, small grenade", 3, 0.4, "Combat_Explosion", { variations: 3 }),
  oneShot("cb-spell", "Combat", "Spell cast",
    "A magic spell cast for a fantasy video game, swirling energy that builds and releases in a bright burst.",
    "element, e.g. fire, ice, lightning, healing", 1.8, 0.4, "Combat_Spell"),
  oneShot("cb-bow", "Combat", "Bow shot",
    "A bow string releasing and an arrow whooshing away, quick and tight.",
    "e.g. heavy crossbow, magic arrow", 1, 0.5, "Combat_Bow"),

  // ── World ───────────────────────────────────────────────────────────────────────────
  oneShot("wd-door", "World", "Door open",
    "A {detail} door opening slowly with creaking hinges.",
    "e.g. heavy metal, sci-fi sliding, castle", 2, 0.45, "World_DoorOpen",
    { detailDefault: "heavy old wooden", variations: 3 }),
  oneShot("wd-lever", "World", "Lever / switch",
    "A heavy metal lever pulled down with a solid mechanical clunk.",
    "e.g. wooden, rusty, electric switch", 1, 0.5, "World_Lever"),
  oneShot("wd-glass", "World", "Glass break",
    "A glass window shattering, a sharp crash with falling shards.",
    "e.g. bottle, crystal, magic barrier", 1.8, 0.45, "World_GlassBreak", { variations: 3 }),
  oneShot("wd-crate", "World", "Crate break",
    "A wooden crate smashed apart, a cracking crunch with splintering pieces falling.",
    "e.g. barrel, clay pot, metal box", 1.5, 0.45, "World_CrateBreak", { variations: 3 }),
  oneShot("wd-splash", "World", "Splash",
    "An object splashing into water, a deep plunge with scattered droplets.",
    "e.g. small pebble, heavy body, puddle", 1.5, 0.45, "World_Splash", { variations: 3 }),

  // ── Ambience: looped by TAKEBOX ───────────────────────────────────────────────────────
  ambience("am-forest", "Forest (day)",
    "Forest ambience during the day, gentle wind in the leaves and distant birdsong.",
    "e.g. tropical jungle, pine forest, enchanted", "Amb_Forest_Loop"),
  ambience("am-night", "Night",
    "Night ambience outdoors, crickets chirping steadily with a soft breeze.",
    "e.g. frogs by a pond, quiet village", "Amb_Night_Loop"),
  ambience("am-rain", "Rain",
    "Steady medium rain falling on leaves and the ground.",
    "e.g. on a tin roof, light drizzle, heavy storm", "Amb_Rain_Loop"),
  ambience("am-wind", "Wind",
    "Strong wind blowing across an open landscape, a low howl with gentle gusts.",
    "e.g. snowy mountain, desert, through ruins", "Amb_Wind_Loop"),
  ambience("am-cave", "Cave / dungeon",
    "Dark cave ambience, a low hollow rumble with slow water drips echoing.",
    "e.g. lava cave, crystal cavern, crypt", "Amb_Cave_Loop"),
  ambience("am-city", "City street",
    "City street ambience, distant traffic and a murmuring crowd.",
    "e.g. Bangkok night market, quiet suburb, medieval town", "Amb_City_Loop"),
  ambience("am-ocean", "Ocean shore",
    "Ocean waves rolling onto a sandy beach at a steady rhythm.",
    "e.g. rocky cliffs, calm lagoon, stormy sea", "Amb_Ocean_Loop"),
  ambience("am-fire", "Campfire",
    "A campfire crackling with soft occasional wood pops.",
    "e.g. fireplace indoors, large bonfire, torch", "Amb_Fire_Loop"),
  ambience("am-machine", "Machine room",
    "A spaceship engine room, a steady low mechanical drone with a soft electrical buzz.",
    "e.g. factory, server room, steam engine", "Amb_Machine_Loop"),

  // ── Retro / 8-bit ────────────────────────────────────────────────────────────────────
  oneShot("rt-jump", "Retro", "Jump",
    "A retro 8-bit video game jump, a quick rising square-wave blip, classic chiptune style.",
    "e.g. higher, softer, bouncy", 0.5, 0.6, "Retro_Jump"),
  oneShot("rt-coin", "Retro", "Coin",
    "A retro 8-bit coin pickup, two fast high square-wave notes, classic chiptune style.",
    "e.g. lower, sparkly, triple note", 0.5, 0.6, "Retro_Coin"),
  oneShot("rt-laser", "Retro", "Laser",
    "A retro 8-bit laser shot, a fast falling square-wave zap, classic arcade style.",
    "e.g. heavy cannon, rapid fire", 0.5, 0.6, "Retro_Laser"),
  oneShot("rt-explosion", "Retro", "Explosion",
    "A retro 8-bit explosion, a crunchy noise burst that fades out, classic arcade style.",
    "e.g. small pop, huge boss explosion", 1.2, 0.6, "Retro_Explosion"),
  oneShot("rt-powerup", "Retro", "Power-up",
    "A retro 8-bit power-up, a fast rising arpeggio of square-wave notes, classic chiptune style.",
    "e.g. slower, sparkly, triumphant", 1, 0.6, "Retro_PowerUp"),
  oneShot("rt-gameover", "Retro", "Game over",
    "A retro 8-bit game over jingle, a short sad falling melody of square-wave notes, classic chiptune style.",
    "e.g. comic, dramatic, very short", 2.5, 0.6, "Retro_GameOver", { variations: 3 }),
];

const SUFFIX: Record<PostStep, string> = {
  tighten: "Isolated one-shot sound effect, close-up and dry.",
  split: "Close-up and dry.",
  loop: "Continuous ambience bed at an even level throughout, with no sudden loud events.",
};

/** Synthesised sounds have no room to be dry in. */
const RETRO_SUFFIX = "Isolated one-shot sound effect.";

export function getGameTemplate(id: string): GameTemplate | undefined {
  return GAME_TEMPLATES.find((template) => template.id === id);
}

export function templatesInGroup(group: GameGroup): GameTemplate[] {
  return GAME_TEMPLATES.filter((template) => template.group === group);
}

/** The exact text sent to ElevenLabs. Shown in the interface too, so people learn what works. */
export function buildTemplatePrompt(template: GameTemplate, detail: string): string {
  const clean = detail.trim().replace(/\s+/g, " ").replace(/[.;,\s]+$/, "").slice(0, DETAIL_MAX);
  const body = template.prompt.includes("{detail}")
    ? template.prompt.replace("{detail}", clean || template.detailDefault || "")
    : clean
      ? `${template.prompt} Style: ${clean}.`
      : template.prompt;
  const suffix = template.group === "Retro" ? RETRO_SUFFIX : SUFFIX[template.post];
  const prompt = `${body} ${suffix}`.replace(/\s+/g, " ").trim();
  // Unreachable with DETAIL_MAX as it is; a guard in case a future template runs long.
  return prompt.length <= PROMPT_MAX ? prompt : prompt.slice(0, PROMPT_MAX);
}

/** What one request costs, when its duration is fixed. */
export function estimateCredits(durationS: number, variations: number): number {
  return Math.round(CREDITS_PER_SECOND * durationS) * variations;
}
