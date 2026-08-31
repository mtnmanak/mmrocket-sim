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
 * ONE ANGULAR FRAME: the set of components that share a clock-angle zero.
 *
 * That is the WHOLE INLINE STACK — every stage's subtree, however many tubes
 * and stages deep — because stages are stacked, not rotated, and the physical
 * lines this file reasons about (a fin's plane, the launch rail) run the full
 * length of the assembled rocket standing on the pad. What breaks the frame is
 * an ASSEMBLY: a pod set or a parallel stage rotates its whole sub-chain, so
 * its contents form their own frame and are never compared with the core's.
 *
 * This walker is shared by the snap buttons and the rail-interference check —
 * ON PURPOSE. v0.088 shipped them computing "in line with a fin" over two
 * different frames (buttons: siblings only; warnings: the stage chain), and the
 * owner promptly found the seam: a pre-existing rail button on the tube above
 * the fin can got no snap buttons at all, while a freshly added one — born a
 * sibling of the fins, because Add attaches under the selected tube — did.
 * One definition, or the two drift apart again.
 */
export interface AngularFrame {
  members: ComponentNode[];
  /** Root children of each assembly found in this frame — each its own frame. */
  assemblies: ComponentNode[][];
}

export function collectFrame(nodes: ComponentNode[]): AngularFrame {
  const members: ComponentNode[] = [];
  const assemblies: ComponentNode[][] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) {
      if (n.type === 'podset' || n.type === 'parallelstage') {
        assemblies.push(n.children ?? []);
        continue;
      }
      members.push(n);
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return { members, assemblies };
}

/** The frame CONTAINING the given node: the inline stack, or its assembly. */
export function frameContaining(tree: RocketTree, id: string): ComponentNode[] | null {
  const frames: ComponentNode[][] = [tree.components];
  while (frames.length) {
    const roots = frames.pop()!;
    const { members, assemblies } = collectFrame(roots);
    if (members.some((m) => m.id === id)) return members;
    frames.push(...assemblies);
  }
  return null;
}

/**
 * Every fin's clock angle among the given frame members.
 *
 * `rotation` is the fin set's clocking (the kernel's `baseRotation`) and the
 * instances are evenly spaced: `rotation + 2πi/N`, exactly what
 * `FinSet.getInstanceAngles` computes and what all three views already mirror.
 */
export function finAnglesAmong(members: ComponentNode[]): number[] {
  const out: number[] = [];
  for (const k of members) {
    if (!isFinSet(k)) continue;
    const n = Math.max(1, Math.round(num(k, 'finCount', k.type === 'tubefinset' ? 6 : 3)));
    const rot = num(k, 'rotation', 0);
    for (let i = 0; i < n; i++) out.push(reducePi(rot + (2 * Math.PI * i) / n));
  }
  return out;
}

/** Back-compat wrapper: the fins among a single parent's children. */
export function finAnglesOn(parent: ComponentNode): number[] {
  return finAnglesAmong(parent.children ?? []);
}

/**
 * Midway between each adjacent pair of fins, for every fin set on the parent —
 * **minus any midpoint that lands on a DIFFERENT set's fin.**
 *
 * That subtraction is the whole point on a rocket with two fin sets on one
 * tube, which is a real build (a canard set ahead of the main set). Midpoints
 * computed per set in isolation are midway between *that* set's fins and can be
 * exactly on another set's, so "between fins" would put the camera straight
 * behind a canard. If every midpoint is spoken for, the un-filtered list comes
 * back rather than nothing — a button that does something imperfect beats a
 * button that does nothing.
 */
export function betweenFinAnglesAmong(members: ComponentNode[]): number[] {
  const out: number[] = [];
  for (const k of members) {
    if (!isFinSet(k)) continue;
    const n = Math.max(1, Math.round(num(k, 'finCount', k.type === 'tubefinset' ? 6 : 3)));
    const rot = num(k, 'rotation', 0);
    // A single fin has no "between two fins"; its opposite side is the closest
    // thing, and that is what (2i+1)π/N gives for N = 1.
    for (let i = 0; i < n; i++) out.push(reducePi(rot + ((2 * i + 1) * Math.PI) / n));
  }
  const fins = finAnglesAmong(members);
  const clear = out.filter((m) => fins.every((f) => angleGap(m, f) > IN_LINE_TOLERANCE));
  return clear.length ? clear : out;
}

/** Back-compat wrapper: the midpoints among a single parent's children. */
export function betweenFinAnglesOn(parent: ComponentNode): number[] {
  return betweenFinAnglesAmong(parent.children ?? []);
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
  const SURFACE = new Set(['launchlug', 'fairing', 'protuberance']);

  const checkFrame = (roots: ComponentNode[]) => {
    // The SAME frame walker the snap buttons use — see collectFrame.
    const { members, assemblies } = collectFrame(roots);
    const frame = {
      buttons: [] as { angle: number; name: string }[],
      fins: [] as { angle: number; owner: string }[],
      others: [] as { angle: number; name: string }[],
    };
    for (const n of members) {
      if (n.type === 'railbutton') {
        frame.buttons.push({ angle: reducePi(num(n, 'angleOffset', 0)), name: nameOf(n, 'Rail button') });
      } else if (isFinSet(n)) {
        const c = Math.max(1, Math.round(num(n, 'finCount', n.type === 'tubefinset' ? 6 : 3)));
        const rot = num(n, 'rotation', 0);
        for (let i = 0; i < c; i++) {
          frame.fins.push({ angle: reducePi(rot + (2 * Math.PI * i) / c), owner: nameOf(n, 'Fins') });
        }
      } else if (SURFACE.has(n.type as string)) {
        frame.others.push({ angle: reducePi(num(n, 'angleOffset', 0)), name: nameOf(n, n.type) });
      }
    }

    for (const b of frame.buttons) {
      for (const f of frame.fins) {
        const g = angleGap(b.angle, f.angle);
        if (g <= IN_LINE_TOLERANCE) {
          out.push(`${b.name} at ${deg(b.angle)} is in line with a fin of "${f.owner}" (${deg(g)} apart) — the rail runs down that line, so the fin fouls it. Move one of them.`);
        }
      }
      for (const o of frame.others) {
        const g = angleGap(b.angle, o.angle);
        if (g <= IN_LINE_TOLERANCE) {
          out.push(`${b.name} at ${deg(b.angle)} is in line with "${o.name}" (${deg(g)} apart) — both sit on the rail's line.`);
        }
      }
    }
    if (frame.buttons.length > 1) {
      const first = frame.buttons[0]!.angle;
      const odd = frame.buttons.find((b) => angleGap(b.angle, first) > 1e-6);
      if (odd) {
        out.push(`Rail buttons on this airframe are at different angles (${deg(first)} and ${deg(odd.angle)}) — one rail is a straight line, so they cannot both engage it.`);
      }
    }
    for (const a of assemblies) checkFrame(a);
  };

  // ONE frame for the whole inline stack, all stages together. The rail is
  // engaged on the PAD, with every stage assembled — a booster's buttons and a
  // sustainer's fins really do share the rail's line at the only moment the
  // rail matters. (v0.088 cut per stage; that was over-cautious and also made
  // this check disagree with the snap buttons about what a frame is.)
  checkFrame(tree.components);

  // Two buttons at the same angle raise the same sentence twice; say it once.
  return [...new Set(out)];
}
