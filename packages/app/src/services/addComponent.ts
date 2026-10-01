import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { axialLength } from '../tree/position.js';
import { interleaveRotation } from '../tree/schema.js';
import { addChild, findNode, inheritDefaults, makeNode, stages, type ParentId } from '../tree/treeModel.js';
import { newRailButtonPair, railButtonPlacement, type NewPairRule } from './railButtonPlacement.js';

/**
 * What a design measures once built — what the property panel's Auto-place
 * reads: StaticInfo's length and CG (the loaded CG when a motor is loaded) and
 * the kernel's station for a component (ComponentInfo.positionX).
 */
export interface DesignMeasure {
  rocketLength: number;
  cg: number;
  /** The kernel's station (m from the nose tip) of a component's front, or undefined. */
  stationOf: (id: string) => number | undefined;
}

/**
 * Builds a design the way the design page does and measures it, or returns
 * null when it does not build. App passes its own build (buildDesign, with the
 * motors, weighing and model flags on screen); null means no build is available.
 */
export type MeasureDesign = (tree: RocketTree) => DesignMeasure | null;

/**
 * THE ADD MENU'S NEW PART ("+ Add to …" → a type), as ONE tree write, so one
 * Ctrl+Z removes it whole. Moved out of App.tsx's `onAdd` so the rules can be
 * tested without the app:
 *
 *  - a new part inherits diameter, material and finish from the part it follows
 *    (the previous sibling, else the parent) — `inheritDefaults`;
 *  - a second fin-type set on a tube defaults BETWEEN the existing set's fins
 *    (2026-08-05d — tube fins + straight fins interleave);
 *  - a new RAIL BUTTON is an auto-placed PAIR (Eric, 2026-09-30) —
 *    `newRailButtonPair`, whose comment carries the rule and its fallback. The
 *    candidate designs it measures are never written; only the result is.
 *
 * `railButtonRule` says which placement rule a new rail button took (for tests
 * and nothing else); it is undefined for every other type.
 */
export function addNewComponent(
  tree: RocketTree,
  parentId: ParentId,
  type: ComponentType,
  measure: MeasureDesign | null,
): { tree: RocketTree; node: ComponentNode; railButtonRule?: NewPairRule } {
  const parent = parentId === 'stage' ? 'stage' as const : findNode(tree, parentId);
  const siblings = parent === 'stage'
    ? stages(tree)[0]?.children ?? []
    : parent?.children ?? [];
  const prev = siblings.length ? siblings[siblings.length - 1]! : null;
  let node = inheritDefaults(makeNode(type), parent, prev);
  if (type.endsWith('finset') && parent !== 'stage') {
    const existing = (parent?.children ?? []).find((c) => c.type.endsWith('finset'));
    if (existing) node['rotation'] = interleaveRotation(existing);
  }
  let railButtonRule: NewPairRule | undefined;
  if (type === 'railbutton' && parent && parent !== 'stage') {
    // The tube's length as the property panel reads it (its `parentLenSi`):
    // the kernel's, a cleared one included.
    const parentLength = axialLength(parent);
    const press = measure ? (b: ComponentNode) => {
      const m = measure(addChild(tree, parentId, b));
      const positionX = m ? m.stationOf(b.id!) : undefined;
      if (!m || positionX === undefined || !Number.isFinite(positionX)) return null;
      return railButtonPlacement(b, { rocketLength: m.rocketLength, cg: m.cg, positionX, parentLength });
    } : null;
    const pair = newRailButtonPair(node, parentLength, press);
    node = { ...node, ...pair.patch } as ComponentNode;
    railButtonRule = pair.rule;
  }
  return { tree: addChild(tree, parentId, node), node, railButtonRule };
}
