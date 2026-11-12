import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rocksimCorpusPath } from './rocksimCorpusPath.testSupport.mjs';

let dir: string;
let profile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rocksim-corpus-'));
  profile = join(dir, 'machine.json');
  vi.stubEnv('MACHINE_PROFILE', profile);
  vi.stubEnv('ROCKSIM_CORPUS', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const writeProfile = (data = {}) => writeFileSync(profile, JSON.stringify({ hostname: hostname(), dropbox: dir, ...data }));

it('uses the env corpus root before a valid profile, without appending a folder', () => {
  writeProfile();
  mkdirSync(join(dir, 'Rocksim Designs'));
  const override = join(dir, 'override');
  mkdirSync(override);
  vi.stubEnv('ROCKSIM_CORPUS', override);
  expect(rocksimCorpusPath()).toBe(override);
  writeFileSync(profile, '{malformed');
  expect(rocksimCorpusPath()).toBe(override);
});
it('returns null with no profile', () => {
  expect(rocksimCorpusPath()).toBeNull();
});
it('returns null when the corpus folder is missing', () => {
  writeProfile();
  expect(rocksimCorpusPath()).toBeNull();
});
it('returns null without throwing for a hostname mismatch', () => {
  writeProfile({ hostname: hostname() + '-foreign' });
  mkdirSync(join(dir, 'Rocksim Designs'));
  expect(rocksimCorpusPath()).toBeNull();
});
it('returns the existing corpus directory', () => {
  writeProfile();
  const corpus = join(dir, 'Rocksim Designs');
  mkdirSync(corpus);
  expect(rocksimCorpusPath()).toBe(corpus);
});
it('returns null for stale Dropbox paths and malformed profiles', () => {
  writeProfile({ dropbox: join(dir, 'absent') });
  expect(rocksimCorpusPath()).toBeNull();
  writeFileSync(profile, '{malformed');
  expect(rocksimCorpusPath()).toBeNull();
});
it('does not fall back when an explicit override is missing or a regular file', () => {
  writeProfile();
  mkdirSync(join(dir, 'Rocksim Designs'));
  const override = join(dir, 'override');
  vi.stubEnv('ROCKSIM_CORPUS', override);
  expect(rocksimCorpusPath()).toBeNull();
  writeFileSync(override, 'not a directory');
  expect(rocksimCorpusPath()).toBeNull();
});
