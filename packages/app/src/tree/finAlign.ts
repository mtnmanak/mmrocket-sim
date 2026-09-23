import { finCountOf } from './counts.js';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { axialLength, drawnExtent, startFromPosition } from './position.js';
import { updateNode } from './treeModel.js';
import { num } from './nodeNum.js';

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
  return num(n, 'rotation', 0);
};

/**
 * How many fins (or tubes) a set has.
 *
 * The tube-fin branch was MISSING here until 2026-09-08 while `mountAngle.ts`
 * (three sites) and `pieces.ts` all defaulted a `tubefinset` to 6. So a tube-fin
 * set whose file omits `finCount` — .rkt and .CDX1 both can — was searched for
 * clearance against THREE tubes and drawn as six, and the one-click interleave
 * then rotated the straight set to an angle that is wrong for the set actually
 * on screen. Found by the audit as a drifted default, which is what it is: one
 * question, four answers, and only this one different.
 *
 * Since audit 2026-09-22 it is `finCountOf` (counts.ts), the one answer every
 * view shares — which also caps it at the kernel's 8, so a set typed or read
 * as 12 is aligned as the 8 fins that fly.
 */
const countOf = (n: ComponentNode): number => finCountOf(n);

/**
 * The axial span a fin set occupies on its parent, metres from the parent's
 * fore end. Anchored by the kernel's length, which is where the set is
 * STATIONED; extended by the drawn outline, because a freeform fin whose tip
 * overhangs its root collides with the set behind it out to the tip.
 *
 * Shared with the RockSim importer's de-collision pass (rocksimFile.ts), which
 * carried its own copy of this and of `spansOverlap` (audit 2026-09-22, from
 * the 8 September record) — two copies of one geometric question.
 */
export function finSetSpan(k: ComponentNode, parentLength: number): [number, number] {
  const pos = (k.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  const start = startFromPosition(pos, axialLength(k), parentLength);
  return [start, start + drawnExtent(k)];
}

/** Do two axial spans overlap? Touching end to end is not an overlap. */
export function spansOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

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

      for (let i = 1; i < finSets.length; i++) {
        const me = finSets[i]!;
        const myRange = finSetSpan(me, pLen);
        const others = finSets.slice(0, i).filter((o) => spansOverlap(finSetSpan(o, pLen), myRange));
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
