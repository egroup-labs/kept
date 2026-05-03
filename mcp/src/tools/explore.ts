import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Vault } from '../vault.js';

export interface VaultEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

async function listDir(
  dirPath: string,
  basePath: string,
  currentDepth: number,
  maxDepth: number,
): Promise<VaultEntry[]> {
  const items = await readdir(dirPath, { withFileTypes: true });

  const statResults = await Promise.all(items.map((item) => stat(join(dirPath, item.name))));

  const entries: VaultEntry[] = [];
  const childPromises: Promise<VaultEntry[]>[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const s = statResults[i]!;
    const fullPath = join(dirPath, item.name);
    const relPath = relative(basePath, fullPath);

    entries.push({
      name: item.name,
      path: relPath.replaceAll('\\', '/'),
      type: item.isDirectory() ? 'directory' : 'file',
      size: s.size,
      modified: s.mtime.toISOString(),
    });

    if (item.isDirectory() && currentDepth < maxDepth) {
      childPromises.push(listDir(fullPath, basePath, currentDepth + 1, maxDepth));
    }
  }

  const children = await Promise.all(childPromises);
  for (const batch of children) {
    entries.push(...batch);
  }

  return entries;
}

export async function listVault(vault: Vault, args: { depth?: number }): Promise<VaultEntry[]> {
  const depth = args.depth ?? 1;
  return listDir(vault.basePath, vault.basePath, 1, depth);
}

export async function listDirectory(
  vault: Vault,
  args: { path: string; depth?: number },
): Promise<VaultEntry[]> {
  const resolved = await vault.resolvePath(args.path);
  const depth = args.depth ?? 1;
  return listDir(resolved, vault.basePath, 1, depth);
}
