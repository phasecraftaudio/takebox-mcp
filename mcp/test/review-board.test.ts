import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav } from "../src/audio/pcm.js";
import { startBoard, type Board } from "../src/board/http.js";
import { updateManifest } from "../src/project.js";
import { createServices } from "../src/services.js";
import { SpendLedger } from "../src/spend.js";
import { takeId } from "../src/takes.js";
import { burst, concat, noise, silence, tempDir } from "./helpers.js";

const boards: Board[] = [];
const directories: string[] = [];
afterEach(async () => {
  while (boards.length) await boards.pop()!.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(env: Record<string, string> = {}) {
  const root = await tempDir("takebox-review-board-");
  const home = await tempDir("takebox-review-ledger-");
  directories.push(root, home);
  await writeFile(path.join(root, "package.json"), "{}");
  // Use WAV to keep the tests independent of browser codec compilation.
  await updateManifest(root, (manifest) => {
    manifest.settings = { formats: { oneShot: ["wav"], loop: ["wav"] } };
    manifest.sounds.coin = {
      kind: "one-shot", role: "sfx", source: "generated", prompt: "A soft wooden coin.",
      durationS: 1, files: [], created: new Date().toISOString(), updated: new Date().toISOString(),
    };
  });
  let calls = 0;
  const services = createServices({
    env: { ELEVENLABS_API_KEY: "review-placeholder", ...env },
    ledger: new SpendLedger(path.join(home, "spend.json")),
    fetch: (async () => {
      calls++;
      return new Response(encodeWav([concat(silence(0.05), burst(0.4, 0.3, 0.04), silence(0.1))], 48000, 16));
    }) as typeof fetch,
  });
  const board = await startBoard(services, root, { open: false });
  boards.push(board);
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(new URL(route, board.url), {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { board, root, services, post, calls: () => calls };
}

describe("review: the board always requires the person's yes", () => {
  it.each([
    ["/api/make", { sounds: [{ name: "jump", prompt: "A springy jump.", duration_s: 1 }] }],
    ["/api/redo", { name: "coin", variations: 1 }],
    ["/api/audition", { styles: ["cozy-wooden"] }],
  ])("does not spend below the MCP ask line without confirmation on %s", async (route, body) => {
    const { post, calls, services } = await fixture();
    const priced = await (await post(route, { ...body, dry_run: true })).json() as { estimate_credits: number };
    expect(priced.estimate_credits).toBeGreaterThan(0);
    expect(priced.estimate_credits).toBeLessThan(services.limits.askAbove);
    expect(calls()).toBe(0);

    const result = await (await post(route, body)).json() as { status: string };
    // A board request must obey the dialog contract even for a small batch.
    expect.soft(calls()).toBe(0);
    expect.soft(await services.ledger.spentToday()).toBe(0);
    expect(result.status).toBe("needs_confirmation");
  });

  it("does not spend a small board batch beyond the amount explicitly confirmed", async () => {
    const { post, calls } = await fixture();
    const response = await post("/api/make", {
      sounds: [{ name: "jump", prompt: "A springy jump.", duration_s: 1 }], confirm_credits: 1,
    });
    const result = await response.json() as { status: string };
    expect.soft(calls()).toBe(0);
    expect(result.status).toBe("needs_confirmation");
  });

  it("rejects a nonnumeric HTTP duration before it can bypass a zero daily cap", async () => {
    const { post, calls } = await fixture({ TAKEBOX_DAILY_CREDITS: "0", TAKEBOX_ASK_ABOVE: "0" });
    const response = await post("/api/make", {
      sounds: [{ name: "jump", prompt: "A springy jump.", duration_s: "auto" }],
    });
    expect.soft(calls()).toBe(0);
    expect(response.status).toBe(400);
  });
});

describe("review: board session boundary", () => {
  it("rejects a foreign Origin on a JSON mutation even when Host is loopback", async () => {
    const { post, root } = await fixture();
    // This is a server-side negative test, not a claim that a normal foreign browser
    // can bypass the current JSON preflight / no-CORS protection.
    const response = await post("/api/direction", { direction: "unapproved change" }, { Origin: "https://foreign.example" });
    expect(response.status).toBe(403);
    const { loadManifest } = await import("../src/project.js");
    expect((await loadManifest(root)).settings?.direction).not.toBe("unapproved change");
  });

  it("prevents another site from framing the board's spend dialog", async () => {
    const { board } = await fixture();
    const response = await fetch(board.url);
    const csp = response.headers.get("content-security-policy") ?? "";
    const frameOptions = response.headers.get("x-frame-options") ?? "";
    await response.arrayBuffer();
    expect(/frame-ancestors\s+(?:'none'|'self')/i.test(csp) || /^(?:DENY|SAMEORIGIN)$/i.test(frameOptions)).toBe(true);
  });
});

describe("review: the board remembers actual loop results", () => {
  it("does not advertise a failed loop conversion as a seamless take", async () => {
    const { post, board } = await fixture();
    const made = await (await post("/api/make", {
      sounds: [{ name: "wind", prompt: "A brief gust of wind.", kind: "loop", duration_s: 1 }], confirm_credits: 40,
    })).json() as { sounds: { notices: string[] }[] };
    expect(made.sounds[0]!.notices.join(" ")).toMatch(/No steady part/);
    const state = await (await fetch(new URL("/api/board", board.url))).json() as { sounds: { name: string; takes: { loopable?: boolean }[] }[] };
    expect(state.sounds.find((sound) => sound.name === "wind")!.takes[0]!.loopable).not.toBe(true);
  });

  it("keeps a successful Make loop result loopable after reloading the board", async () => {
    const { post, board, root } = await fixture();
    const file = "audio/forest_01.wav";
    await mkdir(path.join(root, "audio"), { recursive: true });
    await writeFile(path.join(root, file), encodeWav([noise(16, 0.1)], 48000, 24));
    await updateManifest(root, (manifest) => {
      manifest.sounds.forest = {
        kind: "one-shot", role: "ambience", source: "file", files: [file],
        created: new Date().toISOString(), updated: new Date().toISOString(),
      };
    });
    const result = await (await post(`/api/audio/${takeId("audio/forest_01")}/loop`, {})).json() as { results: { id: string; loopable?: boolean }[] };
    expect(result.results[0]!.loopable).toBe(true);
    const state = await (await fetch(new URL("/api/board", board.url))).json() as { sounds: { name: string; takes: { id: string; loopable?: boolean }[] }[] };
    const saved = state.sounds.find((sound) => sound.name === "forest")!.takes.find((take) => take.id === result.results[0]!.id)!;
    expect(saved.loopable).toBe(true);
  });
});

describe("review: reveal process failures", () => {
  it("keeps the board process alive when the platform reveal helper is unavailable", async () => {
    const moduleUrl = new URL("../src/takes.ts", import.meta.url).href;
    const projectDir = fileURLToPath(new URL("..", import.meta.url));
    // Use a child so an unhandled spawn 'error' cannot terminate the test runner.
    // A missing xdg-open is normal on headless Linux; an empty PATH models the same
    // OS-level ENOENT deterministically on every development platform.
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { reveal } from ${JSON.stringify(moduleUrl)};
      reveal(${JSON.stringify(path.join(projectDir, "test", "synthetic.wav"))});
      setTimeout(() => console.log("still alive"), 100);
    `], { cwd: projectDir, env: { PATH: "" }, timeout: 10_000 })
      .then((out) => ({ code: 0, stdout: out.stdout, stderr: out.stderr }))
      .catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("still alive");
  });
});
