#!/usr/bin/env node
/** stdio wiring. Deliberately thin: everything worth testing is in tools.ts,
 * and the framing below belongs to the SDK.
 *
 * Usage, in an assistant's MCP config:
 *
 *   {
 *     "mcpServers": {
 *       "lionsdegree": {
 *         "command": "npx",
 *         "args": ["-y", "lionsdegree-mcp", "--plan", "/path/to/your-plan.json"]
 *       }
 *     }
 *   }
 *
 * LIONSDEGREE_PLAN works instead of --plan. Nothing else is needed: no
 * account, no key, no network.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeTool, listTools, loadContext, type ToolContext } from "./tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_ROOT = path.resolve(here, "..", "catalog");

function planPath(): string {
  const i = process.argv.indexOf("--plan");
  const fromArg = i >= 0 ? process.argv[i + 1] : undefined;
  const p = fromArg ?? process.env.LIONSDEGREE_PLAN;
  if (!p) {
    // stderr, not stdout: stdout is the protocol channel and anything written
    // there that is not a message corrupts the session.
    console.error(
      "lionsdegree-mcp needs your plan file.\n" +
        "  npx -y lionsdegree-mcp --plan /path/to/your-plan.json\n" +
        "Export one from the planner: Menu → Save plan to a file.",
    );
    process.exit(2);
  }
  return path.resolve(p);
}

async function main() {
  // Loaded ONCE. This process is long-lived, so the ~70 ms spent reading the
  // index here buys in-memory answers for the rest of the session.
  let ctx: ToolContext;
  try {
    ctx = await loadContext({ planPath: planPath(), catalogRoot: CATALOG_ROOT });
  } catch (e) {
    console.error(`lionsdegree-mcp could not open your plan: ${(e as Error).message}`);
    process.exit(1);
  }

  const server = new Server(
    { name: "lionsdegree", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await executeTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  await server.connect(new StdioServerTransport());
}

void main();
