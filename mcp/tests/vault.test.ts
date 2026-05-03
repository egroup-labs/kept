import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestVault, setupTestVault, teardownTestVault } from './helpers.js';

describe('vault', () => {
  let tv: TestVault;

  beforeEach(async () => {
    tv = await setupTestVault();
  });

  afterEach(async () => {
    await teardownTestVault(tv);
  });

  describe('resolvePath', () => {
    it('resolves relative path within vault', async () => {
      const resolved = await tv.vault.resolvePath('claude/test-chat.md');
      expect(resolved).toBe(join(tv.dir, 'claude', 'test-chat.md'));
    });

    it('rejects path traversal with ../', async () => {
      await expect(tv.vault.resolvePath('../etc/passwd')).rejects.toThrow('PATH_ESCAPE');
    });

    it('rejects absolute paths', async () => {
      await expect(tv.vault.resolvePath('/etc/passwd')).rejects.toThrow('PATH_ESCAPE');
    });

    it('resolves empty path to vault root', async () => {
      const resolved = await tv.vault.resolvePath('');
      expect(resolved).toBe(tv.dir);
    });
  });

  describe('resolveAndValidateFile', () => {
    it('resolves existing file', async () => {
      const resolved = await tv.vault.resolveAndValidateFile('notes.md');
      expect(resolved).toBe(join(tv.dir, 'notes.md'));
    });

    it('rejects non-existent file', async () => {
      await expect(tv.vault.resolveAndValidateFile('nope.md')).rejects.toThrow('FILE_NOT_FOUND');
    });
  });

  describe('vaultBase', () => {
    it('returns vault base directory', () => {
      expect(tv.vault.basePath).toBe(tv.dir);
    });
  });
});
