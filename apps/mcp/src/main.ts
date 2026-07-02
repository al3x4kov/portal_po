import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stderrOpLogger } from '@po/server';
import { createTools } from './tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/main.js → apps/mcp/dist → apps/mcp → apps → <repo>
const repoRoot = path.resolve(here, '..', '..', '..');

const PROJECTS_ROOT = process.env.PROJECTS_ROOT
  ? path.resolve(process.env.PROJECTS_ROOT)
  : path.join(repoRoot, 'Projects');

/**
 * Bootstrap the MCP server over stdio (T-1002). Every tool is a thin wrapper
 * over the existing @po/server services, sharing a single PROJECTS_ROOT.
 */
async function main(): Promise<void> {
  const server = new McpServer({ name: 'po-mcp', version: '0.1.0' });

  // stdout is the JSON-RPC channel; all diagnostics go to stderr (ARCH-7).
  for (const t of createTools(PROJECTS_ROOT, undefined, stderrOpLogger())) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      // The SDK validates args against inputSchema before invoking the handler.
      async (args: unknown) => (await t.handler(args)) as never,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal MCP startup error:', err);
  process.exit(1);
});
