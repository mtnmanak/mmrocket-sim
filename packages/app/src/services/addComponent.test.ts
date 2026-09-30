// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  OrkRocket, resetEngine, type ComponentNode, type MotorSpec, type RocketTree,
} from '@online-openrocket/engine';
import {
  addChild, cloneSubtree, defaultTree, duplicateNode, engineTree, findNode, makeNode, normalizeTree,
} from '../tree/treeModel.js';
import { addNewComponent, type MeasureDesign } from './addComponent.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { importOrk } from './orkFile.js';
import { RAIL_BUTTON_AFT_GAP, railButtonPlacement } from './railButtonPlacement.js';

/**
 * A NEW RAIL BUTTON IS AN AUTO-PLACED PAIR (Eric, 2026-09-30: "make new rail
 * buttons default to an auto-placed pair"), on the real kernel. Since v0.144 a
 * rail-button line guides only while two of its stations are on the rail, so
 * the one button the Add menu used to create flew with no guided distance.
 *
 * The pure rule is in railButtonPlacement.test.ts; App's wiring and the one
 * Ctrl+Z are in App.addRailButton.test.tsx. Pinned here: the add path through
 * the kernel, the fallback on a real design, the flight, and that nothing else
 * — an import, a restored session, a paste, a duplicate, a launch lug — moved.
 */

afterEach(() => resetEngine());

const flatten = (nodes: readonly ComponentNode[]): ComponentNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const bodyOf = (t: RocketTree) => flatten(t.components).find((n) => n.type === 'bodytube')!;

/**
 * What App hands addNewComponent (App.tsx `onAdd`): the design page's own
 * build, with no motors here, and a no-op reset. `builds` counts the calls.
 */
function measurer(): { measure: MeasureDesign; builds: () => number } {
  let n = 0;
  return {
    builds: () => n,
    measure: (t) => {
      n++;
      const b = buildDesign({
        tree: t, assigned: [], kbf: false, supersonic: false,
        measuredDryMassKg: null, primaryMountId: null, currentSetKey: '',
      }, { reset: () => {}, build: KERNEL_HANDLES.build });
      if ('error' in b) return null;
      return {
        rocketLength: b.info.length, cg: b.info.cg,
        stationOf: (id) => { try { return b.rocket.componentInfo(id).positionX; } catch { return undefined; } },
      };
    },
  };
}

/** 📍 Auto-place pressed on `id` in design `t`, the way the property panel presses it. */
function pressAutoPlace(t: RocketTree, id: string) {
  const m = measurer().measure(t)!;
  const node = findNode(t, id)!;
  const parent = flatten(t.components).find((p) => (p.children ?? []).some((c) => c.id === id))!;
  return railButtonPlacement(node, {
    rocketLength: m.rocketLength, cg: m.cg, positionX: m.stationOf(id), parentLength: parent['length'] as number,
  });
}

/** The Add menu's rail button as it was before 2026-09-30: one button. */
function addOneButton(t: RocketTree, parentId: string): { tree: RocketTree; id: string } {
  const node = makeNode('railbutton');
  return { tree: addChild(t, parentId, node), id: node.id! };
}

describe('the Add menu\'s new rail button', () => {
  it('is a pair placed exactly where 📍 Auto-place rail buttons puts it: pressing it after the add moves nothing', () => {
    const tree = defaultTree();
    const body = bodyOf(tree);
    const added = addNewComponent(tree, body.id!, 'railbutton', measurer().measure);
    expect(added.railButtonRule).toBe('auto-place');
    expect(added.node['instanceCount']).toBe(2);

    // Press the panel's button on the design the add produced.
    const pressed = pressAutoPlace(added.tree, added.node.id!);
    expect(pressed.feasible).toBe(true);
    expect(pressed.patch.instanceCount).toBe(2);
    expect(pressed.patch.position.method).toBe(added.node.position!.method);
    expect(Math.abs(pressed.patch.position.offset - added.node.position!.offset)).toBeLessThan(1e-6);
    expect(Math.abs(pressed.patch.instanceSeparation - (added.node['instanceSeparation'] as number))).toBeLessThan(1e-6);

    // The kernel puts the forward button on that design's CG and the aft one an
    // inch off the tail.
    const m = measurer().measure(added.tree)!;
    const fwd = m.stationOf(added.node.id!)!;
    expect(fwd).toBeCloseTo(m.cg, 6);
    expect(fwd + (added.node['instanceSeparation'] as number)).toBeCloseTo(m.rocketLength - RAIL_BUTTON_AFT_GAP, 9);
  });

  it('starts from the old add-then-press, and presses again while the pair moves the CG', () => {
    const tree = defaultTree();
    const body = bodyOf(tree);
    // The old two steps: one button, then Auto-place pressed once.
    const one = addOneButton(tree, body.id!);
    const firstPress = pressAutoPlace(one.tree, one.id);
    expect(firstPress.feasible).toBe(true);
    const counter = measurer();
    const added = addNewComponent(tree, body.id!, 'railbutton', counter.measure);
    // The pair's own mass moved the CG after that first press, so it pressed again.
    const shift = Math.abs(added.node.position!.offset - firstPress.patch.position.offset);
    expect(shift).toBeGreaterThan(0.001);
    expect(shift).toBeLessThan(0.01);
    expect(counter.builds()).toBeGreaterThan(2);
    expect(counter.builds()).toBeLessThanOrEqual(6);
  });

  it('flies guided where the one button it used to be flew unguided', () => {
    const C6: MotorSpec = {
      designation: 'C6', diameter: 0.018, length: 0.07,
      times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
      thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
      masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
      cgX: 0.035, ejectionDelay: 5.0,
    };
    const fly = (t: RocketTree) => {
      const mount = flatten(t.components).find((n) => n['motorMount'] === true)!;
      const rocket = OrkRocket.buildTree(engineTree(t));
      rocket.setMotorById(mount.id!, C6);
      const r = rocket.simulate({ launchRodLength: 1, launchRodAngle: 0, windAverage: 0, windStdDeviation: 0,
        randomSeed: 42, timeStep: 0.001, maxTime: 1 });
      return { reason: r.launchGuideReason, effective: r.effectiveLaunchRodLength };
    };
    const tree = defaultTree();
    const body = bodyOf(tree);
    const pair = fly(addNewComponent(tree, body.id!, 'railbutton', measurer().measure).tree);
    expect(pair.reason).toBe('buttons');
    expect(pair.effective).toBeGreaterThan(0);
    const one = fly(addOneButton(tree, body.id!).tree);
    expect(one.reason).toBe('single-button');
    expect(one.effective).toBe(0);
  }, 60_000);

  it('falls back to a pair on its own tube when the CG is on another tube', () => {
    // Two 300 mm tubes; the CG sits in the forward one, the button goes on the
    // aft one, so auto-place's pair would leave that tube.
    const tree = normalizeTree({ name: 'Two tubes', components: [{ type: 'stage', children: [
      { type: 'nosecone', length: 0.1, aftRadius: 0.02, thickness: 0.002, shape: 'ogive' },
      { type: 'bodytube', id: 'fwd', length: 0.3, outerRadius: 0.02, thickness: 0.001, density: 950,
        children: [{ type: 'masscomponent', mass: 0.5, length: 0.02, radius: 0.01, position: { method: 'top', offset: 0 } }] },
      { type: 'bodytube', id: 'aft', length: 0.3, outerRadius: 0.02, thickness: 0.001, density: 950 },
    ] }] } as unknown as RocketTree);
    expect(measurer().measure(tree)!.cg).toBeLessThan(0.4); // in the forward tube
    const added = addNewComponent(tree, 'aft', 'railbutton', measurer().measure);
    expect(added.railButtonRule).toBe('tube-middle');
    expect(added.node['instanceCount']).toBe(2);
    // On the aft tube (400-700 mm): forward button at its middle, aft one an
    // inch off its end — the kernel's own stations.
    const fwd = measurer().measure(added.tree)!.stationOf(added.node.id!)!;
    expect(fwd).toBeCloseTo(0.55, 9);
    expect(fwd + (added.node['instanceSeparation'] as number)).toBeCloseTo(0.7 - RAIL_BUTTON_AFT_GAP, 9);
  });

  it('with no build, still makes a pair on the tube', () => {
    const tree = defaultTree();
    const body = bodyOf(tree);
    const added = addNewComponent(tree, body.id!, 'railbutton', null);
    expect(added.railButtonRule).toBe('tube-middle');
    expect(added.node['instanceCount']).toBe(2);
    expect(added.node['instanceSeparation']).toBeCloseTo(0.15 - RAIL_BUTTON_AFT_GAP, 12);
  });

  it('changes no other part: a new launch lug is still one lug', () => {
    const tree = defaultTree();
    const added = addNewComponent(tree, bodyOf(tree).id!, 'launchlug', measurer().measure);
    expect(added.railButtonRule).toBeUndefined();
    expect(added.node['instanceCount']).toBeUndefined();
    expect(added.node.position).toEqual(makeNode('launchlug').position);
  });
});

describe('a rail button that is not new keeps its count', () => {
  const ork = (instances: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>One button</name>
    <subcomponents><stage><name>Sustainer</name><subcomponents>
      <nosecone><name>N</name><length>0.1</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.02</aftradius></nosecone>
      <bodytube><name>B</name><length>0.5</length><thickness>0.001</thickness><radius>0.02</radius>
        <subcomponents>
          <railbutton><name>Button</name><outerdiameter>0.0097</outerdiameter>${instances}</railbutton>
        </subcomponents>
      </bodytube>
    </subcomponents></stage></subcomponents>
  </rocket></openrocket>`;

  it('an imported .ork that states one button, or omits the count, opens as one button', () => {
    for (const instances of ['<instancecount>1</instancecount>', '']) {
      const r = importOrk(ork(instances));
      const btn = flatten(r.tree.components).find((c) => c.type === 'railbutton')!;
      expect(btn['instanceCount'] ?? 1).toBe(1);
      expect(btn['instanceSeparation'] ?? 0).toBe(0);
    }
  });

  it('a restored session or share link with no count stays without one', () => {
    const t = normalizeTree({ name: 'S', components: [{ type: 'stage', children: [
      { type: 'bodytube', length: 0.5, outerRadius: 0.02, thickness: 0.001, children: [
        { type: 'railbutton', id: 'rb', outerDiameter: 0.0097, position: { method: 'middle', offset: 0 } },
      ] },
    ] }] } as unknown as RocketTree);
    const btn = findNode(t, 'rb')!;
    expect(btn['instanceCount']).toBeUndefined();
    expect(btn.position).toEqual({ method: 'middle', offset: 0 });
  });

  it('a paste or a duplicate keeps the source\'s count and positions', () => {
    const tree = defaultTree();
    const body = bodyOf(tree);
    const one = addOneButton(tree, body.id!);
    const src = findNode(one.tree, one.id)!;
    // Duplicate (⧉).
    const dup = duplicateNode(one.tree, one.id);
    const copy = findNode(dup.tree, dup.newId!)!;
    expect(copy['instanceCount']).toBeUndefined();
    expect(copy.position).toEqual(src.position);
    // Paste (App's onPaste: cloneSubtree, then addChild).
    const pasted = cloneSubtree(src);
    const afterPaste = findNode(addChild(one.tree, body.id!, pasted), pasted.id!)!;
    expect(afterPaste['instanceCount']).toBeUndefined();
    expect(afterPaste.position).toEqual(src.position);
    // A pair keeps its pair.
    const three = { ...src, id: 'p3', instanceCount: 3, instanceSeparation: 0.05 } as ComponentNode;
    const withThree = addChild(tree, body.id!, three);
    const d = duplicateNode(withThree, 'p3');
    const c3 = findNode(d.tree, d.newId!)!;
    expect(c3['instanceCount']).toBe(3);
    expect(c3['instanceSeparation']).toBe(0.05);
    expect(c3.position).toEqual(three.position);
  });
});
