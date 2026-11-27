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
import { applyStageNozzles, motorMounts } from '../tree/treeModel.js';
import { applyConfigSwitchPlan, planConfigSwitch, planImport } from './importApply.js';
import { stageMotors, type StageMotors } from './nozzleFollow.js';
import { importCdx1 } from './rasaeroFile.js';
import { planHeadlessImport } from './simulateFile.js';
import { withFlownNozzles } from './flownNozzles.js';
import { loadNozzleDb, publishedExitSync } from './nozzleDb.js';

const here = dirname(fileURLToPath(import.meta.url));

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
 *
 * What App hands those units is App.nozzle.test.tsx's (audit 2026-09-22, row
 * 477), with App mounted: the seed to this switch, every tree off the undo
 * stack to the hook, the flown stages to the launch report and `hasNozzle` to
 * the stored-run guards. It was string matches over App.tsx at the foot of
 * this file.
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

  it('J23-N a different-motor null snapshot clears an old value and flies its own exit', async () => {
    await loadNozzleDb();
    // Genuine absence exercises automatic/null snapshots; fixture zeros now mean OFF.
    const imported = importCdx1(readFileSync(join(here, '__fixtures__/Complex.Two-Stage.CDX1'), 'utf8')
      .replace(/<(Sustainer|Booster[12])Nozzle(?:Diameter)?>0<\/\1Nozzle(?:Diameter)?>/g, ''));
    const { snapshot } = await planHeadlessImport(imported);
    const stage = snapshot.tree.components[0]!.id!;
    const oldTree = applyStageNozzles(snapshot.tree, { [stage]: 0.012345 });
    const mini = mount(oldTree, snapshot.mountMotors);
    await act(async () => { await Promise.resolve(); });
    const incoming = snapshot.savedConfigs.find(c => c.id !== snapshot.activeConfigId)!;
    expect(incoming.nozzles?.[stage]).toBeNull();
    const switchPlan = planConfigSwitch({ savedConfigs: snapshot.savedConfigs,
      activeConfigId: snapshot.activeConfigId, mountMotors: snapshot.mountMotors,
      unmatchedRefs: {}, tree: oldTree }, incoming, TEXT);
    await act(async () => applyConfigSwitchPlan(switchPlan, snapshot.savedConfigs, {
      seedNozzleFollow: mini.current.seed, history: mini.current.h, setMountMotors: mini.current.setMotors,
      setSavedConfigs: vi.fn(), setUnmatchedRefs: vi.fn(), setActiveConfigId: vi.fn(), setNote: vi.fn(),
    }));
    expect(exit(mini.current.h.treeRef.current, 0)).toBeUndefined();
    const loads = stageMotors(mini.current.h.treeRef.current, Object.entries(incoming.motors));
    const flown = withFlownNozzles(mini.current.h.treeRef.current, loads, publishedExitSync).tree;
    const motorId = loads.find(s => s.stageId === stage)!.motors[0]!.motorId;
    expect(exit(flown, 0)).toBeCloseTo(publishedExitSync(motorId)!, 12);
    expect(mini.current.cleared).toEqual({});
  });
});
