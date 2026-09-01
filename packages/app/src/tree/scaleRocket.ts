import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { classesFittingMount, diameterClass, nearestCommonClass } from '../services/motorDb.js';
import { motorMounts } from './treeModel.js';

/**
 * Scale a whole rocket by one factor — the "upscale/downscale a plan" workflow
 * (Eric, issues-2026-08-31a; researched in docs/research/scale-tool-research-
 * 2026-08-31.md; "I say go - build it", issues-2026-08-31c).
 *
 * WHY THIS IS A KEY LIST AND NOT A SCHEMA WALK
 * --------------------------------------------
 * `schema.ts`'s FIELDS table looks like the natural driver — every length is
 * declared `unit: 'mm' | 'm'`. It is the wrong driver twice over:
 *
 *  - It is INCOMPLETE. `ComponentNode` carries an open index signature, and the
 *    file importers write length-valued keys the schema never declares:
 *    a freeform fin's whole planform (`points`), ring/coupler/bulkhead
 *    `outerRadius` and `innerRadius`, `foreShoulderThickness`,
 *    `aftShoulderThickness`, `instanceSeparation` on rings and lugs,
 *    `filletRadius`, `overrideCGX`, and `radialPosition` on a mass component.
 *    A FIELDS-driven scaler leaves every freeform fin unchanged — which is
 *    Eric's own primary workflow — and puts original-size centering rings
 *    inside a doubled airframe.
 *  - It contains lengths that are NOT rocket geometry. `deployAltitude` is
 *    declared `unit: 'm'` and is an altitude AGL; scaling it moves the
 *    deployment of every altimeter-triggered chute.
 *
 * So the lists below are explicit, per type, and a key is scaled only when it
 * is ALREADY PRESENT as a number. That last rule matters: absence is a value
 * in this tree — an absent transition radius means AUTOMATIC, an absent ring
 * radius means "size yourself off the parent", an absent tube-fin radius means
 * the touching-circle formula. Writing `k × (value ?? default)` would turn
 * every one of those into a frozen explicit number and change the design.
 *
 * WHAT DOES NOT SCALE, AND WHY (Eric, issues-2026-08-31c)
 * ------------------------------------------------------
 * "things like camera shrouds and rail buttons can't 'scale' - a camera is
 * always the same size, it doesn't change. Rail buttons functionally only come
 * in preset sizes (micro, mini, 1010, 1515, unistrut)".
 *
 * The rule that generalises: a part whose size is set by something OUTSIDE the
 * rocket keeps its size and only moves to its new station. That is the camera
 * shroud (the camera is the camera), the rail button (the rail is the rail),
 * and — the same argument, extended here — a launch lug's BORE, which is set
 * by the launch rod, though its length is a design choice and does scale.
 *
 * Angles, counts, densities, drag coefficients, surface finish, cluster
 * spacing (a ratio, already scale-free), motor selection, deployment and
 * separation settings, and the pad conditions are all untouched.
 *
 * ONE PLACE THE RESULT IS DELIBERATELY NOT GEOMETRICALLY SIMILAR
 * -------------------------------------------------------------
 * Densities are left alone, so every SOLID part's mass follows its volume and
 * goes as k³ — measured exactly on the app's default rocket, nose/tube/fins/
 * mount all land on 8.000x at k = 2. A parachute does not: its canopy is a
 * SURFACE density and its lines a LINE density, so the canopy goes as k² and
 * the lines as k (7.976 g -> 22.184 g at k = 2, not 63.8 g).
 *
 * That is correct for a real build — nobody buys thicker ripstop for a bigger
 * rocket — but it means a design carrying recovery gear is NOT exactly
 * similar, and its stability in calibers shifts a little (2.408 -> 2.264 cal
 * on that same rocket). `scaleRocket.test.ts` pins both halves: exact
 * similarity for a structure-only design, and the recovery exception.
 */

const num = (n: ComponentNode, key: string): number | null =>
  typeof n[key] === 'number' && Number.isFinite(n[key] as number) ? (n[key] as number) : null;

/**
 * Length-valued keys per component type. Present-only, multiplied by k.
 *
 * Keys NOT in a list are deliberate, and the ones a reader will ask about are
 * commented where they are omitted.
 */
const LENGTH_KEYS: Record<string, readonly string[]> = {
  nosecone: ['length', 'aftRadius', 'thickness',
    'shoulderRadius', 'shoulderLength', 'shoulderThickness'],
  // foreRadius/aftRadius absent = AUTOMATIC; present-only keeps it that way.
  transition: ['length', 'foreRadius', 'aftRadius', 'thickness',
    'foreShoulderRadius', 'foreShoulderLength', 'foreShoulderThickness',
    'aftShoulderRadius', 'aftShoulderLength', 'aftShoulderThickness'],
  // motorOverhang is how far the MOTOR protrudes past the tube — retention
  // practice (~6 mm), referenced to the motor, not the airframe. Not scaled.
  bodytube: ['length', 'outerRadius', 'thickness'],
  trapezoidfinset: ['rootChord', 'tipChord', 'sweep', 'height', 'thickness',
    'airfoilLeDiamond', 'airfoilTeDiamond', 'finLeRadius',
    'tabHeight', 'tabLength', 'tabOffset', 'filletRadius'],
  // `points` is the whole planform and is handled separately below.
  freeformfinset: ['thickness',
    'airfoilLeDiamond', 'airfoilTeDiamond', 'finLeRadius',
    'tabHeight', 'tabLength', 'tabOffset', 'filletRadius'],
  ellipticalfinset: ['rootChord', 'height', 'thickness',
    'airfoilLeDiamond', 'airfoilTeDiamond', 'finLeRadius',
    'tabHeight', 'tabLength', 'tabOffset', 'filletRadius'],
  // outerRadius absent = the touching-circle formula, which scales itself.
  tubefinset: ['length', 'outerRadius', 'thickness'],
  innertube: ['length', 'outerRadius', 'thickness', 'radialPosition', 'maxMotorLength'],
  tubecoupler: ['length', 'thickness', 'outerRadius', 'innerRadius'],
  centeringring: ['length', 'outerRadius', 'innerRadius', 'instanceSeparation'],
  bulkhead: ['length', 'outerRadius', 'instanceSeparation'],
  engineblock: ['length', 'thickness', 'outerRadius'],
  // A lug's BORE is the launch rod's diameter — 1/8", 3/16", 1/4" — and rods
  // do not scale. Its length is a design choice and does.
  launchlug: ['length', 'instanceSeparation'],
  // A rail button is a catalogue part (micro / mini / 1010 / 1515 / unistrut).
  // The SPACING between a pair is an airframe span and does scale.
  railbutton: ['instanceSeparation'],
  // spillHoleDiameter must track `diameter` — the effective-Cd model is
  // cd·(1−(d/D)²), so only the ratio matters, and scaling both preserves it.
  parachute: ['diameter', 'spillHoleDiameter', 'lineLength'],
  streamer: ['stripLength', 'stripWidth'],
  shockcord: ['cordLength'],
  masscomponent: ['length', 'radius', 'radialPosition'],
  // A camera shroud is sized by the camera inside it. Nothing here.
  fairing: [],
  // A protuberance is a bump the user typed dimensions for rather than a
  // catalogue part, so it scales with the airframe it is on.
  protuberance: ['width', 'height', 'length'],
  podset: ['radiusOffset'],
  parallelstage: ['radiusOffset'],
  // nozzleExitDiameter is the MOTOR's nozzle, used for power-on base drag.
  stage: [],
};

/** Types whose own geometry is fixed hardware — they move, they do not grow. */
const FIXED_SIZE = new Set(['fairing', 'railbutton']);

/** Mass keys — scaled only on parts whose geometry actually scaled. */
const MASS_KEYS = ['mass', 'overrideMass'] as const;

/**
 * The exponent a PINNED mass scales by, per type.
 *
 * It has to match how the same part's COMPUTED mass scales, or a design where
 * the user pinned a weight behaves differently from one where they did not —
 * and a preset pins one automatically (`presets.presetPatch` writes
 * `overrideMass` for any catalogue row carrying a mass, which most parachutes
 * do). Densities are untouched by the scale, so:
 *   - a solid part is a volume: k³
 *   - a canopy or a streamer is a SURFACE density on an area: k²
 *   - a shock cord is a LINE density on a length: k
 * Getting this wrong is not subtle — a catalogued 85 g chute came out at 680 g
 * instead of 340 g, while the summary printed beside it said recovery gear does
 * not go as the cube.
 */
const MASS_EXPONENT: Record<string, number> = {
  parachute: 2,
  streamer: 2,
  shockcord: 1,
};

export interface ScaleResult {
  tree: RocketTree;
  /** Notice lines, headline first (NoticeBar shows only line 1 collapsed). */
  notes: string[];
  /**
   * Something in `notes` needs the user to act — a loaded motor that no longer
   * fits the scaled bore, or a mount left off-class. The caller raises the
   * notice severity on this, so the bar opens itself instead of hiding the
   * warning behind a collapsed headline.
   */
  needsAttention: boolean;
}

export interface ScaleOptions {
  /**
   * After scaling, snap every motor mount's bore to the nearest standard motor
   * size. Off by default: the scaled tube is the honest geometric answer, and
   * the summary says which class it landed near either way.
   */
  snapMounts?: boolean;
  /** Motor diameters currently assigned, by mount id (m), for the fit report. */
  assignedMotorDiameters?: Record<string, number>;
}

/** The rocket's greatest body diameter (m) — what a "scale to a tube" factor divides. */
export function maxBodyDiameter(tree: RocketTree): number {
  let r = 0;
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      const t = n.type as string;
      if (t === 'bodytube') r = Math.max(r, num(n, 'outerRadius') ?? 0);
      else if (t === 'nosecone') r = Math.max(r, num(n, 'aftRadius') ?? 0);
      else if (t === 'transition') {
        r = Math.max(r, num(n, 'foreRadius') ?? 0, num(n, 'aftRadius') ?? 0);
      }
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return r * 2;
}

/**
 * Total nose-to-tail length (m) of the CORE axial chain, stages summed.
 *
 * Does not descend into a pod set or a parallel booster: those hang off the
 * side and their own nose cones and tubes are not part of the rocket's length.
 * Adding them made the dialog's headline read a strap-on design as core plus
 * every booster laid end to end.
 */
export function rocketLength(tree: RocketTree): number {
  const CHAIN = new Set(['nosecone', 'bodytube', 'transition']);
  const OFF_AXIS = new Set(['podset', 'parallelstage']);
  let total = 0;
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      const t = n.type as string;
      if (OFF_AXIS.has(t)) continue;
      if (CHAIN.has(t)) total += num(n, 'length') ?? 0;
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return total;
}

/**
 * A motor mount's wall (m). ONE definition, because the bore reader and the
 * snap writer disagreeing about what an absent thickness means put the snapped
 * tube 1 mm off the class it reported: the reader assumed the kernel's 0.5 mm
 * default and the writer assumed none.
 */
const mountWall = (n: ComponentNode): number => num(n, 'thickness') ?? 0.0005;

/** A motor mount's bore (m): outer radius less wall, or the outer radius for a case airframe. */
export function mountBore(n: ComponentNode): number {
  const or = num(n, 'outerRadius') ?? 0.0095;
  if (n['caseAirframe'] === true) return or * 2;
  return (or - mountWall(n)) * 2;
}

/**
 * How close a scaled bore has to be to a standard casing size to count as
 * being ON it. One constant: the same test was written out four times across
 * two files, so changing it meant four coordinated edits and one miss made the
 * dialog's list disagree with its own checkbox.
 */
export const CLASS_TOLERANCE_MM = 0.05;

/**
 * A mount node as `scaleNode` will leave it — outer radius and any PRESENT
 * wall multiplied, an absent wall left absent. Only the two keys `mountBore`
 * reads; this exists so the preview and the applied tree cannot disagree.
 */
function scaledMountShape(n: ComponentNode, k: number): ComponentNode {
  const out: ComponentNode = { ...n };
  const or = num(n, 'outerRadius');
  if (or !== null) out['outerRadius'] = or * k;
  const th = num(n, 'thickness');
  if (th !== null) out['thickness'] = th * k;
  return out;
}

export interface MountPreview {
  id: string;
  name: string;
  /** Bore before and after, in mm. */
  boreMm: number;
  scaledBoreMm: number;
  /** Nearest standard motor size to the scaled bore (mm). */
  nearestMm: number;
  /** The bore the user will really get, given the snap setting and mount type. */
  finalBoreMm: number;
  /** Is the scaled bore already a standard casing size? */
  onStandardClass: boolean;
  /** Can snapping do anything here — an inner tube that is not already on a class? */
  snappable: boolean;
  /** The assigned motor's class (mm), when one is loaded. */
  motorMm: number | null;
  /** True when the mount IS the airframe (a body tube with motorMount) — never snapped. */
  isAirframe: boolean;
  /**
   * Does the assigned motor still fit the bore the user will actually get?
   * Snapping changes the answer: a mount scaled to just under a class and then
   * snapped UP to it fits again, and warning about it anyway trains people to
   * ignore the warning.
   */
  motorStillFits: boolean;
}

/**
 * What each motor mount becomes under `factor` — the dialog's live preview and
 * the ruling Eric gave for mounts: scale them like desktop does, then check
 * against the standard classes and ask, because "18 mm × 2.27 = 40.86 mm" is
 * not a motor you can buy (Apogee's own worked example).
 */
export function previewMounts(
  tree: RocketTree, factor: number, assigned: Record<string, number> = {},
  snapMounts = false,
): MountPreview[] {
  return motorMounts(tree).map((m) => {
    const boreMm = mountBore(m) * 1000;
    // NOT boreMm * factor. `scaleNode` multiplies a thickness key only when it
    // is PRESENT — an absent wall stays absent, and the kernel keeps applying
    // its own 0.5 mm default to the scaled tube. Multiplying the whole bore by
    // k assumes the default wall scales too, so on a mount with a blanked
    // thickness the preview and the applied tree disagreed by 2·0.0005·(k−1):
    // "28.0 → 56.0 mm" against a real 57.0 mm at k = 2. This is the same
    // reader/writer split `mountWall` closed on the snap path, still open here.
    const scaledBoreMm = mountBore(scaledMountShape(m, factor)) * 1000;
    const nearestMm = nearestCommonClass(scaledBoreMm);
    const motorM = m.id ? assigned[m.id] : undefined;
    const motorMm = typeof motorM === 'number' ? motorM * 1000 : null;
    // A min-diameter mount IS the airframe and is never snapped, so its bore
    // stays the scaled one whatever the checkbox says.
    const isAirframe = m.type !== 'innertube';
    const onStandardClass = Math.abs(scaledBoreMm - nearestMm) < CLASS_TOLERANCE_MM;
    // Snapping is only OFFERED, and only DONE, for an inner tube that is not
    // already on a class.
    const snappable = !isAirframe && !onStandardClass;
    const finalBoreMm = snapMounts && snappable ? nearestMm : scaledBoreMm;
    return {
      id: m.id ?? '',
      name: m.name ?? 'Motor mount',
      boreMm,
      scaledBoreMm,
      nearestMm,
      finalBoreMm,
      onStandardClass,
      snappable,
      motorMm,
      isAirframe,
      motorStillFits: motorMm === null
        || classesFittingMount(finalBoreMm).includes(diameterClass(motorMm)),
    };
  });
}

const round = (x: number, places = 12): number => {
  const p = 10 ** places;
  return Math.round(x * p) / p;
};

/** Scales one node's own fields. Children are handled by the caller. */
function scaleNode(n: ComponentNode, k: number): ComponentNode {
  const type = n.type as string;
  const fixed = FIXED_SIZE.has(type);
  const out: ComponentNode = { ...n };

  for (const key of LENGTH_KEYS[type] ?? []) {
    const v = num(n, key);
    if (v !== null) out[key] = round(v * k);
  }

  // A freeform fin's planform lives entirely in `points` — [x along the body,
  // y off the surface], metres. Both coordinates scale. This is the path Eric
  // designs on, so it is the one that must not be missed.
  if (Array.isArray(n['points'])) {
    const pts = n['points'] as unknown[];
    out['points'] = pts.map((p) => (Array.isArray(p) && p.length >= 2
      && typeof p[0] === 'number' && typeof p[1] === 'number'
      ? [round((p[0] as number) * k), round((p[1] as number) * k)]
      : p));
  }

  // Masses go as k³ — but only where the geometry moved. A camera shroud and a
  // rail button are the same physical part after scaling and weigh the same.
  // (Densities are untouched, so every COMPUTED mass follows its geometry on
  // its own; these two keys are the ones a user pinned by hand or a preset
  // pinned from a catalogue.)
  if (!fixed) {
    const exp = MASS_EXPONENT[type] ?? 3;
    for (const key of MASS_KEYS) {
      const v = num(n, key);
      if (v !== null) out[key] = round(v * k ** exp, 15);
    }
    // An override CG is a station measured from the component's own front — a
    // length, whatever the mass above it does. It belongs INSIDE the
    // !fixed guard: a rail button that kept its 9.7 mm size must keep the CG
    // station measured within it, or the override points outside the part.
    const cg = num(n, 'overrideCGX');
    if (cg !== null) out['overrideCGX'] = round(cg * k);
  }

  // Axial placement. startFromPosition is homogeneous of degree 1 in
  // (parentLength, childLength, offset) for all four methods, so scaling the
  // offset alongside the two lengths keeps every part at the same relative
  // station — including the fixed-size ones, which is desktop's rule too
  // (its "Scale component offsets" box, on for a whole-rocket scale).
  const pos = n.position as ComponentPosition | undefined;
  if (pos && typeof pos.offset === 'number') {
    out.position = { ...pos, offset: round(pos.offset * k) };
  }

  return out;
}

/**
 * Scales the whole design by `factor`, returning a new tree plus the lines the
 * app shows afterwards. Pure — the input tree is untouched.
 */
export function scaleRocket(
  tree: RocketTree, factor: number, opts: ScaleOptions = {},
): ScaleResult {
  const k = factor;
  if (!(k > 0) || !Number.isFinite(k) || k === 1) {
    return { tree, notes: [], needsAttention: false };
  }

  const fixedSeen = new Set<string>();
  const lugSeen = new Set<string>();
  let finSets = 0;
  let massPinned = 0;
  let recovery = false;

  const walk = (nodes: ComponentNode[]): ComponentNode[] => nodes.map((n) => {
    const type = n.type as string;
    if (FIXED_SIZE.has(type)) fixedSeen.add(type);
    if (type === 'launchlug') lugSeen.add(type);
    if (type.endsWith('finset')) finSets++;
    if (type === 'parachute' || type === 'streamer' || type === 'shockcord') recovery = true;
    // Both MASS_KEYS, on every type that is not fixed-size. `mass` is a
    // user-typed weight wherever it appears — a mass component and a
    // protuberance both carry one, and both are scaled by scaleNode — so
    // naming only `masscomponent` here left a protuberance's weight cubed
    // silently. Drive it off the same list scaleNode uses, not off a type.
    if (!FIXED_SIZE.has(type) && MASS_KEYS.some((key) => num(n, key) !== null)) massPinned++;
    const scaled = scaleNode(n, k);
    return n.children ? { ...scaled, children: walk(n.children) } as ComponentNode : scaled;
  });

  let next: RocketTree = { ...tree, components: walk(tree.components) };

  // Motor mounts: scaled geometrically like desktop, then optionally snapped to
  // a real motor size. Snapping preserves the WALL and moves the outer radius,
  // so the bore is exactly the standard class and the tube stays buildable.
  const mountNotes: string[] = [];
  const mounts = previewMounts(tree, k, opts.assignedMotorDiameters ?? {}, opts.snapMounts);
  if (opts.snapMounts && mounts.length) {
    const wanted = new Map(mounts.filter((m) => m.snappable).map((m) => [m.id, m.nearestMm / 1000]));
    const snap = (nodes: ComponentNode[]): ComponentNode[] => nodes.map((n) => {
      const target = n.id ? wanted.get(n.id) : undefined;
      let out = n;
      // ONLY an inner tube. A body tube carrying `motorMount` is the
      // minimum-diameter case, where the mount IS the airframe — snapping its
      // outer radius would silently resize the rocket's skin and leave it
      // discontinuous with the nose cone above it. Those mounts are reported
      // in the summary and left for the user to resize deliberately.
      if (target !== undefined) {
        // The wall here is the SCALED wall (this runs on the scaled tree), so
        // the snapped tube keeps the proportions the scale gave it and only
        // its bore lands on the standard size.
        out = { ...n, outerRadius: round(target / 2 + mountWall(n)) } as ComponentNode;
      }
      return out.children ? { ...out, children: snap(out.children) } as ComponentNode : out;
    });
    next = { ...next, components: snap(next.components) };
  }
  for (const m of mounts) {
    const landed = m.onStandardClass;
    const head = `${m.name}: ${m.boreMm.toFixed(1)} mm bore becomes ${m.scaledBoreMm.toFixed(1)} mm`;
    if (opts.snapMounts && !landed && m.isAirframe) {
      mountNotes.push(`${head}, which is not a standard motor size (nearest is ${m.nearestMm} mm)`
        + ' — and it was NOT snapped, because this mount IS the airframe (a minimum-diameter'
        + ' design). Resize it yourself so the tube above it still matches.');
    } else if (opts.snapMounts && !landed) {
      mountNotes.push(`${head} — snapped to the standard ${m.nearestMm} mm.`);
    } else if (landed) {
      mountNotes.push(`${head}, which is the standard ${m.nearestMm} mm.`);
    } else {
      mountNotes.push(`${head}, which is not a standard motor size `
        + `(nearest is ${m.nearestMm} mm) — pick the mount you can actually build.`);
    }
    if (m.motorMm !== null && !m.motorStillFits) {
      // Name the bore that actually rejected it — the FINAL one, which is the
      // snapped bore when snapping applied. Naming the scaled bore there sent
      // the user to look at a number that was not the problem.
      //
      // There is deliberately no "the snap is what lost it" branch: snapping
      // goes to the NEAREST class, so a motor the scaled bore accepted is
      // accepted by the snapped bore too for every real casing size. Writing
      // that branch anyway produced code no test could reach.
      mountNotes.push(`${m.name}: the ${m.motorMm.toFixed(0)} mm motor loaded in it no longer `
        + `fits the ${m.finalBoreMm.toFixed(1)} mm bore. Choose another motor on `
        + 'Motors & Launch.');
    }
  }

  const pct = `${(k * 100).toFixed(1)} %`;
  const notes: string[] = [
    `Scaled the whole design to ${pct} — ${(rocketLength(tree) * 1000).toFixed(0)} mm long`
    + ` and ${(maxBodyDiameter(tree) * 1000).toFixed(1)} mm across becomes`
    + ` ${(rocketLength(next) * 1000).toFixed(0)} mm and`
    + ` ${(maxBodyDiameter(next) * 1000).toFixed(1)} mm.`,
    'Scaled: every length, diameter, wall thickness, fin planform (freeform points included),'
    + ' shoulder, tab, fillet, chute and streamer size, cord length, and every axial position.',
    'Not scaled, on purpose: angles, fin and instance counts, material densities, drag'
    + ' coefficients, surface finish, motor choice, deployment and separation settings, and'
    + ' the launch conditions.',
    'Check the per-stage Max motor length on Motors & Launch if you have set one: it lives'
    + ' outside the design tree, so this did not touch it, and it is still filtering motors'
    + ' against the rocket you had before.',
  ];
  if (fixedSeen.size) {
    // Sorted so the sentence reads the same whatever order the tree holds
    // them in — a note that reorders itself is a note nobody can test.
    const which = ['fairing', 'railbutton'].filter((t) => fixedSeen.has(t))
      .map((t) => (t === 'fairing' ? 'camera shrouds' : 'rail buttons'));
    notes.push(`${which.join(' and ')} kept their size — a camera is the same camera and a rail`
      + ' button comes in fixed sizes (micro, mini, 1010, 1515, unistrut). They moved to their new'
      + ' stations, and the spacing between a pair of buttons did scale. Check they still suit'
      + ' the new airframe.');
  }
  if (lugSeen.size) {
    notes.push('A launch lug kept its bore — that is the launch rod’s diameter, and rods come'
      + ' in fixed sizes. Its length scaled.');
  }
  if (massPinned) {
    notes.push(`${massPinned} pinned mass${massPinned === 1 ? '' : 'es'} scaled the same way that`
      + ' part’s own material would — the cube of the factor for a solid part, the square for a'
      + ' canopy, the factor for a cord — and any pinned CG station by the factor, which is what'
      + ' keeps the balance point at the same percentage of the length. If a pinned mass was a'
      + ' real part you weighed, it is now a guess: re-weigh it.');
  }
  notes.push(...mountNotes);
  // MEASURED, not assumed: on the app's own default rocket a 2x scale takes the
  // structure to exactly 8x (nose 34.133 -> 273.064 g, tube 50.928 -> 407.422,
  // fins 58.752 -> 470.016, mount 11.066 -> 88.528) while the parachute goes
  // 7.976 -> 22.184 g, because a canopy is fabric of a fixed thickness and its
  // shroud lines are line. That is the RIGHT answer for a real build — you do
  // not buy thicker ripstop for a bigger rocket — but it means a scaled design
  // carrying recovery gear is not exactly similar, and its stability in
  // calibers moves a little (2.41 -> 2.26 cal on that rocket).
  if (recovery) {
    notes.push('Recovery gear is fabric and line, so it does NOT go as the cube: a canopy scales'
      + ' with its area and shroud lines with their length, because that is what you would really'
      + ' build. Two consequences. The design is not exactly similar any more, so the stability'
      + ' margin shifts slightly. And descent rate goes as roughly the square root of the factor —'
      + ` this one lands about ${Math.sqrt(k).toFixed(2)}x as fast — so size the canopy for the`
      + ' new mass rather than trusting the scaled one.');
  }
  notes.push('What a simulator cannot scale, and neither can anything else: Reynolds number, so'
    + ' a downscale flies in proportionally lazier air; the ratio of inertia to aerodynamic'
    + ' moment, so it damps differently; and surface finish, since microns stay microns. The'
    + ' flight is re-computed for the new size rather than assumed — expect different numbers,'
    + ' and treat a big downscale with suspicion.');
  notes.push('Ctrl+Z undoes the whole scale in one step. Use Save As to keep it under a new name'
    + ' — your original file on disk is untouched.');

  if (finSets === 0) {
    notes.push('This design has no fin set, so nothing here checks its stability.');
  }

  const needsAttention = mounts.some((m) => !m.motorStillFits
    || (!m.onStandardClass && !(opts.snapMounts && m.snappable)));
  return { tree: next, notes, needsAttention };
}
