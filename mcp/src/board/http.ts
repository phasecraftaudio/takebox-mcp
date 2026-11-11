/**
 * The sound board: TAKEBOX in the browser, on this machine only.
 *
 * Serves the built board page and answers two sets of routes:
 *   - the ones TAKEBOX desktop's take card calls (/api/audio/:id, /loudness, /tighten, /split,
 *     /loop, /export, /api/reveal), so the board's cards are the desktop app's cards;
 *   - the board's own: the sound list, the plan from the code, making, redoing, auditions.
 *
 * Safety (Codex review 2026-11-09, finding 16, after Inspector's CVE-2025-49596 fix):
 *  - listens on 127.0.0.1 only, and refuses any Host header but its own (DNS rebinding);
 *  - a request that carries an Origin must come from this board's own origin;
 *  - a browser request (it sends Sec-Fetch-Site) must be same-origin and carry this session's
 *    random token, set as an HttpOnly, SameSite=Strict cookie when the page loads, so no other
 *    site or other localhost page can drive the board, even through the take cards' audio;
 *  - the page cannot be framed (frame-ancestors 'none'), so no site can dress up its spend dialog;
 *  - every POST must be JSON, and every paid route validates its body like the MCP tools do;
 *  - a take id only resolves to files listed in takebox.json.
 * A non-browser client (no Origin, no Sec-Fetch-Site) is a program running as the person, which
 * can already read the MCP config with the API key in it; it is not asked for the token.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measureLoudness } from "../../../shared/dsp/loudness.js";
import { runAudition } from "../audition.js";
import { decodeFile, writableFormats } from "../audio/codecs.js";
import { encodeWav } from "../audio/pcm.js";
import type { ZodType } from "zod";
import { makeSounds, type SoundSpec } from "../make.js";
import { loadManifest, MANIFEST, ProjectError, resolveSettings, updateManifest } from "../project.js";
import { scanProject } from "../scan.js";
import { boardAudition, boardDirection, boardDisposition, boardMake, boardRedo, boardRedoMany, boardRegion, boardReveal, boardTool } from "../schemas.js";
import { contextFor, learnedRate, type Services } from "../services.js";
import { STYLE_PRESETS } from "../styles.js";
import {
  cardFor, exportRegion, groupTakes, MIME, playable, resolveTake, reveal, setDisposition, takeTool, type CardResult,
} from "../takes.js";

export interface Board {
  url: string;
  root: string;
  close(): Promise<void>;
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon",
};

function staticRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, "board"), path.resolve(here, "../../dist/board"), path.resolve(here, "../dist/board")]) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "That was not valid JSON.");
  }
}

/** Parse and check a body; anything malformed is refused before it can reach a paid call. */
async function body<T>(req: http.IncomingMessage, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Not accepted: ${issue ? `${issue.path.join(".") || "body"} ${issue.message}` : "invalid request"}.`);
  }
  return parsed.data;
}

const PAGE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...PAGE_HEADERS });
  res.end(text);
}

/** Send `size` bytes, honouring a Range request; `open` streams the bytes from start to end. */
function sendRange(
  req: http.IncomingMessage, res: http.ServerResponse, size: number, type: string, extra: Record<string, string>,
  open: (start: number, end: number) => NodeJS.ReadableStream | Uint8Array,
) {
  const write = (body: NodeJS.ReadableStream | Uint8Array) => (body instanceof Uint8Array ? res.end(body) : body.pipe(res));
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...PAGE_HEADERS, ...extra });
    write(open(start, end));
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...PAGE_HEADERS, ...extra });
  write(open(0, size - 1));
}

async function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, type: string, extra: Record<string, string> = {}) {
  const { size } = await stat(file);
  sendRange(req, res, size, type, extra, (start, end) => createReadStream(file, { start, end }));
}

/**
 * Formats every browser the board may open in can play. Safari has no Ogg Vorbis, and FLAC and
 * Opus are patchy: a game set to OGG broke every take card in Safari (Ryu's listening pass, 11-10).
 */
const BROWSER_SAFE = new Set([".wav", ".mp3", ".m4a"]);

const ROLE_GROUP: Record<string, string> = {
  ui: "Interface", foley: "Footsteps & foley", sfx: "Sounds", impact: "Impacts", ambience: "Ambience", music: "Music & stings", voice: "Voice",
};

async function boardState(services: Services, root: string) {
  const manifest = await loadManifest(root);
  const settings = resolveSettings(root, manifest);
  let name = path.basename(root);
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name?: string };
    if (pkg.name) name = pkg.name;
  } catch {
    // not a node project
  }
  const sounds = await Promise.all(
    Object.entries(manifest.sounds).map(async ([soundName, record]) => {
      const kept = new Set(record.kept ?? []);
      const takes = (
        await Promise.all(
          groupTakes(record.files).map((take, index) =>
            cardFor(root, take, String(index + 1).padStart(2, "0"), {
              // What processing achieved for this take; only takes from before take records fall
              // back to the sound's kind (Codex review 2026-11-09, finding 11).
              loopable: record.takes?.[take.stem]?.loopable ?? (record.takes ? false : record.kind === "loop"),
              kept: kept.has(take.stem),
            }),
          ),
        )
      ).filter((card): card is CardResult => card !== null);
      return {
        name: soundName,
        group: ROLE_GROUP[record.role] ?? "Sounds",
        kind: record.kind,
        role: record.role,
        source: record.source,
        prompt: record.prompt ?? "",
        durationS: record.durationS ?? null,
        kept: kept.size,
        takes,
      };
    }),
  );
  const auditions = await Promise.all(
    Object.entries(manifest.auditions ?? {}).map(async ([key, audition]) => ({
      key,
      label: audition.label,
      direction: audition.direction,
      chosen: audition.direction === settings.direction,
      takes: (
        await Promise.all(groupTakes(audition.files).map((take) => cardFor(root, take, path.basename(take.stem).replace(/_\d+$/, ""), {})))
      ).filter((card): card is CardResult => card !== null),
    })),
  );
  let version = 0;
  try {
    version = (await stat(path.join(root, MANIFEST))).mtimeMs;
  } catch {
    // no takebox.json yet
  }
  return {
    project: root,
    name,
    engine: settings.engine,
    settings: { folder: settings.folder, formats: settings.formats, direction: settings.direction },
    spend: {
      today: await services.ledger.spentToday(),
      cap: services.limits.dailyCap,
      askAbove: services.limits.askAbove,
      // The rate the board's cost labels use: what ElevenLabs really charged lately, as the MCP estimates it.
      perSecond: await learnedRate(services).then(() => services.provider?.creditsPerSecond?.() ?? null),
    },
    provider: services.provider ? services.provider.label : null,
    canWrite: await writableFormats(),
    styles: STYLE_PRESETS,
    sounds: sounds.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)),
    auditions,
    version,
  };
}

export async function startBoard(services: Services, root: string, options: { port?: number; open?: boolean } = {}): Promise<Board> {
  const assets = staticRoot();
  let port = 0;
  const token = randomBytes(32).toString("hex");
  const cookieName = () => `takebox_board_${port}`;
  const hasToken = (req: http.IncomingMessage) => {
    const found = (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).find(([name]) => name === cookieName());
    const given = Buffer.from(found?.[1] ?? "");
    const wanted = Buffer.from(token);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "Wrong host.");
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw new HttpError(403, "Requests from other sites are refused.");
      }
      const site = req.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none") throw new HttpError(403, "Requests from other sites are refused.");
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const route = url.pathname;
      const method = req.method ?? "GET";

      if (route.startsWith("/api/")) {
        // A browser must show this session's token; only the board's own page was given it.
        if ((site !== undefined || origin !== undefined) && !hasToken(req)) throw new HttpError(403, "This board session has ended. Reload the page.");
        const ctx = await contextFor(services, root);
        const manifest = await loadManifest(root);

        if (method === "GET" && route === "/api/board") return send(res, 200, await boardState(services, root));
        if (method === "GET" && route === "/api/version") {
          const version = await stat(path.join(root, MANIFEST)).then((s) => s.mtimeMs, () => 0);
          return send(res, 200, { version, spent: await services.ledger.spentToday() });
        }
        if (method === "GET" && route === "/api/plan") {
          const made = Object.fromEntries(Object.entries(manifest.sounds).map(([n, r]) => [n, r.files]));
          const scan = await scanProject(root, { direction: ctx.settings.direction, made });
          return send(res, 200, scan);
        }

        const audio = /^\/api\/audio\/([A-Za-z0-9_-]+)(?:\/(loudness|tighten|split|loop|export|reject|disposition))?$/.exec(route);
        if (audio) {
          const take = resolveTake(manifest, audio[1]!);
          if (!take) throw new HttpError(404, "That take is not in takebox.json.");
          const action = audio[2];
          if (method === "GET" && !action) {
            const file = playable(root, take);
            if (BROWSER_SAFE.has(path.extname(file).toLowerCase())) return sendFile(req, res, file, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
            // For listening only: a 16-bit WAV of the take. The game's own file is not touched.
            const decoded = await decodeFile(file);
            const wav = encodeWav(decoded.channels, decoded.sampleRate, 16);
            return sendRange(req, res, wav.byteLength, "audio/wav", {}, (start, end) => wav.subarray(start, end + 1));
          }
          if (method === "GET" && action === "loudness") {
            const decoded = await decodeFile(playable(root, take));
            if (decoded.channels.length > 2) return send(res, 200, {});
            return send(res, 200, { loudness: measureLoudness(decoded.channels, decoded.sampleRate) });
          }
          if (method === "POST") {
            if (action === "tighten" || action === "split" || action === "loop") {
              const { preset } = await body(req, boardTool);
              return send(res, 200, { results: await takeTool(ctx, manifest, take, action, preset) });
            }
            if (action === "export") {
              const { start, end } = await body(req, boardRegion);
              return send(res, 200, { result: await exportRegion(ctx, manifest, take, start, end) });
            }
            if (action === "reject") {
              await readJson(req);
              await setDisposition(ctx, take, "reject");
              return send(res, 200, { ok: true });
            }
            if (action === "disposition") {
              const { value } = await body(req, boardDisposition);
              await setDisposition(ctx, take, value);
              return send(res, 200, { ok: true });
            }
          }
          throw new HttpError(404, "Unknown take action.");
        }

        if (method === "POST") {
          // Every spend from the board waits for the person's yes, however small (finding 15).
          const ask = { alwaysConfirm: true };
          if (route === "/api/reveal") {
            const { id } = await body(req, boardReveal);
            const take = resolveTake(manifest, id);
            if (!take) throw new HttpError(404, "That take is not in takebox.json.");
            reveal(path.resolve(root, take.files[0]!));
            return send(res, 200, { ok: true });
          }
          if (route === "/api/make") {
            const input = await body(req, boardMake);
            return send(res, 200, await makeSounds(ctx, input.sounds as SoundSpec[], { ...ask, dryRun: input.dry_run === true, ...(input.confirm_credits !== undefined ? { confirmCredits: input.confirm_credits } : {}) }));
          }
          // New takes of a sound already made, from its own kind, role and length.
          const redoSpec = (want: { name: string; prompt?: string; variations?: number }): SoundSpec => {
            const record = manifest.sounds[want.name];
            if (!record) throw new HttpError(404, `${want.name} is not in takebox.json.`);
            const prompt = want.prompt?.trim() ? want.prompt : record.prompt ?? "";
            if (!prompt.trim()) throw new HttpError(400, `${want.name} came from a file. Write a prompt to generate new takes.`);
            return {
              name: want.name,
              prompt,
              kind: record.kind,
              role: record.role,
              variations: want.variations ?? 1,
              ...(record.durationS ? { duration_s: record.durationS } : {}),
            };
          };
          if (route === "/api/redo") {
            const input = await body(req, boardRedo);
            return send(res, 200, await makeSounds(ctx, [redoSpec(input)], { ...ask, dryRun: input.dry_run === true, ...(input.confirm_credits !== undefined ? { confirmCredits: input.confirm_credits } : {}) }));
          }
          if (route === "/api/redo-many") {
            const input = await body(req, boardRedoMany);
            const specs = input.sounds.map(redoSpec);
            return send(res, 200, await makeSounds(ctx, specs, { ...ask, dryRun: input.dry_run === true, ...(input.confirm_credits !== undefined ? { confirmCredits: input.confirm_credits } : {}) }));
          }
          if (route === "/api/audition") {
            const input = await body(req, boardAudition);
            return send(res, 200, await runAudition(ctx, input.styles, { ...ask, dryRun: input.dry_run === true, ...(input.confirm_credits !== undefined ? { confirmCredits: input.confirm_credits } : {}) }));
          }
          if (route === "/api/direction") {
            const direction = (await body(req, boardDirection)).direction.trim();
            await updateManifest(root, (m) => {
              m.settings = { ...m.settings, direction };
            });
            return send(res, 200, { ok: true, direction });
          }
        }
        throw new HttpError(404, "Unknown route.");
      }

      // ── The page itself ──
      if (method !== "GET") throw new HttpError(405, "GET only.");
      const isPage = route === "/" || route === "/index.html";
      const session = { "Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/` };
      if (!assets) {
        if (!isPage) throw new HttpError(404, "Not found.");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...PAGE_HEADERS });
        res.end("The board page has not been built. Run `npm run build` in takebox/mcp.");
        return;
      }
      const relative = isPage ? "index.html" : decodeURIComponent(route.slice(1));
      const file = path.resolve(assets, relative);
      if (!file.startsWith(assets + path.sep) || !existsSync(file)) throw new HttpError(404, "Not found.");
      return sendFile(req, res, file, STATIC_TYPES[path.extname(file)] ?? "application/octet-stream", isPage ? session : {});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof ProjectError ? 400 : 500;
      if (!res.headersSent) send(res, status, { error: (error as Error).message });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  if (options.open) openBrowser(url);
  return {
    url,
    root,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
    // A missing helper fails later, as an event; without a handler it would end the process (finding 20).
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser to open: the URL is printed and returned
  }
}
