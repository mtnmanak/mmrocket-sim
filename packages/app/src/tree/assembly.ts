import type { ComponentNode } from '@online-openrocket/engine';
import { num } from './nodeNum.js';

/**
 * Geometry helpers for off-axis assemblies (PodSet / ParallelStage) — shared
 * by the 2D schematic, the 3D view, and (later) the .ork writer so all agree
 * on where a pod sits. All SI (metres, radians). Mirrors the kernel:
 * instances ring the parent axis at y = r·cosθ, z = r·sinθ (PodSet
 * getInstanceOffsets), and the RELATIVE radius is a gap from the parent
 * surface.
 */


/*
 * An assembly's AXIAL length — its own nose→body→transition chain, summed — is
 * `position.axialLength(pod)`, which reads each member at the kernel's length.
 * `assemblyChainLength` here was a second copy that read a cleared length as 0
 * (audit 2026-09-30, ledger row 373 regressed), so a pod with a cleared tube
 * was drawn and placed short in the 3D and side views while it flew long.
 */

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
