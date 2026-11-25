import { expect, it, vi } from 'vitest';
import * as motorDb from './motorDb.js';
import { labelMotor } from './motorLabels.testSupport.js';
import * as exMotors from './exMotors.js';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { batchMountDisclosure } from './batchMountDisclosure.js';
import type { BatchMountOption } from './batchSweep.js';
import { testMotor } from './autoDelay.testSupport.js';
import { batchRingSubset, batchRingSplits } from './batchRing.js';

it.each([4, 6])('r3 offers the %s-tube ring while retaining a same-bore centre mount', n => {
  const mounts = ['centre', ...Array.from({ length: n }, (_, i) => `ring${i}`)].map(option);
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'body',
    outerRadius: 0.2, length: 0.6, children: mounts.map((m, i) => ({
      type: 'innertube', id: m.id, motorMount: true, outerRadius: 0.0385, thickness: 0.001,
      radialPosition: i === 0 ? 0 : 0.1, radialDirection: (i - 1) * Math.PI * 2 / n,
    })) }] }] };
  const ring = batchRingSubset(tree, mounts, 'ring0');
  expect(ring?.map(m => m.id)).toEqual(mounts.slice(1).map(m => m.id));
  expect(batchRingSplits(tree, ring!).halves?.groupSize).toBe(n / 2);
  expect(batchRingSubset(tree, mounts, 'centre')).toBeNull();
  expect(batchMountDisclosure(tree, mounts, mounts[1]!, {}, {}, {}, {}).mixedUnavailable)
    .toContain(`Tick Use only ${n} ring mounts`);
  tree.components[0]!.children![0]!.children![0]!.radialPosition = 0.03;
  expect(batchRingSubset(tree, mounts, 'ring0')).toBeNull();
});

const option = (id: string): BatchMountOption => ({ id, label: id, diameterMm: 75, motorCount: 1, maxMotorLengthM: null });
it('A25:4-3 discloses effective target and kept timers including inherited defaults', () => {
  const mounts = ['a', 'b'].map(option);
  const tree = { ignitionDefaults: { a: { event: 'launch' as const, delay: 1.5 }, b: { event: 'launch' as const, delay: 2 } },
    components: mounts.map(m => ({ type: 'innertube' as const, id: m.id, name: m.id, motorMount: true })) };
  const kept = batchMountDisclosure(tree, mounts, mounts[0]!, { b: testMotor().spec }, {}, {}, {});
  expect(kept.text).toContain('a (ignition: Launch + delay (timer), delay 1.5 s) only.');
  expect(kept.text).toContain('(ignition: Launch + delay (timer), delay 2 s) for every flight.');
  const targets = batchMountDisclosure(tree, mounts, mounts[0]!, {}, {}, {}, {}, ['a', 'b']);
  expect(targets.text).toContain('a (ignition: Launch + delay (timer), delay 1.5 s) and b (ignition: Launch + delay (timer), delay 2 s)');
});
it('J1 points from the matching checkbox back to a selected cluster and identifies unlit target copies', () => {
  const mounts = ['a', 'b'].map(option);
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: mounts.map(m => ({
    type: 'innertube', id: m.id, name: m.id, motorMount: true, outerRadius: 0.0385, thickness: 0.001,
    ...(m.id === 'b' ? { cluster: '4-ring' } : {}),
  })) }] };
  const result = batchMountDisclosure(tree, mounts, mounts[1]!, {}, {}, {}, { b: { event: 'never', delay: 0 } }, ['a', 'b']);
  expect(result.mixedUnavailable).toContain('Untick Use all 2 matching mounts for mixed 2+2 on b.');
  expect(result.text).toContain('×4 b (never ignites)');
});

it('A25:4-3 uses inherited Never ignition for a kept mount', () => {
  const mounts = ['a', 'b'].map(option);
  const tree = { ignitionDefaults: { b: { event: 'never' as const, delay: 0 } },
    components: mounts.map(m => ({ type: 'innertube' as const, id: m.id, name: m.id, motorMount: true })) };
  expect(batchMountDisclosure(tree, mounts, mounts[0]!, { b: testMotor().spec }, {}, {}, {}).text)
    .toContain('(never ignites) for every flight.');
});

it('J1 directs an unticked separate-tube ring to the matching checkbox for mixed batches', () => {
  const mounts = ['a', 'b', 'c', 'd'].map(option);
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'body',
    outerRadius: 0.2, length: 0.6, children: mounts.map((m, i) => ({
      type: 'innertube', id: m.id, name: m.id, motorMount: true, outerRadius: 0.0385, thickness: 0.001,
      radialPosition: 0.1, radialDirection: i * Math.PI / 2,
    })) }] }] };
  const result = batchMountDisclosure(tree, mounts, mounts[0]!, {}, {}, {}, {});
  expect(result.mixedUnavailable).toBe('Tick Use all 4 matching mounts for mixed batches on this ring of separate tubes.');
});
it('Round 5 picker retains impulse prefixes for synthetic kept catalogue reloads', () => {
  const reloads = ['229H255-14A', '315H255-14A'].map(d => labelMotor(d, 'Cesaroni'));
  const spy = vi.spyOn(motorDb, 'getCatalogue').mockReturnValue(reloads);
  try {
    const mounts = ['a', 'b', 'c'].map(option);
    const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: mounts.map(m => ({
      type: 'innertube', id: m.id, name: m.id, motorMount: true,
    })) }] };
    const specs = Object.fromEntries(reloads.map((m, i) => [i ? 'c' : 'b', { ...testMotor(false, 5).spec, designation: m.designation }]));
    const ids = { b: reloads[0]!.motorId, c: reloads[1]!.motorId };
    const result = batchMountDisclosure(tree, mounts, mounts[0]!, specs, {}, ids, {});
    const raw = reloads.map(m => m.designation.replace(/-(?:\d{1,2}[A-Z]?|P)$/, ''));
    expect(result.text).toContain(`b keeps ${raw[0]} and c keeps ${raw[1]} for every flight.`);
  } finally { spy.mockRestore(); }
});
it('Round 5 suppresses the entire picker vector for an oversized resolved EX name', () => {
  const ex = exMotors.parseEng('E20 29 100 5 0.05 0.1 Home\n0 0\n0.5 40\n1 0')[0]!;
  const spy = vi.spyOn(exMotors, 'getExMotor').mockReturnValue({ ...ex, designation: 'K'.repeat(1_000_000) });
  try {
    const mounts = ['a', 'b'].map(option);
    const tree: RocketTree = { components: mounts.map(m => ({ type: 'innertube', id: m.id, motorMount: true })) };
    expect(batchMountDisclosure(tree, mounts, mounts[0]!, { b: testMotor(false, 5).spec }, {}, { b: 'ex:oversized-round5' }, {}).text).toBeNull();
  } finally { spy.mockRestore(); }
});
it('Round 4 does not call mounts with missing stage ids a same-stage match', () => {
  const tree: RocketTree = { components: ['a', 'b'].map(id => ({ type: 'innertube', id, motorMount: true,
    outerRadius: 0.0385, thickness: 0.001 })) };
  expect(batchMountDisclosure(tree, [option('a'), option('b')], option('a'), {}, {}, {}, {}).matching).toBe(false);
});
it('Round 4 keeps different makers with the same designation separate in the picker', () => {
  const mounts = ['a', 'b', 'c'].map(option);
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: mounts.map((m, i) => ({
    type: 'innertube', id: m.id, name: `MMT ${i + 1}`, motorMount: true,
  })) }] };
  const spec = { ...testMotor(false, 5).spec, designation: 'C6' };
  const metadata = Object.fromEntries(['Estes', 'Klima'].map((manufacturer, i) => [i ? 'c' : 'b', {
    spec, label: '', meta: { label: '', manufacturer }, ignition: { event: 'automatic' as const, delay: 0 },
  }]));
  expect(batchMountDisclosure(tree, mounts, mounts[0]!, { b: spec, c: spec }, metadata, {}, {}).text)
    .toContain('MMT 2 keeps Estes C6 and MMT 3 keeps Klima C6');
});
it.each([[0.00049, true], [0.00051, false]])('matches actual bores within half a millimetre: %s m', (difference, matching) => {
  const tube = (id: string, bore: number): ComponentNode => ({ type: 'innertube', id, outerRadius: bore / 2 + 0.001, thickness: 0.001, motorMount: true });
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [tube('a', 0.075), tube('b', 0.075 + difference)] }] };
  expect(batchMountDisclosure(tree, [option('a'), option('b')], option('a'), {}, {}, {}, {}).matching).toBe(matching);
  tree.components.push({ type: 'stage', id: 'other', children: [tree.components[0]!.children!.pop()!] });
  expect(batchMountDisclosure(tree, [option('a'), option('b')], option('a'), {}, {}, {}, {}).matching).toBe(false);
});

it('Round 2 uses tree display names, duplicate numbering and actual counts, leaving picker labels alone', () => {
  const mounts = ['a', 'b', 'c', 'd'].map(id => ({ ...option(id), label: 'Inner Tube (⌀ 75 mm)', motorCount: id === 'b' ? 4 : 1 }));
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: mounts.map(m => ({
    type: 'innertube', id: m.id, name: 'Inner Tube', motorMount: true, outerRadius: 0.0385, thickness: 0.001,
    ...(m.id === 'b' ? { cluster: '4-ring' } : {}),
  })) }] };
  const result = batchMountDisclosure(tree, mounts, mounts[0]!, { b: testMotor(false, 5).spec }, {}, {}, {});
  expect(result.text).toContain('Candidates fly in Inner Tube 1 only.');
  expect(result.text).toContain('test ×4 in Inner Tube 2');
  expect(result.text).toContain('Inner Tube 3 and Inner Tube 4 stay empty.');
  expect(result.text).not.toContain('⌀');
  expect(result.mixedUnavailable).toContain('Inner Tube 1 is a single tube');
  expect(mounts[0]!.label).toContain('⌀');
  expect(batchMountDisclosure(tree, mounts, mounts[1]!, {}, {}, {}, {}).text)
    .toContain('Candidates fly ×4 in Inner Tube 2 only.');
});

it('Round 2 safely describes an unknown imported layout', () => {
  const tree: RocketTree = { components: [{ type: 'innertube', id: 'a', name: 'Inner Tube', motorMount: true, cluster: 'future\nlayout' }] };
  expect(batchMountDisclosure(tree, [option('a')], option('a'), {}, {}, {}, {}).mixedUnavailable)
    .toBe("Mixed batches (2+2, 3+3) need a 4-ring or 6-ring cluster; this mount's layout is futurelayout.");
});

it('Round 2 explains one tube repeated in pods without claiming one candidate motor', () => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'podset', id: 'pods', instanceCount: 3,
    children: [{ type: 'innertube', id: 'a', name: 'Pod mount', motorMount: true }] }] }] };
  const selected = { ...option('a'), motorCount: 3 };
  const result = batchMountDisclosure(tree, [selected], selected, {}, {}, {}, {});
  expect(result.mixedUnavailable).toContain('Pod mount represents 3 tubes in the flown design, so each candidate flies in all 3.');
  expect(result.mixedUnavailable).not.toContain('single tube');
});

it.each(['4-ring', '6-ring'])('Round 3 points to another qualifying %s mount with its design name', cluster => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
    { type: 'innertube', id: 'a', name: 'Inner Tube', motorMount: true },
    { type: 'innertube', id: 'b', name: 'Inner Tube', motorMount: true, cluster },
    { type: 'bodytube', id: 'c', name: 'Unsupported', motorMount: true, cluster: '4-ring' },
  ] }] };
  expect(batchMountDisclosure(tree, [option('a'), option('c'), option('b')], option('a'), {}, {}, {}, {}).mixedUnavailable)
    .toContain('Choose Inner Tube 2 in the mount picker for mixed batches.');
  tree.components[0]!.children![1]!.type = 'bodytube';
  expect(batchMountDisclosure(tree, [option('a'), option('c'), option('b')], option('a'), {}, {}, {}, {}).mixedUnavailable)
    .not.toContain('Choose');
});
