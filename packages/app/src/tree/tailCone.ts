import type { ComponentNode } from '@online-openrocket/engine';
import { kernelNum } from './kernelDefaults.js';

/**
 * A FLIPPED NOSE CONE IS A TAIL CONE (.ork `<isflipped>`, desktop's "Flip to
 * tail cone"; format audit 2026-09-03 row 30): the same shape pointing AFT —
 * base forward, point aft, its shoulder at the front, plugging into the tube
 * ahead of it.
 *
 * The node keeps the FILE's convention whichever way the cone points:
 * `aftRadius` is the BASE radius and the unprefixed shoulder keys are the
 * base's shoulder. That is how NoseConeSaver writes them (`<aftradius>` is
 * getBaseRadius()), and the kernel moves them to the fore side itself
 * (NoseCone.setFlipped, called by ComponentFactory). So a reader of the base
 * radius — the reference diameter, the radius a part mounts on, Scale rocket —
 * reads it as before; only a reader that asks WHICH END is which asks here.
 */
export function isTailCone(n: ComponentNode): boolean {
  return n.type === 'nosecone' && n['flipped'] === true;
}

/** A nose cone's end radii, fore then aft, given its base radius: the point forward, or flipped, aft. */
export function noseEnds(n: ComponentNode, base: number): { fore: number; aft: number } {
  return isTailCone(n) ? { fore: base, aft: 0 } : { fore: 0, aft: base };
}

/**
 * A tail cone as the transition it is, for a format with no flipped nose
 * cone: desktop's RockSim exporter writes one so (StageDTO.toNoseConeDTO,
 * PodSetDTO) — fore radius the base, aft radius 0, the shoulder at the front.
 * The shape is carried explicitly: a nose cone's absent shape is ogive, a
 * transition's conical.
 */
export function tailConeAsTransition(n: ComponentNode): ComponentNode {
  const t: ComponentNode = {
    ...n,
    type: 'transition',
    shape: typeof n['shape'] === 'string' ? n['shape'] : 'ogive',
    // A nose cone's absent length flies 70 mm, a transition's 50 mm: carried.
    length: kernelNum(n, 'length'),
    foreRadius: kernelNum(n, 'aftRadius'),
    aftRadius: 0,
  };
  for (const key of ['Radius', 'Length', 'Thickness', 'Capped'] as const) {
    if (n[`shoulder${key}`] !== undefined) t[`foreShoulder${key}`] = n[`shoulder${key}`];
    delete t[`shoulder${key}`];
  }
  delete t['flipped'];
  return t;
}
