import type { ComponentNode } from '@online-openrocket/engine';

/**
 * Geometry helpers for off-axis assemblies (PodSet / ParallelStage) — shared
 * by the 2D schematic, the 3D view, and (later) the .ork writer so all agree
 * on where a pod sits. All SI (metres, radians). Mirrors the kernel:
 * instances ring the parent axis at y = r·cosθ, z = r·sinθ (PodSet
 * getInstanceOffsets), and the RELATIVE radius is a gap from the parent
 * surface.
 */

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

/** The assembly's own axial chain members (a mini nose→body→transition stack). */
const CHAIN_TYPES = new Set(['nosecone', 'bodytube', 'transition']);

/** Total axial length of the assembly's own body chain (m). */
export function assemblyChainLength(pod: ComponentNode): number {
  return (pod.children ?? [])
    .filter((c) => CHAIN_TYPES.has(c.type))
    .reduce((s, c) => s + num(c, 'length', 0), 0);
}

/** Largest outer radius among the assembly's own body chain (m). */
export function assemblyBoundingRadius(pod: ComponentNode): number {
  let r = 0;
  for (const c of pod.children ?? []) {
    if (c.type === 'nosecone') r = Math.max(r, num(c, 'aftRadius', 0));
    else if (c.type === 'bodytube') r = Math.max(r, num(c, 'outerRadius', 0));
    else if (c.type === 'transition') r = Math.max(r, num(c, 'foreRadius', 0), num(c, 'aftRadius', 0));
  }
  return r;
}

/**
 * Distance (m) from the PARENT centerline to the assembly's centerline.
 * - RELATIVE (default): `radiusOffset` is a GAP from the parent surface, so
 *   the resolved radius = offset + parentOuterRadius + assemblyBoundingRadius
 *   (offset 0 ⇒ the pod just touches the airframe).
 * - FREE: `radiusOffset` is measured straight from the parent centerline.
 */
export function resolveAssemblyRadius(pod: ComponentNode, parentOuterRadius: number): number {
  const offset = num(pod, 'radiusOffset', 0);
  const method = typeof pod['radiusMethod'] === 'string' ? (pod['radiusMethod'] as string) : 'relative';
  if (method === 'free') return offset;
  return offset + parentOuterRadius + assemblyBoundingRadius(pod);
}

export interface RingInstance { y: number; z: number; angle: number }

/**
 * The `count` instance centers around the parent axis at `radius`, spaced
 * evenly from `angleOffset` (rad). y = r·cosθ, z = r·sinθ — the kernel's
 * PodSet convention. The 2D view projects `y` and ignores `z`.
 */
export function ringInstanceOffsets(count: number, radius: number, angleOffset = 0): RingInstance[] {
  const n = Math.max(1, Math.round(count));
  const out: RingInstance[] = [];
  for (let i = 0; i < n; i++) {
    const angle = angleOffset + (2 * Math.PI * i) / n;
    out.push({ y: radius * Math.cos(angle), z: radius * Math.sin(angle), angle });
  }
  return out;
}

export function isAssembly(type: string): boolean {
  return type === 'podset' || type === 'parallelstage';
}
