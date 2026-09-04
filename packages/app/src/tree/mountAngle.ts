import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { absoluteStations } from './position.js';
// mountRadiusOf, not a fourth copy of "how wide is the tube under this part".
// It is the expression all three views and engineTree already use, fallbacks
// included (treeModel.ts l. 806), and the wake window below is a fraction of
// that radius — a wrong radius would silently retune the trigger. The import
// costs this module the engine value-import treeModel carries; measured, that
// is one extra kernel eval in the vitest worker for mountAngle.test.ts (~165 ms
// by treeModel.ts's own note) and nothing at all in the bundle, which already
// holds the kernel in its eager entry chunk.
import { mountRadiusOf } from './treeModel.js';

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
        // The assembly NODE belongs to this frame — its own angleOffset is a
        // clock angle in the PARENT's frame, so it can snap to the parent's
        // fins like any other surface part. Its CHILDREN do not: they live in
        // the rotated sub-chain, which is its own frame.
        members.push(n);
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

/**
 * Types whose wake is worth flagging: a bluff bump standing off the airframe.
 *
 * `launchlug` is in the rail check's SURFACE set and is deliberately NOT here.
 * A lug is a slender streamwise tube, not a bluff body, and the only thing the
 * corpus says about lug wakes is a different question entirely — that the
 * SECOND of two lugs is assumed to ride in the FIRST's wake
 * (docs/research/trf-aero-research-2026-08-25.md l. 162). Adding it would fire
 * on nearly every mid-power rocket for a wake nobody has claimed reaches a fin.
 */
const WAKE_SOURCES = new Set(['fairing', 'protuberance']);

/** Fallback names, so an unnamed part still reads as a thing in the sentence. */
const WAKE_SOURCE_NAME: Record<string, string> = {
  fairing: 'Camera shroud',
  protuberance: 'Protuberance',
};

/**
 * How far downstream a bump is still treated as sitting in front of a fin,
 * measured in the bump's OWN height off the surface.
 *
 * A STATED GEOMETRIC CUTOFF, not a physics claim — there is no correlation in
 * this repo that survives at these gaps (see the note on wakeShadowWarnings).
 * 20 heights is chosen from the two ends it has to satisfy: a nose-mounted
 * camera 1.5 m ahead of the fin can must not speak (for the app's default
 * 20 mm shroud this cutoff is 400 mm), and the only quantitative wake
 * observation anywhere in the corpus — @Buckeye's rail button, CFD at M 0.3,
 * *"the wake closes about two diameters behind the button"* — argues the
 * structure is short-lived, so a generous cutoff would be claiming more than
 * anyone has measured. It is a judgement, and the sentence names the actual
 * gap in millimetres so a reader can apply their own.
 */
export const WAKE_REACH_HEIGHTS = 20;

/**
 * How far off a fin's line a bump still counts as standing IN FRONT of it.
 *
 * NOT `IN_LINE_TOLERANCE` on its own, and that is the whole point of this
 * function. The 10° above is derived from a 1010 rail's SLOT — a rail is a
 * line. A shroud is a body, and its own width covers more azimuth than 10° on
 * every airframe a camera is normally flown on: the half-angle it subtends,
 * asin(W / 2R), is 27.6° for the app's default 25 mm shroud on a 54 mm body,
 * 19.5° on 75 mm, 14.8° on 98 mm, and 56.4° for a 45 mm GoPro-class shroud on
 * a 54 mm body. A bare 10° window would stay silent on a shroud clocked 20°
 * off a fin while the shroud's own body physically covers that fin.
 *
 * So the window is the subtended half-angle (derived) PLUS the 10° — the same
 * judgement it always was, doing a different job here: an allowance for a wake
 * being wider than the body that sheds it, which every wake is.
 *
 * With no usable mount radius — an absent transition radius reads as 0 through
 * `mountRadiusOf`, as does a bump on something that is not airframe — the
 * derived term cannot be computed, so this falls back to the bare tolerance
 * rather than to asin(1) = 90°, which would fire on nearly every design.
 */
function wakeWindow(width: number, mountRadius: number): number {
  if (!(mountRadius > 0) || !(width > 0)) return IN_LINE_TOLERANCE;
  return Math.asin(Math.min(1, width / (2 * mountRadius))) + IN_LINE_TOLERANCE;
}

/**
 * A camera shroud (or protuberance) standing in front of a fin.
 *
 * WHAT THE APP DOES TODAY. It charges that fin its full normal force, as if the
 * shroud were not there. `treeModel.engineTree` lowers a shroud to an
 * INDEPENDENT 1-fin kernel surface, and the kernel's
 * `BarrowmanCalculator.calculateComponentNonAxialForces` (patches/…/
 * BarrowmanCalculator.java ll. 363–390) computes every component's instance
 * forces in isolation and merges them — there is no cross-component term
 * anywhere in it. Measured on a 54 mm fixture with the app's default 80×25×20
 * shroud 220 mm ahead of a 3-fin set: cpWorst 0.623443963 m, cnaWorst
 * 10.160125562, CD at M 0.3 0.693915199 — the same to ~15 significant digits
 * (max spread 1 ULP) with the shroud clocked at 0, 30, 45, 60, 90 and 180°.
 * Shroud clocking is invisible to every number the app shows. This function
 * changes none of them; it says so out loud, which is this repo's rule for a
 * known limit.
 *
 * WHY NO SIZE IS QUOTED. The evidence that the wake reaches the fins at all is
 * one qualitative sentence from @Buckeye's CFD — the camera's periodic wake
 * shedding *"can interact with the fins downstream"* — with no fin-force delta,
 * no alpha sweep and no clocking variation behind it. The standard wake
 * correlations (Schlichting far-wake similarity; Silverstein & Katzoff, the one
 * DATCOM 4.4.1 uses) were both applied to this geometry and both disqualified:
 * every gap a camera rocket actually has sits at x/(Cd·H) = 12–28 against a
 * validity floor near 50, the two disagree threefold on wake width, and one
 * returns a NEGATIVE dynamic pressure for an ordinary box shroud at a 100 mm
 * gap. Publishing a number off those would be inventing a calibration.
 *
 * WHY THE SENTENCE CLAIMS NO NET BIAS. This one term moves CP forward, and that
 * is worth saying. What it must NOT say is that the app's margin is therefore
 * optimistic overall: @Buckeye's own CFD puts Barrowman CP up to 2.3 calibers
 * TOO FAR FORWARD of his measurements, an order of magnitude the other way.
 * Both facts belong to the reader; the user guide carries the second.
 *
 * The app's own "▲ on a fin" snap button puts a shroud exactly here on purpose,
 * because that is where a camera gets the fin in shot. This is a stated
 * modelling limit on a reasonable build, not a mistake by the user, and the
 * sentence is worded that way.
 */
export function wakeShadowWarnings(tree: RocketTree): string[] {
  const out: string[] = [];
  // Stations in the rocket frame, WHOLE STACK — the same frame the rail check
  // chose, and the only frame in which "upstream of" means anything during
  // boost, when every stage is still attached and the margin matters.
  const stations = absoluteStations(tree);

  interface Source { name: string; angle: number; height: number; window: number; end: number }
  interface Downstream { owner: string; leading: number; angles: number[] }

  const checkFrame = (roots: ComponentNode[]) => {
    // The SAME frame walker the snap buttons and the rail check use, recursing
    // into assemblies separately for the same reason: a pod set rotates its
    // whole sub-chain, so a core-airframe shroud and a pod's fins are not
    // measured from one zero and must never be compared.
    const { members, assemblies } = collectFrame(roots);
    const sources: Source[] = [];
    const downstream: Downstream[] = [];

    for (const n of members) {
      const st = n.id ? stations.get(n.id) : undefined;
      if (!st) continue;
      if (WAKE_SOURCES.has(n.type as string)) {
        const height = num(n, 'height', 0);
        const width = num(n, 'width', 0);
        // No height off the surface, no bluff wake to reason about — and the
        // cutoff below is measured in heights, so it has nothing to divide by.
        if (!(height > 0)) continue;
        sources.push({
          name: nameOf(n, WAKE_SOURCE_NAME[n.type as string] ?? (n.type as string)),
          angle: reducePi(num(n, 'angleOffset', 0)),
          height,
          window: wakeWindow(width, mountRadiusOf(st.parent)),
          end: st.end,
        });
      } else if (isFinSet(n) && n.type !== 'tubefinset') {
        // Tube fins are excluded deliberately. `finAnglesAmong` happily returns
        // 6 instances for a tube fin ring, but a ring of tubes is a duct, not a
        // plate standing in a wake, and nothing in the corpus bears on what a
        // bump upstream of one does. Silence is the honest answer there.
        const c = Math.max(1, Math.round(num(n, 'finCount', 3)));
        const rot = num(n, 'rotation', 0);
        // The kernel's own instance spacing (FinSet.getInstanceAngles) — the
        // expression finAnglesAmong uses, and the one all three views mirror.
        const angles: number[] = [];
        for (let i = 0; i < c; i++) angles.push(reducePi(rot + (2 * Math.PI * i) / c));
        downstream.push({ owner: nameOf(n, 'Fins'), leading: st.start, angles });
      }
    }

    for (const s of sources) {
      for (const f of downstream) {
        // A wake needs somewhere downstream to go: the bump's AFT end has to be
        // strictly forward of the fin's leading edge. That is all this
        // condition is — it is NOT a claim about what the physics does when the
        // two overlap axially. (Measured: cpWorst reverts to the fins-only
        // value once the shroud's own CP is aft of it, with NO overlap at all,
        // because `getWorstCP` is a 360-step roll sweep that then picks the
        // plane where the shroud is edge-on. That reversion is an artefact of
        // the sweep, not of overlap; it is spelled out because reading it as an
        // overlap effect is the easy mistake and it has been made once already.)
        const gap = f.leading - s.end;
        if (!(gap > 0)) continue;
        if (gap > WAKE_REACH_HEIGHTS * s.height) continue;
        // Report the NEAREST instance of the set, once. A 6-fin set can put two
        // instances inside the window at different separations, which would
        // otherwise be two sentences about one piece of geometry.
        let nearest = Infinity;
        for (const a of f.angles) nearest = Math.min(nearest, angleGap(s.angle, a));
        if (!(nearest <= s.window)) continue;
        const mm = Math.round(gap * 1000);
        const heights = Number((gap / s.height).toFixed(1));
        // The name is QUOTED, unlike the rail sentences: `stripBrackets`
        // (simWarnings.ts ll. 73–75) strips a LEADING bracketed token from
        // every warning string, so a part someone called "[cam]" would lose its
        // name if the sentence opened with it bare.
        out.push(
          `"${s.name}" at ${deg(s.angle)} sits ${mm} mm ahead of a fin of "${f.owner}" — `
          + `${heights} times its own height upstream, ${deg(nearest)} off that fin's line. `
          + 'The wake it sheds is not modelled: that fin is flown at full free-stream dynamic '
          + 'pressure, so the CP shown is computed as if the shroud were not there. On its own '
          + 'that term moves CP forward, toward less margin — but nothing in hobby software '
          + 'models it and no measurement sizes it. Clocking it between the fins removes the '
          + 'question.',
        );
      }
    }

    for (const a of assemblies) checkFrame(a);
  };

  checkFrame(tree.components);

  // Two identical bumps (a pair of cable tunnels, say) raise one sentence.
  return [...new Set(out)];
}
