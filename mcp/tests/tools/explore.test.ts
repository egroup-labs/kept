import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirectory, listVault } from '../../src/tools/explore.js';
import { type TestVault, setupTestVault, teardownTestVault } from '../helpers.js';

describe('explore tools', () => {
  let tv: TestVault;

  beforeEach(async () => {
    tv = await setupTestVault();
  });

  afterEach(async () => {
    await teardownTestVault(tv);
  });

  describe('listVault', () => {
    it('lists root entries at depth 1', async () => {
      const result = await listVault(tv.vault, { depth: 1 });
      const names = result.map((e) => e.name);
      expect(names).toContain('claude');
      expect(names).toContain('chatgpt');
      expect(names).toContain('notes.md');
    });

    it('lists nested files at depth 2', async () => {
      const result = await listVault(tv.vault, { depth: 2 });
      const paths = result.map((e) => e.path);
      expect(paths).toContain('claude/test-chat.md');
    });
  });

  describe('listDirectory', () => {
    it('lists specific subdirectory', async () => {
      const result = await listDirectory(tv.vault, { path: 'claude' });
      const names = result.map((e) => e.name);
      expect(names).toContain('test-chat.md');
      expect(names).toContain('chat2.md');
      expect(names).not.toContain('session.md');
    });

    it('rejects path traversal', async () => {
      await expect(listDirectory(tv.vault, { path: '../..' })).rejects.toThrow('PATH_ESCAPE');
    });
  });
});
