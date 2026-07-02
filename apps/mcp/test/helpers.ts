import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolDef, ToolResult } from '../src/tools.js';

/** Create an isolated temp Projects root for a test. */
export async function makeTmpRoot(): Promise<string> {
  const dir = path.join(os.tmpdir(), `po-mcp-${randomBytes(8).toString('hex')}`, 'Projects');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Remove a temp root (and its parent wrapper). */
export async function cleanup(projectsRoot: string): Promise<void> {
  await fs.rm(path.dirname(projectsRoot), { recursive: true, force: true });
}

/** A fixed clock so created/updated timestamps are deterministic in assertions. */
export const fixedNow = (): string => '2026-06-29T10:00:00.000Z';

/** Index tools by name for direct handler invocation in tests. */
export function byName(tools: ToolDef[]): Map<string, ToolDef> {
  return new Map(tools.map((t) => [t.name, t]));
}

/** Invoke a tool's handler by name, asserting it exists. */
export async function call(
  tools: Map<string, ToolDef>,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const t = tools.get(name);
  if (!t) throw new Error(`No such tool: ${name}`);
  return t.handler(args);
}

/** Extract structuredContent, failing loudly on an error result. */
export function data(res: ToolResult): Record<string, unknown> {
  if (res.isError) throw new Error(`Expected ok, got error: ${res.content[0]?.text}`);
  if (!res.structuredContent) throw new Error('Missing structuredContent');
  return res.structuredContent;
}
