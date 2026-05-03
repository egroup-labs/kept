import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteFile, moveFile } from '../../src/tools/manage.js';
import { type TestVault, setupTestVault, teardownTestVault } from '../helpers.js';

describe('manage tools', () => {
  let tv: TestVault;

  beforeEach(async () => {
    tv = await setupTestVault();
    // Add files specific to manage tests
    await writeFile(join(tv.dir, 'old.md'), '# Old');
  });

  afterEach(async () => {
    await teardownTestVault(tv);
  });

  describe('deleteFile', () => {
    it('deletes existing file', async () => {
      await deleteFile(tv.vault, { path: 'old.md' });
      await expect(stat(join(tv.dir, 'old.md'))).rejects.toThrow();
    });

    it('rejects non-existent file', async () => {
      await expect(deleteFile(tv.vault, { path: 'nope.md' })).rejects.toThrow('FILE_NOT_FOUND');
    });

    it('rejects path traversal', async () => {
      await expect(deleteFile(tv.vault, { path: '../escape.md' })).rejects.toThrow('PATH_ESCAPE');
    });
  });

  describe('moveFile', () => {
    it('moves file to new location', async () => {
      await moveFile(tv.vault, { source: 'old.md', destination: 'new.md' });
      const content = await readFile(join(tv.dir, 'new.md'), 'utf-8');
      expect(content).toBe('# Old');
      await expect(stat(join(tv.dir, 'old.md'))).rejects.toThrow();
    });

    it('moves file into subdirectory', async () => {
      await moveFile(tv.vault, { source: 'old.md', destination: 'claude/moved.md' });
      const content = await readFile(join(tv.dir, 'claude', 'moved.md'), 'utf-8');
      expect(content).toBe('# Old');
    });

    it('creates destination parent directories', async () => {
      await moveFile(tv.vault, { source: 'old.md', destination: 'new-dir/moved.md' });
      const content = await readFile(join(tv.dir, 'new-dir', 'moved.md'), 'utf-8');
      expect(content).toBe('# Old');
    });

    it('rejects if source does not exist', async () => {
      await expect(
        moveFile(tv.vault, { source: 'nope.md', destination: 'dest.md' }),
      ).rejects.toThrow('FILE_NOT_FOUND');
    });

    it('rejects path traversal on destination', async () => {
      await expect(
        moveFile(tv.vault, { source: 'old.md', destination: '../../escape.md' }),
      ).rejects.toThrow('PATH_ESCAPE');
    });

    it('rejects overwriting existing destination', async () => {
      await expect(
        moveFile(tv.vault, { source: 'old.md', destination: 'notes.md' }),
      ).rejects.toThrow('FILE_EXISTS');
    });
  });
});
