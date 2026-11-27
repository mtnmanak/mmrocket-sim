import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { publishedCatalogueCheck } from '../../../scripts/catalogue-freshness.mjs';
import { checkThrustCurve, main } from '../../../scripts/check-upstream.mjs';
import { planPublication } from './catalogue-publish.mjs';
import { MOTORS_MAX_BYTES, CURVES_MAX_BYTES } from '../src/services/catalogueClient.ts';
import { DEFAULT_MAX_JSON_BYTES } from '../src/services/net.ts';

const snapshot = JSON.parse(readFileSync(new URL('../src/data/motors.json', import.meta.url)));
const curves = JSON.parse(readFileSync(new URL('../src/data/motorCurves.json', import.meta.url)));
const day = days => new Date(Date.parse(snapshot.generated) + days * 86_400_000).toISOString().slice(0, 10);
const bytes = value => Buffer.from(JSON.stringify(value));
afterEach(() => vi.restoreAllMocks());

function fixture(change = () => {}) {
  const motorsDoc = structuredClone(snapshot), curvesDoc = structuredClone(curves);
  change(motorsDoc, curvesDoc);
  const plan = planPublication({ motorsBytes: bytes(motorsDoc), curvesBytes: bytes(curvesDoc),
    commit: 'a'.repeat(40), sourceRunId: '123', fetchedAt: `${day(14)}T00:00:00Z` });
  const manifest = { schema: 1, current: plan.snapshotId, snapshots: [plan.entry],
    checkedAt: `${day(14)}T00:00:00Z`, checkedRunId: '123' };
  const getBytes = vi.fn(async url => url.endsWith('/manifest.json') ? bytes(manifest)
    : plan.uploads.find(u => url.endsWith(u.key)).bytes);
  return { manifest, plan, getBytes, now: Date.parse(day(15)) };
}
it('CAT-CHECKED accepts a recent checked date only for matching rows and curves', async () => {
  const { getBytes, now } = fixture();
  expect(await publishedCatalogueCheck(snapshot, curves, getBytes, now)).toBe(day(14));
  expect(getBytes).toHaveBeenCalledTimes(3);
});
it('accepts the manifest byte ceiling and refuses one byte over before reading snapshots', async () => {
  const { manifest, plan, now } = fixture();
  const document = bytes(manifest);
  let manifestBytes = Buffer.concat([document, Buffer.alloc(DEFAULT_MAX_JSON_BYTES - document.length, 32)]);
  const getBytes = vi.fn(async url => url.endsWith('/manifest.json') ? manifestBytes
    : plan.uploads.find(u => url.endsWith(u.key)).bytes);
  expect(await publishedCatalogueCheck(snapshot, curves, getBytes, now)).toBe(day(14));
  manifestBytes = Buffer.concat([manifestBytes, Buffer.from(' ')]);
  getBytes.mockClear();
  expect(await publishedCatalogueCheck(snapshot, curves, getBytes, now)).toBeNull();
  expect(getBytes).toHaveBeenCalledTimes(1);
});
it.each([['motors', MOTORS_MAX_BYTES], ['curves', CURVES_MAX_BYTES]])(
  'accepts the %s byte ceiling but never clears the alarm for a larger published snapshot', async (kind, limit) => {
    const { manifest, plan, getBytes, now } = fixture();
    const upload = plan.uploads[kind === 'motors' ? 0 : 1];
    upload.bytes = Buffer.concat([upload.bytes, Buffer.alloc(limit - upload.bytes.length, 32)]);
    const meta = manifest.snapshots[0][kind];
    meta.bytes = upload.bytes.length;
    meta.sha256 = createHash('sha256').update(upload.bytes).digest('hex');
    expect(await publishedCatalogueCheck(snapshot, curves, getBytes, now)).toBe(day(14));
    upload.bytes = Buffer.concat([upload.bytes, Buffer.from(' ')]);
    meta.bytes = upload.bytes.length;
    meta.sha256 = createHash('sha256').update(upload.bytes).digest('hex');
    getBytes.mockClear();
    expect(await publishedCatalogueCheck(snapshot, curves, getBytes, now)).toBeNull();
    expect(getBytes).toHaveBeenCalledTimes(1);
  },
);
it.each(['missing', 'old', 'future', 'predates', 'bad', 'offset', 'zone-less', 'run', 'numeric run', 'hash', 'rows', 'curves'])('CAT-CHECKED keeps the alarm for %s evidence', async kind => {
  const { manifest, getBytes, now } = fixture((motors, curveDoc) => {
    if (kind === 'rows') motors.motors[0].designation += ' changed';
    if (kind === 'curves') curveDoc.source += ' changed';
  });
  if (kind === 'missing') delete manifest.checkedAt;
  if (kind === 'old') manifest.checkedAt = `${day(1)}T00:00:00Z`;
  if (kind === 'future') manifest.checkedAt = `${day(16)}T00:00:00Z`;
  if (kind === 'predates') manifest.checkedAt = `${day(-1)}T00:00:00Z`;
  if (kind === 'bad') manifest.checkedAt = 'unreadable';
  if (kind === 'offset') manifest.checkedAt = `${day(14)}T22:00:00-05:00`;
  if (kind === 'zone-less') manifest.checkedAt = `${day(14)}T00:00:00`;
  if (kind === 'run') manifest.checkedRunId = 'bad';
  if (kind === 'numeric run') manifest.checkedRunId = 123;
  if (kind === 'hash') manifest.snapshots[0].motors.sha256 = createHash('sha256').update('bad').digest('hex');
  expect(await publishedCatalogueCheck(snapshot, curves, getBytes, now)).toBeNull();
});
it('CAT-CHECKED section 4 prints checked/unchanged instead of the age alarm, retaining the alarm offline', async () => {
  const { getBytes, now } = fixture();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const probe = async url => url.includes('maxResults') ? { matches: snapshot.motors.length } : { manufacturers: [] };
  await main([() => checkThrustCurve(probe, getBytes)], () => {});
  expect(log.mock.calls.flat().join('\n')).toContain(`checked ${day(14)}, unchanged`);
  expect(log.mock.calls.flat().join('\n')).not.toContain('over the 8-day limit');
  log.mockClear();
  await main([() => checkThrustCurve(probe, async () => { throw new Error('offline'); })], () => {});
  expect(log.mock.calls.flat().join('\n')).toContain('over the 8-day limit');
});
