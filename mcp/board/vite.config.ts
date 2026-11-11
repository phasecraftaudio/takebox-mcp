import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The board imports TAKEBOX desktop's take card, styles and fonts directly, and uses the desktop's
// public folder (fonts, wordmark). Vite and React come from the desktop's node_modules at build
// time; the built page is static and needs none of them at run time.
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "../..");

const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

/**
 * Writes licences.txt beside the page: every npm package Vite actually put in the bundle, taken
 * from the bundle's own module list (not from a dependency tree), plus the two typefaces. Every
 * copy of the page has to carry these notices (MIT, ISC, BSD and the OFL all ask for it).
 *
 * Nothing is skipped quietly. Each module in the bundle is one of three things: a file of this
 * repository, a file of an npm package, or a helper the bundler itself adds (Vite's preload
 * polyfill, Rollup's CommonJS helper), whose notice comes from Vite's own licence file. A module
 * that is none of these, or a package with no licence file, stops the build (Codex review
 * 2026-11-11, finding 1: the bundler's helpers had no notice).
 */
function licences(): Plugin {
  return {
    name: "takebox-board-licences",
    generateBundle() {
      const viteDir = path.join(desktop, "node_modules", "vite");
      const viteLicence = readFileSync(path.join(viteDir, "LICENSE.md"), "utf8");
      const viteVersion = (JSON.parse(readFileSync(path.join(viteDir, "package.json"), "utf8")) as { version: string }).version;
      /** One part of Vite's licence file: from the heading that matches to the next heading of its level. */
      const part = (heading: RegExp, level: "#" | "##") => {
        const lines = viteLicence.split("\n");
        const from = lines.findIndex((line) => line.startsWith(`${level} `) && heading.test(line));
        if (from < 0) this.error(`Vite's licence file has no "${heading.source}" part; the board's notices cannot be written.`);
        const rest = lines.slice(from + 1);
        const to = rest.findIndex((line) => /^#{1,2} /.test(line));
        return rest.slice(0, to < 0 ? undefined : to).join("\n").trim();
      };
      // Helpers the bundler adds to the page. They are not files, so they are named here.
      const helpers: Array<{ test: (id: string) => boolean; title: string; text: () => string }> = [
        { test: (id) => id.startsWith("\0vite/") || id.startsWith("vite/"), title: `vite ${viteVersion} (MIT): the page's module preload helper`, text: () => part(/Vite core license/, "#") },
        { test: (id) => id === "\0commonjsHelpers.js", title: "@rollup/plugin-commonjs (MIT), bundled in Vite: the CommonJS helper", text: () => part(/@rollup\/plugin-commonjs/, "##") },
      ];

      const roots = new Map<string, string>();
      const sections: string[] = [];
      const used = new Set<string>();
      for (const id of this.getModuleIds()) {
        const file = id.split("?")[0]!.replace(/^\0/, "");
        const at = file.lastIndexOf("/node_modules/");
        if (at >= 0) {
          const parts = file.slice(at + "/node_modules/".length).split("/");
          const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
          roots.set(name, path.join(file.slice(0, at), "node_modules", name));
          continue;
        }
        if (path.isAbsolute(file) && !path.relative(desktop, file).startsWith("..")) continue; // this repository's own source
        const helper = helpers.find((entry) => entry.test(id));
        if (!helper) this.error(`${JSON.stringify(id)} is in the board's bundle and is neither this repository's file, an npm package nor a known bundler helper. Add its notice to board/vite.config.ts before the page ships.`);
        if (!used.has(helper!.title)) {
          used.add(helper!.title);
          sections.push(`${helper!.title}\n\n${helper!.text()}`);
        }
      }
      for (const [name, dir] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
        const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string; license?: string };
        const file = existsSync(dir) ? readdirSync(dir).find((entry) => LICENCE_FILE.test(entry)) : undefined;
        if (!file) this.error(`${name} is in the board's bundle but has no licence file in ${dir}; the page cannot ship without its notice.`);
        sections.push(`${name} ${manifest.version ?? ""} (${manifest.license ?? "see below"})\n\n${readFileSync(path.join(dir, file!), "utf8").trim()}`);
      }
      for (const [name, file] of [["Inter (typeface)", "Inter-OFL.txt"], ["DM Mono (typeface)", "DM-Mono-OFL.txt"]] as const) {
        sections.push(`${name}\n\n${readFileSync(path.join(desktop, "licenses", file), "utf8").trim()}`);
      }
      const rule = `\n\n${"-".repeat(78)}\n\n`;
      this.emitFile({
        type: "asset",
        fileName: "licences.txt",
        source: `Third-party code and typefaces in the TAKEBOX sound board page.\nTAKEBOX itself is Apache-2.0: see LICENSE and NOTICE in the package.${rule}${sections.join(rule)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: here,
  base: "/",
  publicDir: path.resolve(here, "../../public"),
  plugins: [react(), licences()],
  build: {
    outDir: path.resolve(here, "../dist/board"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    fs: { allow: [path.resolve(here, "../..")] },
    // Development only: `TAKEBOX_BOARD_PORT=8790 takebox-mcp board <game>`, then `vite` here.
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.TAKEBOX_BOARD_PORT || 8790}`, changeOrigin: false } },
  },
});
