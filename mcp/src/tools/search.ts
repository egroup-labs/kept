import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import fg from 'fast-glob';
import type { Vault } from '../vault.js';
import { VaultError } from '../vault.js';

export interface GrepMatch {
  path: string;
  line: number;
  match: string;
  context: string[];
}

// Reject patterns with known catastrophic backtracking constructs
const DANGEROUS_PATTERNS = [
  /\([^)]*[+*][^)]*\)[+*]/, // nested quantifiers like (a+)+
  /\([^)]*\|[^)]*\)[+*]\S*$/, // alternation with outer quantifier at end
];

function isSafeRegex(pattern: string): boolean {
  return !DANGEROUS_PATTERNS.some((d) => d.test(pattern));
}

function validateGlob(glob: string): void {
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(glob)) {
    throw new VaultError('INVALID_PATTERN', 'Glob must not contain path traversal (..)');
  }
  if (/^[A-Za-z]:/.test(glob) || glob.startsWith('/')) {
    throw new VaultError('INVALID_PATTERN', 'Glob must be a relative path');
  }
}

export async function grepVault(
  vault: Vault,
  args: {
    pattern: string;
    glob?: string;
    case_sensitive?: boolean;
    context_lines?: number;
    max_results?: number;
  },
): Promise<GrepMatch[]> {
  if (!isSafeRegex(args.pattern)) {
    throw new VaultError(
      'INVALID_PATTERN',
      'Pattern rejected: potential catastrophic backtracking',
    );
  }

  let regex: RegExp;
  try {
    const flags = args.case_sensitive ? '' : 'i';
    regex = new RegExp(args.pattern, flags);
  } catch {
    throw new VaultError('INVALID_PATTERN', `Invalid regex pattern: ${args.pattern}`);
  }

  const contextLines = args.context_lines ?? 2;
  const maxResults = args.max_results ?? 50;
  const globPattern = args.glob ?? '**/*.md';

  validateGlob(globPattern);

  const files = await fg(globPattern, {
    cwd: vault.basePath,
    absolute: true,
    onlyFiles: true,
  });

  const results: GrepMatch[] = [];

  for (const filePath of files) {
    if (results.length >= maxResults) break;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) break;

      const line = lines[i]!;
      if (regex.test(line)) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const context = lines.slice(start, end + 1);

        results.push({
          path: relative(vault.basePath, filePath).replaceAll('\\', '/'),
          line: i + 1,
          match: line,
          context,
        });
      }
    }
  }

  return results;
}
