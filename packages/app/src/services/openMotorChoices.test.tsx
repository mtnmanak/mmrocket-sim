// @vitest-environment happy-dom
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { useTreeHistory } from '../hooks/useTreeHistory.js';
import { designFingerprint, type DesignSnapshot } from './dirtyState.js';
import { findDbMotor, type MotorDbEntry } from './motorDb.js';
import { matchImportedMotor } from './motorMatch.js';
import { parseEng } from './exMotors.js';
import { resolveImportMotors, type ImportedDesign } from './importApply.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { acceptedOtherMakerNotes, applyOpenMotorChoices, collectOpenMotorIdentities, commitOpenMotorChoices, type OpenMotorState } from './openMotorChoices.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fetchSpec = vi.fn(async (row: MotorDbEntry, delay: number): Promise<MotorSpec> => ({
  designation: row.designation, diameter: row.diameter / 1000, length: row.length / 1000,
  times: [0, 1], thrusts: [0, 1], masses: [0.1, 0.05], cgX: 0.05, ejectionDelay: delay,
}));
const ref = { manufacturer: 'Enerjet', designation: 'F67', diameter: 0.0286, length: 0.127,
  delay: 6, digest: 'file-digest', motorType: 'single', ignitionEvent: 'burnout', ignitionDelay: 1.5 };

async function fixture() {
  const imported: ImportedDesign = {
    name: 'Two mounts', tree: { components: [] }, notes: ['Keep this unrelated warning.'],
    chosenConfigId: 'a', motors: { m: ref, n: ref },
    configs: [
      { id: 'a', name: 'First', isDefault: true, motors: { m: ref, n: ref } },
      { id: 'b', name: 'Second', isDefault: false, motors: { m: { ...ref, delay: 9 } } },
      { id: 'c', name: 'Other maker', isDefault: false, motors: { m: { ...ref, manufacturer: 'AeroTech', designation: 'F67C' } } },
    ],
  };
  const resolved = await resolveImportMotors(imported, r => matchImportedMotor(r, { fetchSpec, exMotors: [] }));
  const snapshot: DesignSnapshot = {
    tree: imported.tree, launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, activeConfigId: 'a',
    mountMotors: Object.fromEntries(Object.entries(resolved.working).map(([id, result]) => [id, result.motor!])),
    savedConfigs: imported.configs!.map(c => ({ ...c, motors: Object.fromEntries(
      Object.entries(c.id === 'a' ? resolved.working : resolved.configResults![c.id]!).map(([id, result]) => [id, result.motor!])) })),
  };
  const state = { mountMotors: snapshot.mountMotors, savedConfigs: snapshot.savedConfigs, unmatchedRefs: {} };
  return { imported, resolved, snapshot, state, groups: collectOpenMotorIdentities(imported, resolved, snapshot) };
}

describe('ask at open choices', () => {
  it('groups only another-maker evidence, with all mounts/configurations and the actual rivals', async () => {
    const { groups, imported, resolved, snapshot } = await fixture();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.locations).toHaveLength(3);
    expect(groups[0]!.carriedBy.join(' ')).toContain('First');
    expect(groups[0]!.carriedBy.join(' ')).toContain('Second');
    expect(groups[0]!.candidates.map(m => m.designation)).toEqual(expect.arrayContaining(['F67C', 'F67W']));
    const unchanged = { ...resolved.working.m!, otherMaker: undefined };
    expect(collectOpenMotorIdentities({ ...imported, configs: [] }, { working: { m: unchanged }, configs: {} }, snapshot)).toEqual([]);
    const quiet = acceptedOtherMakerNotes({ ...resolved, working: { ...resolved.working, other: unchanged } });
    expect(quiet.working.m!.openNote).toBeUndefined();
    expect(quiet.working.other).toBe(unchanged);
    expect(resolved.working.m!.openNote).toBeDefined();
  });

  it.each([
    ['AeroTech', 'G80NBT'], ['Cesaroni Technology Inc.', 'H123-SK'], ['unknown', 'H55'],
  ])('does not ask for the other unconfirmed kind: %s %s', async (manufacturer, designation) => {
    const result = await matchImportedMotor({ ...ref, manufacturer, designation, diameter: 0 }, { fetchSpec, exMotors: [] });
    expect(result.motor).toBeDefined();
    expect(result.openNote).toBeDefined();
    expect(result.otherMaker).toBeUndefined();
  });

  it('replaces every occurrence, keeps offered delay and ignition, defaults unavailable delay, and preserves file identity', async () => {
    const { state, groups, snapshot } = await fixture();
    const row = { ...groups[0]!.candidates.find(m => m.designation === 'F67W')!, delays: '4,6' };
    const next = await applyOpenMotorChoices(state, 'a', groups, { [groups[0]!.key]: { kind: 'catalogue', motor: row } }, fetchSpec);
    for (const motor of [next.mountMotors.m!, next.mountMotors.n!, next.savedConfigs[0]!.motors.m!, next.savedConfigs[1]!.motors.m!]) {
      expect(motor.meta.motorId).toBe(row.motorId);
      expect(motor.openNote).toBeUndefined();
      expect(motor.spec.ejectionDelay).toBe(6);
      expect(motor.ignition).toEqual({ event: 'burnout', delay: 1.5 });
      expect(motor.meta.orkManufacturer).toBeUndefined();
      expect(motor.meta.orkDigest).toBe('file-digest');
      expect(motor.meta.orkType).toBe('single');
    }
    expect(next.savedConfigs[2]!.motors).toEqual(state.savedConfigs[2]!.motors);
    expect(state.mountMotors.m!.openNote).toBeDefined();
    expect(designFingerprint({ ...snapshot, ...next })).not.toBe(designFingerprint(snapshot));
  });

  it('accepting the default clears the note; empty removes every occurrence without touching another identity', async () => {
    const { state, groups } = await fixture();
    const group = groups[0]!;
    const kept = await applyOpenMotorChoices(state, 'a', groups, { [group.key]: { kind: 'catalogue', motor: group.candidates[0]! } }, fetchSpec);
    expect(kept.mountMotors.m!.meta.motorId).toBe(state.mountMotors.m!.meta.motorId);
    expect(kept.mountMotors.m!.openNote).toBeUndefined();
    const empty = await applyOpenMotorChoices(state, 'a', groups, { [group.key]: { kind: 'empty' } }, fetchSpec);
    expect(empty.mountMotors).toEqual({});
    expect(empty.savedConfigs.slice(0, 2).map(c => c.motors)).toEqual([{}, {}]);
    expect(empty.savedConfigs[2]!.motors).toEqual(state.savedConfigs[2]!.motors);
  });

  it('loads the imported EX curve and captured definition at each mount delay without fetching', async () => {
    const { state, groups } = await fixture();
    const ex = parseEng('F67 28.6 127 6 0.043 0.112 Enerjet\n0 0\n0.1 80\n1 0')[0]!;
    fetchSpec.mockClear();
    const next = await applyOpenMotorChoices(state, 'a', groups, { [groups[0]!.key]: { kind: 'ex', motor: ex } }, fetchSpec);
    expect(fetchSpec).not.toHaveBeenCalled();
    expect(next.mountMotors.m!.meta.exMotorId).toBe(ex.motorId);
    expect(next.mountMotors.m!.meta.orkManufacturer).toBe('Enerjet');
    expect(next.savedConfigs[1]!.motors.m!.spec.ejectionDelay).toBe(9);
    expect(next.savedConfigs[1]!.motors.m!.openNote).toBeUndefined();
  });

  it('handles a configuration-less open and rejects a failed curve without modifying the original', async () => {
    const { state, groups } = await fixture();
    const group = { ...groups[0]!, locations: [{ configId: null, mountId: 'm', ref }] };
    const empty = await applyOpenMotorChoices(state, null, [group], { [group.key]: { kind: 'empty' } });
    expect(empty.mountMotors.m).toBeUndefined();
    const fail = vi.fn(fetchSpec).mockImplementationOnce(fetchSpec).mockRejectedValueOnce(new Error('offline'));
    await expect(applyOpenMotorChoices(state, 'a', groups, { [group.key]: { kind: 'catalogue', motor: findDbMotor('F67W')! } }, fail)).rejects.toThrow('offline');
    expect(state.mountMotors.m!.openNote).toBeDefined();
  });

  it('clears unresolved references of the same identity so empty mounts stay empty on save', async () => {
    const { state, groups } = await fixture();
    const unresolved = { ...state, unmatchedRefs: { m: ref }, savedConfigs: state.savedConfigs.map(c => ({
      ...c, unmatchedRefs: { m: ref }, unmatched: ['F67'],
    })) };
    const next = await applyOpenMotorChoices(unresolved, 'a', groups, { [groups[0]!.key]: { kind: 'empty' } });
    expect(next.unmatchedRefs).toEqual({});
    expect(next.savedConfigs[0]!.unmatchedRefs).toEqual({});
    expect(next.savedConfigs[1]!.unmatched).toEqual([]);
    expect(next.savedConfigs[2]!.unmatchedRefs).toEqual({ m: ref });
    expect(unresolved.unmatchedRefs).toEqual({ m: ref });
  });

  it('commits one history step; undo restores all motors and notes, redo restores the answer', async () => {
    const { state, groups, snapshot } = await fixture();
    const next = await applyOpenMotorChoices(state, 'a', groups, { [groups[0]!.key]: { kind: 'empty' } });
    let current: OpenMotorState = state;
    let apply: () => void = () => {};
    let undo: () => void = () => {};
    let redo: () => void = () => {};
    let canUndo = false;
    function Harness() {
      const [value, setValue] = useState<OpenMotorState>(state);
      const revision = useRef<object>({});
      const history = useTreeHistory(snapshot.tree, {
        captureCompanion: () => ({ revision: revision.current, value }),
        restoreCompanion: old => {
          if (revision.current !== old.revision) { revision.current = old.revision; setValue(old.value); }
        },
      });
      current = value; undo = history.undo; redo = history.redo; canUndo = history.canUndo;
      apply = () => commitOpenMotorChoices(next, {
        commitStep: () => { history.commitStep(history.treeRef.current); revision.current = {}; },
        setMountMotors: mountMotors => setValue(prev => ({ ...prev, mountMotors })),
        setSavedConfigs: savedConfigs => setValue(prev => ({ ...prev, savedConfigs })),
        setUnmatchedRefs: unmatchedRefs => setValue(prev => ({ ...prev, unmatchedRefs })),
      });
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      act(() => root.render(<Harness />));
      act(() => apply());
      expect(current).toEqual(next);
      expect(canUndo).toBe(true);
      act(() => undo());
      expect(current).toEqual(state);
      expect(canUndo).toBe(false);
      act(() => redo());
      expect(current).toEqual(next);
    } finally { act(() => root.unmount()); }
  });
});
