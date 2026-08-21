// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRun, addRuns, clearRuns, deleteRun, loadRuns, persistFailed } from './simStore.js';
import type { SimRun } from './simReport.js';

/**
 * Store tests exercise the persistence round-trip, not simulation output —
 * the store never inspects most SimRun fields, so a cast partial is enough.
 */
const mkRun = (id: string, over: Partial<SimRun> = {}): SimRun =>
  ({
    id,
    when: 1755000000000,
    rocket: 'Alpha III',
    motor: 'C6',
    manufacturer: 'Estes',
    delayS: 5,
    maxAltitude: 300,
    ...over,
  }) as SimRun;

/**
 * Replace localStorage with one whose writes are refused, the way a full
 * origin refuses them — reads still hit the real store so loadRuns() keeps
 * returning the stored truth. Optionally jam removeItem too (blocked site
 * data, not quota: quota never refuses a removeItem).
 */
function jamWrites(opts: { removeToo?: boolean } = {}): void {
  const real = localStorage;
  const boom = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => real.getItem(k),
    setItem: boom,
    removeItem: opts.removeToo ? boom : (k: string) => real.removeItem(k),
  });
}

afterEach(() => {
  // Unstub FIRST so the reset below reaches the real store.
  vi.unstubAllGlobals();
  localStorage.clear();
  clearRuns(); // module-level failure flag survives between tests — reset it
});

describe('persist under quota — the table must not lie', () => {
  it('round-trips normally and reports no failure', () => {
    const out = addRun(mkRun('a'));
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(loadRuns().map((r) => r.id)).toEqual(['a']);
    expect(persistFailed()).toBe(false);
  });

  it('addRun on a refused write returns the STORED truth, not the wishful list', () => {
    addRun(mkRun('kept'));
    jamWrites();
    const out = addRun(mkRun('lost'));
    // Before the fix this returned ['lost', 'kept'] — a row that vanished on
    // reload. The store must answer with what localStorage actually holds.
    expect(out.map((r) => r.id)).toEqual(['kept']);
    expect(persistFailed()).toBe(true);
    vi.unstubAllGlobals();
    expect(loadRuns().map((r) => r.id)).toEqual(['kept']);
  });

  it('addRuns (batch) takes the same honest path', () => {
    addRun(mkRun('kept'));
    jamWrites();
    const out = addRuns([mkRun('b1'), mkRun('b2')]);
    expect(out.map((r) => r.id)).toEqual(['kept']);
    expect(persistFailed()).toBe(true);
  });

  it('a write that sticks clears the failure flag', () => {
    jamWrites();
    addRun(mkRun('lost'));
    expect(persistFailed()).toBe(true);
    vi.unstubAllGlobals();
    const out = addRun(mkRun('a'));
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(persistFailed()).toBe(false);
  });

  it('deleteRun on a refused write keeps the run visible (it IS still stored)', () => {
    addRuns([mkRun('a'), mkRun('b')]);
    jamWrites();
    const out = deleteRun('a');
    // The delete did not stick; showing it gone would un-delete on reload.
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(persistFailed()).toBe(true);
  });

  it('clearRuns succeeds even at quota — removeItem frees space, never needs it', () => {
    addRun(mkRun('a'));
    jamWrites(); // setItem refused, removeItem still real
    const out = clearRuns();
    expect(out).toEqual([]);
    expect(persistFailed()).toBe(false);
    vi.unstubAllGlobals();
    expect(loadRuns()).toEqual([]);
  });

  it('clearRuns with storage blocked outright reports the stored truth', () => {
    addRun(mkRun('a'));
    jamWrites({ removeToo: true });
    const out = clearRuns();
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(persistFailed()).toBe(true);
  });
});
