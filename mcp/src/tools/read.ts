import { readFile as fsReadFile } from 'node:fs/promises';
import type { Vault } from '../vault.js';

export async function readFile(vault: Vault, args: { path: string }): Promise<string> {
  const resolved = await vault.resolveAndValidateFile(args.path);
  return fsReadFile(resolved, 'utf-8');
}
