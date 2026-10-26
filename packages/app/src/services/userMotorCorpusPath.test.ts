import { expect, it } from 'vitest';
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
