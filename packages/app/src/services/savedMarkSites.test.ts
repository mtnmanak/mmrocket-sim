// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../components/LaunchPanel.js';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';
import {
  applyImportPlan, planImport, planNewDesign, type ImportedDesign, type ImportSinks,
} from './importApply.js';

/**
 * WHICH actions are allowed to say "this design is saved", and that each one
 * marks the design it actually leaves on screen.
 *
 * `markSaved` clears the unsaved-changes guard, so every mark is a place the
 * Open prompt can be silenced. Three are correct:
 *
 *  - a .ork save        — the only format that round-trips everything
 *  - an import          — the design now IS the file on disk
 *  - New                — an empty design is not work anybody would mind losing
 *
 * BEHAVIOUR FIRST (audit 2026-09-22). This file used to be regexes over
 * App.tsx, and a regex stays green while a mark describes a different design
 * from the one on screen. The import and New marks are now taken inside
 * services/importApply.ts from the same plan App writes, so they are tested
 * here by what they DO: apply the plan, rebuild the state App would hold from
 * what it was handed, and check that state reads clean.
 *
 * What App decides is App.save.test.tsx's (audit 2026-09-22, row 477), with
 * App mounted: that only a .ork save, an open and ✕ New clear the unsaved-work
 * guard — every other Save As / Export entry and the share link pressed, the
 * lossy .rkt / .CDX1 among them — and App's hand-offs to the units here. They
 * were source guards over App.tsx in this file, including a count of
 * `markSaved` sites; a regex stays green while the behaviour it names is wrong.
 */

const TEXT = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };

const motor = (designation: string): MountMotor => ({
  label: `${designation}-P`,
  spec: {
    designation, diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: Infinity,
    times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1],
  },
  meta: { label: designation, manufacturer: 'AeroTech', motorId: `db-${designation}` },
  ignition: { event: 'automatic', delay: 0 },
});

const design = (): RocketTree => ({
  name: 'Rocket',
  components: [{ type: 'stage', id: 'st', name: 'Sustainer', children: [
    { type: 'bodytube', id: 'bt', length: 0.5, outerRadius: 0.03, thickness: 0.001, children: [
      { type: 'innertube', id: 'mmt', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true },
    ] },
  ] }],
});

/** App's writers, recorded — and a stand-in for the history hook's reset. */
function recordingSinks(): { sinks: ImportSinks; held: () => DesignSnapshot; mark: () => string } {
  const got: Partial<DesignSnapshot> = {};
  let mark = '';
  const sinks: ImportSinks = {
    history: { reset: (t?: RocketTree) => { if (t) got.tree = t; } },
    setMountMotors: (v) => { got.mountMotors = v; },
    setUnmatchedRefs: () => {},
    setSavedConfigs: (v) => { got.savedConfigs = v; },
    setActiveConfigId: (v) => { got.activeConfigId = v; },
    setMaxMotorLen: (v) => { got.maxMotorLengthByStage = v; },
    setLaunch: (v) => { got.launch = v; },
    setMeasured: (v) => { got.measured = v; },
    setMachAlt: () => {},
    setNote: () => {},
    setShroudPrompt: () => {},
    markSaved: (m) => { mark = m; },
  };
  return { sinks, held: () => got as DesignSnapshot, mark: () => mark };
}

describe('an import marks the design it leaves on screen', () => {
  it('reads clean straight after the open, plugged motor and file launch included', () => {
    const imported: ImportedDesign = {
      name: 'Rocket', tree: design(), notes: [],
      motors: { mmt: { designation: 'H100', manufacturer: 'AeroTech', diameter: 0.029, length: 0.2, delay: Infinity } },
      launch: { windAverage: 5, timeStepS: 0.02 }, measured: { massKg: 0.9, cgM: 0.31 },
    };
    const plan = planImport(imported, { working: { mmt: { motor: motor('H100'), note: '' } }, configs: {} },
      { launch: DEFAULT_CONDITIONS, text: TEXT });
    const rec = recordingSinks();
    applyImportPlan(plan, rec.sinks);
    expect(rec.mark()).not.toBe('');
    expect(isDirty(designFingerprint(rec.held()), rec.mark(), false)).toBe(false);
  });

  it('marks the launch it wrote, not one captured before the open', () => {
    const before: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 0 };
    const typedDuringOpen: LaunchConditions = { ...before, windAverage: 8 };
    const imported: ImportedDesign = { name: 'f', tree: design(), notes: [], motors: {} };
    const plan = planImport(imported, { working: {}, configs: {} }, { launch: typedDuringOpen, text: TEXT });
    const rec = recordingSinks();
    applyImportPlan(plan, rec.sinks);
    expect(rec.held().launch.windAverage).toBe(8);
    expect(isDirty(designFingerprint(rec.held()), rec.mark(), false)).toBe(false);
    // The mark describes the wind handed in, not another: a mark over the
    // launch the open STARTED under would read dirty against this one. This
    // half is the plan's (one merge, marked from the object it writes); the
    // other half — that App hands in the mirror's launch after its last await,
    // not the render's — is App.save.test.tsx's, a wind typed while a file opens.
    expect(designFingerprint({ ...rec.held(), launch: { ...before, timeStepS: undefined } })).not.toBe(rec.mark());
  });
});

describe('✕ New marks the empty design it writes', () => {
  it('reads clean, however many times it is pressed', () => {
    const measured = { massKg: null, cgM: null };
    for (let i = 0; i < 3; i++) {
      const { snapshot, mark } = planNewDesign({ launch: DEFAULT_CONDITIONS, measured });
      // The tree it hands back is the one it marked: one emptyTree(), not two.
      expect(isDirty(designFingerprint(snapshot), mark, false)).toBe(false);
    }
  });
});
