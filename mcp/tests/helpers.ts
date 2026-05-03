import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Vault, createVault } from '../src/vault.js';

export interface TestVault {
  dir: string;
  vault: Vault;
}

/**
 * Creates a temp vault with sample files:
 *   claude/test-chat.md, claude/chat2.md, chatgpt/session.md, notes.md
 */
export async function setupTestVault(): Promise<TestVault> {
  const dir = await mkdtemp(join(tmpdir(), 'kept-vault-test-'));
  const vault = createVault(dir);
  await mkdir(join(dir, 'claude'), { recursive: true });
  await mkdir(join(dir, 'chatgpt'), { recursive: true });
  await writeFile(join(dir, 'claude', 'test-chat.md'), '# Test Chat\nHello world');
  await writeFile(
    join(dir, 'claude', 'chat2.md'),
    '# Chat 2\nTalking about Rust\nAnd TypeScript too',
  );
  await writeFile(join(dir, 'chatgpt', 'session.md'), '# Session\nPython discussion\nNo Rust here');
  await writeFile(join(dir, 'notes.md'), '# Notes\nRust is great\nLine 3\nLine 4');
  return { dir, vault };
}

export async function teardownTestVault(tv: TestVault): Promise<void> {
  await rm(tv.dir, { recursive: true, force: true });
}
