import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';

export class VaultError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'VaultError';
  }
}

export function createVault(vaultPath: string) {
  const basePath = resolve(vaultPath);

  // Lazily resolved real base path — handles Windows short-name vs long-name discrepancy
  let realBasePath: string | undefined;

  async function getRealBasePath(): Promise<string> {
    if (realBasePath === undefined) {
      try {
        realBasePath = await realpath(basePath);
      } catch {
        realBasePath = basePath;
      }
    }
    return realBasePath;
  }

  async function resolvePath(relativePath: string): Promise<string> {
    if (!relativePath || relativePath === '' || relativePath === '.') {
      return basePath;
    }

    if (isAbsolute(relativePath)) {
      throw new VaultError('PATH_ESCAPE', `Absolute paths not allowed: ${relativePath}`);
    }

    const normalized = normalize(relativePath);
    if (normalized.startsWith('..')) {
      throw new VaultError('PATH_ESCAPE', `Path escapes vault: ${relativePath}`);
    }

    const full = join(basePath, normalized);

    // If target exists, canonicalize via realpath to catch symlink escapes.
    // We compare using real paths but return the basePath-relative join to keep
    // consistent path style with what the caller provided as vaultPath.
    try {
      const real = await realpath(full);
      const realBase = await getRealBasePath();
      if (!real.startsWith(realBase)) {
        throw new VaultError('PATH_ESCAPE', `Resolved path escapes vault: ${relativePath}`);
      }
      return full;
    } catch (err: unknown) {
      if (err instanceof VaultError) throw err;
      // File doesn't exist yet — the normalized join check above is sufficient
      return full;
    }
  }

  async function resolveAndValidateFile(relativePath: string): Promise<string> {
    const resolved = await resolvePath(relativePath);
    try {
      const s = await stat(resolved);
      if (!s.isFile()) {
        throw new VaultError('FILE_NOT_FOUND', `Not a file: ${relativePath}`);
      }
    } catch (err: unknown) {
      if (err instanceof VaultError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new VaultError('PERMISSION_DENIED', `Permission denied: ${relativePath}`);
      }
      throw new VaultError('FILE_NOT_FOUND', `File not found: ${relativePath}`);
    }
    return resolved;
  }

  async function ensureParentDir(filePath: string): Promise<void> {
    const dir = resolve(filePath, '..');
    await mkdir(dir, { recursive: true });
  }

  return {
    basePath,
    resolvePath,
    resolveAndValidateFile,
    ensureParentDir,
  };
}

export type Vault = ReturnType<typeof createVault>;
