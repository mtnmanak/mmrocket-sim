import type { ComponentNode } from '@online-openrocket/engine';
import { CANOPY_DIAMETER_FALLBACK } from './canopyVent.js';
import { num, numOpt } from './nodeNum.js';

/** FreeformFinSet's constructor outline, metres (FreeformFinSet.java:30-34). */
export const KERNEL_DEFAULT_FIN_POINTS: readonly (readonly [number, number])[] = [
  [0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0],
];

/**
 * The material a part flies when its node states no density (SI: kg/m³ bulk,
 * kg/m² surface, kg/m line): the web engine's ApplicationPreferences shim
 * (`getDefaultComponentMaterial`), at the densities its Databases shim copies
 * from upstream. ComponentFactory sets a BULK material only for a density
 * above 0, so an absent or zero one flies Cardboard; a surface or line density
 * is set whenever it is stated, 0 included. A stated density with no material
 * name flies under the name "custom" (ComponentFactory `str(node,
 * "…MaterialName", "custom")`). `kernelDefaults.test.ts` reads both shims.
 */
export const KERNEL_DEFAULT_MATERIALS = {
  bulk: { name: 'Cardboard', density: 680 },
  surface: { name: 'Ripstop nylon', density: 0.067 },
  line: { name: 'Elastic cord (round 2 mm, 1/16 in)', density: 0.0018 },
} as const;

/**
 * WHAT AN ABSENT DIMENSION FLIES — the kernel bridge's own default for a node
 * that carries no `length`, `outerRadius`, `thickness`, `rootChord`, … : the
 * `dbl(node, key, default)` in `ComponentFactory.create` (and, for a ring's
 * wall, `applyPostAttachDimensions`), or, for the two app-only parts, what
 * `treeModel.engineTree` lowers them with.
 *
 * ONE TABLE (audit 2026-09-30). It began as `position.ts`'s LENGTH_DEFAULTS
 * (audit 2026-09-22, row 373), which fixed where a cleared-length part is
 * STATIONED; the parts themselves were still built from fallbacks each
 * consumer kept for itself, and they had drifted from the kernel and from each
 * other: an engine block printed 50 mm long where 5 mm flies, a body tube
 * 100 mm with a 1 mm wall where 300 mm with 0.3 mm flies, an inner tube drawn
 * 50 mm long and printed 100 mm, a trapezoid's tip 25 mm in the STL and DXF
 * but 30 mm on the paper template and 0.6 x the root in the side view.
 * `kernelDefaults.test.ts` reads ComponentFactory.java itself and builds every
 * consumer from a part with no dimension keys against it.
 *
 * Recovery gear's sizes and a mass component's mass are here too: Scale rocket
 * multiplies whatever a part flies, and a part that left them to the kernel
 * kept its size while the rocket grew round it (audit 2026-09-30, on review).
 *
 * ABSENT ON PURPOSE, because no constant is the kernel's answer:
 *  - an AUTOMATIC radius — a transition's ends (taken from its neighbours), a
 *    coupler's, ring's, bulkhead's or engine block's outer radius (the bore it
 *    sits in, which tree/solidContext.ts resolves), a tube-fin set's;
 *  - a tube-fin set's wall, which inherits its parent tube's
 *    (BodyTube.addChild; ComponentFactory.applyTubeFinThickness);
 *  - parachutes, streamers and shock cords' `length`: they have none. Their
 *    size along the axis is `packedLength`, below.
 * Callers keep their own placeholder for those, and say so where they use it.
 *
 * A recovery device's PACKED size is the one entry that is not a `dbl(node,
 * key, default)`: the bridge sets it only when the key is present
 * (ComponentFactory.applyPackedSize), so an absent one is MassObject's own
 * constructor value, 25 mm x 12.5 mm.
 */
const KERNEL_DEFAULTS: Record<string, Readonly<Record<string, number>>> = Object.assign(
  Object.create(null) as Record<string, Readonly<Record<string, number>>>, {
    nosecone: { length: 0.07, aftRadius: 0.012, thickness: 0.002 },
    transition: { length: 0.05, thickness: 0.002 },
    bodytube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003 },
    trapezoidfinset: { rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
    ellipticalfinset: { rootChord: 0.05, height: 0.03, thickness: 0.003 },
    freeformfinset: { thickness: 0.003 },
    tubefinset: { length: 0.1 },
    innertube: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 },
    tubecoupler: { length: 0.05, thickness: 0.0005 },
    centeringring: { length: 0.002 },
    bulkhead: { length: 0.002 },
    engineblock: { length: 0.005, thickness: 0.00095 },
    launchlug: { length: 0.05, outerRadius: 0.0022, thickness: 0.0003 },
    masscomponent: { length: 0.02, radius: 0.005, mass: 0.01 },
    parachute: { diameter: CANOPY_DIAMETER_FALLBACK, lineLength: 0.3, packedLength: 0.025, packedRadius: 0.0125 },
    streamer: { stripLength: 0.5, stripWidth: 0.05, packedLength: 0.025, packedRadius: 0.0125 },
    shockcord: { cordLength: 0.3, packedLength: 0.025, packedRadius: 0.0125 },
    // App-only parts, as engineTree lowers them. A shroud flies as a one-fin
    // strake whose root chord is its length; a protuberance as a zero-length
    // carrier at the bump's centre, so its length is the one the views draw
    // the bump with, which that centre is taken from.
    fairing: { length: 0.08, width: 0.025, height: 0.02 },
    protuberance: { length: 0.06, width: 0.02, height: 0.01 },
  },
);

/**
 * The kernel's default for an absent `key` on a part of `type` (SI), or
 * undefined where it has none — see the absences listed above.
 */
export function kernelDefault(type: string, key: string): number | undefined {
  const byType = KERNEL_DEFAULTS[type];
  return byType && Object.hasOwn(byType, key) ? byType[key] : undefined;
}

/**
 * A node's dimension as the kernel flies it: its own finite value, else the
 * kernel's default for its type. ONLY for a key this table holds for the
 * type — anything else reads NaN, loudly, rather than a quiet guess. Where the
 * kernel has no single value (an automatic radius) the caller keeps
 * `num(n, key, placeholder)` and its own placeholder, and says so.
 */
export function kernelNum(n: ComponentNode, key: string): number {
  return num(n, key, kernelDefault(n.type as string, key) ?? Number.NaN);
}

/**
 * The coefficient a parachute flies when no Cd is typed — the ONE copy, which
 * engineTree (tree/treeModel.ts, re-exported there), recoverySizing and the
 * file writers (kernelRecoveryCd) all read.
 *
 * `RecoveryDevice.cd` is initialised to `Parachute.DEFAULT_CD` (Parachute.java:17)
 * with `cdAutomatic = true`, and `Parachute.getComponentCD` returns that field
 * unchanged, so an untyped canopy flies exactly 0.80 at every Mach.
 * `ComponentFactory` calls `setCD` only for a finite `cd`, so leaving the key
 * OFF is the automatic path — never write this value into the engine tree.
 * A STREAMER has no constant: `Streamer.getComponentCD` computes one from
 * strip length and material density (kernelRecoveryCd below).
 */
export const KERNEL_DEFAULT_CD = 0.8;
/** Streamer.MAX_COMPUTED_CD (Streamer.java:13). */
const STREAMER_MAX_COMPUTED_CD = 0.4;

/**
 * The drag coefficient a parachute or streamer flies: its stated `cd`, which
 * the bridge pins (RecoveryDevice.setCD turns cdAutomatic off), else the
 * kernel's AUTOMATIC one — a recovery device starts cdAutomatic
 * (RecoveryDevice.java:26-27), and getCD returns getComponentCD: for a
 * parachute its DEFAULT_CD, for a streamer
 * 0.034·((ρ + 0.025)/0.105)·(L + 1)/L, at most 0.4 (Streamer.java:139-145),
 * ρ its surface density (Ripstop nylon when none is stated) and L its strip
 * length.
 */
export function kernelRecoveryCd(n: ComponentNode): number {
  const cd = numOpt(n, 'cd');
  if (cd !== undefined) return cd;
  if (n.type !== 'streamer') return KERNEL_DEFAULT_CD;
  const length = kernelNum(n, 'stripLength');
  const density = numOpt(n, 'surfaceDensity') ?? KERNEL_DEFAULT_MATERIALS.surface.density;
  return Math.min(0.034 * ((density + 0.025) / 0.105) * (length + 1) / length, STREAMER_MAX_COMPUTED_CD);
}
