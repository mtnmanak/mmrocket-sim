// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOTOR_DB, MOTOR_DB_DATE, applyOverlay, displayMotorManufacturer, findDbMotor, getCatalogue, getCatalogueOverlay,
  setCatalogueOverlay, type CatalogueOverlay, type MotorDbEntry,
} from './motorDb.js';
import {
  OVERLAY_KEY, RECHECK_MIN_MS, changedMotorsInDesign, checkForCatalogueUpdates as checkUpdates, describeOverlay,
  diffCatalogue, discardCatalogueOverlay, loadStoredOverlay, restoreCatalogueOverlay, screenEntry,
} from './catalogueOverlay.js';
import { mountMotorFromDb } from './motorMatch.js';
import type { MotorSpec } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import { statedWeightTextFor } from './unitText.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';
import { MOTOR_CORRECTIONS } from '../../scripts/motor-corrections.mjs';
import { DEFAULT_MAX_JSON_BYTES } from './net.js';
import { resetThrustcurveBackoffForTests, thrustcurveBackoffMessage } from './thrustcurveTraffic.js';
import { CATALOGUE_BASE } from './catalogueClient.js';
import { catalogueFetch, daysAfter, manifestOf, publication, type Publication } from './catalogueFixture.testSupport.js';

const checkForCatalogueUpdates = checkUpdates;

/**
 * The in-app "check for newer motors" path, which reads the curated
 * catalogue's current snapshot (row 110). Everything here runs against a
 * stubbed fetch and the REAL shipped catalogue as the base.
 */

const row = (over: Partial<MotorDbEntry> = {}): MotorDbEntry => ({
  motorId: 'live-1', manufacturerAbbrev: 'Estes', designation: 'Z9', commonName: 'Z9', impulseClass: 'Z',
  diameter: 18, length: 70, type: 'SU', avgThrustN: 5, maxThrustN: 10, totImpulseNs: 8,
  burnTimeS: 1.6, totalWeightG: 20, propWeightG: 10, delays: '3,5', availability: 'regular',
  propInfo: 'black powder', caseInfo: '', ...over,
});

/**
 * A fetch that serves the curated catalogue: a manifest whose current snapshot
 * lists `live` (with the seven extra fields the published file carries), and
 * that snapshot's files, as real Responses. Each stub is a NEW snapshot — its
 * own id and sha — unless `same` reuses an earlier stub's publication.
 * `generated` dates the snapshot (default: a day after the shipped catalogue).
 */
let snapshotSeq = 0;
function stubCatalogue(live: readonly object[], opts: { generated?: string; motorsDoc?: unknown; same?: { pub: Promise<Publication> } } = {}) {
  const generated = opts.generated ?? daysAfter(MOTOR_DB_DATE, 1);
  const id = `${generated}.${2 + snapshotSeq++}`;
  const pub = opts.same?.pub ?? publication(id, live, {}, { generated, ...('motorsDoc' in opts ? { motorsDoc: opts.motorsDoc } : {}) });
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = await pub;
    return catalogueFetch(manifestOf(p), [p])(input, init);
  });
  return Object.assign(spy as unknown as typeof fetch & typeof spy, { pub });
}

/** A fetch that never answers until its signal aborts — a stalled catalogue — and then fails as fetch does. */
const stalled = (): typeof fetch => (_input, init) => new Promise<Response>((_resolve, reject) => {
  const sig = init?.signal;
  const fail = () => reject(sig?.reason instanceof Error ? sig.reason : Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (sig?.aborted) fail();
  sig?.addEventListener('abort', fail, { once: true });
});

beforeEach(() => { resetThrustcurveBackoffForTests(); localStorage.clear(); setCatalogueOverlay(null); });

it.each(['rejected', 'added', 'changed'])('describes poisoned stored %s scalars without throwing', kind => {
  const poison = { toString: 0, valueOf: 0 };
  const overlay = { baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: 1,
    added: kind === 'added' ? [row({ designation: poison as unknown as string })] : [],
    changed: kind === 'changed' ? [{ motorId: 'live-1', before: row({ avgThrustN: poison as unknown as number }), after: row(), fields: ['avgThrustN'] }] : [],
    removed: [], rejected: kind === 'rejected' ? [{ entry: { manufacturerAbbrev: poison }, reason: 'bad' }] : [] };
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  const loaded = loadStoredOverlay()!;
  expect(loaded).not.toBeNull();
  expect(() => describeOverlay(loaded)).not.toThrow();
});
it('keeps a previously fetched motor as OOP when an answering maker delists it', async () => {
  const learned = row({ motorId: 'previous-new' });
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(0).toISOString(),
    liveCount: 1, added: [learned], changed: [], removed: [], rejected: [] }));
  const live = [row({ motorId: 'still-listed' })];
  const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue(live) as typeof fetch });
  expect(overlay.added.find(m => m.motorId === learned.motorId)).toBeDefined();
  expect(overlay.removed).toContain(learned.motorId);
  expect(getCatalogue().find(m => m.motorId === learned.motorId)?.availability).toBe('OOP');
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([row({ manufacturerAbbrev: 'Another maker' })]) as typeof fetch });
  expect(getCatalogue().find(m => m.motorId === learned.motorId)?.availability).toBe('OOP');
});
it('keeps the last usable fetched motor when its newly listed replacement is refused', async () => {
  const learned = row({ motorId: 'previous-new' });
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(0).toISOString(),
    liveCount: 1, added: [learned], changed: [], removed: [], rejected: [] }));
  const { overlay } = await checkForCatalogueUpdates({ force: true,
    fetchImpl: stubCatalogue([{ ...learned, diameter: -1 }]) as typeof fetch });
  expect(overlay.rejected).toHaveLength(1);
  expect(getCatalogue().find(m => m.motorId === learned.motorId)?.diameter).toBe(18);
  expect(overlay.removed).not.toContain(learned.motorId);
});

it.each([
  { fields: null }, { fields: ['length', null] }, { before: null },
  { before: {} }, { motorId: 'wrong-id' },
])('S7c-5 / S7c-g4 repairs stored change metadata %j with a visible refusal', broken => {
  const before = MOTOR_DB[0]!;
  const change = { motorId: before.motorId, before, after: { ...before, length: before.length + 1 }, fields: ['length'], ...broken };
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(),
    liveCount: 1, added: [], changed: [change], removed: [], rejected: [] }));
  const loaded = restoreCatalogueOverlay()!;
  expect(loaded.changed).toEqual([]);
  expect(loaded.rejected).toHaveLength(1);
  expect(describeOverlay(loaded).join(' ')).toContain('stored');
  expect(getCatalogue()).toBe(MOTOR_DB);
});

it('S7c-g4 repairs stored rejected wrappers, removed IDs and invalid fetch dates with notes', () => {
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: 'not a date',
    liveCount: 0, added: [], changed: [], removed: [null, 7], rejected: [{ entry: null, reason: 'bad' }, null] }));
  const loaded = restoreCatalogueOverlay()!;
  expect(loaded.fetchedAt).toBe('');
  expect(loaded.removed).toEqual([]);
  expect(() => describeOverlay(loaded)).not.toThrow();
  expect(describeOverlay(loaded).join(' ')).toContain('stored');
});

/**
 * B.1 — a motors file is the whole catalogue or nothing. These replace the
 * thrustcurve.org pull's API-shape and page-completeness cases (S7c-g7,
 * S7c-b1): the shape is now one file, its rows counted twice, by the file and
 * by the manifest.
 */
it.each([
  ['no motor list', (rows: object[]) => ({ generated: 'x', count: rows.length })],
  ['a motor list that is not an array', (rows: object[]) => ({ count: rows.length, motors: {} })],
  ['a count that is not the list\'s length', (rows: object[]) => ({ count: rows.length + 1, motors: rows })],
  ['a null row', (rows: object[]) => ({ count: rows.length + 1, motors: [...rows, null] })],
  ['an array row', (rows: object[]) => ({ count: rows.length + 1, motors: [...rows, []] })],
  ['a row with no motorId', (rows: object[]) => ({ count: rows.length + 1, motors: [...rows, { ...row(), motorId: '' }] })],
  ['a row with a numeric motorId', (rows: object[]) => ({ count: rows.length + 1, motors: [...rows, { ...row(), motorId: 7 }] })],
  ['a repeated motorId', (rows: object[]) => ({ count: rows.length + 1, motors: [...rows, rows[0]] })],
  ['a JSON null file', () => null],
])('B.1 refuses a motors file with %s, and leaves the stored overlay as it was', async (_name, doc) => {
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([row()]) });
  const previous = localStorage.getItem(OVERLAY_KEY);
  const installed = getCatalogue();
  const rows = [row({ motorId: 'a' }), row({ motorId: 'b' })];
  const fetchImpl = stubCatalogue(rows, { motorsDoc: doc(rows) });
  await expect(checkForCatalogueUpdates({ force: true, fetchImpl })).rejects.toThrow(/motors file .* not used/);
  expect(localStorage.getItem(OVERLAY_KEY)).toBe(previous);
  expect(getCatalogue()).toBe(installed);
});

it('B.1 refuses a motors file whose count disagrees with the manifest\'s', async () => {
  const rows = [row({ motorId: 'a' }), row({ motorId: 'b' })];
  const pub = publication(`${daysAfter(MOTOR_DB_DATE, 1)}.99`, rows);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const p = await pub;
    const manifest = manifestOf(p) as { snapshots: { motors: { count: number } }[] };
    manifest.snapshots[0]!.motors.count = 3;
    return catalogueFetch(manifest, [p])(input, init);
  });
  await expect(checkForCatalogueUpdates({ force: true, fetchImpl })).rejects.toThrow(/number of motors/);
  expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  // Positive control: the same file under its own count installs.
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue(rows) });
  expect(getCatalogueOverlay()?.added.map(m => m.motorId)).toEqual(['a', 'b']);
});

// H1: planPublication writes a motors file only with rows, and dated as its
// manifest entry; the app holds the file it reads to both.
it('H1 refuses a motors file dated other than its manifest entry, and leaves storage as it was', async () => {
  const rows = [row({ motorId: 'a' }), row({ motorId: 'b' })];
  const generated = daysAfter(MOTOR_DB_DATE, 1);
  const fetchImpl = stubCatalogue(rows, { motorsDoc: { generated: daysAfter(MOTOR_DB_DATE, 2), count: 2, motors: rows } });
  await expect(checkForCatalogueUpdates({ force: true, fetchImpl })).rejects.toThrow(/motors file .* not used/);
  expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  // Positive control: the same rows dated as the manifest says install.
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue(rows, { motorsDoc: { generated, count: 2, motors: rows } }) });
  expect(getCatalogueOverlay()?.added.map(m => m.motorId)).toEqual(['a', 'b']);
});

it('S7c-b2 retains previous additions and changes when their maker is silent on the next check', async () => {
  const before = MOTOR_DB[0]!;
  const added = row({ motorId: 'previous-new', manufacturerAbbrev: before.manufacturerAbbrev });
  const after = { ...before, length: before.length + 1 };
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([...MOTOR_DB.filter(m => m.motorId !== before.motorId), after, added]) as unknown as typeof fetch });
  const live = MOTOR_DB.filter(m => m.manufacturerAbbrev !== before.manufacturerAbbrev);
  const result = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue(live) as unknown as typeof fetch });
  expect(result.silent).toContain(before.manufacturerAbbrev);
  expect(getCatalogue().find(m => m.motorId === added.motorId)).toEqual(added);
  expect(getCatalogue().find(m => m.motorId === before.motorId)).toEqual(after);
  expect(loadStoredOverlay()?.added.map(m => m.motorId)).toContain(added.motorId);
});

it.each(['added', 'changed'] as const)('fresh same-ID results supersede a silent maker previous %s row', async kind => {
  const before = MOTOR_DB[0]!;
  const previous = kind === 'added' ? row({ motorId: 'moved-maker' }) : before;
  const old = { ...previous, manufacturerAbbrev: 'Previous maker', length: previous.length + 1 };
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([
    ...MOTOR_DB.filter(m => m.motorId !== previous.motorId), old,
  ]) as unknown as typeof fetch });
  const fresh = { ...previous, manufacturerAbbrev: before.manufacturerAbbrev, length: previous.length + 2 };
  const result = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([
    ...MOTOR_DB.filter(m => m.motorId !== previous.motorId), fresh,
  ]) as unknown as typeof fetch });
  expect(getCatalogue().find(m => m.motorId === previous.motorId)).toEqual(fresh);
  expect(result.overlay[kind].filter(m => ('after' in m ? m.after.motorId : m.motorId) === previous.motorId)).toHaveLength(1);
  expect(result.silent).not.toContain('Previous maker');
});

it('a newly removed motor cannot retain a stale change attributed to a silent maker', async () => {
  const before = MOTOR_DB.find(m => MOTOR_DB.some(other => other.motorId !== m.motorId && other.manufacturerAbbrev === m.manufacturerAbbrev))!;
  await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([
    ...MOTOR_DB.filter(m => m.motorId !== before.motorId), { ...before, manufacturerAbbrev: 'Previous maker' },
  ]) as unknown as typeof fetch });
  const result = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue(
    MOTOR_DB.filter(m => m.motorId !== before.motorId),
  ) as unknown as typeof fetch });
  expect(result.overlay.removed).toContain(before.motorId);
  expect(result.overlay.changed.find(c => c.motorId === before.motorId)).toBeUndefined();
  expect(getCatalogue().find(m => m.motorId === before.motorId)?.availability).toBe('OOP');
});

it.each(['garbage', '2026-02-31'])('a stored invalid check date (%s) stays unknown and permits a fresh check', async fetchedAt => {
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt,
    liveCount: 0, added: [], changed: [], removed: [], rejected: [] }));
  const restored = restoreCatalogueOverlay()!;
  expect(restored.fetchedAt).toBe('');
  expect(describeOverlay(restored)[0]).not.toMatch(/1970|2026-02-31/);
  const result = await checkForCatalogueUpdates({ fetchImpl: stubCatalogue([row()]) as unknown as typeof fetch });
  expect(result.skipped).toBeNull();
  expect(result.overlay.added.map(m => m.motorId)).toContain('live-1');
});
afterEach(() => {
  resetThrustcurveBackoffForTests();
  vi.useRealTimers();
});

/**
 * B.3 — what a check costs. These replace the 250 ms pacing cases: there is
 * no per-maker pull left to pace.
 */
it('B.3 a new snapshot costs two requests; the same snapshot again costs one and changes only the check date', async () => {
  let t = Date.parse(`${daysAfter(MOTOR_DB_DATE, 2)}T12:00:00Z`);
  const now = () => t;
  const first = stubCatalogue([...MOTOR_DB, row({ motorId: 'new-1' })]);
  const a = await checkForCatalogueUpdates({ force: true, fetchImpl: first, now });
  expect(first.mock.calls.map(c => String(c[0]))).toEqual([`${CATALOGUE_BASE}manifest.json`, `${CATALOGUE_BASE}${(await first.pub).entry.motors.path}`]);
  expect(a.overlay.snapshot?.id).toBe((await first.pub).id);
  const storedBefore = JSON.parse(localStorage.getItem(OVERLAY_KEY)!) as CatalogueOverlay;
  t += 60_000;
  const again = stubCatalogue([], { same: first });
  const b = await checkForCatalogueUpdates({ force: true, fetchImpl: again, now });
  expect(again).toHaveBeenCalledOnce();
  expect(String(again.mock.calls[0]![0])).toBe(`${CATALOGUE_BASE}manifest.json`);
  expect(b.overlay.fetchedAt).toBe(new Date(t).toISOString());
  const storedAfter = JSON.parse(localStorage.getItem(OVERLAY_KEY)!) as CatalogueOverlay;
  expect({ ...storedAfter, fetchedAt: storedBefore.fetchedAt }).toEqual(storedBefore);
  // Positive control: a new snapshot of the same rows is downloaded.
  const next = stubCatalogue([...MOTOR_DB, row({ motorId: 'new-1' })]);
  await checkForCatalogueUpdates({ force: true, fetchImpl: next, now });
  expect(next).toHaveBeenCalledTimes(2);
});

it('B.3 the first check after an install downloads the motors file once, and a snapshot equal to the bundle reads as no change', async () => {
  const fetchImpl = stubCatalogue(MOTOR_DB);
  const { overlay } = await checkForCatalogueUpdates({ fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect([overlay.added, overlay.changed, overlay.removed, overlay.rejected]).toEqual([[], [], [], []]);
  expect(overlay.liveCount).toBe(MOTOR_DB.length);
  expect(getCatalogue()).toBe(MOTOR_DB);
});

it('B.4 a snapshot older than the shipped catalogue downloads nothing, removes nothing, and records the check', async () => {
  const older = stubCatalogue(MOTOR_DB.slice(1), { generated: daysAfter(MOTOR_DB_DATE, -3) });
  const { overlay, skipped, stored } = await checkForCatalogueUpdates({ fetchImpl: older });
  expect(older).toHaveBeenCalledOnce();
  expect(skipped).toBeNull();
  expect(stored).toBe(true);
  expect([overlay.added, overlay.changed, overlay.removed]).toEqual([[], [], []]);
  // C (audit S5-2): the older snapshot is never recorded — the field is
  // absent, not undefined, which rescreen would read as a bad snapshot.
  expect(Object.hasOwn(overlay, 'snapshot')).toBe(false);
  expect(getCatalogue()).toBe(MOTOR_DB);
  expect(Object.hasOwn(JSON.parse(localStorage.getItem(OVERLAY_KEY)!) as object, 'snapshot')).toBe(false);
  expect(loadStoredOverlay()?.rejected).toEqual([]);
  // The throttle holds after it, and the next check costs one request.
  expect((await checkForCatalogueUpdates({ fetchImpl: older })).skipped).toBe('recent');
  await checkForCatalogueUpdates({ force: true, fetchImpl: older });
  expect(older).toHaveBeenCalledTimes(2);
  // Positive control: the same rows dated the shipped catalogue's day are read, and the missing motor is removed.
  const same = stubCatalogue(MOTOR_DB.slice(1), { generated: MOTOR_DB_DATE });
  const read = await checkForCatalogueUpdates({ force: true, fetchImpl: same });
  expect(same).toHaveBeenCalledTimes(2);
  expect(read.overlay.removed).toEqual([MOTOR_DB[0]!.motorId]);
});

it('B.4 an older snapshot keeps what an earlier check learned, and the snapshot that check read', async () => {
  const learnedFrom = stubCatalogue([...MOTOR_DB, row({ motorId: 'learned' })]);
  await checkForCatalogueUpdates({ force: true, fetchImpl: learnedFrom });
  const { overlay } = await checkForCatalogueUpdates({ force: true,
    fetchImpl: stubCatalogue([row({ motorId: 'older-only' })], { generated: daysAfter(MOTOR_DB_DATE, -1) }) });
  expect(overlay.added.map(m => m.motorId)).toEqual(['learned']);
  expect(getCatalogue().some(m => m.motorId === 'learned')).toBe(true);
  // C: the newer snapshot the rows came from stays the active one.
  expect(overlay.snapshot?.id).toBe((await learnedFrom.pub).id);
  expect(loadStoredOverlay()?.snapshot?.id).toBe((await learnedFrom.pub).id);
});

// C: v0.196 stored the older ref, and its same-snapshot shortcut put it back
// on every check (and would under a release that keeps MOTOR_DB_DATE).
it('C an older ref an earlier check stored is dropped by the same-snapshot shortcut, and the rows are kept', async () => {
  const older = stubCatalogue([row({ motorId: 'older-only' })], { generated: daysAfter(MOTOR_DB_DATE, -2) });
  const p = await older.pub;
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-01-01T00:00:00.000Z', liveCount: 1,
    added: [row({ motorId: 'kept' })], changed: [], removed: [], rejected: [],
    snapshot: { id: p.id, generated: p.generated, motorsSha256: p.entry.motors.sha256,
      curves: { path: p.entry.curves.path, bytes: p.entry.curves.bytes, sha256: p.entry.curves.sha256 } } }));
  const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl: older });
  expect(older).toHaveBeenCalledOnce();
  expect(Object.hasOwn(overlay, 'snapshot')).toBe(false);
  expect(overlay.added.map(m => m.motorId)).toEqual(['kept']);
  expect(Object.hasOwn(JSON.parse(localStorage.getItem(OVERLAY_KEY)!) as object, 'snapshot')).toBe(false);
  // Positive control: a newer snapshot still becomes the active one.
  const newer = stubCatalogue([...MOTOR_DB, row({ motorId: 'kept' })]);
  const read = await checkForCatalogueUpdates({ force: true, fetchImpl: newer });
  expect(read.overlay.snapshot?.id).toBe((await newer.pub).id);
});

it('C an overlay a curated check wrote with no snapshot is described as the curated catalogue, not thrustcurve.org', async () => {
  const { overlay } = await checkForCatalogueUpdates({ force: true,
    fetchImpl: stubCatalogue([row({ motorId: 'older-only' })], { generated: daysAfter(MOTOR_DB_DATE, -2) }) });
  expect(describeOverlay(overlay)[0]).toContain('curated catalogue checked');
  expect(describeOverlay(overlay)[0]).not.toContain('thrustcurve.org');
  // A pre-row-110 pull still reads as one.
  expect(describeOverlay({ ...overlay, fetchedAt: `${daysAfter(MOTOR_DB_DATE, 1)}T00:00:00.000Z` })[0]).toContain('thrustcurve.org checked');
});

it('B.2 installs only the 18 catalogue fields of a row, and nothing a __proto__ or constructor key carries', async () => {
  const hostile = JSON.parse(`{${JSON.stringify(row({ motorId: 'proto-row' })).slice(1, -1)},
    "__proto__": { "polluted": true, "realManufacturer": 7 }, "constructor": { "prototype": { "polluted": true } },
    "realManufacturer": 7}`) as object;
  const fetchImpl = stubCatalogue([hostile]);
  const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl });
  const added = overlay.added.find(m => m.motorId === 'proto-row')!;
  expect(Object.keys(added).sort()).toEqual(Object.keys(row()).sort());
  expect(Object.getPrototypeOf(added)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(displayMotorManufacturer(added)).toBe('Estes');
  // The full-field publication's extras never arrive either.
  for (const m of getCatalogue()) expect(Object.hasOwn(m, 'certOrg') || Object.hasOwn(m, 'infoUrl')).toBe(false);
});

it('B.2 / A.3 a catalogue failure never touches thrustcurve.org\'s back-off, and an open back-off does not block a check', async () => {
  const down = vi.fn(async () => new Response('<html>503</html>', { status: 503 }));
  await expect(checkForCatalogueUpdates({ force: true, fetchImpl: down })).rejects.toThrow(/HTTP 503/);
  expect(thrustcurveBackoffMessage()).toBe('');
  // Open thrustcurve.org's breaker; the catalogue check still runs.
  const { thrustcurveFetch } = await import('./thrustcurveTraffic.js');
  await thrustcurveFetch(async () => new Response('{}', { status: 503 }))('https://www.thrustcurve.org/api/v1/download.json');
  expect(thrustcurveBackoffMessage()).not.toBe('');
  const fetchImpl = stubCatalogue([row()]);
  await checkForCatalogueUpdates({ force: true, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

describe('screenEntry — a live row must be a possible motor', () => {
  it.each(['impulseClass', 'propInfo', 'caseInfo', 'delays', 'type'])('storage hardening: refuses non-text %s', (field) => {
    for (const value of [{}, 7, [], true]) {
      expect(screenEntry(row({ [field]: value }))).toBe(`${field} is not text`);
    }
    for (const value of [undefined, null, '', 'text']) {
      expect(screenEntry(row({ [field]: value }))).toBeNull();
    }
  });
  it('accepts a normal row and refuses the impossible ones with a reason', () => {
    expect(screenEntry(row())).toBeNull();
    expect(screenEntry(row({ motorId: '' }))).toMatch(/motorId/);
    expect(screenEntry(row({ designation: ' ' }))).toMatch(/designation/);
    expect(screenEntry(row({ diameter: 0 }))).toMatch(/diameter/);
    expect(screenEntry(row({ length: 5000 }))).toMatch(/length/);
    expect(screenEntry(row({ propWeightG: 30, totalWeightG: 20 }))).toMatch(/more propellant/);
    expect(screenEntry(row({ totImpulseNs: -1 }))).toMatch(/impulse/);
    expect(screenEntry(row({ burnTimeS: NaN }))).toMatch(/burn/);
    expect(screenEntry(row({ availability: 'sometimes' }))).toMatch(/availability/);
  });

  it('tolerates the fields thrustcurve.org legitimately leaves blank', () => {
    // 156 of the shipped rows lack one or both weights.
    expect(screenEntry(row({ totalWeightG: undefined, propWeightG: undefined }))).toBeNull();
  });

  it('requires what the motor browser draws on every row (audit 2026-09-22)', () => {
    // The table calls burnTimeS.toFixed and the search commonName.toLowerCase:
    // one live row without either threw inside the render. Every shipped row
    // has both, so a live row without them is refused, not drawn.
    expect(screenEntry(row({ burnTimeS: undefined }))).toMatch(/burn time/);
    expect(screenEntry(row({ commonName: undefined as unknown as string }))).toMatch(/common name/);
    expect(screenEntry(row({ commonName: ' ' }))).toMatch(/common name/);
  });

  it('names a missing number as missing, never as "undefined" or "null" (audit 2026-09-30)', () => {
    // The reason is shown: describeOverlay writes "Refused <motor>: <reason>."
    // into the motor browser's note. A live row without the field, or with
    // JSON's null in it, read "diameter undefined mm is not a motor".
    const cases = [['diameter', 'no diameter'], ['length', 'no length'], ['burnTimeS', 'no burn time']] as const;
    for (const [field, reason] of cases) {
      for (const missing of [undefined, null]) {
        expect(screenEntry({ ...row(), [field]: missing }), `${field} ${String(missing)}`).toBe(reason);
      }
    }
    // A number that is there but impossible is still quoted.
    expect(screenEntry(row({ diameter: 0 }))).toBe('diameter 0 mm (0 in) is not a motor');
  });
});

describe('diffCatalogue', () => {
  const base = MOTOR_DB;
  it('finds an added motor, a changed field, and a removed motor', () => {
    const estesC6 = base.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    const live = base.filter((m) => m.motorId !== base[0]!.motorId)          // one removed
      .map((m) => (m.motorId === estesC6.motorId ? { ...m, totImpulseNs: 9.0 } : m)) // one changed
      .concat([row({ motorId: 'brand-new' })]);                                // one added
    const d = diffCatalogue(base, live);
    expect(d.added.map((m) => m.motorId)).toEqual(['brand-new']);
    expect(d.removed).toEqual([base[0]!.motorId]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]!.fields).toEqual(['totImpulseNs']);
    expect(d.changed[0]!.before.totImpulseNs).toBe(8.82);
    expect(d.changed[0]!.after.totImpulseNs).toBe(9.0);
  });

  it('does not call float serialisation noise a change', () => {
    const live = base.map((m) => (m.totalWeightG ? { ...m, totalWeightG: m.totalWeightG + 1e-12 } : m));
    expect(diffCatalogue(base, live).changed).toEqual([]);
  });

  it('is empty against itself', () => {
    const d = diffCatalogue(base, base);
    expect(d.added).toEqual([]); expect(d.changed).toEqual([]); expect(d.removed).toEqual([]);
  });
});

describe('applyOverlay and the effective catalogue', () => {
  it('returns the base itself when there is nothing to apply, so identity checks hold', () => {
    expect(applyOverlay(MOTOR_DB, null)).toBe(MOTOR_DB);
    expect(getCatalogue()).toBe(MOTOR_DB);
  });

  it('replaces changed rows, appends added ones, and marks removed ones OOP rather than deleting them', () => {
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    const gone = MOTOR_DB.find((m) => m.availability === 'regular' && m.motorId !== c6.motorId)!;
    const overlay: CatalogueOverlay = {
      baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: 1,
      added: [row({ motorId: 'brand-new', designation: 'Z9' })],
      changed: [{ motorId: c6.motorId, before: c6, after: { ...c6, totImpulseNs: 9 }, fields: ['totImpulseNs'] }],
      removed: [gone.motorId], rejected: [],
    };
    setCatalogueOverlay(overlay);
    const eff = getCatalogue();
    expect(eff).toHaveLength(MOTOR_DB.length + 1);
    expect(eff.find((m) => m.motorId === c6.motorId)!.totImpulseNs).toBe(9);
    expect(eff.find((m) => m.motorId === gone.motorId)!.availability).toBe('OOP');
    // And the lookups every importer and the browser use see it, because they
    // default to getCatalogue() — this is the seam the whole feature rests on.
    expect(findDbMotor('Z9', 18, undefined, 'Estes')?.motorId).toBe('brand-new');
    expect(findDbMotor('C6', 18, undefined, 'Estes')?.totImpulseNs).toBe(9);
    setCatalogueOverlay(null);
    expect(findDbMotor('Z9', 18, undefined, 'Estes')).toBeNull();
  });
});

describe('persistence and expiry', () => {
  const stored = (over: Partial<CatalogueOverlay> = {}): CatalogueOverlay => ({
    baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: 1,
    added: [row({ motorId: 'kept' })], changed: [], removed: [], rejected: [], ...over,
  });

  it('storage hardening: re-screens optional strings in cached added and changed motors', () => {
    const shipped = MOTOR_DB[0]!;
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored({
      added: [row(), row({ motorId: 'bad', propInfo: {} as string })],
      changed: [{ motorId: shipped.motorId, before: shipped,
        after: { ...shipped, impulseClass: 7 as unknown as string }, fields: ['impulseClass'] }],
    })));
    const loaded = restoreCatalogueOverlay()!;
    expect(loaded.added.map((m) => m.motorId)).toEqual(['live-1']);
    expect(loaded.changed).toEqual([]);
    expect(loaded.rejected.map((r) => r.reason)).toEqual(['propInfo is not text', 'impulseClass is not text']);
  });

  it('restores an overlay diffed against THIS catalogue', () => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored()));
    expect(restoreCatalogueOverlay()?.added[0]!.motorId).toBe('kept');
    expect(getCatalogueOverlay()?.added).toHaveLength(1);
  });

  it('discards — and deletes — an overlay diffed against an older catalogue', () => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored({ baseGenerated: '2026-07-04' })));
    expect(loadStoredOverlay()).toBeNull();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });

  it('drops a corrupt entry rather than throwing', () => {
    localStorage.setItem(OVERLAY_KEY, '{"nope":1}');
    expect(loadStoredOverlay()).toBeNull();
    localStorage.setItem(OVERLAY_KEY, 'not json');
    expect(loadStoredOverlay()).toBeNull();
  });

  it('re-screens a stored overlay, so a row written before a rule existed cannot reach the browser', () => {
    // An overlay stored before the screen required burnTimeS and commonName:
    // the motor browser draws `burnTimeS.toFixed(1)` on every row, and its
    // Check-again button is inside that browser, so the row stuck until a release.
    const shipped = MOTOR_DB[0]!;
    const noBurn = { ...row({ motorId: 'no-burn' }), burnTimeS: undefined } as unknown as MotorDbEntry;
    const noName = { ...shipped, commonName: undefined } as unknown as MotorDbEntry;
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored({
      added: [row({ motorId: 'kept' }), noBurn],
      changed: [{ motorId: shipped.motorId, before: shipped, after: noName, fields: ['commonName'] }],
    })));
    const o = restoreCatalogueOverlay()!;
    expect(o.added.map((m) => m.motorId)).toEqual(['kept']);
    expect(o.changed).toEqual([]);
    // "no burn time", which read "burn time undefined s" until 2026-09-30.
    expect(o.rejected.map((r) => r.reason)).toEqual(['no burn time', 'no common name']);
    expect(getCatalogue().some((m) => m.motorId === 'no-burn')).toBe(false);
    expect(getCatalogue().find((m) => m.motorId === shipped.motorId)?.commonName).toBe(shipped.commonName);
  });

  it('discardCatalogueOverlay clears both the store and the live catalogue', () => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored()));
    restoreCatalogueOverlay();
    expect(getCatalogue()).toHaveLength(MOTOR_DB.length + 1);
    discardCatalogueOverlay();
    expect(getCatalogue()).toBe(MOTOR_DB);
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });
});

describe('checkForCatalogueUpdates — the button', () => {
  it('reads the manifest and the snapshot\'s motors file, screens, diffs, persists and installs', async () => {
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    const live = MOTOR_DB
      .map((m) => (m.motorId === c6.motorId ? { ...m, totImpulseNs: 9.1 } : m))
      .concat([row({ motorId: 'new-1', manufacturerAbbrev: 'Estes' }), row({ motorId: 'bad-1', manufacturerAbbrev: 'Estes', diameter: 0 })]);
    const spy = stubCatalogue(live);
    const { overlay, skipped, stored } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch });
    expect(skipped).toBeNull();
    expect(stored).toBe(true);
    // The whole shipped catalogue's rows, with the published file's extra
    // fields: past net.ts's 256 KB JSON default, which the motors file is not held to.
    expect((await spy.pub).motorsBytes.length).toBeGreaterThan(DEFAULT_MAX_JSON_BYTES);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(overlay.liveCount).toBe(live.length);
    expect(overlay.snapshot).toEqual({ id: (await spy.pub).id, generated: (await spy.pub).generated,
      motorsSha256: (await spy.pub).entry.motors.sha256, curves: { path: (await spy.pub).entry.curves.path,
        bytes: (await spy.pub).entry.curves.bytes, sha256: (await spy.pub).entry.curves.sha256 } });
    expect(overlay.added.map((m) => m.motorId)).toEqual(['new-1']);
    expect(overlay.changed.map((c) => c.motorId)).toEqual([c6.motorId]);
    expect(overlay.rejected).toHaveLength(1);
    expect(overlay.rejected[0]!.reason).toMatch(/diameter/);
    expect(overlay.removed).toEqual([]);
    expect(overlay.baseGenerated).toBe(MOTOR_DB_DATE);
    // Installed and persisted.
    expect(getCatalogue().find((m) => m.motorId === 'new-1')).toBeDefined();
    expect(getCatalogue().find((m) => m.motorId === 'bad-1')).toBeUndefined();
    expect(loadStoredOverlay()?.added).toHaveLength(1);
  });

  it('reads a live row still carrying a figure the shipped catalogue corrects as no change at all', async () => {
    // Until 2026-10-01 the shipped catalogue itself carried two rows that fail
    // screenEntry, exactly as thrustcurve.org lists them, and this test held a
    // live pull returning them unchanged to refusing nothing. They are corrected
    // now (scripts/motor-corrections.mjs), with the AeroTech K62N's length since,
    // and thrustcurve.org still serves the known-bad figures, so a live pull
    // returns them DIFFERENT from the shipped rows. Without the same corrections
    // on the live side they would arrive as changes: the two impossible ones
    // refused by the screen and reported on every check, and the K62N's 274 mm,
    // a length the screen passes, applied, putting the error back everywhere.
    const live = MOTOR_DB.map((m) => {
      const c = MOTOR_CORRECTIONS.find((x) => x.motorId === m.motorId);
      if (!c) return m;
      const asUpstream: Record<string, unknown> = { ...m };
      for (const [f, { bad }] of Object.entries(c.fields)) asUpstream[f] = bad;
      return asUpstream as unknown as MotorDbEntry;
    });
    // Not vacuous: compared raw, every one of those live rows is a change.
    expect(diffCatalogue(MOTOR_DB, live).changed.map((c) => c.motorId).sort())
      .toEqual(MOTOR_CORRECTIONS.map((c) => c.motorId).sort());
    const spy = stubCatalogue(live);
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true });
    expect(overlay.rejected).toEqual([]);
    expect(overlay.removed).toEqual([]);
    expect(overlay.added).toEqual([]);
    expect(overlay.changed).toEqual([]);
    expect(getCatalogue()).toBe(MOTOR_DB);
  });

  it('still reports a corrected row that the catalogue moves to a third figure, as any change', async () => {
    // The corrections hide only their own known-bad figure, never a real move.
    const id = '5f4294d200023100000000f5'; // Contrail J234-BG, shipped corrected to 922 mm
    const live = MOTOR_DB.map((m) => (m.motorId === id ? { ...m, length: 914 } : m));
    const spy = stubCatalogue(live);
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true });
    expect(overlay.changed.map((c) => [c.motorId, c.fields])).toEqual([[id, ['length']]]);
    expect(getCatalogue().find((m) => m.motorId === id)!.length).toBe(914);
  });

  it('refuses a CHANGE that makes a motor implausible, and keeps the shipped row', async () => {
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    const live = MOTOR_DB.map((m) => (m.motorId === c6.motorId ? { ...m, propWeightG: 999 } : m));
    const spy = stubCatalogue(live);
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true });
    expect(overlay.changed).toEqual([]);
    expect(overlay.rejected).toHaveLength(1);
    expect(overlay.rejected[0]!.reason).toMatch(/more propellant/);
    expect(getCatalogue().find((m) => m.motorId === c6.motorId)!.propWeightG).toBe(c6.propWeightG);
  });

  it('refuses a repeat inside six hours unless forced, and keeps the previous result', async () => {
    const spy = stubCatalogue(MOTOR_DB);
    let t = Date.parse('2026-09-05T12:00:00Z');
    const now = () => t;
    await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, now });
    const calls = spy.mock.calls.length;
    t += RECHECK_MIN_MS - 1;
    const again = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, now });
    expect(again.skipped).toBe('recent');
    expect(spy.mock.calls.length).toBe(calls);
    const forced = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, now, force: true });
    expect(forced.skipped).toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThan(calls);
    // A forced check restarts the six-hour window from ITS fetch time.
    t += RECHECK_MIN_MS + 1;
    const later = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, now });
    expect(later.skipped).toBeNull();
  });

  it('never marks a whole maker out of production because the snapshot carries none of its rows (audit 2026-09-22)', async () => {
    // The snapshot carries no Estes rows at all — the silent-maker rule now
    // reads "a maker the snapshot carries no rows for" — and all but one of
    // Quest's. Only Quest's missing motor is believed removed.
    const estes = MOTOR_DB.filter((m) => m.manufacturerAbbrev === 'Estes');
    const quest = MOTOR_DB.filter((m) => m.manufacturerAbbrev === 'Quest');
    expect(estes.length).toBeGreaterThan(10);
    const live = MOTOR_DB.filter((m) => m.manufacturerAbbrev !== 'Estes' && m.motorId !== quest[0]!.motorId);
    const { overlay, silent } = await checkForCatalogueUpdates({
      fetchImpl: stubCatalogue(live) as unknown as typeof fetch, force: true,
    });
    expect(overlay.removed).toEqual([quest[0]!.motorId]);
    expect(silent).toEqual(['Estes']);
    expect(getCatalogue().filter((m) => m.manufacturerAbbrev === 'Estes' && m.availability === 'OOP').length)
      .toBe(estes.filter((m) => m.availability === 'OOP').length);
  });

  it.each(['manifest.json', 'motors'])('surfaces an HTTP failure on %s as one sentence naming the catalogue, and installs nothing', async (which) => {
    // The service's own error page, not JSON: the status is what there is to say.
    const good = stubCatalogue([row()]);
    const path = which === 'manifest.json' ? which : (await good.pub).entry.motors.path;
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith(path)
      ? new Response('<html><h1>503 Service Unavailable</h1></html>', { status: 503 }) : good(input, init));
    const err = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('catalogue.mountainmanrockets.com answered HTTP 503.');
    expect(getCatalogueOverlay()).toBeNull();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });
});

/**
 * A DEADLINE AND A CAP ON EVERY ANSWER (audit 2026-09-30, carried to the
 * curated catalogue). The manifest has 30 s and 256 KB; each snapshot file has
 * 120 s and is read no further than the size its manifest declares
 * (catalogueClient.test.ts holds the reader itself).
 */
describe('checkForCatalogueUpdates — a deadline and a cap on every answer', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('gives up on a stalled manifest at its deadline, says so, and installs nothing', async () => {
    vi.useFakeTimers();
    let outcome: unknown = 'pending';
    void checkForCatalogueUpdates({ fetchImpl: stalled(), force: true })
      .then(() => { outcome = 'resolved'; }, (e: unknown) => { outcome = e; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/did not answer within 30 s/);
    expect(getCatalogueOverlay()).toBeNull();
  });

  it('gives up on a stalled motors file at 120 s', async () => {
    const good = stubCatalogue([row()]);
    const path = (await good.pub).entry.motors.path;
    const hang = stalled();
    vi.useFakeTimers();
    let outcome: unknown = 'pending';
    void checkForCatalogueUpdates({ force: true, fetchImpl: (input, init) => String(input).endsWith(path) ? hang(input, init) : good(input, init) })
      .then(() => { outcome = 'resolved'; }, (e: unknown) => { outcome = e; });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect((outcome as Error).message).toMatch(/did not answer within 120 s/);
    expect(getCatalogueOverlay()).toBeNull();
  });

  it('stops reading a motors file that runs past its declared size, and installs nothing', async () => {
    const good = stubCatalogue([row({ motorId: 'r1' })]);
    const p = await good.pub;
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith(p.entry.motors.path)
      ? new Response(new Uint8Array([...p.motorsBytes, ...new Uint8Array(2 * 1024 * 1024)])) : good(input, init));
    await expect(checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true }))
      .rejects.toThrow(/ran past \d+ KB/);
    expect(getCatalogueOverlay()).toBeNull();
  });

  it('a motors file that is not the one its manifest names installs nothing', async () => {
    const good = stubCatalogue([row({ motorId: 'r1' })]);
    const swapped = await publication(`${daysAfter(MOTOR_DB_DATE, 1)}.98`, [row({ motorId: 'r2' })]);
    const p = await good.pub;
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith(p.entry.motors.path)
      ? new Response(swapped.motorsBytes.slice(0, p.motorsBytes.length) as Uint8Array<ArrayBuffer>) : good(input, init));
    await expect(checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true })).rejects.toThrow(/does not match|not the size/);
    expect(getCatalogueOverlay()).toBeNull();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });

  it('still stops on the user’s Stop, as the AbortError the motor browser tells a Stop by', async () => {
    const ctrl = new AbortController();
    const p = checkForCatalogueUpdates({ fetchImpl: stalled(), force: true, signal: ctrl.signal });
    ctrl.abort();
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect(getCatalogueOverlay()).toBeNull();
  });
});

describe('the words the browser shows', () => {
  const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
  const overlay: CatalogueOverlay = {
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-01T09:00:00Z', liveCount: 1200,
    added: [row({ motorId: 'n' })],
    changed: [{ motorId: c6.motorId, before: c6, after: { ...c6, totImpulseNs: 9.1 }, fields: ['totImpulseNs'] }],
    removed: [], rejected: [{ entry: { manufacturerAbbrev: 'X', designation: 'Q1' }, reason: 'diameter 0 mm (0 in) is not a motor' }],
  };

  it('leads with the counts and names each change field by field', () => {
    const lines = describeOverlay(overlay);
    expect(lines[0]).toContain('1 new, 1 changed, 0 no longer listed, 1 refused as implausible');
    expect(lines[0]).toContain('checked 2026-10-01');
    expect(lines.some((l) => /Estes C6: totImpulseNs 8\.82 → 9\.1/.test(l))).toBe(true);
    expect(lines.some((l) => /Refused X Q1: diameter/.test(l))).toBe(true);
  });

  it('names the changed motors that are loaded in the design, by maker and designation', () => {
    expect(changedMotorsInDesign(overlay, [{ label: 'C6-5', manufacturer: 'Estes' }])).toHaveLength(1);
    expect(changedMotorsInDesign(overlay, [{ label: 'C6-5', manufacturer: 'Quest' }])).toHaveLength(0);
    expect(changedMotorsInDesign(overlay, [{ label: 'D12-5', manufacturer: 'Estes' }])).toHaveLength(0);
  });

  it('knows a loaded motor whose picker label says "(auto delay)"', () => {
    // App labels an auto-delay motor "C6 (auto delay)" (mountDelayEdits), and
    // this matcher's private copy of the delay rule stripped only "-5" / "-P",
    // so a changed motor flown on auto delay was never named (audit
    // 2026-09-22, Dead code row 575: one shared delay-strip rule).
    expect(changedMotorsInDesign(overlay, [{ label: 'C6 (auto delay)', manufacturer: 'Estes' }])).toHaveLength(1);
    expect(changedMotorsInDesign(overlay, [{ label: 'C6-p', manufacturer: 'Estes' }])).toHaveLength(1);
  });
});

it('recognizes a loaded designation after its catalogue delay and impulse prefix were replaced', () => {
  for (const [designation, manufacturerAbbrev, commonName, label] of [
    ['F115SN-12A', 'AeroTech', 'F115', 'F115SN-8'],
    ['1013J453-16A', 'Cesaroni', 'J453', 'J453 (auto delay)'],
  ]) {
    const before = { ...MOTOR_DB[0]!, designation: designation!, manufacturerAbbrev: manufacturerAbbrev!, commonName: commonName! };
    const after = { ...before, totImpulseNs: before.totImpulseNs + 1 };
    const overlay: CatalogueOverlay = { ...diffCatalogue([before], [after]),
      baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, rejected: [] };
    expect(changedMotorsInDesign(overlay, [{ label: label!, manufacturer: manufacturerAbbrev }])).toHaveLength(1);
  }
});

it('restores an overlay-only motor label before App installs the stored overlay', async () => {
  // Startup needs a fresh module instance, before any set/restore/discard call.
  vi.resetModules();
  const { restoreMotorLabels } = await import('./motorLabels.js');
  const { getCatalogueOverlay } = await import('./motorDb.js');
  const added = row({ motorId: 'overlay-only', designation: 'F67C', commonName: 'F67', manufacturerAbbrev: 'AeroTech' });
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE,
    fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, added: [added], changed: [], removed: [], rejected: [] }));
  const spec = { designation: added.designation, ejectionDelay: 9 } as MotorSpec;
  const old = mountMotorFromDb(added, spec, 9, { event: 'automatic', delay: 0 });
  old.label = 'F67-9';
  const got = restoreMotorLabels({ mount: old })['mount']!;
  expect(got.label).toBe('F67C-9');
  expect(got.spec).toBe(spec);
  expect(getCatalogueOverlay()).toBeNull();
});

it.each([false, true])('refreshes label clashes when the overlay changes (installed: %s)', async (installed) => {
  vi.resetModules();
  const { getCatalogue, motorLabel, setCatalogueOverlay } = await import('./motorDb.js');
  const { labelCatalogue, motorTooltip, restoreConfigLabels, restoreMotorLabels } = await import('./motorLabels.js');
  const { withAuto, withDelay, withPlugged } = await import('./mountDelayEdits.js');
  const entry = MOTOR_DB.find(m => m.designation === '1013J453-16A')!;
  const added = { ...entry, motorId: 'overlay-clash', designation: '999J453-12A' };
  const overlay: CatalogueOverlay = { baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-06T00:00:00Z',
    liveCount: MOTOR_DB.length + 1, added: [added], changed: [], removed: [], rejected: [] };
  const mm = mountMotorFromDb(entry, { designation: entry.designation, ejectionDelay: 9 } as MotorSpec,
    9, { event: 'automatic', delay: 0 });
  const before = labelCatalogue();
  expect(restoreMotorLabels({ mount: mm }).mount!.label).toBe('J453-9');
  const install = (next: CatalogueOverlay | null) => {
    if (installed) setCatalogueOverlay(next);
    else if (next) localStorage.setItem(OVERLAY_KEY, JSON.stringify(next));
    else localStorage.removeItem(OVERLAY_KEY);
  };
  install(overlay);
  const catalogue = labelCatalogue();
  expect(catalogue).not.toBe(before);
  expect(labelCatalogue()).toBe(catalogue);
  const restored = restoreMotorLabels({ mount: mm }).mount!;
  expect(restored.label).toBe('1013J453-9');
  expect(restored.meta.label).toBe(restored.label);
  expect(restored.spec).toBe(mm.spec);
  expect(motorLabel(added, 9, {}, catalogue)).toBe('999J453-9');
  expect(restoreConfigLabels({ id: 'A', name: null, isDefault: true, motors: { mount: mm } }).motors.mount!.label)
    .toBe(restored.label);
  expect(motorTooltip(mm)).toBe('Cesaroni 1013J453-16A, 9 s delay (1013J453-9)');
  expect(withDelay(mm, 8).label).toBe('1013J453-8');
  expect(withAuto(mm, true).label).toBe('1013J453 (auto delay)');
  expect(withPlugged(mm, true).label).toBe('1013J453-P');
  if (installed) expect(motorLabel(entry, 9)).toBe('1013J453-9');
  else expect(getCatalogue()).toBe(before);
  install({ ...overlay, added: [{ ...added, designation: '999J454-12A' }] });
  expect(restoreMotorLabels({ mount: restored }).mount!.label).toBe('J453-9');
  expect(motorTooltip(mm)).toBe('Cesaroni 1013J453-16A, 9 s delay (J453-9)');
  install(overlay);
  expect(withDelay(mm, 8).label).toBe('1013J453-8');
  install(null);
  expect(restoreMotorLabels({ mount: restored }).mount!.label).toBe('J453-9');
  expect(withDelay(mm, 8).label).toBe('J453-8');
});

it('does not confuse AMW case impulses when naming changed loaded motors', () => {
  const before = MOTOR_DB.filter(m => m.manufacturerAbbrev === 'AMW'
    && ['BB-54-1050', 'BB-54-2550'].includes(m.designation));
  expect(before).toHaveLength(2);
  const overlay: CatalogueOverlay = { ...diffCatalogue(before, before.map(m => ({ ...m, totImpulseNs: m.totImpulseNs + 1 }))),
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-04T00:00:00Z', liveCount: 2, rejected: [] };
  for (const suffix of ['-P', '-9', ' (auto delay)']) {
    expect(changedMotorsInDesign(overlay, [{ label: 'BB-54-2550' + suffix, manufacturer: 'AMW' }])
      .map(c => c.after.designation)).toEqual(['BB-54-2550']);
  }
});

it('recognizes a loaded PS designation with plugged, numeric and Auto labels', () => {
  const before = MOTOR_DB.find(m => m.designation === 'N1975W-PS')!;
  const overlay: CatalogueOverlay = { ...diffCatalogue([before], [{ ...before, totImpulseNs: before.totImpulseNs + 1 }]),
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, rejected: [] };
  for (const suffix of ['', '-9', ' (auto delay)']) {
    expect(changedMotorsInDesign(overlay, [{ label: 'N1975W-PS' + suffix, manufacturer: 'AeroTech' }]))
      .toHaveLength(1);
  }
});

it.each([false, true])('uses one overlay designation for restore, delay edits and tooltip (installed: %s)', async (installed) => {
  vi.resetModules();
  const { setCatalogueOverlay, getCatalogueOverlay } = await import('./motorDb.js');
  const { motorTooltip, restoreConfigLabels, restoreMotorLabels } = await import('./motorLabels.js');
  const { withAuto, withDelay, withPlugged } = await import('./mountDelayEdits.js');
  const before = MOTOR_DB.find(m => m.designation === 'F67C')!;
  const after = { ...before, designation: 'F67C-UPDATED' };
  const overlay: CatalogueOverlay = { ...diffCatalogue([before], [after]),
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, rejected: [] };
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  if (installed) setCatalogueOverlay(overlay);
  const spec = { designation: before.designation, ejectionDelay: 9 } as MotorSpec;
  const old = mountMotorFromDb(before, spec, 9, { event: 'automatic', delay: 0 });
  const restored = restoreMotorLabels({ mount: old })['mount']!;
  expect(restored.label).toBe('F67C-UPDATED-9');
  expect(restored.spec).toBe(spec);
  expect(restoreConfigLabels({ id: 'A', name: null, isDefault: true, motors: { mount: old } }).motors['mount']!.label)
    .toBe(restored.label);
  expect(motorTooltip(restored)).toBe(`AeroTech F67C-UPDATED, 9 s delay (${restored.label})`);
  const edited = withDelay(restored, 8);
  const auto = withAuto(edited, true);
  const plugged = withPlugged(auto, true);
  for (const [mm, label, delay] of [
    [edited, 'F67C-UPDATED-8', '8 s delay'],
    [auto, 'F67C-UPDATED (auto delay)', 'automatic delay'],
    [plugged, 'F67C-UPDATED-P', 'plugged'],
  ] as const) {
    expect(mm.label).toBe(label);
    expect(mm.meta.label).toBe(label);
    expect(mm.spec.designation).toBe(before.designation);
    expect(motorTooltip(mm)).toBe(`AeroTech F67C-UPDATED, ${delay} (${label})`);
  }
  expect(getCatalogueOverlay()).toBe(installed ? overlay : null);
});

it.each(['restore', 'set', 'discard'] as const)('ignores another tab stored overlay after %s initializes this tab', async (initialize) => {
  vi.resetModules();
  const { getCatalogue, getCatalogueOverlay, setCatalogueOverlay } = await import('./motorDb.js');
  const { restoreCatalogueOverlay, discardCatalogueOverlay } = await import('./catalogueOverlay.js');
  const { motorTooltip, restoreConfigLabels, restoreMotorLabels } = await import('./motorLabels.js');
  const { withAuto, withDelay, withPlugged } = await import('./mountDelayEdits.js');
  const { planConfigSwitch } = await import('./importApply.js');
  const before = MOTOR_DB.find(m => m.designation === 'F67C')!;
  const overlay: CatalogueOverlay = { ...diffCatalogue([before], [{ ...before, designation: 'F67CT' }]),
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, rejected: [] };
  if (initialize === 'restore') expect(restoreCatalogueOverlay()).toBeNull();
  else if (initialize === 'set') setCatalogueOverlay(null);
  else discardCatalogueOverlay();
  // A different tab stores a rename that this tab has never installed.
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  expect(getCatalogueOverlay()).toBeNull();
  const spec = { designation: before.designation, ejectionDelay: 9, masses: [0.1], length: 0.1 } as MotorSpec;
  const old = mountMotorFromDb(before, spec, 9, { event: 'automatic', delay: 0 });
  const edited = withDelay(old, 7);
  expect(edited.label).toBe('F67C-7');
  expect(motorTooltip(edited, getCatalogue())).toBe('AeroTech F67C, 7 s delay (F67C-7)');
  expect(motorTooltip(edited)).toBe(motorTooltip(edited, getCatalogue()));
  expect(withAuto(edited, true).label).toBe('F67C (auto delay)');
  expect(withPlugged(edited, true).label).toBe('F67C-P');
  old.label = 'F67-9';
  old.meta.label = 'F67-9';
  const restored = restoreMotorLabels({ mount: old });
  expect(restored['mount']?.label).toBe('F67C-9');
  expect(restored['mount']?.spec).toBe(spec);
  const config: SavedConfig = { id: 'A', name: null, isDefault: true, motors: { mount: old } };
  expect(restoreConfigLabels(config).motors['mount']?.label).toBe('F67C-9');
  const plan = planConfigSwitch({ tree: { name: 'empty', components: [] }, savedConfigs: [config], activeConfigId: null,
    mountMotors: {}, unmatchedRefs: {} }, config, statedWeightTextFor(DEFAULT_PREFS.units));
  expect(plan.mountMotors['mount']?.label).toBe('F67C-9');
  expect(plan.savedConfigs[0]?.motors['mount']?.label).toBe('F67C-9');
  expect(getCatalogueOverlay()).toBeNull();
});

it('names a renamed loaded motor by id, with both rename sides as the no-id fallback', () => {
  const before = MOTOR_DB.find(m => m.designation === 'F67C')!;
  const after = { ...before, designation: 'F67C-UPDATED', commonName: 'F67-UPDATED' };
  const overlay: CatalogueOverlay = { ...diffCatalogue([before], [after]),
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, rejected: [] };
  expect(changedMotorsInDesign(overlay, [{ motorId: before.motorId, manufacturer: 'AeroTech', label: 'stale-label' }]))
    .toEqual(overlay.changed);
  expect(changedMotorsInDesign(overlay, [{ motorId: 'another-motor', manufacturer: 'AeroTech', label: 'F67C-9' }]))
    .toEqual([]);
  for (const label of ['F67C-9', 'F67C-UPDATED-9', 'F67-9', 'F67-UPDATED-9']) {
    expect(changedMotorsInDesign(overlay, [{ manufacturer: 'AeroTech', label }])).toEqual(overlay.changed);
    expect(changedMotorsInDesign(overlay, [{ manufacturer: 'Quest', label }])).toEqual([]);
  }
});

it.each([
  ['diameter', 'oops', 'diameter "oops" is not a motor'],
  ['length', Infinity, 'length "Infinity" is not a motor'],
  ['totalWeightG', 'bad', 'loaded weight "bad"'],
  ['propWeightG', NaN, 'propellant weight "NaN"'],
] as const)('quotes an unreadable live %s token', (field, raw, reason) => {
  expect(screenEntry({ ...row(), [field]: raw } as unknown as MotorDbEntry)).toBe(reason);
});
it.each([
  ['diameter', { toString: 0, valueOf: 0 }, 'diameter is not a number'],
  ['totalWeightG', [], 'totalWeightG is not a number'],
  ['avgThrustN', '12', 'avgThrustN is not a number'],
  ['burnTimeS', '1.5', 'burnTimeS is not a number'],
] as const)('still refuses a live %s that is not a number when there is no token to quote', (field, raw, reason) => {
  expect(screenEntry({ ...row(), [field]: raw } as unknown as MotorDbEntry)).toBe(reason);
});

// Closure audit of v0.194, row D: a hand-edited stored row with valid catalogue
// fields plus a non-string realManufacturer was installed whole, and
// displayMotorManufacturer threw on it while drawing the motor browser.
const extraField = [['7', 7], ['{"toString":0}', { toString: 0 }]] as const;

it.each(extraField)('D restores stored rows with only the catalogue fields (realManufacturer %s)', (_name, real) => {
  const shipped = MOTOR_DB[0]!;
  const extra = { realManufacturer: real, note: 'hand edit' };
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(),
    liveCount: MOTOR_DB.length + 1, added: [{ ...row(), ...extra }],
    changed: [{ motorId: shipped.motorId, before: { ...shipped, ...extra },
      after: { ...shipped, length: shipped.length + 1, ...extra }, fields: ['length'] }],
    removed: [], rejected: [] }));
  const loaded = restoreCatalogueOverlay()!;
  for (const entry of [...loaded.added, ...loaded.changed.flatMap(c => [c.before, c.after])]) {
    expect(Object.keys(entry)).not.toContain('realManufacturer');
    expect(Object.keys(entry)).not.toContain('note');
  }
  expect(loaded.added.map(m => m.motorId)).toEqual(['live-1']);
  expect(loaded.changed.map(c => c.motorId)).toEqual([shipped.motorId]);
  expect(loaded.rejected).toEqual([]);
  for (const m of getCatalogue()) expect(() => displayMotorManufacturer(m)).not.toThrow();
  expect(displayMotorManufacturer(getCatalogue().find(m => m.motorId === 'live-1')!)).toBe('Estes');
});

it.each([['a non-catalogue field', ['realManufacturer']], ['no field', []]] as const)(
  'D discards a stored change that names %s', (_name, fields) => {
    const shipped = MOTOR_DB[0]!;
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(),
      liveCount: MOTOR_DB.length, added: [],
      changed: [{ motorId: shipped.motorId, before: { ...shipped, realManufacturer: 'A' },
        after: { ...shipped, realManufacturer: 'B' }, fields }],
      removed: [], rejected: [] }));
    const loaded = restoreCatalogueOverlay()!;
    expect(loaded.changed).toEqual([]);
    expect(loaded.rejected.map(r => r.reason)).toContain('unreadable stored change metadata discarded; the shipped motor was kept');
  });

it('D returns a stored overlay with no extra fields unchanged', () => {
  const shipped = MOTOR_DB[0]!;
  const stored = { baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: MOTOR_DB.length + 1,
    added: [row()], changed: [{ motorId: shipped.motorId, before: shipped, after: { ...shipped, length: shipped.length + 1 },
      fields: ['length'] }], removed: [], rejected: [] };
  localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored));
  expect(loadStoredOverlay()).toStrictEqual(JSON.parse(JSON.stringify(stored)));
});

it.each(extraField)('D labels a loaded motor at startup past a stored realManufacturer %s', async (_name, real) => {
  vi.resetModules();
  const { motorTooltip } = await import('./motorLabels.js');
  const entry = MOTOR_DB.find(m => m.designation === '1013J453-16A')!;
  localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(),
    liveCount: MOTOR_DB.length, added: [], changed: [{ motorId: entry.motorId, before: entry,
      after: { ...entry, length: entry.length + 1, realManufacturer: real }, fields: ['length'] }], removed: [], rejected: [] }));
  const mm = mountMotorFromDb(entry, { designation: entry.designation, ejectionDelay: 9 } as MotorSpec,
    9, { event: 'automatic', delay: 0 });
  expect(motorTooltip(mm)).toBe('Cesaroni 1013J453-16A, 9 s delay (J453-9)');
});

/** B.5 — the snapshot record an overlay keeps, re-validated on every restore. */
describe('the stored snapshot record', () => {
  const ID = `${daysAfter(MOTOR_DB_DATE, 1)}.7`;
  const good = {
    id: ID, generated: daysAfter(MOTOR_DB_DATE, 1), motorsSha256: 'a'.repeat(64),
    curves: { path: `v1/${ID}/motorCurves.json`, bytes: 1000, sha256: 'b'.repeat(64) },
  };
  const stored = (snapshot?: unknown) => ({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: 1,
    added: [row({ motorId: 'kept' })], changed: [], removed: [], rejected: [], ...(snapshot === undefined ? {} : { snapshot }) });

  it('restores a valid record as it was stored', () => {
    const overlay = stored(good);
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
    expect(loadStoredOverlay()).toStrictEqual(overlay);
  });

  it.each([
    ['another origin', { ...good, curves: { ...good.curves, path: 'https://evil.example/motorCurves.json' } }],
    ['another snapshot\'s file', { ...good, curves: { ...good.curves, path: `v1/${MOTOR_DB_DATE}/motorCurves.json` } }],
    ['an uppercase sha', { ...good, curves: { ...good.curves, sha256: 'B'.repeat(64) } }],
    ['a short motors sha', { ...good, motorsSha256: 'a'.repeat(63) }],
    ['a non-integer size', { ...good, curves: { ...good.curves, bytes: 2.5 } }],
    ['a prototype-key id', { ...good, id: '__proto__' }],
    ['null', null],
    ['a string', 'snapshot'],
  ])('drops a record with %s, keeps the rows, and says so', (_name, snapshot) => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(stored(snapshot)));
    const restored = restoreCatalogueOverlay()!;
    expect(Object.hasOwn(restored, 'snapshot')).toBe(false);
    expect(restored.added.map(m => m.motorId)).toEqual(['kept']);
    expect(restored.rejected.map(r => r.reason)).toEqual(['unreadable stored catalogue snapshot discarded; check the catalogue again']);
  });

  it('a legacy overlay with no record restores unchanged, and gains no snapshot key', () => {
    const overlay = stored();
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
    const restored = loadStoredOverlay()!;
    expect(restored).toStrictEqual(overlay);
    expect(Object.hasOwn(restored, 'snapshot')).toBe(false);
  });

  it('the first snapshot check marks a legacy overlay\'s added motors the snapshot does not list as no longer listed (OOP)', async () => {
    // Reported to the owner: a motor a thrustcurve.org pull added, from a maker
    // the snapshot carries, reads as removed once the snapshot omits it.
    const learned = row({ motorId: 'legacy-added', manufacturerAbbrev: 'Estes' });
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({ ...stored(), added: [learned], fetchedAt: new Date(0).toISOString() }));
    restoreCatalogueOverlay();
    expect(getCatalogue().find(m => m.motorId === learned.motorId)?.availability).toBe('regular');
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: stubCatalogue(MOTOR_DB) });
    expect(overlay.removed).toEqual([learned.motorId]);
    expect(getCatalogue().find(m => m.motorId === learned.motorId)?.availability).toBe('OOP');
    // Positive control: a snapshot that lists it keeps it in production.
    const listed = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([...MOTOR_DB, learned]) });
    expect(listed.overlay.removed).toEqual([]);
  });
});

/**
 * B.7 — one check at a time. The stub below IGNORES the abort, as a fetch
 * that has already answered would, so only the generation guard stands
 * between a superseded check and the store.
 */
describe('one check at a time', () => {
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return { gate, release };
  };
  const gatedManifest = (inner: typeof fetch, gate: Promise<void>): typeof fetch & ReturnType<typeof vi.fn> =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('manifest.json')) await gate;
      return inner(input, { ...init, signal: undefined });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it('a Discard while a check is in flight: the check installs nothing and stores nothing afterwards', async () => {
    const { gate, release } = held();
    const fetchImpl = gatedManifest(stubCatalogue([...MOTOR_DB, row({ motorId: 'late' })]), gate);
    const pending = checkForCatalogueUpdates({ force: true, fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    discardCatalogueOverlay();
    release();
    expect((await pending.then(() => null, (e: unknown) => e as Error))?.name).toBe('AbortError');
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
    expect(getCatalogueOverlay()).toBeNull();
    // Positive control: the same check without the Discard installs.
    const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([...MOTOR_DB, row({ motorId: 'late' })]) });
    expect(overlay.added.map(m => m.motorId)).toEqual(['late']);
  });

  it('a newer check supersedes one in flight: only the newer result is installed', async () => {
    const { gate, release } = held();
    const older = gatedManifest(stubCatalogue([...MOTOR_DB, row({ motorId: 'older' })]), gate);
    const first = checkForCatalogueUpdates({ force: true, fetchImpl: older }).then(() => null, (e: unknown) => e as Error);
    await vi.waitFor(() => expect(older).toHaveBeenCalledOnce());
    const second = await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue([...MOTOR_DB, row({ motorId: 'newer' })]) });
    release();
    expect((await first)?.name).toBe('AbortError');
    expect(second.overlay.added.map(m => m.motorId)).toEqual(['newer']);
    expect(getCatalogueOverlay()?.added.map(m => m.motorId)).toEqual(['newer']);
    expect(loadStoredOverlay()?.added.map(m => m.motorId)).toEqual(['newer']);
  });

  it('a newer check aborts the request of the one in flight', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const first = checkForCatalogueUpdates({ force: true, fetchImpl: async (_input, init) => { seen.push(init?.signal); return stalled()(_input, init); } })
      .then(() => null, (e: unknown) => e as Error);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await checkForCatalogueUpdates({ force: true, fetchImpl: stubCatalogue(MOTOR_DB) });
    expect(seen[0]?.aborted).toBe(true);
    expect((await first)?.name).toBe('AbortError');
  });
});
