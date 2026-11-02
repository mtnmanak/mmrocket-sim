import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { downloadRawFiles } from './fetch-motor-curves.mjs';

/**
 * digest-census.mjs's raw-file cache against a stand-in for thrustcurve.org —
 * never the network, and only in its own temp folder. Until 2026-10-28 the
 * script did all its work at import and cached whatever came back, so an empty
 * 200 batch left a short cache that read as withdrawn files on every later run.
 */

// Every case injects its download; a reach for the real network fails loudly.
vi.stubGlobal('fetch', async () => { throw new Error('global fetch called'); });

const DEFAULT_OUT = join(tmpdir(), 'mmrsim-digest-census');
const hadDefaultOut = existsSync(DEFAULT_OUT);
const { cachedRawFiles } = await import('./digest-census.mjs');

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const bundle = { generated: '2026-09-21', curves: { a: [{ samples: [[0, 0]] }], b: [{ samples: [[0, 0]] }] } };
const raw = (motorId) => ({ motorId, simfileId: `f-${motorId}`, format: 'RASP', data: 'cmF3' });
/** A download through the real downloadRawFiles, answering `pick(motorIds)`. */
function stand(pick) {
  const calls = [];
  const download = (ids, options) => {
    calls.push({ ids, options });
    return downloadRawFiles(ids, { ...options, sleep: async () => {},
      fetchImpl: async (_url, opts) => ({ ok: true, status: 200, json: async () => ({ results: pick(JSON.parse(opts.body).motorIds) }) }) });
  };
  return { download, calls };
}
const cacheFiles = (dir) => readdirSync(dir).filter((name) => /^raw-.*\.json$/.test(name));
const cachePath = (dir, value) => join(dir, `raw-${value.generated}-${createHash('sha256').update(JSON.stringify(value)).digest('hex')}.json`);

it('downloads fresh raw files when bundle contents change on the same generation date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-census-')); dirs.push(dir);
  const first = stand(ids => ids.map(raw));
  const oldPath = await cachedRawFiles(bundle, dir, { download: first.download, log: () => {} });
  const changed = { ...bundle, curves: { ...bundle.curves, a: [{ samples: [[0, 1]] }] } };
  const fresh = stand(ids => ids.map(id => ({ ...raw(id), data: 'bmV3' })));
  const newPath = await cachedRawFiles(changed, dir, { download: fresh.download, log: () => {} });
  expect(fresh.calls).toHaveLength(1);
  expect(newPath).not.toBe(oldPath);
  expect(JSON.parse(readFileSync(newPath, 'utf8'))['f-a'].data).toBe('bmV3');
  expect(JSON.parse(readFileSync(oldPath, 'utf8'))['f-a'].data).toBe('cmF3');
});

it('imports without creating its output folder or downloading', () => {
  if (!hadDefaultOut) expect(existsSync(DEFAULT_OUT)).toBe(false);
  expect(typeof cachedRawFiles).toBe('function');
});

it('writes no cache after an empty batch, so a later call downloads again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-census-')); dirs.push(dir);
  const empty = stand(() => []);
  await expect(cachedRawFiles(bundle, dir, { download: empty.download, log: () => {} })).rejects.toThrow(/no usable raw file/);
  expect(empty.calls[0].options.previous).toBe(bundle);
  expect(cacheFiles(dir)).toEqual([]);
  const good = stand((ids) => ids.map(raw));
  await cachedRawFiles(bundle, dir, { download: good.download, log: () => {} });
  expect(good.calls).toHaveLength(1);
  expect(cacheFiles(dir)).toEqual([cachePath(dir, bundle).split(/[\\/]/).at(-1)]);
});

it('writes a good batch once, and a later call reads the cache without downloading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-census-')); dirs.push(dir);
  const good = stand((ids) => ids.map(raw));
  const rawPath = await cachedRawFiles(bundle, dir, { download: good.download, log: () => {} });
  expect(rawPath).toBe(cachePath(dir, bundle));
  expect(Object.keys(JSON.parse(readFileSync(rawPath, 'utf8')))).toEqual(['f-a', 'f-b']);
  expect(good.calls).toHaveLength(1);
  expect(good.calls[0].ids).toEqual(['a', 'b']);
  const again = stand(() => { throw new Error('downloaded again'); });
  expect(await cachedRawFiles(bundle, dir, { download: again.download, log: () => {} })).toBe(rawPath);
  expect(again.calls).toHaveLength(0);
});

it.each([
  ['short (a motor with curves has no raw file)', JSON.stringify({ 'f-a': { motorId: 'a', format: 'RASP', data: 'cmF3' } })],
  ['corrupt (not JSON)', '{"f-a": '],
  ['not a file map', '[]'],
  ['a map of something else', JSON.stringify({ 'f-a': 'cmF3', 'f-b': null })],
])('downloads again once, and replaces the cache, when an existing one is %s', async (_what, held) => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-census-')); dirs.push(dir);
  const rawPath = cachePath(dir, bundle);
  writeFileSync(rawPath, held);
  const lines = [];
  const good = stand((ids) => ids.map(raw));
  expect(await cachedRawFiles(bundle, dir, { download: good.download, log: (s) => lines.push(s) })).toBe(rawPath);
  expect(good.calls).toHaveLength(1);
  expect(Object.keys(JSON.parse(readFileSync(rawPath, 'utf8')))).toEqual(['f-a', 'f-b']);
  expect(lines.join('')).toMatch(/^ {2}cached raw files at .* are (?:unreadable|incomplete).*; downloading again\n/);
  // A failed download leaves the bad cache as it was, and the next run tries again.
  writeFileSync(rawPath, held);
  const empty = stand(() => []);
  await expect(cachedRawFiles(bundle, dir, { download: empty.download, log: () => {} })).rejects.toThrow(/no usable raw file/);
  expect(readFileSync(rawPath, 'utf8')).toBe(held);
});

it('reads a complete cache without downloading, even when a curveless motor has no raw file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-census-')); dirs.push(dir);
  const withCurveless = { ...bundle, curves: { ...bundle.curves, c: [] } };
  const rawPath = cachePath(dir, withCurveless);
  const held = JSON.stringify(Object.fromEntries(['a', 'b'].map((id) => [`f-${id}`, raw(id)])));
  writeFileSync(rawPath, held);
  const again = stand(() => { throw new Error('downloaded again'); });
  expect(await cachedRawFiles(withCurveless, dir, { download: again.download, log: () => {} })).toBe(rawPath);
  expect(again.calls).toHaveLength(0);
  expect(readFileSync(rawPath, 'utf8')).toBe(held);
});

it('downloads fresh raw files for changed content on the same date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-census-')); dirs.push(dir);
  const good = stand(ids => ids.map(raw));
  const first = await cachedRawFiles(bundle, dir, { download: good.download, log: () => {} });
  const changed = structuredClone(bundle);
  changed.curves.a[0].samples.push([1, 9]);
  const second = await cachedRawFiles(changed, dir, { download: good.download, log: () => {} });
  expect(second).not.toBe(first);
  expect(good.calls).toHaveLength(2);
});
