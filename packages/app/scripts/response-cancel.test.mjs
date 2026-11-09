import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCatalogue } from './fetch-motor-db.mjs';
import { fetchWithRetry } from './fetch-component-presets.mjs';
import { addDigestsMain, downloadRawFiles, fetchCurves } from './fetch-motor-curves.mjs';
import { checkHead } from '../../../scripts/check-upstream.mjs';

afterEach(() => vi.restoreAllMocks());
const quiet = () => {};
const motor = { motorId: 'test', designation: 'Test', manufacturerAbbrev: 'Test' };
function refused(status = 503) {
  // A failed cleanup must neither hide the refusal nor become unhandled.
  return { ok: false, status, headers: new Headers(),
    body: { cancel: vi.fn(async () => { throw new Error('cleanup failed'); }) },
    json: vi.fn(), text: vi.fn() };
}

it('cancels a refused catalogue response without reading it', async () => {
  const res = refused();
  await expect(fetchCatalogue({ fetchImpl: async () => res, log: quiet })).rejects.toThrow('HTTP 503');
  expect(res.body.cancel).toHaveBeenCalledTimes(1);
  expect(res.json).not.toHaveBeenCalled();
});

it.each([403, 429, 503])('cancels each preset HTTP %s refusal before waiting', async status => {
  vi.spyOn(console, 'warn').mockImplementation(quiet);
  const responses = [];
  await expect(fetchWithRetry('https://example.invalid', {
    fetchImpl: async () => { const res = refused(status); responses.push(res); return res; },
    sleep: async () => { expect(responses.at(-1).body.cancel).toHaveBeenCalledTimes(1); },
  }, 2)).rejects.toThrow();
  expect(responses).toHaveLength(2);
  for (const res of responses) {
    expect(res.body.cancel).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  }
});

it('cancels refused raw curve downloads', async () => {
  const res = refused();
  await expect(downloadRawFiles(['test'], { fetchImpl: async () => res, sleep: quiet, log: quiet }))
    .rejects.toThrow('HTTP 503');
  expect(res.body.cancel).toHaveBeenCalledTimes(1);
  expect(res.json).not.toHaveBeenCalled();
});

it.each([false, true])('cancels refused curve downloads (individual retry: %s)', async individual => {
  const res = refused();
  const fetchImpl = vi.fn(async () => res);
  if (individual) fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ motorId: 'foreign' }] }) });
  const got = await fetchCurves([motor], { fetchImpl, sleep: quiet, log: quiet });
  expect(got.failed[0]).toContain('HTTP 503');
  expect(res.body.cancel).toHaveBeenCalledTimes(1);
  expect(res.json).not.toHaveBeenCalled();
});

it('cancels a refused digest refresh response exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'response-cancel-'));
  vi.spyOn(console, 'error').mockImplementation(quiet);
  try {
    const outPath = join(dir, 'curves.json');
    writeFileSync(outPath, JSON.stringify({ curves: { test: [] } }));
    const res = refused();
    expect(await addDigestsMain({ outPath, fetchImpl: async () => res, sleep: quiet, log: quiet })).toBe(1);
    expect(res.body.cancel).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('cancels a refused upstream probe response', async () => {
  const res = refused();
  vi.stubGlobal('fetch', async () => res);
  try {
    await expect(checkHead()).rejects.toThrow('HTTP 503');
    expect(res.body.cancel).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
