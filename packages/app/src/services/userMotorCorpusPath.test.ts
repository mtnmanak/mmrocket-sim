import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userMotorCorpusPath } from './userMotorCorpusPath.testSupport.js';

it.each(['C:/git', 'E:/git'])('finds a checkout-relative user corpus on %s', drive => {
  const root = join(drive, 'online_open_rocket');
  const expected = join(root, 'docs', 'User files');
  expect(userMotorCorpusPath(root, path => path === expected, join)).toBe(expected);
});

it.each(['C:/git', 'E:/git'])('finds the main-checkout fallback from a worktree on %s', drive => {
  const root = join(drive, 'oor-wt', 'c1');
  const expected = join(drive, 'online_open_rocket', 'docs', 'User files');
  expect(userMotorCorpusPath(root, path => path === expected, join)).toBe(expected);
});

it('reports an absent corpus explicitly', () => {
  expect(userMotorCorpusPath('missing', () => false, join)).toBeNull();
});

// The real consumer now uses the resolver's directory check. Predicate
// injection above is only for the historical cross-drive path fixtures.
it('rejects an env candidate that is a file and finds checkout docs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'user-corpus-'));
  try {
    const envRoot = join(dir, 'env'), repoRoot = join(dir, 'repo');
    mkdirSync(envRoot);
    writeFileSync(join(envRoot, 'User files'), 'not a directory');
    const docs = join(repoRoot, 'docs', 'User files');
    mkdirSync(docs, { recursive: true });
    vi.stubEnv('MMRSIM_REFERENCE_ROOT', envRoot);
    vi.stubEnv('MACHINE_PROFILE', join(dir, 'absent.json'));
    expect(userMotorCorpusPath(repoRoot)).toBe(docs);
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
