export const SOURCE_GENRES = [
  "Fantasy",
  "Fighting",
  "Sci-Fi",
  "Cute",
  "Horror",
  "Funny",
] as const;

export type SourceGenre = (typeof SOURCE_GENRES)[number];
export type SourceForm = "one-shot" | "continuous" | "decay";

function preset<const Name extends string>(
  name: Name,
  note: string,
  form: SourceForm,
  only: string,
  exclude: string[],
) {
  return { name, note, form, only, exclude } as const;
}

export const SOURCE_PRESETS = {
  Fantasy: [
    preset("Magic Whoosh", "Magical movement through air only.", "one-shot", "magical energy moving through air", ["charge", "cast release", "impact", "debris", "voice", "tail"]),
    preset("Magic Charge", "Energy gathering only. No release or impact.", "continuous", "magical energy gathering and intensifying", ["cast release", "projectile travel", "impact", "contact", "voice", "music"]),
    preset("Magic Cast", "One magical release transient.", "one-shot", "one magical release or emission transient", ["charge buildup", "projectile travel", "impact", "contact", "voice", "tail"]),
    preset("Magic Projectile", "Magical travel only. No cast or impact.", "one-shot", "magical energy traveling past through air", ["charge", "cast transient", "impact", "debris", "voice", "tail"]),
    preset("Magic Impact", "One magical-energy contact transient.", "one-shot", "one magical-energy contact transient", ["charge", "cast", "projectile travel", "body hit", "debris", "tail"]),
    preset("Enchantment Shimmer", "One magical shimmer or sparkle layer.", "continuous", "a delicate magical shimmer or sparkling energy texture", ["cast", "impact", "voice", "music", "rhythm", "multiple events"]),
    preset("Portal Open / Close", "One portal boundary movement layer.", "one-shot", "one portal boundary opening or closing movement", ["charge", "impact", "debris", "voice", "music", "long sequence"]),
    preset("Energy Shield", "One barrier activation or compact resonance.", "one-shot", "one magical barrier activation or compact energy resonance", ["weapon swing", "body hit", "debris", "voice", "music", "long sequence"]),
    preset("Fire Element", "One isolated fire burst or combustion layer.", "one-shot", "one isolated fire burst, flare, or combustion layer", ["impact", "debris", "voice", "other elements", "music", "boom"]),
    preset("Ice Element", "One isolated frost or crystalline layer.", "one-shot", "one isolated ice formation, frost, or crystalline crack layer", ["impact", "debris", "voice", "other elements", "music", "boom"]),
    preset("Electricity Element", "One isolated arc or discharge layer.", "one-shot", "one isolated electrical arc, crackle, or discharge layer", ["impact", "debris", "voice", "other elements", "music", "boom"]),
    preset("Wind Element", "One supernatural gust or pressure layer.", "one-shot", "one isolated supernatural wind gust or air-pressure layer", ["contact", "debris", "voice", "other elements", "music", "impact"]),
    preset("Healing / Purify", "One gentle restorative energy layer.", "continuous", "one gentle restorative or purifying magical energy texture", ["cast impact", "voice", "music", "rhythm", "dark texture", "multiple events"]),
    preset("Dark / Corruption", "One dark magical texture or pulse.", "continuous", "one dark corrupted magical energy texture or pulse", ["impact", "voice", "music", "rhythm", "creature vocal", "multiple events"]),
    preset("Magic Tail / Decay", "Magical energy fading away. No attack.", "decay", "the described magical resonance fading away", ["attack", "cast transient", "impact", "movement", "voice", "debris"]),
    preset("Fantasy Custom", "Only the single fantasy component described.", "one-shot", "the single fantasy sound component described", ["additional events", "music", "dialogue", "automatic layering", "trailer processing"]),
  ],
  Fighting: [
    preset("Body Whoosh", "Limb or body air movement only.", "one-shot", "limb or body movement through air", ["contact", "impact", "cloth", "vocal effort", "magic", "tail"]),
    preset("Cloth Movement", "Cloth friction and garment movement only.", "one-shot", "cloth friction, flap, or garment movement", ["body movement", "footsteps", "contact", "weapon", "voice", "magic"]),
    preset("Punch Contact", "Fist contact and short body resonance.", "one-shot", "fist contact and short body resonance", ["arm whoosh", "cloth", "vocal effort", "debris", "magic", "reverb"]),
    preset("Kick Contact", "Foot contact and short body resonance.", "one-shot", "foot contact and short body resonance", ["leg whoosh", "cloth", "vocal effort", "debris", "magic", "reverb"]),
    preset("Body Hit", "Compact body contact and organic resonance.", "one-shot", "compact body contact and short organic resonance", ["limb whoosh", "cloth", "vocal effort", "debris", "magic", "reverb"]),
    preset("Block / Parry", "One defensive contact transient.", "one-shot", "one defensive contact transient between the described materials", ["attack swing", "body hit", "voice", "debris", "magic", "tail"]),
    preset("Grapple / Throw", "One grab, shove, or throw-contact layer.", "one-shot", "one close body grab, shove, or throw-contact layer", ["footsteps", "cloth", "vocal effort", "weapon", "magic", "boom"]),
    preset("Footstep", "One foot contacting the described surface.", "one-shot", "one foot contacting the described surface", ["second step", "cloth", "body movement", "weapon", "voice", "ambience"]),
    preset("Landing", "Landing contact and short weight resonance.", "one-shot", "feet or body landing contact and short weight resonance", ["jump whoosh", "voice", "cloth", "debris shower", "magic", "tail"]),
    preset("Weapon Movement", "Weapon handling or air movement only.", "one-shot", "weapon handling or movement through air", ["contact", "impact", "draw or sheathe", "body hit", "voice", "tail"]),
    preset("Weapon Draw / Sheathe", "Weapon sliding against its holder only.", "one-shot", "weapon sliding against its sheath or holder", ["swing", "combat contact", "body hit", "voice", "magic", "tail"]),
    preset("Metal Impact", "One metal contact and short resonance.", "one-shot", "one metal contact transient with short material resonance", ["movement", "body hit", "voice", "magic", "debris shower", "tail"]),
    preset("Wood Impact", "One wood contact and short resonance.", "one-shot", "one wood contact transient with short material resonance", ["movement", "body hit", "voice", "magic", "debris shower", "tail"]),
    preset("Stone Impact", "One stone contact and short resonance.", "one-shot", "one stone contact transient with short material resonance", ["movement", "body hit", "voice", "magic", "debris shower", "tail"]),
    preset("Break / Crack", "One isolated material fracture.", "one-shot", "one material fracture or crack event", ["weapon swing", "body hit", "voice", "magic", "extended collapse", "tail"]),
    preset("Debris / Scatter", "One debris scatter. No primary impact.", "one-shot", "one discrete scatter or fall of the described debris", ["primary impact", "body hit", "movement", "voice", "magic", "boom"]),
    preset("Weapon Resonance", "Weapon material ring after contact.", "decay", "the weapon material's compact ring or resonance after contact", ["attack", "swing", "body hit", "voice", "magic", "debris"]),
    preset("Human Effort", "One nonverbal martial-arts effort vocal.", "one-shot", "one nonverbal human martial-arts effort vocalization", ["words", "dialogue", "body hit", "movement", "weapon", "ambience"]),
    preset("Fighting Sub Layer", "One clean low-frequency impulse.", "one-shot", "one clean low-frequency impulse", ["audible impact", "midrange transient", "debris", "whoosh", "voice", "tail"]),
    preset("Fighting Custom", "Only the single combat component described.", "one-shot", "the single fighting sound component described", ["additional events", "music", "dialogue", "automatic layering", "trailer processing"]),
  ],
  "Sci-Fi": [
    preset("Energy Weapon Charge", "Weapon energy loading only.", "continuous", "futuristic weapon energy charging and intensifying", ["shot", "projectile", "impact", "mechanical action", "voice", "music"]),
    preset("Energy Weapon Shot", "One energy muzzle discharge.", "one-shot", "one futuristic energy-weapon discharge transient", ["charge", "projectile travel", "impact", "debris", "voice", "tail"]),
    preset("Energy Projectile Pass", "Energy travel or pass-by only.", "one-shot", "one energy projectile passing through space or air", ["charge", "shot", "impact", "debris", "voice", "tail"]),
    preset("Energy Impact", "One futuristic energy contact transient.", "one-shot", "one futuristic energy contact transient", ["charge", "shot", "projectile travel", "debris shower", "voice", "tail"]),
    preset("Sustained Beam", "One continuous energy beam layer.", "continuous", "one stable sustained futuristic energy beam", ["charge", "launch", "impact", "voice", "music", "multiple events"]),
    preset("Servo Movement", "One motor or robotic joint movement.", "one-shot", "one compact servo, actuator, or robotic joint movement", ["footstep", "impact", "hydraulics", "voice", "alarm", "ambience"]),
    preset("Hydraulic Movement", "One piston or pressure-release movement.", "one-shot", "one hydraulic piston or pressure-driven mechanical movement", ["impact", "servo", "door sequence", "voice", "alarm", "ambience"]),
    preset("Door / Hatch Mechanism", "One door mechanism movement layer.", "one-shot", "one futuristic door or hatch mechanism movement", ["room ambience", "footsteps", "voice", "alarm", "impact", "music"]),
    preset("Interface Beep", "One concise futuristic UI tone.", "one-shot", "one concise futuristic interface feedback tone", ["voice", "alarm sequence", "ambience", "impact", "music", "reverb"]),
    preset("Alarm Pulse", "One electronic warning pulse.", "one-shot", "one electronic warning or alert pulse", ["voice", "siren sequence", "ambience", "impact", "music", "multiple events"]),
    preset("Hologram", "One holographic activation or steady texture.", "continuous", "one holographic projection activation or stable digital texture", ["voice", "interface sequence", "impact", "alarm", "music", "multiple events"]),
    preset("Teleport", "One teleport boundary movement layer.", "one-shot", "one teleportation displacement or boundary movement", ["charge", "impact", "debris", "voice", "music", "long sequence"]),
    preset("Energy Shield", "One shield activation or compact resonance.", "one-shot", "one futuristic energy-shield activation or compact resonance", ["weapon shot", "body hit", "debris", "voice", "alarm", "long sequence"]),
    preset("Glitch", "One malfunction or digital interruption.", "one-shot", "one digital glitch, malfunction, or data interruption", ["voice phrase", "music", "rhythm", "impact", "ambience", "multiple events"]),
    preset("Engine / Power Hum", "One steady machine or reactor texture.", "continuous", "one steady futuristic engine, reactor, or power-system hum", ["alarm", "voice", "impact", "music", "rhythm", "multiple machines"]),
    preset("Electric Arc", "One electrical discharge layer.", "one-shot", "one isolated futuristic electrical arc or discharge", ["impact", "alarm", "voice", "engine", "music", "multiple events"]),
    preset("Sci-Fi Tail / Decay", "Electronic or energy resonance fading.", "decay", "the described electronic or energy resonance fading away", ["attack", "shot", "impact", "movement", "voice", "alarm"]),
    preset("Sci-Fi Custom", "Only the single sci-fi component described.", "one-shot", "the single science-fiction sound component described", ["additional events", "music", "dialogue", "automatic layering", "trailer processing"]),
  ],
  Cute: [
    preset("Soft Whoosh", "One light, friendly movement layer.", "one-shot", "one soft light playful movement through air", ["impact", "voice", "music", "debris", "dark texture", "tail"]),
    preset("Tiny Pop", "One small rounded pop.", "one-shot", "one tiny soft rounded pop", ["impact sequence", "voice", "music", "debris", "reverb", "multiple pops"]),
    preset("Bubble Pop", "One delicate bubble pop.", "one-shot", "one delicate airy bubble pop", ["splash", "voice", "music", "impact layer", "reverb", "multiple pops"]),
    preset("Sparkle / Twinkle", "One bright magical sparkle layer.", "one-shot", "one bright delicate sparkle or twinkle", ["melody", "voice", "impact", "whoosh", "dark texture", "multiple notes"]),
    preset("Toy Squeak", "One small toy-like squeak.", "one-shot", "one small friendly toy-like squeak", ["voice", "music", "impact", "ambience", "reverb", "multiple squeaks"]),
    preset("Bouncy Boing", "One light springy bounce.", "one-shot", "one light rounded springy boing", ["impact layer", "voice", "music", "ambience", "debris", "multiple bounces"]),
    preset("Soft Impact", "One gentle padded contact.", "one-shot", "one gentle padded or plush contact transient", ["whoosh", "voice", "debris", "music", "hard crack", "tail"]),
    preset("Tiny Footstep", "One tiny character foot contact.", "one-shot", "one tiny light character footstep on the described surface", ["second step", "cloth", "voice", "ambience", "music", "body movement"]),
    preset("Plush Movement", "Soft plush or fabric movement only.", "one-shot", "soft plush fabric friction or toy movement", ["footstep", "impact", "voice", "music", "hard material", "multiple events"]),
    preset("Cute Creature Vocal", "One short nonverbal cute vocal.", "one-shot", "one short nonverbal friendly creature vocalization", ["words", "dialogue", "movement", "impact", "music", "ambience"]),
    preset("Cute Magic Cast", "One small friendly magic release.", "one-shot", "one small friendly magical release or poof", ["charge", "projectile", "impact", "voice", "music", "long tail"]),
    preset("Pickup / Collect", "One concise collectible feedback layer.", "one-shot", "one concise bright collectible or pickup feedback sound", ["voice", "melody", "ambience", "impact", "music", "multiple notes"]),
    preset("Success UI", "One cheerful success feedback layer.", "one-shot", "one concise cheerful interface success sound", ["voice", "melody phrase", "ambience", "impact", "music", "long reverb"]),
    preset("Cute Tail / Decay", "Soft bright resonance fading.", "decay", "a soft bright playful resonance fading away", ["attack", "impact", "voice", "music", "dark texture", "movement"]),
    preset("Cute Custom", "Only the single cute component described.", "one-shot", "the single cute playful sound component described", ["additional events", "music", "dialogue", "automatic layering", "cinematic processing"]),
  ],
  Horror: [
    preset("Ghost Whoosh", "One spectral movement layer.", "one-shot", "one breathy spectral movement through air", ["whisper", "impact", "music", "debris", "footsteps", "tail"]),
    preset("Spectral Whisper", "One wordless ghostly whisper texture.", "continuous", "one wordless breathy spectral whisper texture", ["intelligible words", "dialogue", "impact", "music", "movement", "multiple voices"]),
    preset("Monster Vocal", "One nonverbal threatening creature vocal.", "one-shot", "one nonverbal threatening monster vocalization", ["words", "dialogue", "movement", "impact", "ambience", "music"]),
    preset("Creature Movement", "One creature body or limb movement.", "one-shot", "one unsettling creature body or limb movement", ["footstep", "impact", "vocal", "music", "ambience", "multiple events"]),
    preset("Wet Flesh Movement", "One organic wet movement layer.", "one-shot", "one close wet organic flesh movement", ["impact", "bone crack", "vocal", "music", "ambience", "multiple events"]),
    preset("Bone Crack", "One dry bone fracture.", "one-shot", "one close dry bone snap or fracture", ["body impact", "flesh movement", "voice", "music", "ambience", "multiple cracks"]),
    preset("Gore / Squish", "One wet organic contact layer.", "one-shot", "one close wet organic squish or compression", ["bone crack", "voice", "music", "ambience", "movement", "multiple events"]),
    preset("Heavy Body Impact", "One heavy organic contact transient.", "one-shot", "one heavy close body contact transient with short organic resonance", ["whoosh", "voice", "debris", "music", "ambience", "tail"]),
    preset("Skitter Footstep", "One small rapid creature foot contact.", "one-shot", "one small sharp creature foot contact on the described surface", ["second step", "vocal", "ambience", "music", "body impact", "movement sequence"]),
    preset("Creak", "One stressed wood or metal creak.", "one-shot", "one slow stressed material creak", ["door slam", "footstep", "voice", "ambience", "music", "multiple creaks"]),
    preset("Chain / Rattle", "One short metallic restraint movement.", "one-shot", "one short close chain, restraint, or metal rattle", ["impact", "footsteps", "voice", "ambience", "music", "long sequence"]),
    preset("Heartbeat", "One isolated organic heartbeat pulse.", "one-shot", "one close isolated organic heartbeat pulse", ["second beat", "breathing", "voice", "music", "ambience", "rhythm sequence"]),
    preset("Jumpscare Transient", "One sudden horror impact layer.", "one-shot", "one sudden sharp frightening impact transient", ["riser", "music", "voice", "debris", "long tail", "sequence"]),
    preset("Dread Drone", "One continuous unsettling texture.", "continuous", "one steady low unsettling horror drone or texture", ["impact", "voice", "melody", "rhythm", "transition", "multiple events"]),
    preset("Dark Ritual Energy", "One ominous supernatural energy layer.", "continuous", "one ominous supernatural or ritual energy texture", ["chanting", "words", "music", "impact", "rhythm", "multiple events"]),
    preset("Horror Tail / Decay", "Dark resonance fading. No attack.", "decay", "the described dark resonance fading away", ["attack", "impact", "movement", "voice", "music", "debris"]),
    preset("Horror Custom", "Only the single horror component described.", "one-shot", "the single horror sound component described", ["additional events", "music", "dialogue", "automatic layering", "trailer processing"]),
  ],
  Funny: [
    preset("Cartoon Whoosh", "One exaggerated movement layer.", "one-shot", "one exaggerated playful cartoon movement through air", ["impact", "voice", "music", "debris", "footsteps", "tail"]),
    preset("Boing", "One springy cartoon bounce.", "one-shot", "one exaggerated springy cartoon boing", ["impact layer", "voice", "music", "ambience", "multiple bounces", "tail"]),
    preset("Cartoon Pop", "One exaggerated clean pop.", "one-shot", "one exaggerated clean cartoon pop", ["voice", "music", "debris", "ambience", "multiple pops", "tail"]),
    preset("Squeak", "One rubbery or toy-like squeak.", "one-shot", "one exaggerated rubbery toy-like squeak", ["voice", "music", "impact", "ambience", "multiple squeaks", "tail"]),
    preset("Rubber Stretch", "One elastic stretch movement.", "one-shot", "one exaggerated elastic rubber stretch movement", ["snap", "impact", "voice", "music", "ambience", "multiple events"]),
    preset("Spring Twang", "One mechanical spring release.", "one-shot", "one exaggerated mechanical spring twang", ["boing sequence", "impact", "voice", "music", "ambience", "multiple notes"]),
    preset("Comedic Impact", "One exaggerated soft impact.", "one-shot", "one exaggerated rounded comedic contact transient", ["whoosh", "voice", "debris", "music", "ambience", "tail"]),
    preset("Slap", "One sharp cartoon slap contact.", "one-shot", "one sharp exaggerated slap contact", ["arm whoosh", "voice", "music", "debris", "ambience", "tail"]),
    preset("Bonk", "One hollow cartoon head impact.", "one-shot", "one hollow rounded cartoon bonk impact", ["whoosh", "voice", "music", "debris", "ambience", "tail"]),
    preset("Wobble", "One unstable wobbling movement.", "one-shot", "one exaggerated unstable wobbling movement", ["impact", "voice", "music", "ambience", "footsteps", "multiple events"]),
    preset("Cartoon Footstep", "One exaggerated character footstep.", "one-shot", "one exaggerated cartoon foot contact on the described surface", ["second step", "voice", "music", "ambience", "body movement", "tail"]),
    preset("Slide Whistle Gesture", "One short rising or falling whistle gesture.", "one-shot", "one short comedic slide-whistle rise or fall", ["melody", "voice", "impact", "ambience", "music bed", "multiple gestures"]),
    preset("Clown Horn", "One short silly horn honk.", "one-shot", "one short exaggerated comedic horn honk", ["melody", "voice", "impact", "ambience", "music", "multiple honks"]),
    preset("Funny Creature Vocal", "One short nonverbal silly vocal.", "one-shot", "one short nonverbal silly creature vocalization", ["words", "dialogue", "movement", "impact", "music", "ambience"]),
    preset("Fail UI", "One concise comedic failure cue.", "one-shot", "one concise comedic interface failure sound", ["voice", "melody phrase", "ambience", "impact", "music bed", "long reverb"]),
    preset("Funny Custom", "Only the single comedic component described.", "one-shot", "the single funny sound component described", ["additional events", "music bed", "dialogue", "automatic layering", "cinematic processing"]),
  ],
} as const;

export type SourceType =
  (typeof SOURCE_PRESETS)[SourceGenre][number]["name"];

export function getSourcePreset(genre: SourceGenre, sourceType: string) {
  return SOURCE_PRESETS[genre].find((item) => item.name === sourceType);
}

const genreCharacter: Record<SourceGenre, string> = {
  Fantasy: "Fantasy game sound character.",
  Fighting: "Focused fighting-game sound character.",
  "Sci-Fi": "Futuristic science-fiction game sound character.",
  Cute: "Soft, bright, cute game sound character.",
  Horror: "Close, unsettling horror game sound character.",
  Funny: "Exaggerated, playful comedy game sound character.",
};

function trimAtWord(value: string, length: number) {
  if (value.length <= length) return value;
  const shortened = value.slice(0, Math.max(0, length - 1));
  const lastSpace = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, lastSpace > length * 0.7 ? lastSpace : shortened.length).trim()}…`;
}

export function buildIsolatedPrompt(
  description: string,
  genre: SourceGenre,
  sourceType: SourceType,
) {
  const rule = getSourcePreset(genre, sourceType);
  if (!rule) throw new Error("Select a source type from the chosen genre.");
  const suffix = [
    `Isolated ${rule.form} sound-effect stem for layering.`,
    genreCharacter[genre],
    `Only ${rule.only}.`,
    "Dry, close perspective, minimal room.",
    `Exclude ${rule.exclude.join(", ")}.`,
  ].join(" ");
  const descriptionBudget = Math.max(40, 450 - suffix.length - 2);
  const cleanDescription = description.trim().replace(/[.;\s]+$/, "");
  return `${trimAtWord(cleanDescription, descriptionBudget)}. ${suffix}`;
}
