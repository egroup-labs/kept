import { rename, stat, unlink } from 'node:fs/promises';
import type { Vault } from '../vault.js';
import { VaultError } from '../vault.js';

export async function deleteFile(vault: Vault, args: { path: string }): Promise<string> {
  const resolved = await vault.resolveAndValidateFile(args.path);
  await unlink(resolved);
  return args.path;
}

export async function moveFile(
  vault: Vault,
  args: { source: string; destination: string },
): Promise<string> {
  const srcResolved = await vault.resolveAndValidateFile(args.source);
  const destResolved = await vault.resolvePath(args.destination);

  // Prevent silent overwrite
  try {
    await stat(destResolved);
    throw new VaultError('FILE_EXISTS', `Destination already exists: ${args.destination}`);
  } catch (err: unknown) {
    if (err instanceof VaultError) throw err;
    // ENOENT expected — destination is free
  }

  await vault.ensureParentDir(destResolved);
  await rename(srcResolved, destResolved);
  return args.destination;
}
