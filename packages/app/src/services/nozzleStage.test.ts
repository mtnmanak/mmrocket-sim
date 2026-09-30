// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { applyStageNozzles, findNode, mountMotorCount, nozzleMotorCount, nozzleStages, stagesWithNozzle, motorisedStagesWithNozzle } from '../tree/treeModel.js';
import { equivalentExitDiameterM, followNozzle, stageMotorKey, stageMotors } from './nozzleFollow.js';
import { nozzleOversize } from './nozzleCheck.js';
import { exportOrk, importOrk } from './orkFile.js';
import { nozzleExportNotes } from './nozzleExport.js';
import { exportRkt } from './rocksimFile.js';
import { encodeShareFragment, decodeShareFragment } from './shareLink.js';
import { FIELDS } from '../tree/schema.js';

const design = (): RocketTree => ({ name: 'Nozzles', components: [{
  type: 'stage', id: 'core', name: 'Core', nozzleExitDiameter: 0.01,
  children: [{ type: 'bodytube', id: 'body', length: 0.5, outerRadius: 0.05, children: [
    { type: 'innertube', id: 'cm', motorMount: true },
    { type: 'parallelstage', id: 'boost', name: 'Strap-ons', instanceCount: 3, children: [
      { type: 'bodytube', length: 0.3, outerRadius: 0.03, children: [
        { type: 'innertube', id: 'bm', motorMount: true, cluster: '4-ring' },
        { type: 'podset', id: 'pods', instanceCount: 2, children: [
          { type: 'bodytube', id: 'pm', motorMount: true },
          { type: 'parallelstage', id: 'nested', instanceCount: 5, children: [
            { type: 'bodytube', id: 'nm', motorMount: true },
          ] },
        ] },
      ] },
    ] },
  ] }],
}] });
const motor = (id = 'known'): MountMotor => ({
  label: id, ignition: { event: 'automatic', delay: 0 }, meta: { motorId: id, label: id },
  spec: { designation: id, diameter: 0.01, length: 0.05, times: [0, 1], thrusts: [1, 0], masses: [0.1, 0.05], cgX: 0.025, ejectionDelay: 5 },
});

describe('per-instance nozzle ownership and OFF', () => {
  it('offers the same optional nozzle property on serial and parallel stages, never pods', () => {
    for (const kind of ['stage', 'parallelstage'] as const) {
      const field = FIELDS[kind].find((f) => f.key === 'nozzleExitDiameter');
      expect(field?.optional).toBe(true);
      expect(field?.help).toContain('0');
    }
    expect(FIELDS.parallelstage.find((f) => f.key === 'nozzleExitDiameter')?.help).toContain('ONE strap-on');
    expect(FIELDS.podset.some((f) => f.key === 'nozzleExitDiameter')).toBe(false);
  });
  it('counts clusters and pods below ownership, excluding every enclosing ring', () => {
    const t = design();
    expect(nozzleStages(t).map((s) => s.id)).toEqual(['core', 'boost', 'nested']);
    expect(nozzleMotorCount(t, 'bm')).toBe(4);
    expect(nozzleMotorCount(t, 'pm')).toBe(2);
    expect(nozzleMotorCount(t, 'nm')).toBe(1);
    expect(mountMotorCount(t, 'nm')).toBe(30);
    const loadout = stageMotors(t, ['cm', 'bm', 'pm', 'nm'].map((id) => [id, motor()]));
    expect(loadout.map((s) => s.motors.map((m) => m.count))).toEqual([[1], [4, 2], [1]]);
    expect(equivalentExitDiameterM([{ count: 4, exitDiameterM: 0.01 }])).toBe(0.02);
    const key = stageMotorKey(loadout[1]!);
    findNode(t, 'boost')!['instanceCount'] = 8;
    expect(stageMotorKey(stageMotors(t, [['bm', motor()], ['pm', motor()]])[1]!)).toBe(key);
    expect(stageMotors(t, [])[1]!.motors).toEqual([]);
    expect(equivalentExitDiameterM([{ count: 4, exitDiameterM: 0.01 }, { count: 1, exitDiameterM: null }])).toBeNull();
  });

  it('applies and reports parallel values recursively without touching pods or unchanged identities', () => {
    const t = design();
    const out = applyStageNozzles(t, { boost: 0.025, nested: 0, pods: 0.01 });
    expect(findNode(out, 'boost')!['nozzleExitDiameter']).toBe(0.025);
    expect(findNode(out, 'nested')!['nozzleExitDiameter']).toBe(0);
    expect(findNode(out, 'pods')!['nozzleExitDiameter']).toBeUndefined();
    expect(applyStageNozzles(out, { boost: 0.025, nested: 0, gone: 0.1 })).toBe(out);
    expect(findNode(out, 'cm')).toBe(findNode(t, 'cm'));
    expect(stagesWithNozzle(out).map((s) => s.id)).toEqual(['core', 'boost']);
    expect(motorisedStagesWithNozzle(out, [['bm', motor()]]).map((s) => s.id)).toEqual(['boost']);
    expect(findNode(applyStageNozzles(out, { nested: null }), 'nested')!['nozzleExitDiameter']).toBeUndefined();
  });

  it('bounds the equivalent by one strap-on’s motor casings, not the whole ring', () => {
    const t = applyStageNozzles(design(), { boost: 0.025 });
    const warning = nozzleOversize(t, [['bm', motor()]]);
    expect(warning).toHaveLength(1);
    expect(warning[0]!.casingEquivalentM).toBe(0.02);
    expect(warning[0]!.motorCount).toBe(4);
  });

  it('explicit zero survives every motor-change decision', () => {
    for (const publishedM of [null, 0.02]) {
      expect(followNozzle({ hadMotorsBefore: true, previousLabel: 'Old', currentValueM: 0, publishedM })).toEqual({ kind: 'none' });
    }
  });
});

describe('nozzle file contract', () => {
  it('preserves parallel and OFF values through the actual compressed share payload', async () => {
    const t = applyStageNozzles(design(), { boost: 0.025, nested: 0 });
    const xml = exportOrk({ name: 'Share', tree: t });
    const shared = await decodeShareFragment(await encodeShareFragment(xml));
    expect(nozzleStages(importOrk(shared).tree).map((s) => s['nozzleExitDiameter'])).toEqual([0.01, 0.025, 0]);
  });
  it('round-trips distinct serial, parallel and nested zero values, including legacy boosters', () => {
    const t = applyStageNozzles(design(), { boost: 0.025, nested: 0 });
    const xml = exportOrk({ name: t.name!, tree: t });
    for (const text of [xml, xml.replaceAll('parallelstage', 'boosterset')]) {
      const back = importOrk(text).tree;
      expect(nozzleStages(back).map((s) => s['nozzleExitDiameter'])).toEqual([0.01, 0.025, 0]);
    }
    const zeroCore = applyStageNozzles(t, { core: 0 });
    expect(nozzleStages(importOrk(exportOrk({ name: 'Off', tree: zeroCore })).tree)[0]!['nozzleExitDiameter']).toBe(0);
  });

  it('rejects negative/nonfinite values and never reads a descendant nozzle as its owner’s', () => {
    const wrap = (body: string) => `<openrocket><rocket><subcomponents><stage><subcomponents><bodytube><subcomponents>${body}</subcomponents></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
    for (const value of ['-1', 'NaN', 'Infinity', '']) {
      const t = importOrk(wrap(`<parallelstage><nozzleexitdiameter>${value}</nozzleexitdiameter></parallelstage>`)).tree;
      expect(nozzleStages(t).map((s) => s['nozzleExitDiameter'])).toEqual([undefined, undefined]);
    }
    const t = importOrk(wrap('<podset><nozzleexitdiameter>0.01</nozzleexitdiameter></podset>')).tree;
    expect(JSON.stringify(t)).not.toContain('nozzleExitDiameter');
    const pod: ComponentNode = { type: 'podset', nozzleExitDiameter: 0.01 };
    expect(exportOrk({ name: 'Pod', tree: { name: 'Pod', components: [{ type: 'stage', children: [{ type: 'bodytube', children: [pod] }] }] } })).not.toContain('nozzleexitdiameter');
  });

  it('reports unsupported exports including OFF, keeping serial RASAero positive exits separate', () => {
    const t = applyStageNozzles(design(), { boost: 0.02, nested: 0 });
    expect(nozzleExportNotes(t, '.CDX1')).toHaveLength(2);
    expect(nozzleExportNotes(t, '.rkt')).toHaveLength(3);
    const notes: string[] = [];
    exportRkt({ name: t.name!, tree: t, notes });
    expect(notes.join(' ')).toContain('explicit nozzle OFF');
    expect(notes.join(' ')).toContain('Strap-ons');
    expect(nozzleExportNotes(applyStageNozzles(t, { core: 0 }), '.CDX1')).toHaveLength(3);
  });
});
