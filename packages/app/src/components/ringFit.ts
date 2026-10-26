import { INITIAL_UNITS, noticeComparison, type UnitSelection } from '../prefs/units.js';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { numOpt } from '../tree/nodeNum.js';
import { axialLength, positionOf, resolveAbsolutePositions, startFromPosition } from '../tree/position.js';
import { DISPLAY_NAME } from '../tree/schema.js';
import { solidContextFor } from '../tree/solidContext.js';
import { findParent } from '../tree/treeModel.js';

interface RingFitComparison {
  dimension: 'outside' | 'inside';
  actualRadius: number;
  expectedRadius: number;
  tube: ComponentNode;
}

/** Pick-only advice: compare written catalogue dimensions only in certain layouts. */
export function ringFitFor(tree: RocketTree, node: ComponentNode, written: { outside: boolean; inside: boolean }, units: UnitSelection = INITIAL_UNITS): {
  notes: string[]; comparisons: RingFitComparison[];
} {
  const result = { notes: [] as string[], comparisons: [] as RingFitComparison[] };
  if (node.type !== 'centeringring' && node.type !== 'bulkhead') return result;
  // Importers can still contain rocket-origin positions before App normalizes
  // them. Compare every sibling in the parent's frame, without editing the tree.
  tree = resolveAbsolutePositions(tree);
  const parent = node.id ? findParent(tree, node.id) : null;
  const isTube = (n: ComponentNode) =>
    n.type === 'bodytube' || n.type === 'innertube' || n.type === 'tubecoupler';
  if (!parent || parent === 'stage' || !isTube(parent)) return result;
  node = parent.children?.find(child => child.id === node.id) ?? node;
  const span = (n: ComponentNode, p: ComponentNode): [number, number] => {
    const length = axialLength(n);
    const start = startFromPosition(positionOf(n), length, axialLength(p));
    return [start, start + length];
  };
  const [fore, aft] = span(node, parent);
  // Allow roundoff at an end, not a physical overhang. Automatic sizing clamps
  // to the parent's ends even when an imported part actually sits elsewhere.
  if (fore < -1e-9 || aft > axialLength(parent) + 1e-9) return result;
  const ctx = solidContextFor(tree, node);
  if (ctx.mountLayoutUnresolved) return result;
  const outside = numOpt(node, 'outerRadius');
  const inside = numOpt(node, 'innerRadius');
  let bore = ctx.parentInnerRadius;
  let boreTube = parent;
  let aroundParent = false;
  let mountTube: ComponentNode | undefined;
  const overlapping = (parent.children ?? []).filter(tube => {
    if (tube.id === node.id || (tube.type !== 'innertube' && tube.type !== 'tubecoupler')) return false;
    const [tubeFore, tubeAft] = span(tube, parent);
    return aft >= tubeFore && fore <= tubeAft;
  });
  for (const tube of overlapping) {
    const r = numOpt(tube, 'outerRadius')
      ?? (tube.type === 'tubecoupler' ? solidContextFor(tree, tube).parentInnerRadius : undefined);
    // An enclosing sibling can be the real container (av-bay bulkheads), and
    // the kernel's automatic size still follows the parent. Stay silent.
    if (outside === undefined || r === undefined || r >= outside) return result;
    if (tube.type === 'innertube') mountTube = tube;
  }
  if (parent.type === 'innertube' || parent.type === 'tubecoupler') {
    const hostCtx = solidContextFor(tree, parent);
    const parentOuter = numOpt(parent, 'outerRadius')
      ?? (parent.type === 'tubecoupler' ? hostCtx.parentInnerRadius : undefined);
    if (outside !== undefined && parentOuter !== undefined && outside > parentOuter) {
      const host = parent.id ? findParent(tree, parent.id) : null;
      if (!host || host === 'stage' || !isTube(host) || hostCtx.mountLayoutUnresolved) return result;
      const [parentFore] = span(parent, host);
      if (parentFore + fore < -1e-9 || parentFore + aft > axialLength(host) + 1e-9) return result;
      // A second surrounding tube makes this host guess ambiguous too.
      if ((host.children ?? []).some(tube => {
        if (tube.id === parent.id || (tube.type !== 'innertube' && tube.type !== 'tubecoupler')) return false;
        const [tubeFore, tubeAft] = span(tube, host);
        return parentFore + aft >= tubeFore && parentFore + fore <= tubeAft;
      })) return result;
      bore = hostCtx.parentInnerRadius;
      if (bore === undefined) return result;
      boreTube = host;
      mountTube = parent;
      aroundParent = true;
    }
  }
  // A 0.5 mm diameter tolerance allows ordinary catalogue rounding/clearance.
  const tolerance = 0.00025;
  // A sleeve around a tube need not reach the host bore. Only actual wall
  // interference proves an outside misfit in that layout.
  if (written.outside && outside !== undefined && bore !== undefined
    && (outside > bore + tolerance || bore > outside + 0.0015)
    && (!aroundParent || outside > bore)) {
    result.comparisons.push({ dimension: 'outside', actualRadius: outside, expectedRadius: bore, tube: boreTube });
  }
  const mount = mountTube === parent ? numOpt(parent, 'outerRadius')
    ?? (parent.type === 'tubecoupler' ? solidContextFor(tree, parent).parentInnerRadius : undefined)
    : ctx.mountOuterRadius;
  if (written.inside && node.type === 'centeringring' && inside !== undefined && mount !== undefined && mountTube
    && mount > inside + tolerance) {
    result.comparisons.push({ dimension: 'inside', actualRadius: inside, expectedRadius: mount, tube: mountTube });
  }
  result.notes = result.comparisons.map(({ dimension, actualRadius, expectedRadius, tube }) => {
    const tubeName = tube.name || DISPLAY_NAME[tube.type] || tube.type;
    const comparison = dimension === 'outside' ? `the bore of ${tubeName}`
      : `the outside diameter of the ${tube['motorMount'] === true ? 'motor-mount ' : ''}tube it fits around (${tubeName})`;
    const direction = dimension === 'outside' && actualRadius > expectedRadius ? 'exceeds'
      : `is ${actualRadius < expectedRadius ? 'smaller' : 'larger'} than`;
    const [actual, limit] = noticeComparison('length', actualRadius * 2, expectedRadius * 2, units, { parenthesized: true });
    if (actual.startsWith('just ')) return `${node.name || DISPLAY_NAME[node.type]}'s catalogue ${dimension} diameter is just ${actualRadius < expectedRadius ? 'under' : 'over'} ${comparison} (${limit}).`;
    return `${node.name || DISPLAY_NAME[node.type]}'s catalogue ${dimension} diameter (${noticeComparison('length', actualRadius * 2, expectedRadius * 2, units, { parenthesized: true })[0]}) ${direction} ${comparison} (${noticeComparison('length', actualRadius * 2, expectedRadius * 2, units, { parenthesized: true })[1]}).`;
  });
  if (result.notes.length > 0) result.notes.push('The flight and print/cut exports use the catalogue dimensions just applied. Undo the pick (Ctrl+Z), or pick a part sized for this tube.');
  return result;
}
