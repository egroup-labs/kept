import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from '../../src/tools/read.js';
import { type TestVault, setupTestVault, teardownTestVault } from '../helpers.js';

describe('read tool', () => {
  let tv: TestVault;

  beforeEach(async () => {
    tv = await setupTestVault();
  });

  afterEach(async () => {
    await teardownTestVault(tv);
  });

  it('reads existing file', async () => {
    const content = await readFile(tv.vault, { path: 'claude/test-chat.md' });
    expect(content).toBe('# Test Chat\nHello world');
  });

  it('rejects non-existent file', async () => {
    await expect(readFile(tv.vault, { path: 'nope.md' })).rejects.toThrow('FILE_NOT_FOUND');
  });

  it('rejects path traversal', async () => {
    await expect(readFile(tv.vault, { path: '../../etc/passwd' })).rejects.toThrow('PATH_ESCAPE');
  });
});
