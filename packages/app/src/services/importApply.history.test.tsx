// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../App.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../components/LaunchPanel.js';
import { useTreeHistory, type TreeHistory } from '../hooks/useTreeHistory.js';
import { designFingerprint, isDirty } from './dirtyState.js';
import {
  applyConfigSwitchPlan, applyImportPlan, importMark, planConfigSwitch, planImport, type ImportedDesign,
  type ImportSinks,
} from './importApply.js';

/**
 * AN OPEN AND A CONFIGURATION SWITCH START THE UNDO HISTORY OVER (audit
 * 2026-09-22). The stack holds the tree alone, and nothing ever cleared it:
 *
 *  - after an Open (or a share link) Ctrl+Z put the previous airframe back
 *    under the new file's launch conditions, measured mass and configurations,
 *    and Save wrote that hybrid;
 *  - after a configuration switch it put the previous configuration's nozzle,
 *    separations and deployments back under the new motors — measured on
 *    `38-54 2-stage.CDX1`, a K627 flying the M1350's 31.75 mm exit.
 *
 * Driven through the real history hook, with the plan-apply functions App
 * calls, so a Ctrl+Z here is the Ctrl+Z the user presses.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };

const motor = (designation: string): MountMotor => ({
  label: `${designation}-10`,
  spec: {
    designation, diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: 10,
    times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1],
  },
  meta: { label: designation, manufacturer: 'AeroTech', motorId: `db-${designation}` },
  ignition: { event: 'automatic', delay: 0 },
});

/** A two-stage design whose booster flies configuration A's 30 mm nozzle. */
const twoStage = (name = 'two'): RocketTree => ({
  name,
  components: [
    { type: 'stage', id: 's1', name: 'Sustainer', children: [
      { type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.03, thickness: 0.001, children: [
        { type: 'innertube', id: 'm1', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
      ] } as ComponentNode,
    ] } as ComponentNode,
    { type: 'stage', id: 's2', name: 'Booster', nozzleExitDiameter: 0.03, children: [
      { type: 'bodytube', id: 'b2', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
        { type: 'innertube', id: 'm2', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true } as ComponentNode,
      ] } as ComponentNode,
    ] } as ComponentNode,
  ],
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function renderHistory(initial: RocketTree): { current: TreeHistory } {
  const result = { current: undefined as unknown as TreeHistory };
  function Probe() {
    result.current = useTreeHistory(initial);
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return result;
}

const ctrlZ = () => act(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
});

const sinksWith = (history: TreeHistory): ImportSinks & Record<string, ReturnType<typeof vi.fn> | unknown> => ({
  history,
  setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(), setSavedConfigs: vi.fn(), setActiveConfigId: vi.fn(),
  setMaxMotorLen: vi.fn(), setLaunch: vi.fn(), setMeasured: vi.fn(), setMachAlt: vi.fn(), setNote: vi.fn(),
  setShroudPrompt: vi.fn(), markSaved: vi.fn(),
});

describe('an Open', () => {
  it('leaves nothing for Ctrl+Z to put back: the previous airframe stays gone', () => {
    const h = renderHistory(twoStage('mine'));
    // Real work on the previous design, so the stack has something on it.
    act(() => h.current.setTree({ ...h.current.treeRef.current, name: 'mine, edited' }));
    expect(h.current.canUndo).toBe(true);

    const imported: ImportedDesign = {
      name: 'theirs', tree: { name: 'theirs', components: [{ type: 'stage', id: 'o1', name: 'Sustainer' }] },
      notes: [], motors: {}, launch: { windAverage: 6 },
    };
    const plan = planImport(imported, { working: {}, configs: {} }, { launch: DEFAULT_CONDITIONS, text: TEXT });
    act(() => applyImportPlan(plan, sinksWith(h.current)));

    expect(h.current.tree.name).toBe('theirs');
    expect(h.current.canUndo).toBe(false);
    ctrlZ();
    expect(h.current.tree.name).toBe('theirs');
  });

  /**
   * Audit 2026-09-22 (the launchRef row). The mark merged the launch captured
   * when the open STARTED while the state kept the edit made during it, so a
   * wind typed while the file was opening left the new design reading unsaved.
   * Now App plans from the launch as it stands after the last await, and the
   * value written is the value marked.
   */
  it('writes and marks ONE launch: a wind typed during the open is kept and the design reads clean', () => {
    const h = renderHistory(twoStage());
    const typedDuringOpen: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 7 };
    const imported: ImportedDesign = { name: 'f', tree: twoStage('f'), notes: [], motors: {}, launch: { launchRodAngleDeg: 3 } };
    const plan = planImport(imported, { working: {}, configs: {} }, { launch: typedDuringOpen, text: TEXT });
    const sinks = sinksWith(h.current);
    act(() => applyImportPlan(plan, sinks));

    const written = (sinks.setLaunch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LaunchConditions;
    expect(written.windAverage).toBe(7);
    expect(written.launchRodAngleDeg).toBe(3);
    const mark = (sinks.markSaved as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(mark).toBe(importMark(plan));
    // The state App now holds — every field from what the sinks were handed.
    const held = {
      tree: h.current.tree,
      mountMotors: (sinks.setMountMotors as ReturnType<typeof vi.fn>).mock.calls[0]![0],
      launch: written,
      maxMotorLengthByStage: (sinks.setMaxMotorLen as ReturnType<typeof vi.fn>).mock.calls[0]![0],
      savedConfigs: (sinks.setSavedConfigs as ReturnType<typeof vi.fn>).mock.calls[0]![0],
      activeConfigId: (sinks.setActiveConfigId as ReturnType<typeof vi.fn>).mock.calls[0]![0],
      measured: (sinks.setMeasured as ReturnType<typeof vi.fn>).mock.calls[0]![0],
    };
    expect(isDirty(designFingerprint(held), mark, false)).toBe(false);
  });
});

describe('a configuration switch', () => {
  const A: SavedConfig = { id: 'A', name: 'A', isDefault: true, motors: { m1: motor('K1'), m2: motor('M1350') }, nozzles: { s2: 0.03 } };
  const B: SavedConfig = {
    id: 'B', name: 'B', isDefault: false, motors: { m1: motor('K1'), m2: motor('K627') },
    nozzles: { s2: 0.0254 }, separations: { s2: { separationEvent: 'ejection', separationDelay: 0 } },
  };

  it('leaves nothing for Ctrl+Z to put back: the previous configuration’s nozzle stays gone', () => {
    const h = renderHistory(twoStage());
    act(() => h.current.setTree({ ...h.current.treeRef.current, name: 'edited on A' }));
    const plan = planConfigSwitch({
      savedConfigs: [A, B], activeConfigId: 'A', mountMotors: A.motors, unmatchedRefs: {}, tree: h.current.treeRef.current,
    }, B, TEXT);
    act(() => applyConfigSwitchPlan(plan, [A, B], {
      seedNozzleFollow: vi.fn(), history: h.current, setSavedConfigs: vi.fn(), setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(),
      setActiveConfigId: vi.fn(), setNote: vi.fn(),
    }));
    expect(h.current.tree.components[1]!['nozzleExitDiameter']).toBe(0.0254);
    expect(h.current.canUndo).toBe(false);
    ctrlZ();
    // Before: A's 30 mm exit came back under B's K627.
    expect(h.current.tree.components[1]!['nozzleExitDiameter']).toBe(0.0254);
    expect(h.current.tree.name).toBe('edited on A');
  });

  it('still starts the history over when the switch changes nothing in the tree', () => {
    const C: SavedConfig = { id: 'C', name: 'C', isDefault: false, motors: { m1: motor('K1') } };
    const h = renderHistory(twoStage());
    act(() => h.current.setTree({ ...h.current.treeRef.current, name: 'edited' }));
    const plan = planConfigSwitch({
      savedConfigs: [A, C], activeConfigId: 'A', mountMotors: A.motors, unmatchedRefs: {}, tree: h.current.treeRef.current,
    }, C, TEXT);
    expect(plan.tree).toBe(h.current.treeRef.current);
    act(() => applyConfigSwitchPlan(plan, [A, C], {
      seedNozzleFollow: vi.fn(), history: h.current, setSavedConfigs: vi.fn(), setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(),
      setActiveConfigId: vi.fn(), setNote: vi.fn(),
    }));
    expect(h.current.canUndo).toBe(false);
  });

  it('writes the configurations only when the write-back changed them', () => {
    const h = renderHistory(twoStage());
    const configs = [A, B];
    const run = (working: Record<string, MountMotor>) => {
      const setSavedConfigs = vi.fn();
      const plan = planConfigSwitch({
        savedConfigs: configs, activeConfigId: 'A', mountMotors: working, unmatchedRefs: {}, tree: h.current.treeRef.current,
      }, B, TEXT);
      act(() => applyConfigSwitchPlan(plan, configs, {
        seedNozzleFollow: vi.fn(), history: h.current, setSavedConfigs, setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(),
        setActiveConfigId: vi.fn(), setNote: vi.fn(),
      }));
      return setSavedConfigs;
    };
    // The working set is already A's: identity, nothing written (the dirty-state contract).
    expect(run(A.motors)).not.toHaveBeenCalled();
    // A delay changed on A: A is written back before the switch.
    expect(run({ ...A.motors, m1: { ...A.motors['m1']!, label: 'K1-14' } })).toHaveBeenCalledTimes(1);
  });
});
