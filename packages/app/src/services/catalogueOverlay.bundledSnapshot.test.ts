// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOTOR_DB, MOTOR_DB_DATE, getCatalogue, getCatalogueOverlay, setCatalogueOverlay, type MotorDbEntry } from './motorDb.js';
import { OVERLAY_KEY, checkForCatalogueUpdates, discardCatalogueOverlay, loadStoredOverlay } from './catalogueOverlay.js';
import { bundledSnapshot, setBundledSnapshotForTests } from './bundledSnapshot.js';
import { CATALOGUE_BASE } from './catalogueClient.js';
import { catalogueFetch, daysAfter, manifestOf, publication, type Publication } from './catalogueFixture.testSupport.js';
import committedRecord from '../data/catalogueSnapshot.json';

/**
 * Owner 113-9e: a release that knows which curated snapshot its bundled rows
 * are installs "no change" from the manifest alone, without the ~600 KB motors
 * file. The record is injected through setBundledSnapshotForTests; the
 * committed catalogueSnapshot.json is never edited here.
 */

const here = dirname(fileURLToPath(import.meta.url));

function checkCommittedRecord(record: { schema: number; generated: string | null; motorsSha256: string | null; curvesSha256: string | null }): void {
  if (record.motorsSha256 === null && record.curvesSha256 === null) {
    // Nothing to hold yet: the release pipeline does not write the record (owner question Q1).
    console.info('catalogueSnapshot.json is unknown (null values); the bundle-equals-snapshot shortcut is off and this check does nothing.');
    return;
  }
  expect(record.schema).toBe(1);
  expect(record.motorsSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(record.curvesSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(record.generated).toBe(MOTOR_DB_DATE);
  const curves = readFileSync(join(here, '../data/motorCurves.json'));
  expect(record.curvesSha256).toBe(createHash('sha256').update(curves).digest('hex'));
}

const row = (over: Partial<MotorDbEntry> = {}): MotorDbEntry => ({
  motorId: 'live-1', manufacturerAbbrev: 'Estes', designation: 'Z9', commonName: 'Z9', impulseClass: 'Z',
  diameter: 18, length: 70, type: 'SU', avgThrustN: 5, maxThrustN: 10, totImpulseNs: 8,
  burnTimeS: 1.6, totalWeightG: 20, propWeightG: 10, delays: '3,5', availability: 'regular',
  propInfo: 'black powder', caseInfo: '', ...over,
});

/** The bundle's rows published as a snapshot dated after the shipped catalogue, as a no-change refresh publishes them. */
let pub: Publication;
const counted = (p: Publication = pub) => vi.fn(catalogueFetch(manifestOf(p), [p])) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const recordOf = (p: Publication, over: Record<string, unknown> = {}) => ({
  schema: 1, generated: MOTOR_DB_DATE, motorsSha256: p.entry.motors.sha256, curvesSha256: p.entry.curves.sha256, ...over,
});
const UNKNOWN = { schema: 1, generated: null, motorsSha256: null, curvesSha256: null };
const NOW = Date.parse(`${daysAfter(MOTOR_DB_DATE, 3)}T12:00:00Z`);
const now = () => NOW;

beforeEach(async () => {
  localStorage.clear();
  setCatalogueOverlay(null);
  pub ??= await publication(`${daysAfter(MOTOR_DB_DATE, 2)}`, MOTOR_DB);
});
afterEach(() => setBundledSnapshotForTests(null));

describe('the bundled snapshot record', () => {
  it('(i) a matching record costs one request, stores the snapshot, and leaves the shipped catalogue as it is', async () => {
    setBundledSnapshotForTests(recordOf(pub));
    const fetchImpl = counted();
    const { overlay, skipped, stored, silent } = await checkForCatalogueUpdates({ force: true, fetchImpl, now });
    expect(fetchImpl.mock.calls.map(c => String(c[0]))).toEqual([`${CATALOGUE_BASE}manifest.json`]);
    expect([skipped, stored, silent]).toEqual([null, true, []]);
    expect([overlay.added, overlay.changed, overlay.removed, overlay.rejected]).toEqual([[], [], [], []]);
    expect(overlay.liveCount).toBe(MOTOR_DB.length);
    expect(loadStoredOverlay()?.snapshot?.id).toBe(pub.id);
    expect(loadStoredOverlay()?.snapshot?.motorsSha256).toBe(pub.entry.motors.sha256);
    expect(getCatalogue()).toBe(MOTOR_DB);
    // The throttle still holds after it.
    expect((await checkForCatalogueUpdates({ fetchImpl, now })).skipped).toBe('recent');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ['a motors sha off by one character', (p: Publication) => recordOf(p, { motorsSha256: `${p.entry.motors.sha256.slice(0, -1)}${p.entry.motors.sha256.endsWith('0') ? '1' : '0'}` })],
    ['a curves sha off by one character', (p: Publication) => recordOf(p, { curvesSha256: `${p.entry.curves.sha256.slice(0, -1)}${p.entry.curves.sha256.endsWith('0') ? '1' : '0'}` })],
    ['a record dated another catalogue', (p: Publication) => recordOf(p, { generated: daysAfter(MOTOR_DB_DATE, -1) })],
    ['an uppercase sha', (p: Publication) => recordOf(p, { motorsSha256: p.entry.motors.sha256.toUpperCase() })],
    ['an unknown record', () => UNKNOWN],
    ['another schema', (p: Publication) => recordOf(p, { schema: 2 })],
  ])('(ii) %s downloads the motors file', async (_name, record) => {
    setBundledSnapshotForTests(record(pub));
    const fetchImpl = counted();
    const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(`${CATALOGUE_BASE}${pub.entry.motors.path}`);
    expect(overlay.snapshot?.id).toBe(pub.id);
  });

  it('(ii) a manifest whose motor count is not the bundle\'s downloads, even with both shas matching', async () => {
    const short = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, MOTOR_DB.slice(1));
    setBundledSnapshotForTests(recordOf(short));
    // The shas match the manifest; only the count tells it is not the bundle.
    const fetchImpl = counted(short);
    const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(overlay.removed).toEqual([MOTOR_DB[0]!.motorId]);
  });

  it('(ii) a record naming only the curves file of the manifest downloads', async () => {
    const other = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.3`, [...MOTOR_DB.slice(1), row({ motorId: 'new-1' })]);
    // The live snapshot carries the bundle's count but not its rows; the record's motors sha is the bundle's own.
    setBundledSnapshotForTests(recordOf(pub, { curvesSha256: other.entry.curves.sha256 }));
    const fetchImpl = counted(other);
    const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(overlay.added.map(m => m.motorId)).toEqual(['new-1']);
  });

  /** A stored overlay carrying an added row from an answering maker, and added, changed and removed rows from a maker the bundle does not carry. */
  const learned = () => ({
    baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(0).toISOString(), liveCount: MOTOR_DB.length + 2,
    added: [row({ motorId: 'answering-added' }), row({ motorId: 'silent-added', manufacturerAbbrev: 'NoSuchMaker' })],
    changed: [{ motorId: 'silent-changed', before: row({ motorId: 'silent-changed', manufacturerAbbrev: 'NoSuchMaker' }),
      after: row({ motorId: 'silent-changed', manufacturerAbbrev: 'NoSuchMaker', avgThrustN: 6 }), fields: ['avgThrustN'] }],
    removed: ['silent-added'], rejected: [{ entry: row({ motorId: 'refused' }), reason: 'no burn time' }],
    snapshot: { id: `${daysAfter(MOTOR_DB_DATE, 1)}`, generated: daysAfter(MOTOR_DB_DATE, 1), motorsSha256: 'a'.repeat(64),
      curves: { path: `v1/${daysAfter(MOTOR_DB_DATE, 1)}/motorCurves.json`, bytes: 10, sha256: 'b'.repeat(64) } },
  });

  it.each([
    ['no stored overlay', null],
    ['a stored overlay with added, changed and silent-maker rows', learned],
  ])('installs exactly what the download path installs, from %s', async (_name, previous) => {
    const run = async (record: unknown) => {
      localStorage.clear();
      setCatalogueOverlay(null);
      if (previous) localStorage.setItem(OVERLAY_KEY, JSON.stringify(previous()));
      setBundledSnapshotForTests(record);
      const fetchImpl = counted();
      const result = await checkForCatalogueUpdates({ force: true, fetchImpl, now });
      return { result, requests: fetchImpl.mock.calls.length, stored: JSON.parse(localStorage.getItem(OVERLAY_KEY)!) as unknown,
        catalogue: getCatalogue() };
    };
    const download = await run(UNKNOWN);
    const shortcut = await run(recordOf(pub));
    expect([download.requests, shortcut.requests]).toEqual([2, 1]);
    expect(shortcut.result).toStrictEqual(download.result);
    expect(shortcut.stored).toStrictEqual(download.stored);
    expect(shortcut.catalogue).toStrictEqual(download.catalogue);
    if (previous) {
      // The control is not vacuous: the earlier check's rows are carried, and the silent maker is named.
      expect(shortcut.result.overlay.added.map(m => m.motorId)).toEqual(['answering-added', 'silent-added']);
      expect(shortcut.result.overlay.removed).toEqual(['answering-added', 'silent-added']);
      expect(shortcut.result.silent).toEqual(['NoSuchMaker']);
    }
  });

  it('keeps the same-snapshot rule: an overlay already on this snapshot is kept as it was, not rebuilt', async () => {
    setBundledSnapshotForTests(recordOf(pub));
    const previous = { ...learned(), snapshot: { id: pub.id, generated: pub.generated, motorsSha256: pub.entry.motors.sha256,
      curves: { path: pub.entry.curves.path, bytes: pub.entry.curves.bytes, sha256: pub.entry.curves.sha256 } } };
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(previous));
    const fetchImpl = counted();
    const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(overlay).toStrictEqual({ ...previous, fetchedAt: new Date(NOW).toISOString() });
  });

  it('(iii) after a Discard, a matching record installs an empty overlay with one request', async () => {
    setBundledSnapshotForTests(recordOf(pub));
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(learned()));
    discardCatalogueOverlay();
    const fetchImpl = counted();
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect([overlay.added, overlay.changed, overlay.removed, overlay.rejected]).toEqual([[], [], [], []]);
    expect(getCatalogue()).toBe(MOTOR_DB);
  });

  it('(iii) a check still running when Discard is pressed installs nothing', async () => {
    setBundledSnapshotForTests(recordOf(pub));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inner = counted();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return inner(input, { ...init, signal: undefined });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const pending = checkForCatalogueUpdates({ force: true, fetchImpl, now }).then(() => null, (e: unknown) => e as Error);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    discardCatalogueOverlay();
    release();
    expect((await pending)?.name).toBe('AbortError');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
    expect(getCatalogueOverlay()).toBeNull();
  });

  it('reads a record as known only with two 64-hex shas and the shipped catalogue\'s date', () => {
    const ok = recordOf(pub);
    setBundledSnapshotForTests(ok);
    expect(bundledSnapshot()).toStrictEqual({ generated: MOTOR_DB_DATE, motorsSha256: ok.motorsSha256, curvesSha256: ok.curvesSha256 });
    for (const bad of [UNKNOWN, null, 'record', { ...ok, schema: 2 }, { ...ok, generated: daysAfter(MOTOR_DB_DATE, 1) },
      { ...ok, motorsSha256: ok.motorsSha256.toUpperCase() }, { ...ok, curvesSha256: ok.curvesSha256.slice(1) },
      { ...ok, motorsSha256: 7 }]) {
      setBundledSnapshotForTests(bad === null ? UNKNOWN : bad);
      expect(bundledSnapshot()).toBeNull();
    }
  });

  it.each(['stale date', 'missing motors sha', 'missing curves sha', 'schema', 'sha format'] as const)('the CI guard refuses a raw record with %s', kind => {
    const curvesSha256 = createHash('sha256').update(readFileSync(join(here, '../data/motorCurves.json'))).digest('hex');
    const known = { schema: 1, generated: MOTOR_DB_DATE, motorsSha256: 'a'.repeat(64), curvesSha256 };
    expect(() => checkCommittedRecord(known)).not.toThrow();
    const bad = { ...known,
      ...(kind === 'stale date' ? { generated: daysAfter(MOTOR_DB_DATE, -1) } : {}),
      ...(kind === 'missing motors sha' ? { motorsSha256: null } : {}),
      ...(kind === 'missing curves sha' ? { curvesSha256: null } : {}),
      ...(kind === 'schema' ? { schema: 2 } : {}),
      ...(kind === 'sha format' ? { motorsSha256: 'not-a-sha' } : {}),
    };
    expect(() => checkCommittedRecord(bad)).toThrow();
  });

  it('the CI guard accepts the explicitly unknown raw record', () => {
    expect(() => checkCommittedRecord(UNKNOWN)).not.toThrow();
  });

  it('the committed record, when known, is this bundle\'s: its curves sha is motorCurves.json\'s and its date is the catalogue\'s', () => {
    setBundledSnapshotForTests(null);
    checkCommittedRecord(committedRecord);
  });
});
