// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetCatalogueAutoCheckForTests, startCatalogueAutoCheck, subscribeAutomaticCatalogueResult, type CatalogueAutoCheckEnv,
} from './catalogueAutoCheck.js';
import {
  OVERLAY_KEY, RECHECK_MIN_MS, checkForCatalogueUpdates, discardCatalogueOverlay, loadStoredOverlay, restoreCatalogueOverlay,
} from './catalogueOverlay.js';
import { MOTOR_DB, MOTOR_DB_DATE, getCatalogue, getCatalogueOverlay, setCatalogueOverlay, subscribeCatalogue, type MotorDbEntry } from './motorDb.js';
import { CATALOGUE_BASE } from './catalogueClient.js';
import { catalogueFetch, daysAfter, manifestOf, publication, type Publication } from './catalogueFixture.testSupport.js';

/**
 * The automatic check on load (row 110, part C): every skip beside the same
 * setup with one input varied, where the check does run.
 */

const added = (motorId: string): MotorDbEntry => ({ ...MOTOR_DB.find(m => m.manufacturerAbbrev === 'Estes')!, motorId });
let pub: Publication;
let fetchImpl: ReturnType<typeof catalogueFetch>;
const T0 = Date.parse(`${daysAfter(MOTOR_DB_DATE, 3)}T12:00:00Z`);
let now = T0;
const env = (over: Partial<CatalogueAutoCheckEnv> = {}): CatalogueAutoCheckEnv => ({
  online: () => true, now: () => now, storage: () => localStorage, fetchImpl,
  restored: () => true, onInstall: subscribeCatalogue, ...over,
});
const manifestRequests = () => fetchImpl.seen.filter(r => r.url === `${CATALOGUE_BASE}manifest.json`).length;
/** A new page: module state reset, storage kept, App's restore run again. */
const reload = () => { resetCatalogueAutoCheckForTests(); restoreCatalogueOverlay(); };

beforeEach(async () => {
  localStorage.clear();
  setCatalogueOverlay(null);
  resetCatalogueAutoCheckForTests();
  now = T0;
  pub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, [...MOTOR_DB, added('auto-new')]);
  fetchImpl = catalogueFetch(manifestOf(pub), [pub]);
});
afterEach(() => { vi.restoreAllMocks(); setCatalogueOverlay(null); localStorage.clear(); });

describe('when it runs', () => {
  it('runs online: one manifest request and one motors file, installed and stored', async () => {
    expect(await startCatalogueAutoCheck(env())).toBe('checked');
    expect(fetchImpl.seen.map(r => r.url)).toEqual([`${CATALOGUE_BASE}manifest.json`, `${CATALOGUE_BASE}${pub.entry.motors.path}`]);
    expect(getCatalogue().some(m => m.motorId === 'auto-new')).toBe(true);
    expect(loadStoredOverlay()?.snapshot?.id).toBe(pub.id);
  });

  it('skips offline, with no request', async () => {
    expect(await startCatalogueAutoCheck(env({ online: () => false }))).toBe('offline');
    expect(fetchImpl.seen).toEqual([]);
    expect(getCatalogueOverlay()).toBeNull();
  });

  it('skips within six hours across a reload, and runs after six hours', async () => {
    await startCatalogueAutoCheck(env());
    expect(manifestRequests()).toBe(1);
    now = T0 + RECHECK_MIN_MS - 1;
    reload();
    expect(await startCatalogueAutoCheck(env())).toBe('recent');
    expect(manifestRequests()).toBe(1);
    now = T0 + RECHECK_MIN_MS;
    reload();
    expect(await startCatalogueAutoCheck(env())).toBe('checked');
    expect(manifestRequests()).toBe(2);
    // The same snapshot: the manifest alone, no second motors file.
    expect(fetchImpl.seen).toHaveLength(3);
  });

  it('treats a check date in the future as expired', async () => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(T0 + 86_400_000).toISOString(),
      liveCount: 0, added: [], changed: [], removed: [], rejected: [] }));
    reload();
    expect(await startCatalogueAutoCheck(env())).toBe('checked');
    expect(manifestRequests()).toBe(1);
    // Positive control: the same overlay dated an hour ago holds the check off.
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({ ...loadStoredOverlay()!, fetchedAt: new Date(T0 - 3_600_000).toISOString() }));
    reload();
    expect(await startCatalogueAutoCheck(env())).toBe('recent');
    expect(manifestRequests()).toBe(1);
  });

  it('does not run when storage cannot be written, and the button still can', async () => {
    const blocked = { setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); }, removeItem: () => {} };
    expect(await startCatalogueAutoCheck(env({ storage: () => blocked }))).toBe('no-storage');
    resetCatalogueAutoCheckForTests();
    expect(await startCatalogueAutoCheck(env({ storage: () => { throw new Error('SecurityError'); } }))).toBe('no-storage');
    expect(fetchImpl.seen).toEqual([]);
    await checkForCatalogueUpdates({ force: true, fetchImpl });
    expect(manifestRequests()).toBe(1);
  });

  it('a skip installs nothing: getCatalogue() is the same array before and after', async () => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(T0 - 60_000).toISOString(),
      liveCount: MOTOR_DB.length + 1, added: [added('kept')], changed: [], removed: [], rejected: [] }));
    reload();
    const before = getCatalogue();
    const installs = vi.fn();
    const stop = subscribeCatalogue(installs);
    expect(await startCatalogueAutoCheck(env())).toBe('recent');
    resetCatalogueAutoCheckForTests();
    expect(await startCatalogueAutoCheck(env({ online: () => false }))).toBe('offline');
    stop();
    expect(getCatalogue()).toBe(before);
    expect(installs).not.toHaveBeenCalled();
  });

  it('starts once per page', async () => {
    expect(await startCatalogueAutoCheck(env())).toBe('checked');
    expect(await startCatalogueAutoCheck(env())).toBe('already-started');
    expect(manifestRequests()).toBe(1);
  });
});

describe('order and failure', () => {
  it('waits for App\'s restore, so the restore cannot overwrite the check\'s result', async () => {
    let restored = false;
    const outcome = startCatalogueAutoCheck(env({ restored: () => restored }));
    await new Promise(r => setTimeout(r, 20));
    expect(fetchImpl.seen).toEqual([]);
    // App's mount effect: a restore that finds nothing stored installs null.
    restored = true;
    restoreCatalogueOverlay();
    expect(await outcome).toBe('checked');
    expect(getCatalogueOverlay()?.added.map(m => m.motorId)).toEqual(['auto-new']);
  });

  it('a failure writes one console.debug line, shows nothing, installs nothing, and never rejects', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const rejecting = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    process.on('unhandledRejection', unhandled);
    try {
      expect(await startCatalogueAutoCheck(env({ fetchImpl: rejecting }))).toBe('failed');
      await new Promise(r => setTimeout(r, 20));
    } finally {
      window.removeEventListener('unhandledrejection', unhandled);
      process.off('unhandledRejection', unhandled);
    }
    expect(rejecting).toHaveBeenCalledOnce();
    expect(debug).toHaveBeenCalledOnce();
    expect(String(debug.mock.calls[0]![0])).toMatch(/^MMRocket Sim: the automatic motor catalogue check did not complete: Could not reach catalogue\.mountainmanrockets\.com\.$/);
    expect(unhandled).not.toHaveBeenCalled();
    expect(getCatalogueOverlay()).toBeNull();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });
});

describe('beside the button and Discard', () => {
  /** The manifest held until `release`; the stub ignores aborts, so only the generation guard can stop a stale result. */
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('manifest.json')) await gate;
      return fetchImpl(input, { ...init, signal: undefined });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    return { impl, release };
  };

  it('a Discard during an automatic check: no install and no store afterwards', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { impl, release } = gated();
    const outcome = startCatalogueAutoCheck(env({ fetchImpl: impl }));
    await vi.waitFor(() => expect(impl).toHaveBeenCalledOnce());
    discardCatalogueOverlay();
    release();
    expect(await outcome).toBe('failed');
    expect(getCatalogueOverlay()).toBeNull();
    expect(localStorage.getItem(OVERLAY_KEY)).toBeNull();
  });

  it('a button press during an automatic check: one result, the button\'s, and no automatic notice', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { impl, release } = gated();
    const results = vi.fn();
    const stop = subscribeAutomaticCatalogueResult(results);
    const outcome = startCatalogueAutoCheck(env({ fetchImpl: impl }));
    await vi.waitFor(() => expect(impl).toHaveBeenCalledOnce());
    const buttonPub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.3`, [...MOTOR_DB, added('button-new')]);
    const button = await checkForCatalogueUpdates({ force: true, fetchImpl: catalogueFetch(manifestOf(buttonPub), [buttonPub]) });
    release();
    expect(await outcome).toBe('failed');
    stop();
    expect(button.overlay.added.map(m => m.motorId)).toEqual(['button-new']);
    expect(getCatalogueOverlay()?.added.map(m => m.motorId)).toEqual(['button-new']);
    expect(loadStoredOverlay()?.added.map(m => m.motorId)).toEqual(['button-new']);
    expect(results).not.toHaveBeenCalled();
  });

  it('tells its subscribers of a changed motor once: not again on a same-snapshot recheck or a newer snapshot repeating it', async () => {
    const shipped = MOTOR_DB.find(m => m.manufacturerAbbrev === 'Estes' && Number.isFinite(m.totImpulseNs))!;
    const rows = (bump: number) => MOTOR_DB.map(m => (m === shipped ? { ...m, totImpulseNs: m.totImpulseNs + bump } : m));
    pub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, rows(1));
    fetchImpl = catalogueFetch(manifestOf(pub), [pub]);
    const changedIds = vi.fn();
    const stop = subscribeAutomaticCatalogueResult(o => changedIds(o.changed.map(c => c.motorId)));
    await startCatalogueAutoCheck(env());
    now = T0 + RECHECK_MIN_MS;
    reload();
    await startCatalogueAutoCheck(env()); // the same snapshot
    const newer = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.3`, rows(1));
    fetchImpl = catalogueFetch(manifestOf(newer, [pub]), [pub, newer]);
    now += RECHECK_MIN_MS;
    reload();
    await startCatalogueAutoCheck(env()); // a newer snapshot, the same change
    const further = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.4`, rows(2));
    fetchImpl = catalogueFetch(manifestOf(further, [pub, newer]), [pub, newer, further]);
    now += RECHECK_MIN_MS;
    reload();
    await startCatalogueAutoCheck(env()); // the same motor changed again: new figures, told again
    stop();
    expect(changedIds.mock.calls.map(([ids]) => ids)).toEqual([[shipped.motorId], [], [], [shipped.motorId]]);
    expect(getCatalogueOverlay()?.changed.map(c => c.motorId)).toEqual([shipped.motorId]);
  });

  it('an automatic result reaches its subscribers (positive control for the above)', async () => {
    const results = vi.fn();
    const stop = subscribeAutomaticCatalogueResult(results);
    await startCatalogueAutoCheck(env());
    stop();
    expect(results).toHaveBeenCalledOnce();
    expect(results.mock.calls[0]![0].added.map((m: MotorDbEntry) => m.motorId)).toEqual(['auto-new']);
  });
});
