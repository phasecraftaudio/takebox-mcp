/**
 * TAKEBOX as an MCP server.
 *
 * Six tools, in the order an agent uses them:
 *   setup          where we are, what it can write, what it can spend; change project settings
 *   plan_sounds    read the game's code for what needs sound, with the sound designer's guide
 *   search_sounds  find a sound already made, in the project, or in the person's library
 *   make_sounds    generate a batch: estimate, spend check, then trimmed, levelled, named files
 *   finish_sounds  trim / loop / split / level / convert files that already exist, at no cost
 *   analyze_sounds measure files and flag what will cause trouble in an engine
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyze, compareSet } from "./audio/analyze.js";
import { decodeFile, findFfmpeg, QUALITIES, writableFormats, type Format } from "./audio/codecs.js";
import { ROLES } from "./audio/level.js";
import { SHAPES, SPLIT_PRESETS } from "./finish.js";
import { GUIDE, SOUND_PASS } from "./guide.js";
import { finishSounds, makeSounds, type Context } from "./make.js";
import {
  CHANNEL_MODES, checkRoot, detectEngine, ENGINES, loadManifest, MANIFEST, ProjectError, resolveSettings, sanitizeName,
  updateManifest, type Settings,
} from "./project.js";
import { runAudition, MAX_STYLES } from "./audition.js";
import { startBoard, type Board } from "./board/http.js";
import { scanProject } from "./scan.js";
import { formatList, soundSpec } from "./schemas.js";
import { searchSounds } from "./search.js";
import { createServices, learnedRate, type ServiceOptions } from "./services.js";
import { STYLE_PRESETS } from "./styles.js";

export const VERSION = "0.1.1";

export type ServerOptions = ServiceOptions & {
  /** Tests: start boards without opening a browser. */
  openBrowser?: boolean;
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
});

const project = z.string().optional().describe("Path to the game's folder. Leave out to use the configured or current project.");

export function createServer(options: ServerOptions = {}) {
  const services = createServices(options);
  const { env, ledger, limits, apiKey, provider, libraries } = services;
  /** One board per project for the life of this server. */
  const boards = new Map<string, Promise<Board>>();

  const server = new McpServer(
    { name: "takebox", title: "TAKEBOX", version: VERSION },
    {
      instructions:
        "TAKEBOX makes and manages a game's sound effects and ambience: it plans from the code, searches the person's library, " +
        "generates with ElevenLabs, and trims, levels, loops, names and converts every file for the game's engine. " +
        "Start with setup, then plan_sounds. Read the guide (takebox://guide) before writing prompts. " +
        "Always estimate with make_sounds dry_run and get the person's yes before spending. Never claim a sound is good; ask them to listen.",
    },
  );

  async function rootFor(given?: string): Promise<string> {
    if (given) return checkRoot(given);
    if (env.TAKEBOX_PROJECT) return checkRoot(env.TAKEBOX_PROJECT);
    if (server.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.server.listRoots();
        const first = roots.find((root) => root.uri.startsWith("file://"));
        if (first) return checkRoot(fileURLToPath(first.uri));
      } catch {
        // the client said it has roots but did not answer: fall back
      }
    }
    return checkRoot(services.cwd);
  }

  async function contextFor(given: string | undefined, extra?: { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (n: never) => Promise<void> }): Promise<Context & { settings: Settings }> {
    const root = await rootFor(given);
    // Estimates from what ElevenLabs really charged lately (Codex review: the agent path missed it).
    await learnedRate(services);
    const manifest = await loadManifest(root);
    const token = extra?._meta?.progressToken;
    return {
      root,
      settings: resolveSettings(root, manifest),
      provider,
      ledger,
      limits,
      ...(extra?.signal ? { signal: extra.signal } : {}),
      ...(token !== undefined && extra?.sendNotification
        ? {
            progress: (done: number, total: number, message: string) => {
              void extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } } as never).catch(() => undefined);
            },
          }
        : {}),
    };
  }

  // ── setup ──────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "setup",
    {
      title: "Set up TAKEBOX for this game",
      description:
        "Shows the project TAKEBOX is working in, the engine it detected, where sounds go and in which formats, the sound direction, " +
        "which formats this machine can write, the ElevenLabs account and today's spend against the cap, and any sound libraries. " +
        "Pass `set` to change the project's settings (saved in takebox.json). Call this first.",
      inputSchema: {
        project,
        set: z
          .object({
            engine: z.enum(ENGINES).optional(),
            folder: z.string().optional().describe("Where finished sounds go, relative to the project."),
            one_shot_formats: formatList.optional().describe('Formats for one-shots and sequences, e.g. ["ogg","mp3"].'),
            loop_formats: formatList.optional(),
            direction: z.string().max(200).optional().describe("The game's sound direction: one line of materials and character every prompt shares."),
            quality: z.enum(QUALITIES).optional().describe("Lossy formats only: high, standard or small files."),
            bit_depth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional().describe("WAV/AIFF bit depth. 32 means 32-bit float."),
            channels: z.enum(CHANNEL_MODES).optional().describe("keep, or fold everything to mono (3D games) or stereo."),
          })
          .optional(),
        check_account: z.boolean().default(true).describe("Ask ElevenLabs how many credits are left (free, no generation)."),
      },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const root = await rootFor(args.project);
        const writable = await writableFormats();
        if (args.set) {
          const requested = [...(args.set.one_shot_formats ?? []), ...(args.set.loop_formats ?? [])];
          const unwritable = requested.filter((format) => !writable.includes(format));
          if (unwritable.length) {
            throw new ProjectError(`This machine cannot write ${unwritable.join(", ")} (no ffmpeg with that encoder). It can write: ${writable.join(", ")}.`);
          }
          await updateManifest(root, (manifest) => {
            const current = resolveSettings(root, manifest);
            const set = args.set!;
            manifest.settings = {
              ...manifest.settings,
              ...(set.engine ? { engine: set.engine } : {}),
              ...(set.folder ? { folder: set.folder } : {}),
              // Formats are stored only when someone chose them, so the engine's defaults keep applying otherwise.
              ...(set.one_shot_formats || set.loop_formats
                ? { formats: { oneShot: set.one_shot_formats ?? current.formats.oneShot, loop: set.loop_formats ?? current.formats.loop } }
                : {}),
              ...(set.direction !== undefined ? { direction: set.direction.trim() } : {}),
              ...(set.quality ? { quality: set.quality } : {}),
              ...(set.bit_depth ? { bitDepth: set.bit_depth } : {}),
              ...(set.channels ? { channels: set.channels } : {}),
            };
          });
        }
        const manifest = await loadManifest(root);
        const settings = resolveSettings(root, manifest);
        const ffmpeg = await findFfmpeg();
        let account: unknown = provider ? "not checked" : "no ELEVENLABS_API_KEY in the MCP config: search, finish and analyze work; make_sounds does not";
        if (provider && args.check_account) {
          try {
            const info = await provider.account(extra.signal);
            account = { tier: info.tier, credits_left: Math.max(0, info.creditsLimit - info.creditsUsed), credits_limit: info.creditsLimit, resets_at: info.resetsAt };
          } catch (error) {
            account = `could not read the account: ${(error as Error).message}`;
          }
        }
        return json({
          project: root,
          engine: { using: settings.engine, detected: detectEngine(root) },
          settings: {
            folder: settings.folder,
            one_shot_formats: settings.formats.oneShot,
            loop_formats: settings.formats.loop,
            direction: settings.direction || "(not set: settle one before writing prompts)",
            quality: settings.quality,
            bit_depth: settings.bitDepth,
            channels: settings.channels,
          },
          this_machine: { can_write: writable, ffmpeg: ffmpeg ? ffmpeg.path : "none (built-in formats only: wav, aiff, mp3, ogg)" },
          provider: provider ? { name: provider.label, key: `…${apiKey.slice(-4)}`, account } : account,
          spend: { spent_today: await ledger.spentToday(), daily_cap: limits.dailyCap, asks_above: limits.askAbove },
          libraries: libraries.length ? libraries : "none (set TAKEBOX_LIBRARY in the MCP config to search a sound library)",
          sounds_in_project: Object.keys(manifest.sounds).length,
          manifest: MANIFEST,
          guide: "Read takebox://guide before planning, or call plan_sounds, which includes it.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── plan_sounds ────────────────────────────────────────────────────────────────────
  server.registerTool(
    "plan_sounds",
    {
      title: "Plan the game's sounds",
      description:
        "Reads the game's code and lists what needs sound: game moments it found (with file:line evidence), audio files the code " +
        "references that do not exist, how the game already plays audio, and style words. Each moment comes with a draft prompt from " +
        "TAKEBOX's researched templates. Returns the sound designer's guide too. Evidence is a lead, not a verdict: read it, judge " +
        "what this game needs, then propose a list to the person. Does not generate or spend anything.",
      inputSchema: {
        project,
        include_guide: z.boolean().default(true).describe("Include the sound design guide. Leave on unless you already have it."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const root = await rootFor(args.project);
        const manifest = await loadManifest(root);
        const settings = resolveSettings(root, manifest);
        const made = Object.fromEntries(Object.entries(manifest.sounds).map(([name, record]) => [name, record.files]));
        const scan = await scanProject(root, { direction: settings.direction, made });
        return json({
          project: root,
          engine: settings.engine,
          direction: settings.direction || "(not set)",
          formats: settings.formats,
          files_scanned: scan.filesScanned,
          ...(scan.truncated ? { note: "Large project: only the first 3000 files were read." } : {}),
          style_hints: scan.styleHints,
          how_the_game_plays_audio: scan.playback.length ? scan.playback : "no audio playback found in the code yet",
          missing_audio_files: scan.missingAudio,
          audio_references_in_code: scan.referencedAudio,
          moments_found: scan.cues.map((cue) => ({
            cue: cue.cue,
            mentions: cue.mentions,
            evidence: cue.evidence,
            draft: cue.suggestion,
            ...(cue.alreadyMade ? { already_made: cue.alreadyMade } : {}),
          })),
          already_made: Object.keys(manifest.sounds),
          next:
            "Judge which moments are real, add what the code does not show (ambience per area, UI, stings), settle the direction if it is " +
            "not set, rewrite the drafts in it, then show the person the list and the make_sounds dry_run cost. A missing_audio_file is " +
            "a sound the code already expects: make it, then point that line at the new file from takebox.json.",
          ...(args.include_guide ? { guide: GUIDE } : {}),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── search_sounds ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "search_sounds",
    {
      title: "Search for a sound",
      description:
        "Finds sounds by words, before paying to make one: in the sounds TAKEBOX already made for this project (by name and prompt), " +
        "every audio file in the project, and the person's sound libraries (TAKEBOX_LIBRARY). Matches folder and file names, " +
        "including UCS names, with common synonyms. Bring a library file into the game with finish_sounds.",
      inputSchema: {
        project,
        query: z.string().min(2).describe('What it is and what it is made of, e.g. "footsteps gravel boots" or "wooden door creak".'),
        scope: z.enum(["all", "project", "library"]).default("all"),
        limit: z.number().int().min(1).max(50).default(12),
        analyze: z.boolean().default(false).describe("Measure the top 5 results (length, loudness, problems). Slower."),
        refresh: z.boolean().default(false).describe("Re-read the library folders instead of the 10-minute cache."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      try {
        const root = await rootFor(args.project);
        const manifest = await loadManifest(root);
        const result = await searchSounds({ query: args.query, root, manifest, libraries, scope: args.scope, limit: args.limit, refresh: args.refresh });
        const hits = await Promise.all(
          result.hits.map(async (hit, index) => {
            const base = { where: hit.where, name: hit.name, path: hit.where === "made" ? hit.path : hit.path, matched: hit.matched, ...(hit.files ? { files: hit.files } : {}), ...(hit.prompt ? { prompt: hit.prompt } : {}) };
            if (!args.analyze || index >= 5 || hit.where === "made") return base;
            try {
              const analysis = analyze(await decodeFile(hit.path, extra.signal));
              return { ...base, measured: { duration_s: analysis.durationS, channels: analysis.channels, sample_rate: analysis.sampleRate, lufs_m_max: analysis.lufsMomentaryMax, flags: analysis.flags } };
            } catch (error) {
              return { ...base, measured: `could not read: ${(error as Error).message}` };
            }
          }),
        );
        return json({ query: args.query, searched: result.searched, hits, ...(result.notes.length ? { notes: result.notes } : {}) });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── make_sounds ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "make_sounds",
    {
      title: "Make sounds",
      description:
        "Generates a batch of sounds with ElevenLabs and finishes every take for the game: trimmed so it fires instantly, split into " +
        "separate hits for sequences, made seamless for loops, levelled by role, written in the project's formats and named in order. " +
        "Originals are kept in .takebox/originals, so re-finishing later is free. Every file is listed in takebox.json. " +
        "Use dry_run first for the cost. Batches above the ask line return needs_confirmation: show the person the list and cost, " +
        "and call again with confirm_credits only after they say yes. The daily cap cannot be raised from here.",
      inputSchema: {
        project,
        sounds: z.array(soundSpec).min(1).max(40),
        dry_run: z.boolean().default(false).describe("Only estimate the credits. Nothing is generated."),
        confirm_credits: z.number().int().optional().describe("The estimate the person agreed to. Needed above the ask line."),
        formats: formatList.optional().describe("Override the project's formats for this batch."),
        model: z.string().optional().describe("ElevenLabs model id. Leave out for their default."),
      },
      annotations: { openWorldHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const ctx = await contextFor(args.project, extra as never);
        if (args.formats) {
          const writable = await writableFormats();
          const missing = args.formats.filter((format: Format) => !writable.includes(format));
          if (missing.length) throw new ProjectError(`This machine cannot write ${missing.join(", ")}. It can write: ${writable.join(", ")}.`);
        }
        const specs = args.sounds.map((sound) => ({
          name: sound.name,
          prompt: sound.prompt,
          kind: sound.kind,
          variations: sound.variations,
          ...(sound.role ? { role: sound.role } : {}),
          ...(sound.duration_s !== undefined ? { duration_s: sound.duration_s } : {}),
          ...(sound.influence !== undefined ? { influence: sound.influence } : {}),
          ...(sound.split_preset ? { split_preset: sound.split_preset } : {}),
        }));
        return json(
          await makeSounds(ctx, specs, {
            dryRun: args.dry_run,
            ...(args.confirm_credits !== undefined ? { confirmCredits: args.confirm_credits } : {}),
            ...(args.formats ? { formats: args.formats } : {}),
            ...(args.model ? { model: args.model } : {}),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── finish_sounds ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "finish_sounds",
    {
      title: "Finish existing sounds",
      description:
        "Trims, loops, splits, levels and converts audio that already exists, with no generation and no cost. Two uses: " +
        "(1) names: re-finish sounds TAKEBOX made, from their originals, e.g. a new format or level (their old finished files are replaced); " +
        "(2) files: bring the person's own or library files into the game (any format in, the project's formats out). " +
        "Never changes the input files. Records the results in takebox.json.",
      inputSchema: {
        project,
        names: z.array(z.string()).optional().describe("Sounds from takebox.json to re-finish from their originals."),
        files: z.array(z.string()).optional().describe("Files or folders (absolute, or relative to the project) to bring in."),
        name: z.string().optional().describe("With files: one name for all of them (they become its variations). Otherwise each keeps its own name."),
        shape: z.enum(["auto", ...SHAPES]).default("auto").describe("auto (by the sound's kind; plain files are trimmed), trim, loop, split, none."),
        split_preset: z.enum(SPLIT_PRESETS).optional().describe(
          "Splits only: how to find each hit. Leave it out when re-finishing by name: the sound is cut the way it was made and its takes keep their numbers. " +
            "Name one to cut a made sound again from its original: if the cuts come out different, every take from it is new and renumbered, and cuts rejected before come back. " +
            "A split made by TAKEBOX 0.1.0 has no preset on record, so it needs one named, and its takes are always new.",
        ),
        level: z.union([z.enum(["role", "off"]), z.number().min(-40).max(-6)]).default("role").describe('"role" (by role), "off", or a LUFS target.'),
        role: z.enum(ROLES).optional(),
        channels: z.enum(CHANNEL_MODES).optional(),
        sample_rate: z.number().int().min(8000).max(192000).optional().describe("Resample to this rate. Leave out to keep each file's own."),
        formats: formatList.optional(),
        quality: z.enum(QUALITIES).optional(),
        bit_depth: z.union([z.literal(16), z.literal(24), z.literal(32)]).optional(),
        folder: z.string().optional().describe("Output folder relative to the project. Default: the project's sound folder."),
        replace: z.boolean().default(true).describe("With names: replace the sound's previous finished files."),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async (args, extra) => {
      try {
        const ctx = await contextFor(args.project, extra as never);
        if (args.formats) {
          const writable = await writableFormats();
          const missing = args.formats.filter((format: Format) => !writable.includes(format));
          if (missing.length) throw new ProjectError(`This machine cannot write ${missing.join(", ")}. It can write: ${writable.join(", ")}.`);
        }
        const manifest = await loadManifest(ctx.root);
        const { project: _project, ...input } = args;
        return json(await finishSounds(ctx, input, manifest.sounds));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── analyze_sounds ─────────────────────────────────────────────────────────────────
  server.registerTool(
    "analyze_sounds",
    {
      title: "Analyze sounds",
      description:
        "Measures audio files the way a sound designer checks them before they go into a game: length, loudness (LUFS), true peak, " +
        "silence at the head and tail, clipping, DC offset, stereo that is really mono, loops that click. Flags problems in plain words " +
        "and compares levels across the set. Facts only; it never says a sound is good.",
      inputSchema: {
        project,
        names: z.array(z.string()).optional().describe("Sounds from takebox.json."),
        files: z.array(z.string()).optional().describe("Files or folders, absolute or relative to the project."),
        all: z.boolean().default(false).describe("Every sound in takebox.json."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      try {
        const root = await rootFor(args.project);
        const manifest = await loadManifest(root);
        const targets: { file: string; isLoop: boolean; label: string }[] = [];
        const names = args.all ? Object.keys(manifest.sounds) : (args.names ?? []).map(sanitizeName);
        for (const name of names) {
          const record = manifest.sounds[name];
          if (!record) continue;
          for (const file of record.files) {
            // One reading per take: the first format written is enough.
            const stem = file.replace(/\.[^.]+$/, "");
            if (targets.some((t) => t.file.replace(/\.[^.]+$/, "") === path.resolve(root, stem))) continue;
            targets.push({ file: path.resolve(root, file), isLoop: record.kind === "loop", label: file });
          }
        }
        for (const given of args.files ?? []) {
          const full = path.isAbsolute(given) ? given : path.resolve(root, given);
          const { readdir, stat } = await import("node:fs/promises");
          if ((await stat(full)).isDirectory()) {
            for (const entry of (await readdir(full)).sort()) {
              if (/\.(wav|ogg|mp3|flac|opus|m4a|aiff?|aifc|caf)$/i.test(entry)) {
                targets.push({ file: path.join(full, entry), isLoop: /loop|amb/i.test(entry), label: path.join(given, entry) });
              }
            }
          } else targets.push({ file: full, isLoop: /loop|amb/i.test(given), label: given });
        }
        if (targets.length === 0) throw new ProjectError("Nothing to analyze: give names, files, or all: true.");
        if (targets.length > 100) throw new ProjectError(`That is ${targets.length} files; analyze at most 100 at a time.`);
        const results: { name: string; analysis: ReturnType<typeof analyze>; isLoop: boolean }[] = [];
        const errors: string[] = [];
        for (const target of targets) {
          try {
            results.push({ name: target.label, analysis: analyze(await decodeFile(target.file, extra.signal), { expectLoop: target.isLoop }), isLoop: target.isLoop });
          } catch (error) {
            errors.push(`${target.label}: ${(error as Error).message}`);
          }
        }
        const flagged = results.filter((r) => r.analysis.flags.length).length;
        return json({
          summary: `${results.length} file${results.length === 1 ? "" : "s"} measured, ${flagged} with something to fix.`,
          files: results.map((r) => ({ file: r.name, ...r.analysis })),
          set_notes: compareSet(results),
          ...(errors.length ? { errors } : {}),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── audition_styles ────────────────────────────────────────────────────────────────
  server.registerTool(
    "audition_styles",
    {
      title: "Audition styles",
      description:
        `Makes the same three sounds (a jump, a coin and a hit) in up to ${MAX_STYLES} directions, one take each, so the person can hear ` +
        "styles side by side and pick by ear before any real sound is made. Styles are preset ids or free-text directions. " +
        `Presets: ${STYLE_PRESETS.map((p) => `${p.id} (${p.name})`).join(", ")}. ` +
        "Files go to .takebox/auditions, not the game. Use dry_run first to see what it costs. Then open_board to listen.",
      inputSchema: {
        project,
        styles: z.array(z.string().min(2)).min(1).max(MAX_STYLES).describe("Preset ids, or directions in words."),
        dry_run: z.boolean().default(false),
        confirm_credits: z.number().int().optional(),
      },
      annotations: { openWorldHint: true, destructiveHint: false },
    },
    async (args, extra) => {
      try {
        const ctx = await contextFor(args.project, extra as never);
        return json(await runAudition(ctx, args.styles, { dryRun: args.dry_run, ...(args.confirm_credits !== undefined ? { confirmCredits: args.confirm_credits } : {}) }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── open_board ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    "open_board",
    {
      title: "Open the sound board",
      description:
        "Opens TAKEBOX's sound board in the person's browser, on this machine only: every sound and take with play buttons and " +
        "waveforms, keep / redo / reject, editable prompts, style auditions side by side, the plan from the code, and the spend. " +
        "What they keep there is recorded in takebox.json (kept); wire those takes in. Returns the address.",
      inputSchema: { project },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (args) => {
      try {
        const root = await rootFor(args.project);
        let board = boards.get(root);
        const fresh = !board;
        if (!board) {
          board = startBoard(services, root, { open: options.openBrowser ?? true });
          boards.set(root, board);
          board.catch(() => boards.delete(root));
        }
        const { url } = await board;
        return json({
          url,
          opened: fresh && (options.openBrowser ?? true) ? "in the default browser" : "already running; give the person the address",
          note: "The board stays up while this AI session is open. Without the AI, the person can run: takebox-mcp board <project>",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── The guide and the one-command pass ─────────────────────────────────────────────
  server.registerResource(
    "guide",
    "takebox://guide",
    { title: "TAKEBOX sound design guide", description: "How to plan, write, make and wire a game's sounds.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );

  server.registerPrompt(
    "sound_pass",
    { title: "Full sound pass", description: "Plan, search, make, check and wire every sound this game needs, one step at a time." },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: `${SOUND_PASS}\n\n---\n\n${GUIDE}` } }] }),
  );

  return server;
}
