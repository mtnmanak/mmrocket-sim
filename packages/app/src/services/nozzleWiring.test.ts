// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { useNozzleFollow, type NozzleCleared, type NozzleLookup } from '../hooks/useNozzleFollow.js';
import { useTreeHistory, type TreeHistory } from '../hooks/useTreeHistory.js';
import { motorMounts } from '../tree/treeModel.js';
import { applyConfigSwitchPlan, planConfigSwitch, planImport } from './importApply.js';
import { stageMotors, type StageMotors } from './nozzleFollow.js';
import { importCdx1 } from './rasaeroFile.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, '../App.tsx'), 'utf8');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A CONFIGURATION SWITCH KEEPS THE NOZZLE THE CONFIGURATION STATES (audit
 * 2026-09-22). This file was regexes over App.tsx and stayed green while the
 * switch cleared it: the nozzle-follow record had never seen the new loadout,
 * so the effect took the switch for a motor swap. Measured by the audit on
 * `ThreeCarbYen-2018.CDX1`: switching to sim-2 deleted its stated 25.40 mm
 * sustainer exit under a false note ("was for M745-P"), and Save then dropped
 * it. Driven here through the units App runs — the history hook, the
 * nozzle-follow hook and the switch plan — on the real file.
 */
describe('a configuration switch keeps the nozzle the configuration states', () => {
  const TEXT = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };
  const IN = 0.0254;
  /** Catalogue-shaped records for every motor the file names; none has a published exit here. */
  const motor = (designation: string): MountMotor => ({
    label: `${designation}-P`,
    spec: {
      designation, diameter: 0.075, length: 0.6, cgX: 0.3, ejectionDelay: Infinity,
      times: [0, 1], thrusts: [0, 0], masses: [5, 2],
    },
    meta: { label: designation, manufacturer: 'CTI', motorId: `db-${designation}` },
    ignition: { event: 'automatic', delay: 0 },
  });
  const noPublished: NozzleLookup = async () => null;

  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  /** App's three pieces, and nothing else: the tree + history, the motors, the follow effect. */
  interface Mini {
    h: TreeHistory;
    setMotors: (m: Record<string, MountMotor>) => void;
    seed: (s: readonly StageMotors[]) => void;
    cleared: Record<string, NozzleCleared>;
  }
  function mount(tree: RocketTree, motors: Record<string, MountMotor>): { current: Mini } {
    const out = { current: undefined as unknown as Mini };
    function MiniApp() {
      const h = useTreeHistory(tree);
      const [m, setMotors] = useState(motors);
      const loadout = useMemo(() => {
        const ids = new Set(motorMounts(h.tree).map((n) => n.id));
        return stageMotors(h.tree, Object.entries(m).filter(([id]) => ids.has(id)));
      }, [h.tree, m]);
      const nf = useNozzleFollow({ loadout, treeRef: h.treeRef, writeTree: h.writeTree, lookup: noPublished });
      out.current = { h, setMotors, seed: nf.seed, cleared: nf.cleared };
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MiniApp)));
    return out;
  }

  /** ThreeCarbYen opened on sim-1, then switched to sim-2 through the plan App runs. */
  const openAndSwitch = async (seed: 'app' | 'none') => {
    const r = importCdx1(readFileSync(join(here, '__fixtures__/ThreeCarbYen-2018.CDX1'), 'utf8'));
    const resolved = {
      working: Object.fromEntries(Object.entries(r.motors)
        .map(([id, ref]) => [id, { motor: motor(ref.designation), note: '' }])),
      configs: Object.fromEntries(r.configs.filter((c) => c.id !== r.chosenConfigId).map((c) => [c.id,
        Object.fromEntries(Object.entries(c.motors).map(([id, ref]) => [id, motor(ref.designation)]))])),
    };
    const opened = planImport(r, resolved, { launch: DEFAULT_CONDITIONS, text: TEXT }).snapshot;
    const mini = mount(opened.tree, opened.mountMotors);
    await act(async () => { await Promise.resolve(); });
    const sim2 = opened.savedConfigs.find((c) => c.id === 'rasaero-sim-2') as SavedConfig;
    const plan = planConfigSwitch({
      savedConfigs: opened.savedConfigs, activeConfigId: opened.activeConfigId, mountMotors: opened.mountMotors,
      unmatchedRefs: {}, tree: mini.current.h.treeRef.current,
    }, sim2, TEXT);
    await act(async () => {
      applyConfigSwitchPlan(plan, opened.savedConfigs, {
        seedNozzleFollow: seed === 'app' ? mini.current.seed : () => {},
        history: mini.current.h, setMountMotors: mini.current.setMotors,
        setSavedConfigs: vi.fn(), setUnmatchedRefs: vi.fn(), setActiveConfigId: vi.fn(), setNote: vi.fn(),
      });
    });
    // The follow effect's lookups resolve over a few microtasks.
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
    return mini;
  };
  /** By position: each parse mints fresh `c<N>` ids. 0 = Sustainer, 1 = Booster. */
  const exit = (t: RocketTree, stage: number) => t.components[stage]!['nozzleExitDiameter'];
  const idOf = (t: RocketTree, stage: number) => t.components[stage]!.id!;

  it('keeps sim-2 stated exits (25.40 mm sustainer, 63.5 mm booster) with no "was for" note', async () => {
    const m = (await openAndSwitch('app')).current;
    expect(exit(m.h.treeRef.current, 0)).toBeCloseTo(1.0 * IN, 6);
    expect(exit(m.h.treeRef.current, 1)).toBeCloseTo(2.5 * IN, 6);
    expect(m.cleared).toEqual({});
  });

  it('(the defect, reproduced) without the seed the switch reads as a motor swap and clears them', async () => {
    const m = (await openAndSwitch('none')).current;
    const t = m.h.treeRef.current;
    expect(exit(t, 0)).toBeUndefined();
    expect(m.cleared[idOf(t, 0)]?.previousLabel).toBe('M745WC-P');
    // The booster's 63.5 mm, just written by the switch, goes too - "was for N2501".
    expect(exit(t, 1)).toBeUndefined();
    expect(m.cleared[idOf(t, 1)]?.previousLabel).toBe('N2501-WH-P');
  });
});

/**
 * WHAT APP HANDS THE NOZZLE-FOLLOW HOOK (audit 2026-09-22, from review). The
 * two tests above show the switch plan keeps the stated nozzle WHEN it is
 * given the hook's seed, and useNozzleFollow.test.tsx shows an undone state
 * gets the loaded motor's exit WHEN `onRestore` hands it to `restoring` — the
 * "(the defect, reproduced)" cases are what each looks like without. Neither
 * can see App do the handing, so it is held here until App renders in a test.
 */
describe('App wires the nozzle-follow hook into the switch and the history', () => {
  it('passes the hook’s seed to the configuration switch (audit row 279)', () => {
    const src = app();
    expect(src).toContain('cleared: nozzleCleared, seed: seedNozzleFollow, restoring: restoreNozzleFollow,');
    expect(src).toMatch(/applyConfigSwitchPlan\(plan, savedConfigs, \{\s+seedNozzleFollow,/);
  });

  it('hands every tree coming off the undo stack to the hook before it is written', () => {
    expect(app()).toMatch(/onRestore: \(t\) => \{\s+restoreNozzleFollow\(t\);\s+return spendSpentMarks\.current\(t\);/);
  });
});

/**
 * The two places App has to spend the nozzle exit diameter (2026-09-08), both
 * of which are absences that no other test in the suite can see.
 *
 * The check and the sentence are pure and tested in nozzleCheck.test.ts; the
 * report line is pure and tested in simReport.test.ts. What neither can prove
 * is that App still CALLS them — delete either call and every one of those
 * tests still passes while the user sees nothing. These stay source guards
 * until the notice list and the Launch path have units of their own to call
 * (audit 2026-09-22, the regex-test row): they are App wiring, not the
 * nozzle-follow bookkeeping, which is tested by behaviour above.
 */
describe('App surfaces the nozzle plausibility warning', () => {
  it('runs the check against the design and the motors actually loaded', () => {
    expect(app()).toContain('for (const w of nozzleOversize(tree, assigned)) {');
  });

  it('renders it through the notice channel, keyed per stage, as a warning', () => {
    const src = app();
    const start = src.indexOf('id: `nozzle-oversize:');
    expect(start, 'the notice entry is gone').toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).toContain('id: `nozzle-oversize:${w.stageId}`');
    expect(block).toContain("severity: 'warn'");
    expect(block).toContain('text: nozzleOversizeText(w, (m) =>');
  });

  /**
   * NOT dismissible, for the reason a build error is not: it is a standing
   * fact about the design on screen, so a x would be a button that does
   * nothing — the warning comes straight back on the next render.
   */
  it('offers no dismiss on it', () => {
    const src = app();
    const start = src.indexOf('id: `nozzle-oversize:');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).not.toContain('onDismiss');
  });

  it('re-runs when the design, the motors or the length unit change', () => {
    // The memo would otherwise hold a warning about a nozzle that has been
    // corrected, or print millimetres to someone who has switched to inches.
    expect(app()).toContain('tree, assigned, prefs.units.length]);');
  });
});

describe('App tells the launch report which stages flew a nozzle', () => {
  /**
   * MOTORISED, not merely nozzle-bearing (2026-09-08, review). The kernel's
   * own gate is `getThrust(t) > 0`, so a stage the flown configuration left
   * empty — a two-stage RASAero import whose booster motor is not in the
   * database is the common shape — bought exactly nothing, and the report
   * must not name it as corrected.
   */
  it('passes the names of the stages that flew a MOTOR into buildSimRun', () => {
    expect(app()).toContain('nozzleStages: motorisedStagesWithNozzle(tree, assigned).map((s) => s.name),');
  });

  /**
   * Names only. Whether the term was LIVE is decided inside the report from
   * the two model stamps, which are the kernel's own gate — App must not
   * second-guess it here, or the two answers can disagree.
   */
  it('does not gate the names on the aero model itself', () => {
    const src = app();
    const i = src.indexOf('nozzleStages: motorisedStagesWithNozzle(tree');
    const line = src.slice(i, src.indexOf('\n', i));
    expect(line).not.toContain('effectiveKbf');
    expect(line).not.toContain('usedSupersonic');
  });
});

/**
 * THE STORED-RUN GUARD (2026-09-08, review). `designKey`, `motorSetKey` and
 * `conditionsKey` all hash app-side state, so none of them can see a KERNEL
 * change: a run of a nozzle-bearing design flown before v0.119 certified as
 * "matches the design as it stands" while the new kernel re-flies it up to
 * +29.7 % higher, and an .ork export wrote its stale apogee as that
 * configuration's authoritative result. The predicate is pure and tested in
 * simReport.test.ts; what only this file can see is that App still FEEDS it.
 */
describe('App feeds the pressure-thrust provenance stamp', () => {
  it('tells both match keys whether the design spends the term', () => {
    // provenanceKey (the staleness banner) and currentMatchKey (Show charts).
    // ONE assembly since the 2026-09-22 audit: provenanceKey is built by
    // simReport's designMatchKeyOf, and currentMatchKey is that same key gated
    // on a rocket and a motor — so one feed reaches both, where there used to
    // be two to keep in step.
    const src = app();
    const hits = src.split('hasNozzle: motorisedStagesWithNozzle(tree, assigned).length > 0,').length - 1;
    expect(hits).toBe(1);
    expect(src).toContain('() => (built && primaryMountId ? provenanceKey : null),');
  });

  it('refuses an unstamped run in the .ork <flightdata> export too', () => {
    // Moved out of App.tsx on 2026-09-08 into services/orkFlightData.ts, which
    // is where it can finally be tested for BEHAVIOUR rather than for its own
    // source text — see orkFlightData.test.ts, "refuses a run with no
    // pressure-thrust stamp". What stays here is the wiring check: App must
    // still tell the pure rule whether this design HAS a nozzle, because a
    // `hasNozzle: false` passed by mistake would disable the guard silently.
    expect(app()).toContain('hasNozzle: stagesWithNozzle(tree).length > 0,');
    expect(readFileSync(join(here, 'orkFlightData.ts'), 'utf8')).toContain(
      'if (!runCarriesNozzleStamp(r, { hasNozzle, ...model })) continue;');
  });
});
