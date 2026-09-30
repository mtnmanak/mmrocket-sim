import { testResolution } from './autoDelay.testSupport.js';
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import {
  changedSinceRun, designMatchKeyOf, KERNEL_PHYSICS_CHANGED, PHYSICS_REVISION,
  physicsRevisionsFor, requiresPhysicsRevision, runCarriesPhysicsRevision, runMatchesDesign, type SimRun,
} from './simReport.js';
import { flightDataForExport, flownAutoDelays, type FlightDataForExportInput } from './orkFlightData.js';
import { addRun, loadRuns, runsToCsv, runsToTable } from './simStore.js';

const motor = {
  spec: { designation: 'C6', ejectionDelay: 5 }, meta: { autoDelay: true },
  ignition: { event: 'automatic', delay: 0 },
} as MountMotor;

const treeWith = (node: ComponentNode): RocketTree => ({
  components: [{ type: 'stage', children: [{ type: 'bodytube', children: [node] }] }],
});

describe('K9/K15 upgrade provenance', () => {
  it.each([
    { type: 'launchlug', position: { method: 'top', offset: 0.01 } },
    { type: 'railbutton', position: { method: 'top', offset: 0.01 } },
    { type: 'transition', foreShoulderThickness: 0.002 },
    { type: 'transition', aftShoulderThickness: 0.002, aftShoulderCapped: true },
  ] as ComponentNode[])('rejects an unstamped nested $type without changing any persisted key', (node) => {
    const tree = treeWith(node);
    const key = designMatchKeyOf({
      physicsKey: JSON.stringify(tree), assigned: [['mount', motor]], hardwareDeltaKg: 0,
      launch: DEFAULT_CONDITIONS, aeroMode: 'classic', effectiveKbf: false,
      autoSupersonic: false, hasNozzle: false,
      requiresPhysicsRevision: requiresPhysicsRevision(tree),
    });
    const stored = {
      delayResolution: testResolution([['mount', motor]], [5]),
      id: 'pre-release', when: 1, flightConfigId: 'A', rocket: 'Historical rocket',
      designKey: key.designKey, motorSetKey: key.motorSetKey, conditionsKey: key.conditionsKey,
      aeroModel: 'classic', rogersKbf: false, delayS: 5, recommendedDelayS: 5,
      maxAltitude: 123, comments: 'Historical safety report',
    } as SimRun;
    const input: FlightDataForExportInput = {
      runs: [stored], savedConfigs: [{ id: 'A', name: 'A', isDefault: true, motors: { mount: motor } }],
      activeConfigId: 'A', assigned: [['mount', motor]], mountIds: ['mount'],
      ...key, model: key, hasNozzle: false, motorSetKeyOf: () => key.motorSetKey,
      primaryMountOf: () => 'mount', hardwareDeltaKg: 0,
    };
    expect(requiresPhysicsRevision(tree)).toBe(true);
    expect(runMatchesDesign(stored, key)).toBe(false);
    expect(changedSinceRun(stored, key)).toEqual([KERNEL_PHYSICS_CHANGED]);
    expect(flightDataForExport(input)).toEqual({});
    expect(flownAutoDelays(input)).toEqual({});
    // Inactive configurations and designs with no configuration share the guard.
    expect(flownAutoDelays({ ...input, activeConfigId: 'B', assigned: [] })).toEqual({});
    expect(flightDataForExport({ ...input, activeConfigId: 'B', assigned: [] })).toEqual({});
    expect(flownAutoDelays({ ...input, activeConfigId: null, savedConfigs: [],
      runs: [{ ...stored, flightConfigId: undefined }] })).toEqual({});

    const fresh = { ...stored, id: 'new-launch', physicsRevision: PHYSICS_REVISION };
    expect(runMatchesDesign(fresh, key)).toBe(true);
    expect(changedSinceRun(fresh, key)).toEqual([]);
    expect(Object.keys(flightDataForExport({ ...input, runs: [fresh] }))).toEqual(['A']);
    expect(flownAutoDelays({ ...input, runs: [fresh] })).toEqual({ A: { mount: 5 } });
    const inactive = { ...input, runs: [fresh], activeConfigId: 'B', assigned: [] };
    expect(flownAutoDelays(inactive)).toEqual({ A: { mount: 5 } });
    expect(Object.keys(flightDataForExport(inactive))).toEqual(['A']);
    expect(flownAutoDelays({ ...input, activeConfigId: null, savedConfigs: [],
      runs: [{ ...fresh, flightConfigId: undefined }] })).toEqual({ '': { mount: 5 } });
    // Kernel changes apply to every aero model, including auto-resolved flights.
    for (const [aeroModel, rogersKbf] of [
      ['classic', false], ['classic', true], ['supersonic', false], ['auto-supersonic', false],
    ] as const) {
      const model = { ...key, aeroMode: aeroModel === 'classic' ? 'classic' as const : 'supersonic' as const,
        effectiveKbf: rogersKbf };
      const onModel = { ...stored, aeroModel, rogersKbf };
      expect(runMatchesDesign(onModel, model)).toBe(false);
      expect(changedSinceRun(onModel, model)).toEqual([KERNEL_PHYSICS_CHANGED]);
      expect(flightDataForExport({ ...input, model, runs: [onModel] })).toEqual({});
      expect(runMatchesDesign({ ...onModel, physicsRevision: PHYSICS_REVISION }, model)).toBe(true);
    }
    // A stale newest row cannot mask a qualifying flight further down history.
    expect(flownAutoDelays({ ...input, runs: [stored, fresh] })).toEqual({ A: { mount: 5 } });
    expect(Object.keys(flightDataForExport({ ...input, runs: [stored, fresh] }))).toEqual(['A']);
    for (const stamp of ['old-revision', '', null, 1, true]) {
      const bad = { ...stored, physicsRevision: stamp } as SimRun;
      expect(runMatchesDesign(bad, key)).toBe(false);
      expect(flightDataForExport({ ...input, runs: [bad] })).toEqual({});
      expect(flownAutoDelays({ ...input, runs: [bad] })).toEqual({});
    }

    // Loading and historical CSV export must never silently re-stamp or replace a report.
    localStorage.clear();
    addRun(stored);
    addRun(fresh);
    const restored = loadRuns();
    expect(restored[0]!.physicsRevision).toBe(PHYSICS_REVISION);
    expect(restored[1]).toEqual(stored);
    expect(runsToCsv([restored[1]!])).toContain('Historical safety report');
    expect(runsToCsv([restored[1]!])).toContain('123');
    // XLSX consumes this same table, with no simulation or provenance migration.
    expect(runsToTable([restored[1]!]).rows[0]).toContain('Historical safety report');
  });

  it.each([
    { type: 'protuberance' }, { type: 'fairing' }, { type: 'bodytube' },
    { type: 'transition' }, { type: 'transition', foreShoulderThickness: 0, aftShoulderThickness: 0 },
    { type: 'nosecone', shoulderThickness: 0.002 },
  ] as ComponentNode[])('keeps unaffected $type history reproducible', (node) => {
    const requires = requiresPhysicsRevision(treeWith(node));
    expect(requires).toBe(false);
    const key = { designKey: 'd', motorSetKey: 'm', conditionsKey: 'c',
      aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false,
      requiresPhysicsRevision: requires };
    const run = { ...key, aeroModel: 'classic', rogersKbf: false } as unknown as SimRun;
    expect(runMatchesDesign(run, key)).toBe(true);
    expect(changedSinceRun(run, key)).toEqual([]);
  });

  it('does not attribute an old batch row to the current tree without a design key', () => {
    expect(changedSinceRun({ conditionsKey: 'c' } as SimRun, {
      designKey: 'd', motorSetKey: 'm', conditionsKey: 'c', requiresPhysicsRevision: true,
      aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false,
    })).toBeNull();
  });
});

describe('ordered physics revision history', () => {
  it.each([
    [{ type: 'transition', aftShoulderThickness: 0.002 }, true],
    [{ type: 'launchlug' }, true],
    [{ type: 'railbutton' }, false],
    [{ type: 'protuberance' }, true],
  ] as [ComponentNode, boolean][])('v0.143 on %s only needs later applicable revisions', (node, accepted) => {
    const tree = treeWith(node);
    const key = designMatchKeyOf({ physicsKey: 'same', assigned: [['mount', motor]], hardwareDeltaKg: 0,
      launch: DEFAULT_CONDITIONS, aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false,
      hasNozzle: false, physicsRevisions: physicsRevisionsFor(tree) });
    const run = { ...key, id: 'old', physicsRevision: 'guide-clearance-transition-mass-v1',
      aeroModel: 'classic', rogersKbf: false, delayS: 5, recommendedDelayS: 5, flightConfigId: 'A', when: 1, maxAltitude: 100, comments: '' } as unknown as SimRun;
    const input: FlightDataForExportInput = { ...key, runs: [run], savedConfigs: [{ id: 'A', name: 'A', isDefault: true, motors: { mount: motor } }], activeConfigId: 'A',
      assigned: [['mount', motor]], mountIds: ['mount'], model: key, hasNozzle: false,
      motorSetKeyOf: () => key.motorSetKey, primaryMountOf: () => 'mount', hardwareDeltaKg: 0 };
    expect(runMatchesDesign(run, key)).toBe(accepted);
    expect(changedSinceRun(run, key)).toEqual(accepted ? [] : [KERNEL_PHYSICS_CHANGED]);
    expect(Object.keys(flightDataForExport(input)).length > 0).toBe(accepted);
    expect(Object.keys(flownAutoDelays(input)).length > 0).toBe(accepted);
    expect(runCarriesPhysicsRevision({ physicsRevision: PHYSICS_REVISION }, key)).toBe(true);
    expect(runCarriesPhysicsRevision({}, key)).toBe(String(node.type) === 'protuberance');
  });
});
