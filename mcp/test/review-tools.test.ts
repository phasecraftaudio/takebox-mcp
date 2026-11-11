import { rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import * as codecs from "../src/audio/codecs.js";
import { updateManifest } from "../src/project.js";
import { createServer } from "../src/server.js";
import { SpendLedger } from "../src/spend.js";
import { tempDir } from "./helpers.js";

describe("review: MCP preflight before spending", () => {
  it("refuses an unavailable saved default format before generating a paid take", async () => {
    const root = await tempDir("takebox-review-tools-game-");
    const home = await tempDir("takebox-review-tools-home-");
    // This project was configured on a machine that could write Opus. The next
    // developer has only TAKEBOX's built-in codecs, a supported installation.
    await updateManifest(root, (manifest) => {
      manifest.settings = { formats: { oneShot: ["opus"], loop: ["ogg"] } };
    });
    const available = vi.spyOn(codecs, "writableFormats").mockResolvedValue(["wav", "aiff", "mp3", "ogg"]);
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      throw new Error("Unexpected provider call: the output format should have been checked first");
    }) as typeof fetch;
    const server = createServer({
      env: { TAKEBOX_PROJECT: root, ELEVENLABS_API_KEY: "review-placeholder" },
      ledger: new SpendLedger(path.join(home, "spend.json")), fetch: fake,
    });
    const client = new Client({ name: "review", version: "1" });
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const result = await client.callTool({ name: "make_sounds", arguments: {
        sounds: [{ name: "jump", prompt: "A springy jump.", duration_s: 1 }],
        confirm_credits: 40,
      } });
      expect({ calls, isError: Boolean(result.isError) }).toEqual({ calls: 0, isError: true });
    } finally {
      await client.close();
      await server.close();
      available.mockRestore();
      await Promise.all([root, home].map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });
});
