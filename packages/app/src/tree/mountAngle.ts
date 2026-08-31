import type { ComponentNode, RocketTree } from '@online-openrocket/engine';

/**
 * Clock angles around the airframe: where a surface-mounted part can SNAP to,
 * and when one is somewhere it must not be.
 *
 * Eric, 2026-08-31: *"Most of the items we rotate around the body tube that are
 * singular tend to be either exactly in line with a fin or exactly between two
 * fins. We also should probably have a collision detection for anything that is
 * also in line with the rail buttons — rail buttons usually can't have anything
 * else in line with them (especially fins) or there would be no way to slide
 * the rocket onto the launch rail."*
 *
 * FRAME TRAP, and it is the reason everything here takes a PARENT rather than a
 * tree: a pod set or a parallel stage rotates its whole sub-chain, so a fin
 * inside a pod and a rail button on the core airframe are not measured from the
 * same zero. Angles are only ever compared between siblings on one parent.
 */

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

const isFinSet = (n: ComponentNode): boolean => n.type.endsWith('finset');

/** Wrap to (−π, π] — the kernel's own range (MathUtil.reducePi). */
export function reducePi(a: number): number {
  return a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
}

/** Smallest unsigned angle between two clock positions, 0…π. */
export function angleGap(a: number, b: number): number {
  return Math.abs(reducePi(a - b));
}

/**
 * Every fin's clock angle on this parent, in the parent's own frame.
 *
 * `rotation` is the fin set's clocking (the kernel's `baseRotation`) and the
 * instances are evenly spaced: `rotation + 2πi/N`, exactly what
 * `FinSet.getInstanceAngles` computes and what all three views already mirror.
 */
export function finAnglesOn(parent: ComponentNode): number[] {
  const out: number[] = [];
  for (const k of parent.children ?? []) {
    if (!isFinSet(k)) continue;
    const n = Math.max(1, Math.round(num(k, 'finCount', k.type === 'tubefinset' ? 6 : 3)));
    const rot = num(k, 'rotation', 0);
    for (let i = 0; i < n; i++) out.push(reducePi(rot + (2 * Math.PI * i) / n));
  }
  return out;
}

/** Midway between each adjacent pair of fins, for every fin set on the parent. */
export function betweenFinAnglesOn(parent: ComponentNode): number[] {
  const out: number[] = [];
  for (const k of parent.children ?? []) {
    if (!isFinSet(k)) continue;
    const n = Math.max(1, Math.round(num(k, 'finCount', k.type === 'tubefinset' ? 6 : 3)));
    const rot = num(k, 'rotation', 0);
    // A single fin has no "between two fins"; its opposite side is the closest
    // thing, and that is what (2i+1)π/N gives for N = 1.
    for (let i = 0; i < n; i++) out.push(reducePi(rot + ((2 * i + 1) * Math.PI) / n));
  }
  return out;
}

/** The candidate nearest `from`, or null when there are no candidates. */
export function nearestAngle(candidates: number[], from: number): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const c of candidates) {
    const g = angleGap(c, from);
    if (g < bestGap) { bestGap = g; best = c; }
  }
  return best;
}

/**
 * How close counts as "in line with".
 *
 * 10° is a judgement, not a derivation, and it is stated wherever it shows: on
 * a 54 mm airframe it is about 5 mm of arc, which is the order of a 1010 rail's
 * slot — close enough that a fin there fouls the rail, far enough that it does
 * not fire on a shroud someone deliberately put a third of the way round. The
 * warning names the actual separation so the reader can judge it themselves.
 */
export const IN_LINE_TOLERANCE = (10 * Math.PI) / 180;

const deg = (rad: number): string => {
  const d = (reducePi(rad) * 180) / Math.PI;
  return `${Math.abs(d) < 0.05 ? 0 : Number(d.toFixed(1))}°`;
};

const nameOf = (n: ComponentNode, fallback: string): string =>
  (typeof n.name === 'string' && n.name.trim()) ? n.name : fallback;

/**
 * Design-time interference around the rail.
 *
 * Two distinct errors, both of which stop a rocket going on the pad:
 *
 *  1. Something shares a rail button's clock angle. The rail occupies that line
 *     for the whole length of the rocket, so a fin, lug, shroud or bump there
 *     collides with it on the way up the rail.
 *  2. Two rail buttons on the same airframe at DIFFERENT angles. One rail is a
 *     straight line; buttons that do not share a clock angle cannot both engage
 *     it. (Two buttons at the SAME angle is the normal build, and OpenRocket
 *     also expresses that as one component with `instanceCount` 2 — collinear
 *     by construction, which is why this only fires on separate nodes.)
 *
 * Returns plain sentences, ready for the same warning strip the kernel's own
 * warnings use.
 */
export function railInterferenceWarnings(tree: RocketTree): string[] {
  const out: string[] = [];

  const walk = (nodes: ComponentNode[]) => {
    for (const parent of nodes) {
      const kids = parent.children ?? [];
      const buttons = kids.filter((k) => k.type === 'railbutton');

      if (buttons.length) {
        const finAngles: { angle: number; owner: string }[] = [];
        for (const k of kids) {
          if (!isFinSet(k)) continue;
          const n = Math.max(1, Math.round(num(k, 'finCount', k.type === 'tubefinset' ? 6 : 3)));
          const rot = num(k, 'rotation', 0);
          for (let i = 0; i < n; i++) {
            finAngles.push({ angle: reducePi(rot + (2 * Math.PI * i) / n), owner: nameOf(k, 'Fins') });
          }
        }
        const others = kids.filter((k) =>
          k !== undefined
          && k.type !== 'railbutton'
          && (k.type === 'launchlug' || k.type === 'fairing' || (k.type as string) === 'protuberance'));

        for (const b of buttons) {
          const ba = reducePi(num(b, 'angleOffset', 0));
          const bn = nameOf(b, 'Rail button');
          for (const f of finAngles) {
            const g = angleGap(ba, f.angle);
            if (g <= IN_LINE_TOLERANCE) {
              out.push(`${bn} at ${deg(ba)} is in line with a fin of "${f.owner}" (${deg(g)} apart) — the rail runs down that line, so the fin fouls it. Move one of them.`);
            }
          }
          for (const o of others) {
            const oa = reducePi(num(o, 'angleOffset', 0));
            const g = angleGap(ba, oa);
            if (g <= IN_LINE_TOLERANCE) {
              out.push(`${bn} at ${deg(ba)} is in line with "${nameOf(o, o.type)}" (${deg(g)} apart) — both sit on the rail's line.`);
            }
          }
        }

        // Buttons that disagree with each other.
        const first = reducePi(num(buttons[0]!, 'angleOffset', 0));
        for (let i = 1; i < buttons.length; i++) {
          const a = reducePi(num(buttons[i]!, 'angleOffset', 0));
          if (angleGap(a, first) > 1e-6) {
            out.push(`Rail buttons on "${nameOf(parent, parent.type)}" are at different angles (${deg(first)} and ${deg(a)}) — one rail is a straight line, so they cannot both engage it.`);
            break;
          }
        }
      }
      walk(kids);
    }
  };
  walk(tree.components);
  // The same fin set can raise the identical sentence twice through two
  // buttons at the same angle; the strip should say it once.
  return [...new Set(out)];
}
