import type { ComponentNode } from '@online-openrocket/engine';
import { CANOPY_DIAMETER_FALLBACK } from './canopyVent.js';
import { num } from './nodeNum.js';

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
 *  - parachutes, streamers and shock cords' length: the bridge never sets it,
 *    so the kernel keeps MassObject's packed 25 mm — `axialLength`'s own
 *    fallback.
 * Callers keep their own placeholder for those, and say so where they use it.
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
    parachute: { diameter: CANOPY_DIAMETER_FALLBACK, lineLength: 0.3 },
    streamer: { stripLength: 0.5, stripWidth: 0.05 },
    shockcord: { cordLength: 0.3 },
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
