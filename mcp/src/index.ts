import { readFile as fsReadFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listDirectory, listVault } from './tools/explore.js';
import { deleteFile, moveFile } from './tools/manage.js';
import { readFile } from './tools/read.js';
import { grepVault } from './tools/search.js';
import { updateFile, writeFile } from './tools/write.js';
import { VaultError, createVault } from './vault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

async function loadInstructions(): Promise<string> {
  const skillPath = join(__dirname, '..', 'skills', 'vault', 'SKILL.md');
  const raw = await fsReadFile(skillPath, 'utf-8');
  return raw.replace(/^---[\s\S]*?---\s*/, '').trim();
}

function expandHome(p: string): string {
  return p.replace(/^~(?=[/\\]|$)/, homedir());
}

const vaultPath = process.env.KEPT_VAULT_PATH
  ? expandHome(process.env.KEPT_VAULT_PATH)
  : join(homedir(), '.kept', 'vault');

const vault = createVault(vaultPath);
const instructions = await loadInstructions();

function mcpResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function mcpError(err: unknown) {
  if (err instanceof VaultError) {
    return {
      content: [{ type: 'text' as const, text: `[${err.code}] ${err.message}` }],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

const server = new McpServer({ name: 'kept-vault', version }, { instructions });

server.tool(
  'list_vault',
  'List all files and directories in the vault root',
  { depth: z.number().min(1).max(10).optional().describe('Recursion depth (default: 1)') },
  async (args) => {
    try {
      const entries = await listVault(vault, args);
      return mcpResult(JSON.stringify(entries, null, 2));
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'list_directory',
  'List contents of a specific vault subdirectory',
  {
    path: z.string().describe('Relative path to directory within vault'),
    depth: z.number().min(1).max(10).optional().describe('Recursion depth (default: 1)'),
  },
  async (args) => {
    try {
      const entries = await listDirectory(vault, args);
      return mcpResult(JSON.stringify(entries, null, 2));
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'read_file',
  'Read the full content of a markdown file in the vault',
  { path: z.string().describe('Relative path to file within vault') },
  async (args) => {
    try {
      const content = await readFile(vault, args);
      return mcpResult(content);
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'write_file',
  'Create a new file in the vault. Fails if file already exists.',
  {
    path: z.string().describe('Relative path for the new file'),
    content: z.string().describe('File content to write'),
  },
  async (args) => {
    try {
      const resolved = await writeFile(vault, args);
      return mcpResult(`Created: ${resolved}`);
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'update_file',
  'Overwrite an existing file in the vault. Fails if file does not exist.',
  {
    path: z.string().describe('Relative path to existing file'),
    content: z.string().describe('New file content'),
  },
  async (args) => {
    try {
      const resolved = await updateFile(vault, args);
      return mcpResult(`Updated: ${resolved}`);
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'delete_file',
  'Delete a file from the vault. Cannot delete directories.',
  { path: z.string().describe('Relative path to file to delete') },
  async (args) => {
    try {
      const deleted = await deleteFile(vault, args);
      return mcpResult(`Deleted: ${deleted}`);
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'move_file',
  'Move or rename a file within the vault',
  {
    source: z.string().describe('Current relative path of the file'),
    destination: z.string().describe('New relative path for the file'),
  },
  async (args) => {
    try {
      const dest = await moveFile(vault, args);
      return mcpResult(`Moved to: ${dest}`);
    } catch (err) {
      return mcpError(err);
    }
  },
);

server.tool(
  'grep_vault',
  'Regex search across all markdown files in the vault',
  {
    pattern: z.string().describe('Regex pattern to search for'),
    glob: z.string().optional().describe('Glob filter for files (default: **/*.md)'),
    case_sensitive: z.boolean().optional().describe('Case-sensitive search (default: false)'),
    context_lines: z
      .number()
      .min(0)
      .max(10)
      .optional()
      .describe('Lines of context around match (default: 2)'),
    max_results: z
      .number()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum results to return (default: 50)'),
  },
  async (args) => {
    try {
      const matches = await grepVault(vault, args);
      return mcpResult(JSON.stringify(matches, null, 2));
    } catch (err) {
      return mcpError(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('kept-vault MCP server running on stdio');

async function shutdown() {
  console.error('kept-vault shutting down');
  await server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
