import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps tracked package tests free of personal machine paths', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z', '--', 'packages/'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(path => /\.(?:test(?:Support)?|spec)\.[cm]?[jt]sx?$/.test(path));
  expect(files.length).toBeGreaterThan(0);
  // Split the search strings so this guard does not match its own source.
  const forbidden = ['G:' + '/Documents/Dropbox', 'Users/' + 'peltz', 'Users/' + 'Eric'];
  const violations = files.filter(path => forbidden.some(value => readFileSync(join(root, path), 'utf8').includes(value)));
  // No exclusions: the lazy-chunks E: module-id fixture contains none of these strings.
  expect(violations).toEqual([]);
});
