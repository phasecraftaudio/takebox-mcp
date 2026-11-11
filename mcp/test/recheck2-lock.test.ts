import { execFile } from "node:child_process";
import { rm, utimes } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.js";

const folders: string[] = [];
const execute = promisify(execFile);
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("recheck: recovery after a reclaimer crashes", () => {
  it("honors its timeout when a crashed reclaimer left an empty recovery guard", async () => {
    const folder = await tempDir("takebox-recheck2-lock-");
    folders.push(folder);
    const lock = path.join(folder, "spend.json.lock");
    const guard = `${lock}.reclaim`;
    // One exited owner leaves its named lock. A second exited process models a
    // reclaimer crashing between exclusive-create and writeFile: its guard is empty.
    await execute(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(lock)}, process.pid + " dead-owner " + Date.now());
    `], { env: { PATH: "" } });
    await execute(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.closeSync(fs.openSync(${JSON.stringify(guard)}, "wx"));
    `], { env: { PATH: "" } });
    const old = new Date(Date.now() - 11_000);
    await utimes(guard, old, old);
    const moduleUrl = new URL("../src/lock.ts", import.meta.url).href;
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    // Isolate the waiter: a broken recovery loop must never hang the test runner.
    const outcome = await execute(process.execPath, ["--import", tsx, "--input-type=module", "-e", `
      const { withFileLock } = await import(${JSON.stringify(moduleUrl)});
      try {
        await withFileLock(${JSON.stringify(lock)}, async () => {}, { timeoutMs: 40 });
        process.stdout.write("acquired");
      } catch {
        process.stdout.write("timed_out");
      }
    `], { timeout: 1500, killSignal: "SIGKILL", env: { PATH: "" } })
      .then(({ stdout }) => stdout)
      .catch((error: Error & { killed?: boolean }) => error.killed ? "hung" : String(error));
    // Recovering the guard or reporting timeout is acceptable; an endless loop is not.
    expect(outcome).toMatch(/^(acquired|timed_out)$/);
  });
});
