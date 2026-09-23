// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../components/LaunchPanel.js';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';
import {
  applyImportPlan, planImport, planNewDesign, type ImportedDesign, type ImportSinks,
} from './importApply.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, '../App.tsx'), 'utf8');

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
 * What stays a source guard is what has no unit to call: the ABSENCES. The
 * .rkt / .CDX1 exports are LOSSY (RockSim drops launch conditions, flight
 * configurations and the measured mass/CG; RASAero keeps launch but drops
 * configurations, measured and flight data), and a share link puts nothing on
 * disk — marking any of them would let the next Open discard precisely what
 * the file does not hold. An absence is invisible to every behavioural test.
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
    // The defect this closes: the old mark merged the launch from the render
    // that STARTED the open, so it described a wind nobody had on screen.
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

describe('only a full-fidelity save clears the unsaved-changes mark (App-only absences)', () => {
  it('names markSaved in exactly three places', () => {
    // onSaveOrk and startNewDesign call it; applyImported hands it to
    // applyImportPlan (tested above). Its own definition and comments do not
    // count.
    const code = app().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const refs = code.match(/\bmarkSaved\b(?! = \()/g) ?? [];
    expect(refs.length, 'a new markSaved site appeared — is it full fidelity?').toBe(3);
  });

  it('the .ork save marks only after a real write', () => {
    expect(app()).toContain("if (out.kind !== 'cancelled') markSaved(mark);");
  });

  it('the lossy exports do NOT mark', () => {
    const src = app();
    for (const fn of ['onSaveRkt', 'onSaveCdx1']) {
      const start = src.indexOf(`const ${fn} = async`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      // Body runs to the next top-level `const on...` declaration.
      const rest = src.slice(start + 10);
      const end = rest.search(/\n {2}const on[A-Z]/);
      const body = rest.slice(0, end === -1 ? 4000 : end);
      expect(body.includes('markSaved'), `${fn} must not clear the unsaved-changes mark`).toBe(false);
    }
  });

  it('copying a share link does NOT mark', () => {
    const src = app();
    const i = src.indexOf('await navigator.clipboard.writeText(url)');
    expect(i).toBeGreaterThan(-1);
    // The whole share-link builder, from the payload to the copy.
    const start = src.lastIndexOf('const frag = await encodeShareFragment', i);
    expect(src.slice(start, i + 400).includes('markSaved'),
      'copying a share link must not clear the unsaved-changes mark').toBe(false);
  });
});
