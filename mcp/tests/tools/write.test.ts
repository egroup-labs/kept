import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateFile, writeFile } from '../../src/tools/write.js';
import { type TestVault, setupTestVault, teardownTestVault } from '../helpers.js';

describe('write tools', () => {
  let tv: TestVault;

  beforeEach(async () => {
    tv = await setupTestVault();
  });

  afterEach(async () => {
    await teardownTestVault(tv);
  });

  describe('writeFile', () => {
    it('creates new file', async () => {
      await writeFile(tv.vault, { path: 'new.md', content: '# New File' });
      const content = await fsReadFile(join(tv.dir, 'new.md'), 'utf-8');
      expect(content).toBe('# New File');
    });

    it('creates parent directories', async () => {
      await writeFile(tv.vault, { path: 'deep/nested/file.md', content: '# Deep' });
      const content = await fsReadFile(join(tv.dir, 'deep', 'nested', 'file.md'), 'utf-8');
      expect(content).toBe('# Deep');
    });

    it('rejects if file already exists', async () => {
      await expect(writeFile(tv.vault, { path: 'notes.md', content: 'overwrite' })).rejects.toThrow(
        'FILE_EXISTS',
      );
    });

    it('rejects path traversal', async () => {
      await expect(writeFile(tv.vault, { path: '../escape.md', content: 'bad' })).rejects.toThrow(
        'PATH_ESCAPE',
      );
    });
  });

  describe('updateFile', () => {
    it('overwrites existing file', async () => {
      await updateFile(tv.vault, { path: 'notes.md', content: '# Updated' });
      const content = await fsReadFile(join(tv.dir, 'notes.md'), 'utf-8');
      expect(content).toBe('# Updated');
    });

    it('rejects non-existent file', async () => {
      await expect(updateFile(tv.vault, { path: 'nope.md', content: 'fail' })).rejects.toThrow(
        'FILE_NOT_FOUND',
      );
    });
  });
});
