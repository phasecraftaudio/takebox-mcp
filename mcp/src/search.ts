/**
 * Search: find a sound before paying to make one.
 *
 * Looks in three places — the sounds TAKEBOX already made for this project (by name and by the
 * prompt that made them), every audio file inside the project, and the person's own sound
 * libraries (TAKEBOX_LIBRARY: folders separated by the system path separator).
 *
 * Matching is by words in folder and file names, which is how libraries are organised. UCS names
 * (`FOLYFeet_Boots Gravel Walk_XYZ.wav`) split into their words; a small synonym list catches the
 * obvious misses (footstep ↔ feet, explosion ↔ boom). No audio is listened to here: `analyze`
 * measures the top results only when asked.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { AUDIO_EXTENSIONS } from "./audio/codecs.js";
import type { Manifest } from "./project.js";
import { tokens } from "./scan.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "Library", "Temp", "obj", "Intermediate", "Saved", ".godot", ".import"]);
const MAX_LIBRARY_FILES = 300_000;
const INDEX_TTL_MS = 10 * 60 * 1000;

/** Each line: words that should find each other. */
const SYNONYM_GROUPS = [
  "footstep footsteps step steps feet foot walk walking run running foley",
  "explosion explode explosions boom blast bomb detonation",
  "whoosh swoosh swish woosh swing pass by passby",
  "click clicks tick button tap ui interface",
  "coin coins money gold cash pickup collect",
  "hit hits impact impacts punch thud smack strike",
  "door doors gate",
  "glass shatter break smash",
  "water splash liquid wave waves ocean sea",
  "rain storm thunder weather",
  "wind gust breeze air",
  "magic spell cast sparkle shimmer",
  "gun gunshot shot shoot rifle pistol firearm",
  "ambience ambient amb atmosphere atmos room tone roomtone bed",
  "fire flame flames burn campfire",
  "creature monster growl roar",
  "laser zap blaster",
  "jump hop",
  "land landing thump",
  "error buzz wrong fail",
  "notify notification alert chime ding",
  "metal metallic clang",
  "wood wooden",
  "stone rock rocks gravel",
  "cloth fabric rustle",
];
const SYNONYMS = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const words = group.split(" ");
  for (const word of words) {
    const set = SYNONYMS.get(word) ?? new Set<string>();
    for (const other of words) if (other !== word) set.add(other);
    SYNONYMS.set(word, set);
  }
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export interface Hit {
  where: "made" | "project" | "library";
  /** Absolute path to the file, or the sound name for a made sound. */
  path: string;
  name: string;
  score: number;
  matched: string[];
  /** For a made sound: the files and prompt. */
  files?: string[];
  prompt?: string;
}

interface Indexed {
  at: number;
  files: string[];
  truncated: boolean;
}
const indexes = new Map<string, Indexed>();

async function listAudio(root: string, limit: number): Promise<Indexed> {
  const files: string[] = [];
  const queue = [root];
  const audio = new Set(AUDIO_EXTENSIONS.map((ext) => `.${ext}`));
  while (queue.length) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) queue.push(full);
      } else if (audio.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
        if (files.length >= limit) return { at: Date.now(), files, truncated: true };
      }
    }
  }
  return { at: Date.now(), files, truncated: false };
}

async function indexOf(root: string, refresh: boolean, limit: number): Promise<Indexed> {
  const cached = indexes.get(root);
  if (cached && !refresh && Date.now() - cached.at < INDEX_TTL_MS) return cached;
  const fresh = await listAudio(root, limit);
  indexes.set(root, fresh);
  return fresh;
}

function score(query: string[], nameWords: string[], folderWords: string[]): { score: number; matched: string[] } {
  const name = new Set(nameWords.map(stem));
  const folder = new Set(folderWords.map(stem));
  let total = 0;
  const matched: string[] = [];
  for (const raw of query) {
    const word = stem(raw);
    let best = 0;
    if (name.has(word)) best = 3;
    else if (folder.has(word)) best = 1.5;
    else {
      const related = [...(SYNONYMS.get(raw) ?? SYNONYMS.get(word) ?? [])].map(stem);
      if (related.some((w) => name.has(w))) best = 2;
      else if (related.some((w) => folder.has(w))) best = 1;
      else if (word.length >= 4 && [...name].some((w) => w.startsWith(word))) best = 1;
    }
    if (best > 0) matched.push(raw);
    total += best;
  }
  return { score: total, matched };
}

export interface SearchOptions {
  query: string;
  root: string;
  manifest: Manifest;
  libraries: string[];
  scope: "all" | "project" | "library";
  limit: number;
  refresh?: boolean;
}

export async function searchSounds(options: SearchOptions): Promise<{ hits: Hit[]; searched: string[]; notes: string[] }> {
  const query = [...new Set(tokens(options.query).filter((w) => w.length > 1 && !/^\d+$/.test(w)))].filter(
    // Joined pairs only help identifiers; for a typed query keep the plain words.
    (w) => options.query.toLowerCase().includes(w),
  );
  const notes: string[] = [];
  if (query.length === 0) return { hits: [], searched: [], notes: ["Give a few words: what the sound is and what it is made of."] };
  const hits: Hit[] = [];
  const searched: string[] = [];
  const needed = Math.max(1, Math.ceil(query.length * 0.5));

  if (options.scope !== "library") {
    searched.push("takebox.json");
    for (const [name, record] of Object.entries(options.manifest.sounds)) {
      const words = [...tokens(name), ...tokens(record.prompt ?? "")];
      const result = score(query, words, []);
      if (result.matched.length >= needed) {
        hits.push({ where: "made", path: name, name, score: result.score + 1, matched: result.matched, files: record.files, ...(record.prompt ? { prompt: record.prompt } : {}) });
      }
    }
    searched.push(options.root);
    const project = await indexOf(options.root, options.refresh ?? false, 20_000);
    const made = new Set(Object.values(options.manifest.sounds).flatMap((r) => r.files.map((f) => path.resolve(options.root, f))));
    for (const file of project.files) {
      if (made.has(file) || file.includes(`${path.sep}.takebox${path.sep}`)) continue;
      const rel = path.relative(options.root, file);
      const result = score(query, tokens(path.basename(file, path.extname(file))), tokens(path.dirname(rel)));
      if (result.matched.length >= needed) hits.push({ where: "project", path: file, name: path.basename(file), score: result.score, matched: result.matched });
    }
  }

  if (options.scope !== "project") {
    if (options.libraries.length === 0) {
      notes.push("No sound library is set. If the person has one, set TAKEBOX_LIBRARY in the MCP config to its folder(s).");
    }
    for (const library of options.libraries) {
      searched.push(library);
      const index = await indexOf(library, options.refresh ?? false, MAX_LIBRARY_FILES);
      if (index.files.length === 0) notes.push(`No audio found in ${library}.`);
      if (index.truncated) notes.push(`${library} has more than ${MAX_LIBRARY_FILES} files; only the first ${MAX_LIBRARY_FILES} were searched.`);
      for (const file of index.files) {
        const rel = path.relative(library, file);
        const result = score(query, tokens(path.basename(file, path.extname(file))), tokens(path.dirname(rel)));
        if (result.matched.length >= needed) hits.push({ where: "library", path: file, name: path.basename(file), score: result.score, matched: result.matched });
      }
    }
  }

  hits.sort((a, b) => b.matched.length - a.matched.length || b.score - a.score || a.path.length - b.path.length);
  return { hits: hits.slice(0, options.limit), searched, notes };
}
