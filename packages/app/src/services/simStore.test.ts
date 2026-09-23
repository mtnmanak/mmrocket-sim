// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addRun, addRuns, clearRuns, deleteRun, loadRuns, persistFailed, restoreRun, runsToCsv, runsToTable,
} from './simStore.js';
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

describe('restoreRun — the ✕\'s Undo (audit 2026-09-22)', () => {
  const ids = () => loadRuns().map((r) => r.id);

  it('puts a run back above the one that sat below it — flights added since stay on top', () => {
    addRuns([mkRun('a'), mkRun('b'), mkRun('c')]);
    const b = loadRuns()[1]!;
    deleteRun('b');
    addRun(mkRun('new'));
    expect(restoreRun(b, 'c').map((r) => r.id)).toEqual(['new', 'a', 'b', 'c']);
    expect(ids()).toEqual(['new', 'a', 'b', 'c']);
  });

  it('the bottom row goes back to the bottom', () => {
    addRuns([mkRun('a'), mkRun('b')]);
    const b = loadRuns()[1]!;
    deleteRun('b');
    expect(restoreRun(b, null).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('with its neighbour gone too, it goes back by its own time', () => {
    addRuns([mkRun('a', { when: 3 }), mkRun('b', { when: 2 }), mkRun('c', { when: 1 }), mkRun('z', { when: 0 })]);
    const b = loadRuns()[1]!;
    deleteRun('b');
    deleteRun('c');
    addRun(mkRun('d', { when: 4 }));
    expect(restoreRun(b, 'c').map((r) => r.id)).toEqual(['d', 'a', 'b', 'z']);
    expect(ids()).toEqual(['d', 'a', 'b', 'z']);
  });

  it('never doubles a run that is already there', () => {
    addRuns([mkRun('a'), mkRun('b')]);
    const a = loadRuns()[0]!;
    expect(restoreRun(a, 'b').map((r) => r.id)).toEqual(['a', 'b']);
  });
});

const KEY = 'online-openrocket.sim-runs.v1';

describe('a corrupt history costs ONE row, not the store (net-storage-6)', () => {
  it('keeps every usable run and drops only the elements that are not runs', () => {
    localStorage.setItem(KEY, JSON.stringify([
      mkRun('good'),
      null,
      {},                      // no id — cannot be shown, selected or deleted
      'not a run',
      [1, 2],
      { id: 42, when: 1 },     // an id, but not a string one
      mkRun('alsoGood'),
    ]));
    expect(loadRuns().map((r) => r.id)).toEqual(['good', 'alsoGood']);
  });

  it('THE DATA LOSS: the next saved flight no longer overwrites the whole history', () => {
    // Before the fix the unguarded revive loop threw a TypeError on the null,
    // the catch returned [], and addRun's `[run, ...loadRuns()]` persisted just
    // the fresh run over everything — silently, with persistFailed() false.
    localStorage.setItem(KEY, JSON.stringify([mkRun('a'), null, mkRun('b')]));
    expect(addRun(mkRun('fresh')).map((r) => r.id)).toEqual(['fresh', 'a', 'b']);
    expect(loadRuns().map((r) => r.id)).toEqual(['fresh', 'a', 'b']);
    expect(persistFailed()).toBe(false);
  });

  it('a row with unusable FIELD values is kept — dropping it would be the same over-reaction', () => {
    const bent = { ...mkRun('bent'), when: 'yesterday', maxAltitude: 'high' };
    localStorage.setItem(KEY, JSON.stringify([bent, mkRun('ok')]));
    expect(loadRuns().map((r) => r.id)).toEqual(['bent', 'ok']);
  });

  it('normalises an array-typed field whose shape is wrong', () => {
    // `?? []` does not catch a value of the wrong SHAPE: a string survives it
    // and throws on .map/.find/.join instead, inside a click handler.
    localStorage.setItem(KEY, JSON.stringify([{
      ...mkRun('x'), deployments: 'nope', boosterMotors: 7, simWarnings: {}, branches: 'no',
    }]));
    const r = loadRuns()[0]!;
    expect(r.deployments).toBeUndefined();
    expect(r.boosterMotors).toBeUndefined();
    expect(r.simWarnings).toBeUndefined();
    expect(r.branches).toBeUndefined();
    expect(() => runsToCsv(loadRuns())).not.toThrow();
  });

  it('still revives plugged delays on the rows it keeps', () => {
    localStorage.setItem(KEY, JSON.stringify([null, { ...mkRun('p'), delayS: 'Infinity' }]));
    expect(loadRuns()[0]!.delayS).toBe(Infinity);
  });

  it('a payload that is not an array at all is still nothing', () => {
    localStorage.setItem(KEY, JSON.stringify({ id: 'a' }));
    expect(loadRuns()).toEqual([]);
    localStorage.setItem(KEY, 'not json');
    expect(loadRuns()).toEqual([]);
  });
});

describe('one corrupt timestamp must not kill BOTH exports (net-storage-4)', () => {
  const dateCell = (r: SimRun): string | number => {
    const { headers, rows } = runsToTable([r]);
    return rows[0]![headers.indexOf('Date')]!;
  };

  it('a good run still exports its ISO date', () => {
    expect(dateCell(mkRun('a'))).toBe(new Date(1755000000000).toISOString());
  });

  // toISOString() throws RangeError on an Invalid Date, and neither export
  // handler has a try/catch — so one bad row made both buttons silent no-ops
  // for the whole table until the user pressed "Clear all".
  const bad: [string, unknown][] = [
    ['absent', undefined],
    ['a string', 'yesterday'],
    ['finite but past the Date range', 1e16], // Number.isFinite alone lets this through
    ['NaN', NaN],
    ['null', null],
  ];
  for (const [label, when] of bad) {
    it(`degrades to an empty cell, and still exports, when \`when\` is ${label}`, () => {
      const r = { ...mkRun('bad'), when } as unknown as SimRun;
      expect(dateCell(r)).toBe('');
      expect(() => runsToCsv([r])).not.toThrow();
      expect(() => runsToTable([r])).not.toThrow();
    });
  }

  it('one bad row does not cost the good rows their export', () => {
    const rows = [mkRun('a'), { ...mkRun('b'), when: 'nope' } as unknown as SimRun, mkRun('c')];
    const csv = runsToCsv(rows);
    expect(csv.split('\n')).toHaveLength(4); // header + three rows
    expect(csv).toContain(new Date(1755000000000).toISOString());
  });
});

/**
 * THE LEAD COLUMNS SAY "MISSING" THE WAY THE DETAIL COLUMNS DO (audit
 * 2026-09-22). `null * k` is 0, so a refused-motor flight — maxAcceleration
 * null — exported "Accel 0" beside a blank m/s² column. Apogee and velocity
 * used the same unguarded product.
 */
describe('the flight-day lead columns', () => {
  const cell = (r: SimRun, header: string): string | number => {
    const { headers, rows } = runsToTable([r]);
    return rows[0]![headers.indexOf(header)]!;
  };

  it('are blank, not 0, when the run has no figure', () => {
    const r = { ...mkRun('refused'), maxAltitude: null, maxVelocity: null, maxAcceleration: null } as unknown as SimRun;
    expect(cell(r, 'Accel (Gs)')).toBe('');
    expect(cell(r, 'Apogee (ft)')).toBe('');
    expect(cell(r, 'Velocity (mph)')).toBe('');
    // ...exactly as the detail column already was.
    expect(cell(r, 'Max acceleration (m/s2)')).toBe('');
  });

  it('still convert a real figure, and a real zero', () => {
    const r = mkRun('ok', { maxAltitude: 300, maxVelocity: 100, maxAcceleration: 9.80665 * 12 });
    expect(cell(r, 'Apogee (ft)')).toBe(984);
    expect(cell(r, 'Velocity (mph)')).toBe(223.7);
    expect(cell(r, 'Accel (Gs)')).toBe(12);
    expect(cell(mkRun('flat', { maxAcceleration: 0 }), 'Accel (Gs)')).toBe(0);
  });
});

/**
 * A STORED RECOVERY WEIGHT FROM THE WRONG INSTANT (audit 2026-09-22 review).
 * Runs saved before `burnoutMassSettled` hold the mass at the FIRST burnout —
 * on a flight with more than one motor mount, possibly the whole stack
 * (154.3 g stored for a sustainer landing at 81.3 g). The series is not
 * stored, so it cannot be re-read: it is blanked, and only where it can
 * differ.
 */
describe('a stored run’s recovery weight', () => {
  const stored = (runs: object[]): SimRun[] => {
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify(runs));
    return loadRuns();
  };
  const weight = (r: SimRun, header = 'Recovery Weight (g)') => {
    const { headers, rows } = runsToTable([r]);
    return rows[0]![headers.indexOf(header)];
  };

  it('is blanked on an unstamped run that flew a second mount or a booster branch', () => {
    const [staged, multiMount] = stored([
      mkRun('staged', { burnoutMass: 0.1543, boosterMotors: ['C6'], branches: [{} as never] }),
      mkRun('outboard', { burnoutMass: 0.1543, boosterMotors: ['C6'] }),
    ]);
    expect(staged!.burnoutMass).toBeNull();
    expect(multiMount!.burnoutMass).toBeNull();
    expect(weight(staged!)).toBe('');
    expect(weight(staged!, 'Recovery weight (kg)')).toBe('');
  });

  it('is kept on an unstamped single-mount run — the first burnout is the last', () => {
    const [single] = stored([mkRun('single', { burnoutMass: 0.04 })]);
    expect(single!.burnoutMass).toBe(0.04);
    expect(weight(single!)).toBe(40);
  });

  it('is kept on a stamped run, staged or not', () => {
    const [staged] = stored([
      mkRun('new', { burnoutMass: 0.0813, burnoutMassSettled: true, boosterMotors: ['C6'] }),
    ]);
    expect(staged!.burnoutMass).toBe(0.0813);
    expect(weight(staged!, 'Recovery weight (kg)')).toBe(0.0813);
  });

  it('heads its detail column "Recovery weight", not "Burnout mass" beside "Time to burnout"', () => {
    const { headers } = runsToTable([mkRun('a')]);
    expect(headers).toContain('Recovery weight (kg)');
    expect(headers.some((h) => /burnout mass/i.test(h))).toBe(false);
  });
});
