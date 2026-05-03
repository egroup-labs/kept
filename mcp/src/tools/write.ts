import { writeFile as fsWriteFile } from 'node:fs/promises';
import type { Vault } from '../vault.js';
import { VaultError } from '../vault.js';

export async function writeFile(
  vault: Vault,
  args: { path: string; content: string },
): Promise<string> {
  const resolved = await vault.resolvePath(args.path);

  await vault.ensureParentDir(resolved);
  try {
    await fsWriteFile(resolved, args.content, { encoding: 'utf-8', flag: 'wx' });
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      throw new VaultError(
        'FILE_EXISTS',
        `File already exists: ${args.path}. Use update_file instead.`,
      );
    }
    throw err;
  }
  return resolved;
}

export async function updateFile(
  vault: Vault,
  args: { path: string; content: string },
): Promise<string> {
  const resolved = await vault.resolveAndValidateFile(args.path);
  await fsWriteFile(resolved, args.content, 'utf-8');
  return resolved;
}
