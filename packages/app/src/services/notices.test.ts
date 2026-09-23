import { describe, expect, it, vi } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { designNotices, type NoticeDismissers, type NoticeInput } from './notices.js';
import { impulseNote, repairSamples } from './thrustcurve.js';

/**
 * THE NOTICE LIST (audit 2026-09-22, row 501 — extraction #5 of 8 September).
 * Each branch of App's notice memo, asserted by what the list says: its id,
 * its severity, its words, and whether it offers a ×. While this lived in
 * App.tsx, App.session.test.tsx read two of its branches' words off a rendered
 * App (a failed save's file note, the run-cap note); everything else — every
 * severity, every ×, the other seven branches — was held by regexes over the
 * source or by nothing, and a regex passes on a wrong severity as long as the
 * text still matches. A severity here decides whether the bar opens itself
 * over the phone's tab bar.
 */

const spec = (designation: string, diameterMm: number, extra: object = {}): MotorSpec => ({
  designation, diameter: diameterMm / 1000, length: 0.3,
  times: [0, 1, 2], thrusts: [0, 100, 0], masses: [0.5, 0.3, 0.2],
  cgX: 0.15, ejectionDelay: 5, ...extra,
} as MotorSpec);

const mm = (s: MotorSpec): MountMotor => ({
  label: s.designation, spec: s, meta: { label: s.designation }, ignition: { event: 'automatic', delay: 0 },
});

/** One stage with `nozzleMm` typed on it (0 = none), one mount inside. */
const design = (nozzleMm = 0): RocketTree => ({
  name: 'Test',
  components: [{
    type: 'stage', id: 'sus', name: 'Sustainer',
    ...(nozzleMm > 0 ? { nozzleExitDiameter: nozzleMm / 1000 } : {}),
    children: [{
      type: 'bodytube', id: 'bt', length: 0.5,
      children: [{ type: 'innertube', id: 'mount', length: 0.2 } as ComponentNode],
    } as ComponentNode],
  } as ComponentNode],
});

const quiet = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  error: null,
  buildFailed: false,
  motorFailures: [],
  tree: design(),
  assigned: [],
  restoredByOlderBuild: false,
  timeStepMigrated: false,
  timeStepMigratedFrom: null,
  padMassNote: null,
  fileNote: null,
  runsCapped: { evicted: 0, unsaved: 0 },
  lengthText: (m) => `${Math.round(m * 1e5) / 100} mm`,
  ...over,
});

const dismissers = (): NoticeDismissers => ({
  simError: vi.fn(), staleSession: vi.fn(), timeStep: vi.fn(),
  padMassNote: vi.fn(), fileNote: vi.fn(), runsCapped: vi.fn(),
});

const one = (over: Partial<NoticeInput>, d = dismissers()) => {
  const out = designNotices(quiet(over), d);
  expect(out).toHaveLength(1);
  return out[0]!;
};

describe('designNotices', () => {
  it('says nothing about a design with nothing to say', () => {
    expect(designNotices(quiet(), dismissers())).toEqual([]);
  });

  describe('an error', () => {
    it('from the BUILD is an error with no × — it is a standing fact and would come straight back', () => {
      const n = one({ error: 'Unknown component type', buildFailed: true });
      expect(n).toMatchObject({ id: 'build-error', severity: 'error', text: 'Unknown component type' });
      expect(n.onDismiss).toBeUndefined();
    });

    it('from a FLIGHT is dismissible, and the × clears the simulation error', () => {
      const d = dismissers();
      const n = one({ error: 'simulation diverged', buildFailed: false }, d);
      expect(n).toMatchObject({ id: 'build-error', severity: 'error' });
      n.onDismiss!();
      expect(d.simError).toHaveBeenCalledOnce();
    });
  });

  it('warns once per refused motor, keyed by its mount, and never as an error', () => {
    const out = designNotices(quiet({
      motorFailures: [{ mountId: 'a', text: 'A: no curve' }, { mountId: 'b', text: 'B: no curve' }],
    }), dismissers());
    expect(out.map((n) => [n.id, n.severity, n.text])).toEqual([
      ['motor-failed:a', 'warn', 'A: no curve'],
      ['motor-failed:b', 'warn', 'B: no curve'],
    ]);
    expect(out.every((n) => n.onDismiss === undefined)).toBe(true);
  });

  describe('what a loaded motor\'s published curve needed', () => {
    it('says a curve was mended, naming the motor and every repair, as a warning', () => {
      const repaired = spec('L1115', 75, { curveRepairs: ['put samples back into time order', 'dropped 2 duplicate data points'] });
      const n = one({ assigned: [['mount', mm(repaired)]] });
      expect(n).toMatchObject({ id: 'curve-repair:mount', severity: 'warn' });
      expect(n.text).toBe('L1115: its published thrust curve needed repair before it could be flown'
        + ' (put samples back into time order; dropped 2 duplicate data points). This is a fault in the'
        + ' motor file, not in your design.');
      expect(n.onDismiss).toBeUndefined();
    });

    it('reads repairSamples\' own words as a repair', () => {
      // Two readings at one instant that disagree: the repair keeps both.
      const { repairs } = repairSamples([
        { time: 0, thrust: 0 }, { time: 0.5, thrust: 5 }, { time: 0.5, thrust: 6 }, { time: 1, thrust: 0 },
      ]);
      expect(repairs).toEqual(['separated 1 sample sharing t=0.5 s']);
      const n = one({ assigned: [['mount', mm(spec('F39', 24, { curveRepairs: repairs }))]] });
      expect(n.text).toBe('F39: its published thrust curve needed repair before it could be flown'
        + ' (separated 1 sample sharing t=0.5 s). This is a fault in the motor file, not in your design.');
    });

    /**
     * NOT A REPAIR (the guide pass of audit 2026-09-22). thrustcurve.ts appends
     * the impulse note — "the curve flown integrates N % off the certified
     * total" — to the same `curveRepairs` list, and the list was printed as
     * "<motor>: its published thrust curve needed repair before it could be
     * flown (The thrust curve flown for … ). This is a fault in the motor
     * file": a sentence inside another's brackets, claiming a repair nothing
     * made and a fault the note itself does not allege.
     */
    it('says an impulse that disagrees with the certification in its own words, not as a repair', () => {
      const note = impulseNote({ designation: 'J460T', totImpulseNs: 10 },
        [{ time: 0, thrust: 0 }, { time: 1, thrust: 20 }, { time: 2, thrust: 0 }])!;
      expect(note).toMatch(/^The thrust curve flown for J460T integrates to 20 N·s, \+100\.0 %/);
      const n = one({ assigned: [['mount', mm(spec('J460T', 54, { curveRepairs: [note] }))]] });
      expect(n).toMatchObject({ id: 'curve-impulse:mount', severity: 'warn', text: note });
      expect(n.text).not.toContain('needed repair');
      expect(n.text).not.toContain('fault in the motor file');
    });

    it('says each in its own words when a curve needed both', () => {
      const note = impulseNote({ designation: 'J460T', totImpulseNs: 10 },
        [{ time: 0, thrust: 0 }, { time: 1, thrust: 20 }, { time: 2, thrust: 0 }])!;
      const out = designNotices(quiet({
        assigned: [['mount', mm(spec('J460T', 54, { curveRepairs: ['put samples back into time order', note] }))]],
      }), dismissers());
      expect(out.map((n) => [n.id, n.text])).toEqual([
        ['curve-repair:mount', 'J460T: its published thrust curve needed repair before it could be flown'
          + ' (put samples back into time order). This is a fault in the motor file, not in your design.'],
        ['curve-impulse:mount', note],
      ]);
    });

    /**
     * Told apart by the note's own opening, not by the repairs' shape: every
     * repair repairSamples writes today starts lower-case, but a repair worded
     * some new way — capitalised, say — is still a repair, and must not lose
     * the sentence that says the curve was mended.
     */
    it('keeps a repair worded some new way a repair', () => {
      const n = one({ assigned: [['mount', mm(spec('F39', 24, { curveRepairs: ['Resampled the tail-off'] }))]] });
      expect(n).toMatchObject({ id: 'curve-repair:mount', severity: 'warn' });
      expect(n.text).toBe('F39: its published thrust curve needed repair before it could be flown'
        + ' (Resampled the tail-off). This is a fault in the motor file, not in your design.');
    });

    it('keys each motor\'s notices by its mount, so loading another does not make them new', () => {
      const repaired = (d: string) => mm(spec(d, 29, { curveRepairs: ['put samples back into time order'] }));
      const out = designNotices(quiet({ assigned: [['booster', repaired('H128')], ['sustainer', repaired('G80')]] }),
        dismissers());
      expect(out.map((n) => n.id)).toEqual(['curve-repair:booster', 'curve-repair:sustainer']);
    });
  });

  it('names a design restored from an older build as INFORMATION — the bar must not open for it', () => {
    const d = dismissers();
    const n = one({ restoredByOlderBuild: true }, d);
    expect(n.id).toBe('stale-session');
    // Every returning user after every release sees this; at `warn` the bar
    // opened itself on most loads, over the phone's tab bar.
    expect(n.severity).toBe('info');
    expect(n.text).toContain('restored from autosave and was read in by an earlier build');
    n.onDismiss!();
    expect(d.staleSession).toHaveBeenCalledOnce();
  });

  describe('the time-step migration', () => {
    it('names the replaced step when the panel can take it back', () => {
      const d = dismissers();
      const n = one({ timeStepMigrated: true, timeStepMigratedFrom: 0.01 }, d);
      expect(n).toMatchObject({ id: 'timestep-migrated', severity: 'info' });
      expect(n.text).toContain('it is now set to 0.05 s');
      expect(n.text).toContain('To get the old step back, type 0.01 into the Time step field in the Launch panel.');
      n.onDismiss!();
      expect(d.timeStep).toHaveBeenCalledOnce();
    });

    it('promises no number it cannot name', () => {
      const n = one({ timeStepMigrated: true, timeStepMigratedFrom: null });
      expect(n.text).not.toContain('To get the old step back');
      expect(n.text).toContain('takes a finer step, if you have a reason to pay for one.');
    });
  });

  it('carries the pad-mass note at its own severity, dismissible', () => {
    const d = dismissers();
    for (const severity of ['info', 'warn'] as const) {
      const n = one({ padMassNote: { text: 'moved', severity } }, d);
      expect(n).toMatchObject({ id: 'pad-mass-moved', severity, text: 'moved' });
      n.onDismiss!();
    }
    expect(d.padMassNote).toHaveBeenCalledTimes(2);
  });

  describe('a nozzle exit wider than the motors in its stage', () => {
    it('is checked against the design and the motors actually loaded, keyed per stage, as a warning', () => {
      const n = one({ tree: design(60), assigned: [['mount', mm(spec('H128', 29))]] });
      expect(n).toMatchObject({ id: 'nozzle-oversize:sus', severity: 'warn' });
      // In the caller's unit — the one part of the sentence that needs prefs.
      expect(n.text).toContain('Sustainer: the nozzle exit diameter is 60 mm, wider than the 29 mm casing');
    });

    it('offers no × — it is a standing fact about the design on screen', () => {
      expect(one({ tree: design(60), assigned: [['mount', mm(spec('H128', 29))]] }).onDismiss).toBeUndefined();
    });

    it('says nothing with no motor loaded, or with a plausible exit', () => {
      expect(designNotices(quiet({ tree: design(60) }), dismissers())).toEqual([]);
      expect(designNotices(quiet({ tree: design(20), assigned: [['mount', mm(spec('H128', 29))]] }), dismissers()))
        .toEqual([]);
    });
  });

  it('carries the file note at its own severity, and its × clears it', () => {
    const d = dismissers();
    const n = one({ fileNote: { text: 'Could not open that .ork file.', severity: 'error' } }, d);
    expect(n).toMatchObject({ id: 'file-note', severity: 'error', text: 'Could not open that .ork file.' });
    n.onDismiss!();
    expect(d.fileNote).toHaveBeenCalledOnce();
  });

  it('warns that the run cap removed saved runs, and says how to keep the rest', () => {
    const d = dismissers();
    const n = one({ runsCapped: { evicted: 1, unsaved: 0 } }, d);
    expect(n).toMatchObject({ id: 'runs-evicted', severity: 'warn' });
    expect(n.text).toBe('Saved simulations keeps the newest 500 runs, so the oldest 1 was removed to make room.'
      + ' Download the run table (Results) to keep a copy of the rest before more go.');
    n.onDismiss!();
    expect(d.runsCapped).toHaveBeenCalledOnce();
    expect(one({ runsCapped: { evicted: 0, unsaved: 3 } }).text).toContain('3 new runs did not fit');
  });

  /**
   * NoticeBar leads with the most serious notice and, among equals, the
   * newest; notices arriving together keep THIS order. So the order is part
   * of what the user sees first.
   */
  it('lists them in one fixed order', () => {
    const out = designNotices(quiet({
      error: 'e', buildFailed: true,
      motorFailures: [{ mountId: 'mount', text: 'refused' }],
      tree: design(60),
      assigned: [['mount', mm(spec('H128', 29, { curveRepairs: ['put samples back into time order'] }))]],
      restoredByOlderBuild: true,
      timeStepMigrated: true,
      padMassNote: { text: 'p', severity: 'info' },
      fileNote: { text: 'f', severity: 'info' },
      runsCapped: { evicted: 2, unsaved: 0 },
    }), dismissers());
    expect(out.map((n) => n.id)).toEqual([
      'build-error', 'motor-failed:mount', 'curve-repair:mount', 'stale-session', 'timestep-migrated',
      'pad-mass-moved', 'nozzle-oversize:sus', 'file-note', 'runs-evicted',
    ]);
  });
});
