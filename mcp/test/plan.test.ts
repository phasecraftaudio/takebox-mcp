import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { defaultSettings, detectEngine } from "../src/project.js";
import { scanProject } from "../src/scan.js";
import { searchSounds } from "../src/search.js";
import { sine, tempDir } from "./helpers.js";

async function game(files: Record<string, string>) {
  const root = await tempDir("takebox-scan-");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

describe("engine detection and defaults", () => {
  it("knows the engines by their project files", async () => {
    expect(detectEngine(await game({ "project.godot": "" }))).toBe("godot");
    expect(detectEngine(await game({ "Assets/x.txt": "", "ProjectSettings/y.txt": "" }))).toBe("unity");
    expect(detectEngine(await game({ "Shooter.uproject": "{}" }))).toBe("unreal");
    expect(detectEngine(await game({ "package.json": "{}" }))).toBe("web");
  });

  it("puts web sounds in public/audio as OGG, Godot one-shots as WAV and loops as OGG", async () => {
    const web = defaultSettings(await game({ "package.json": "{}", "public/index.html": "" }));
    expect(web).toMatchObject({ folder: "public/audio", formats: { oneShot: ["ogg"], loop: ["ogg"] } });
    const godot = defaultSettings(await game({ "project.godot": "" }));
    expect(godot).toMatchObject({ folder: "audio", formats: { oneShot: ["wav"], loop: ["ogg"] } });
  });

  it("uses an audio folder the project already has", async () => {
    expect(defaultSettings(await game({ "package.json": "{}", "src/assets/sounds/x.txt": "" })).folder).toBe("src/assets/sounds");
  });
});

describe("plan_sounds scan", () => {
  it("finds game moments with evidence, missing files and how audio is played", async () => {
    const root = await game({
      "package.json": '{"name":"coin-runner","description":"a cozy pixel platformer"}',
      "src/player.ts": [
        "import { Howl } from 'howler';",
        "export function onJump() { velocity.y = -10; }",
        "function collectCoin(coin) { score += 1; play('sfx/coin.ogg'); }",
        "if (player.isGrounded && wasFalling) landed();",
      ].join("\n"),
      "src/world.ts": "const rain = new ParticleSystem('rain'); // storm level",
      "node_modules/lib/index.js": "function explode() {}",
    });
    const scan = await scanProject(root);
    const cues = Object.fromEntries(scan.cues.map((cue) => [cue.cue, cue]));
    expect(cues.jump!.evidence[0]).toMatch(/^src\/player\.ts:2 /);
    expect(cues.coin_pickup).toBeDefined();
    expect(cues.land).toBeDefined();
    expect(cues.amb_rain!.suggestion.kind).toBe("loop");
    expect(cues.explosion).toBeUndefined(); // node_modules is not the game
    expect(scan.missingAudio).toEqual([{ reference: "sfx/coin.ogg", at: "src/player.ts:3" }]);
    expect(scan.playback.map((p) => p.library)).toContain("Howler.js");
    expect(scan.styleHints.map((s) => s.word)).toEqual(expect.arrayContaining(["cozy", "pixel", "platformer"]));
  });

  it("drafts prompts from TAKEBOX's templates, in the game's direction, retro when the game is", async () => {
    const plain = await scanProject(await game({ "game.js": "function jump() {}" }), { direction: "soft wooden toy-like" });
    expect(plain.cues[0]!.suggestion.prompt).toMatch(/soft wooden toy-like/);
    expect(plain.cues[0]!.suggestion.prompt.length).toBeLessThanOrEqual(450);
    const retro = await scanProject(await game({ "game.js": "// an 8-bit arcade chiptune game\nfunction jump() {}" }));
    expect(retro.cues.find((c) => c.cue === "jump")!.suggestion.prompt).toMatch(/8-bit|chiptune|retro/i);
  });

  it("does not read pixel art as chiptune audio, and follows a retro direction when given", async () => {
    const pixel = await scanProject(await game({ "package.json": '{"description":"a cozy pixel platformer"}', "game.js": "function jump() {}" }));
    expect(pixel.cues.find((c) => c.cue === "jump")!.suggestion.prompt).not.toMatch(/8-bit|chiptune|square/i);
    const soft = await scanProject(await game({ "game.js": "// chiptune\nfunction jump() {}" }), { direction: "soft wet moss and wood" });
    expect(soft.cues.find((c) => c.cue === "jump")!.suggestion.prompt).not.toMatch(/chiptune|square/i);
    const asked = await scanProject(await game({ "game.js": "function jump() {}" }), { direction: "bright 8-bit chiptune" });
    expect(asked.cues.find((c) => c.cue === "jump")!.suggestion.prompt).toMatch(/8-bit|chiptune/i);
  });

  it("adds the direction as a style note, never into a template's material slot", async () => {
    const scan = await scanProject(await game({ "game.js": "function landed() {}\nfunction openDoor() {}" }), { direction: "soft wooden toy-like, warm and rounded" });
    const land = scan.cues.find((c) => c.cue === "land")!.suggestion.prompt;
    const door = scan.cues.find((c) => c.cue === "door_open")!.suggestion.prompt;
    expect(land).toMatch(/^A video game character landing on the ground, /);
    expect(land).toMatch(/Style: soft wooden toy-like, warm and rounded\.$/);
    expect(door).toMatch(/^A heavy old wooden door opening/);
  });

  it("marks what is already made", async () => {
    const scan = await scanProject(await game({ "game.js": "function jump() {}" }), { made: { jump: ["audio/jump_01.wav"] } });
    expect(scan.cues[0]!.alreadyMade).toEqual(["audio/jump_01.wav"]);
  });
});

describe("search_sounds", () => {
  it("finds library files by UCS names, folders and synonyms", async () => {
    const library = await tempDir("library-");
    const files = [
      "Foley/Footsteps/FOLYFeet_Boots Gravel Walk_SND_01.wav",
      "Foley/Footsteps/FOLYFeet_Sneakers Wood Run_SND_02.wav",
      "Explosions/EXPLBomb_Big Blast Debris_SND.wav",
      "Doors/DOORWood_Creak Open_SND.wav",
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(library, file)), { recursive: true });
      await writeFile(path.join(library, file), encodeWav([sine(0.1, 440, 0.2)], 48000));
    }
    const root = await tempDir("game-");
    const search = (query: string) =>
      searchSounds({ query, root, manifest: { takebox: 1, sounds: {} }, libraries: [library], scope: "all", limit: 5 });

    expect((await search("footsteps gravel")).hits[0]!.name).toBe("FOLYFeet_Boots Gravel Walk_SND_01.wav");
    expect((await search("explosion")).hits[0]!.name).toMatch(/EXPLBomb/);
    expect((await search("wooden door creak")).hits[0]!.name).toMatch(/DOORWood/);
    expect((await search("laser zap")).hits).toEqual([]);
  });

  it("finds sounds already made, by name and prompt, and says when no library is set", async () => {
    const root = await tempDir("game-");
    const result = await searchSounds({
      query: "coin chime",
      root,
      manifest: { takebox: 1, sounds: { coin_pickup: { kind: "one-shot", role: "sfx", source: "generated", prompt: "A bright gold coin chime.", files: ["audio/coin_pickup_01.ogg"], created: "", updated: "" } } },
      libraries: [],
      scope: "all",
      limit: 5,
    });
    expect(result.hits[0]).toMatchObject({ where: "made", name: "coin_pickup" });
    expect(result.notes.join(" ")).toMatch(/TAKEBOX_LIBRARY/);
  });
});
