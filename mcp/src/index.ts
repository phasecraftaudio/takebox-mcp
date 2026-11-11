/**
 * TAKEBOX MCP server over stdio. stdout carries the protocol, so anything for a human goes to stderr.
 *
 *   takebox-mcp                    the MCP server (what an AI client runs)
 *   takebox-mcp board [project]    the sound board alone, in the browser, no AI needed
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startBoard } from "./board/http.js";
import { checkRoot } from "./project.js";
import { createServer, VERSION } from "./server.js";
import { createServices } from "./services.js";

const [command, given] = process.argv.slice(2);

if (command === "board") {
  const services = createServices();
  const root = checkRoot(given ?? process.env.TAKEBOX_PROJECT ?? process.cwd());
  const port = process.env.TAKEBOX_BOARD_PORT ? Number(process.env.TAKEBOX_BOARD_PORT) : undefined;
  const board = await startBoard(services, root, { open: true, ...(port ? { port } : {}) });
  console.error(`TAKEBOX ${VERSION} sound board for ${root}\n${board.url}\nCtrl+C to stop.`);
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`TAKEBOX MCP ${VERSION} ready`);
}
