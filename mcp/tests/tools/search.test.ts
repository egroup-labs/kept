import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grepVault } from '../../src/tools/search.js';
import { type TestVault, setupTestVault, teardownTestVault } from '../helpers.js';

describe('grep_vault', () => {
  let tv: TestVault;

  beforeEach(async () => {
    tv = await setupTestVault();
  });

  afterEach(async () => {
    await teardownTestVault(tv);
  });

  it('finds matches across files', async () => {
    const results = await grepVault(tv.vault, { pattern: 'Rust' });
    expect(results.length).toBe(3);
  });

  it('returns file path and line number', async () => {
    const results = await grepVault(tv.vault, { pattern: 'Rust' });
    const first = results[0];
    expect(first).toHaveProperty('path');
    expect(first).toHaveProperty('line');
    expect(first).toHaveProperty('match');
  });

  it('respects max_results', async () => {
    const results = await grepVault(tv.vault, { pattern: 'Rust', max_results: 1 });
    expect(results.length).toBe(1);
  });

  it('is case-insensitive by default', async () => {
    const results = await grepVault(tv.vault, { pattern: 'rust' });
    expect(results.length).toBe(3);
  });

  it('supports case-sensitive search', async () => {
    const results = await grepVault(tv.vault, { pattern: 'rust', case_sensitive: true });
    expect(results.length).toBe(0);
  });

  it('includes context lines', async () => {
    const results = await grepVault(tv.vault, { pattern: 'Rust is', context_lines: 1 });
    expect(results[0]!.context.length).toBeGreaterThan(1);
  });

  it('filters by glob', async () => {
    const results = await grepVault(tv.vault, { pattern: 'Rust', glob: 'claude/**' });
    expect(results.every((r) => r.path.startsWith('claude/'))).toBe(true);
  });

  it('rejects invalid regex', async () => {
    await expect(grepVault(tv.vault, { pattern: '[invalid' })).rejects.toThrow('INVALID_PATTERN');
  });

  it('rejects dangerous regex patterns', async () => {
    await expect(grepVault(tv.vault, { pattern: '(a+)+$' })).rejects.toThrow('INVALID_PATTERN');
  });

  it('rejects glob with path traversal', async () => {
    await expect(grepVault(tv.vault, { pattern: 'test', glob: '../../etc/**' })).rejects.toThrow(
      'INVALID_PATTERN',
    );
  });

  it('rejects absolute glob', async () => {
    await expect(grepVault(tv.vault, { pattern: 'test', glob: '/etc/**' })).rejects.toThrow(
      'INVALID_PATTERN',
    );
  });
});
