// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOTOR_DB, MOTOR_DB_DATE, applyOverlay, findDbMotor, getCatalogue, getCatalogueOverlay,
  setCatalogueOverlay, type CatalogueOverlay, type MotorDbEntry,
} from './motorDb.js';
import {
  OVERLAY_KEY, RECHECK_MIN_MS, changedMotorsInDesign, checkForCatalogueUpdates, describeOverlay,
  diffCatalogue, discardCatalogueOverlay, loadStoredOverlay, restoreCatalogueOverlay, screenEntry,
} from './catalogueOverlay.js';

/**
 * The in-app "check thrustcurve.org for newer motors" path. Everything here
 * runs against a stubbed fetch and the REAL shipped catalogue as the base.
 */

const row = (over: Partial<MotorDbEntry> = {}): MotorDbEntry => ({
  motorId: 'live-1', manufacturerAbbrev: 'Estes', designation: 'Z9', commonName: 'Z9', impulseClass: 'Z',
  diameter: 18, length: 70, type: 'SU', avgThrustN: 5, maxThrustN: 10, totImpulseNs: 8,
  burnTimeS: 1.6, totalWeightG: 20, propWeightG: 10, delays: '3,5', availability: 'regular',
  propInfo: 'black powder', caseInfo: '', ...over,
});

/** A fetch that serves metadata.json and one search.json page per manufacturer. */
function stubApi(live: MotorDbEntry[], opts: { cap?: string[] } = {}): ReturnType<typeof vi.fn> {
  const mfrs = [...new Set(live.map((m) => m.manufacturerAbbrev))];
  const spy = vi.fn(async (url: string) => {
    const u = new URL(url);
    let body: unknown;
    if (u.pathname.endsWith('/metadata.json')) {
      body = { manufacturers: mfrs.map((abbrev) => ({ abbrev })), impulseClasses: ['A', 'B', 'C'] };
    } else {
      const mfr = u.searchParams.get('manufacturer');
      const ic = u.searchParams.get('impulseClass');
      let results = live.filter((m) => m.manufacturerAbbrev === mfr && (!ic || m.impulseClass === ic));
      // Simulate the 500 cap for a named manufacturer: the un-subdivided
      // query returns 500 stub rows so the caller must page by class.
      if (!ic && opts.cap?.includes(mfr!)) results = Array.from({ length: 500 }, (_, i) => row({ motorId: `cap-${i}`, manufacturerAbbrev: mfr! }));
      body = { results };
    }
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  return spy;
}

beforeEach(() => { localStorage.clear(); setCatalogueOverlay(null); });
afterEach(() => { localStorage.clear(); setCatalogueOverlay(null); });

describe('screenEntry — a live row must be a possible motor', () => {
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
    expect(screenEntry(row({ totalWeightG: undefined, propWeightG: undefined, burnTimeS: undefined }))).toBeNull();
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
  it('pulls one page per manufacturer, screens, diffs, persists and installs', async () => {
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    const live = MOTOR_DB
      .map((m) => (m.motorId === c6.motorId ? { ...m, totImpulseNs: 9.1 } : m))
      .concat([row({ motorId: 'new-1', manufacturerAbbrev: 'Estes' }), row({ motorId: 'bad-1', manufacturerAbbrev: 'Estes', diameter: 0 })]);
    const spy = stubApi(live);
    const { overlay, skipped, stored } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch });
    expect(skipped).toBeNull();
    expect(stored).toBe(true);
    const mfrCount = new Set(live.map((m) => m.manufacturerAbbrev)).size;
    expect(spy).toHaveBeenCalledTimes(1 + mfrCount);
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

  it('pages by impulse class when a manufacturer hits the 500 cap', async () => {
    const live = [row({ motorId: 'a1', manufacturerAbbrev: 'Big', impulseClass: 'A' }), row({ motorId: 'b1', manufacturerAbbrev: 'Big', impulseClass: 'B' })];
    const spy = stubApi(live, { cap: ['Big'] });
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true });
    // metadata + the capped query + one per class (A, B, C)
    expect(spy).toHaveBeenCalledTimes(1 + 1 + 3);
    expect(overlay.added.map((m) => m.motorId).sort()).toEqual(['a1', 'b1']);
  });

  it('screens only what it would apply — a shipped row that is implausible but unchanged is left alone', async () => {
    // The shipped catalogue carries rows that fail screenEntry (thrustcurve.org
    // lists more propellant than loaded mass on at least one motor); the
    // runtime refuses those at fly time with a message. A live pull that
    // returns them UNCHANGED must not refuse them (they were reviewed when
    // shipped) and must not mistake them for removed.
    const implausible = MOTOR_DB.filter((m) => screenEntry(m) !== null);
    expect(implausible.length).toBeGreaterThan(0);
    const spy = stubApi(MOTOR_DB);
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true });
    expect(overlay.rejected).toEqual([]);
    expect(overlay.removed).toEqual([]);
    expect(overlay.added).toEqual([]);
    expect(overlay.changed).toEqual([]);
    expect(getCatalogue()).toBe(MOTOR_DB);
  });

  it('refuses a CHANGE that makes a motor implausible, and keeps the shipped row', async () => {
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    const live = MOTOR_DB.map((m) => (m.motorId === c6.motorId ? { ...m, propWeightG: 999 } : m));
    const spy = stubApi(live);
    const { overlay } = await checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch, force: true });
    expect(overlay.changed).toEqual([]);
    expect(overlay.rejected).toHaveLength(1);
    expect(overlay.rejected[0]!.reason).toMatch(/more propellant/);
    expect(getCatalogue().find((m) => m.motorId === c6.motorId)!.propWeightG).toBe(c6.propWeightG);
  });

  it('refuses a repeat inside six hours unless forced, and keeps the previous result', async () => {
    const spy = stubApi(MOTOR_DB);
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

  it('surfaces an HTTP failure as an error naming the endpoint, and installs nothing', async () => {
    const spy = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    await expect(checkForCatalogueUpdates({ fetchImpl: spy as unknown as typeof fetch })).rejects.toThrow(/HTTP 503/);
    expect(getCatalogueOverlay()).toBeNull();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });
});

describe('the words the browser shows', () => {
  const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
  const overlay: CatalogueOverlay = {
    baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-01T09:00:00Z', liveCount: 1200,
    added: [row({ motorId: 'n' })],
    changed: [{ motorId: c6.motorId, before: c6, after: { ...c6, totImpulseNs: 9.1 }, fields: ['totImpulseNs'] }],
    removed: [], rejected: [{ entry: { manufacturerAbbrev: 'X', designation: 'Q1' }, reason: 'diameter 0 mm is not a motor' }],
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
});
