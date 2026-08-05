import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { axialLength, startFromPosition } from './position.js';
import { updateNode } from './treeModel.js';

/**
 * One-click fin-set alignment (issue 2026-08-05e): rotates axially-overlapping
 * sibling fin sets so their fins interleave with the widest possible angular
 * clearance — the manual counterpart of the importer's de-collision pass.
 *
 * The first set on each tube keeps its rotation; every later set that overlaps
 * an earlier one is rotated to the angle that maximizes the minimum circular
 * distance between any of its fins and any fin of the overlapping sets. For
 * the common two-set cases this reproduces the half-pitch interleave (6 tube
 * fins + 3 straight fins → 30°), and it generalizes to three or more sets.
 */

export interface FinAlignResult {
  tree: RocketTree;
  /** One human-readable line per rotated set (empty = nothing to do). */
  changes: string[];
}

const rotOf = (n: ComponentNode, patches: Map<string, number>): number => {
  if (n.id && patches.has(n.id)) return patches.get(n.id)!;
  return typeof n['rotation'] === 'number' ? (n['rotation'] as number) : 0;
};

const countOf = (n: ComponentNode): number =>
  Math.max(1, Math.round(typeof n['finCount'] === 'number' ? (n['finCount'] as number) : 3));

/** Smallest circular distance between any fin of set A and any fin of set B. */
function minClearance(rotA: number, countA: number, rotB: number, countB: number): number {
  const TWO_PI = Math.PI * 2;
  let best = Infinity;
  for (let i = 0; i < countA; i++) {
    const a = rotA + (TWO_PI * i) / countA;
    for (let j = 0; j < countB; j++) {
      const b = rotB + (TWO_PI * j) / countB;
      let d = Math.abs(a - b) % TWO_PI;
      if (d > Math.PI) d = TWO_PI - d;
      best = Math.min(best, d);
    }
  }
  return best;
}

export function autoAlignFinSets(tree: RocketTree): FinAlignResult {
  const patches = new Map<string, number>();
  const changes: string[] = [];

  const visit = (parentNode: ComponentNode) => {
    const kids = parentNode.children ?? [];
    const finSets = kids.filter((k) => k.type.endsWith('finset'));
    if (finSets.length >= 2) {
      const pLen = typeof parentNode['length'] === 'number' ? (parentNode['length'] as number) : 0.2;
      const range = (k: ComponentNode): [number, number] => {
        const len = axialLength(k);
        const pos = (k.position ?? { method: 'top', offset: 0 }) as { method: 'top' | 'middle' | 'bottom' | 'absolute'; offset: number };
        const start = startFromPosition(pos, len, pLen);
        return [start, start + len];
      };
      const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

      for (let i = 1; i < finSets.length; i++) {
        const me = finSets[i]!;
        const myRange = range(me);
        const others = finSets.slice(0, i).filter((o) => overlaps(range(o), myRange));
        if (!others.length || !me.id) continue;

        // Grid-search this set's rotation over one of its own pitches for
        // the angle with the widest minimum clearance to the earlier sets.
        const myCount = countOf(me);
        const pitch = (Math.PI * 2) / myCount;
        const STEPS = 720;
        let bestRot = rotOf(me, patches);
        let bestClear = -1;
        for (let s = 0; s < STEPS; s++) {
          const r = (pitch * s) / STEPS;
          let clear = Infinity;
          for (const o of others) {
            clear = Math.min(clear, minClearance(r, myCount, rotOf(o, patches), countOf(o)));
          }
          if (clear > bestClear + 1e-9) {
            bestClear = clear;
            bestRot = r;
          }
        }

        const current = rotOf(me, patches);
        // Compare achieved clearance, not the angle: a set already sitting in
        // a different-but-equally-clear spot should be left alone.
        let currentClear = Infinity;
        for (const o of others) {
          currentClear = Math.min(currentClear, minClearance(current, myCount, rotOf(o, patches), countOf(o)));
        }
        if (bestClear > currentClear + 1e-6) {
          patches.set(me.id, bestRot);
          changes.push(
            `“${me.name ?? me.type}” rotated to ${Math.round((bestRot * 180) / Math.PI)}° `
            + `(was ${Math.round((current * 180) / Math.PI)}°) for the widest fin clearance.`,
          );
        }
      }
    }
    for (const k of kids) visit(k);
  };

  for (const top of tree.components) visit(top);

  let out = tree;
  for (const [id, rotation] of patches) out = updateNode(out, id, { rotation });
  return { tree: out, changes };
}
