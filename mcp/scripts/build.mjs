#!/usr/bin/env node
// Builds the two halves of TAKEBOX MCP:
//   dist/takebox-mcp.js  the server: this package, TAKEBOX's shared DSP and take tools, in one file.
//                        npm dependencies (MCP SDK, zod, the WebAssembly codecs) stay external.
//   dist/board/          the sound board page, built with the desktop app's Vite and React.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const outfile = path.join(root, "dist/takebox-mcp.js");
await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "inline",
  logLevel: "info",
});
await chmod(outfile, 0o755);

// The desktop's own Vite, so the board's take card is built exactly as the app's is.
const vite = path.resolve(root, "../node_modules/.bin/vite");
const board = spawnSync(vite, ["build", "--config", path.join(root, "board/vite.config.ts"), "--logLevel", "warn"], { stdio: "inherit", cwd: path.join(root, "board") });
if (board.status !== 0) {
  console.error("The board did not build. Run `npm install` in the TAKEBOX folder first: the board uses its Vite and React.");
  process.exit(board.status ?? 1);
}
// public/licences.html is the desktop app's own notice page (its ffmpeg, Electron and service). It is
// generated, so it is only there when the desktop was built on this machine, and it does not describe
// this package. The board's notices are dist/board/licences.txt, written by board/vite.config.ts.
await rm(path.join(root, "dist/board/licences.html"), { force: true });
console.log("  dist/board/ built");
