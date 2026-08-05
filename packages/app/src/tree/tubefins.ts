import type { ComponentNode } from '@online-openrocket/engine';

/**
 * Tube-fin tube radius (m). When the set carries no explicit outerRadius the
 * kernel's "auto" rule applies: N tubes just touching each other around the
 * body — r = R·sin(π/N) / (1 − sin(π/N)) (TubeFinSet.getOuterRadius).
 */
export function tubeFinRadius(node: ComponentNode, bodyRadius: number): number {
  const explicit = node['outerRadius'];
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const n = Math.max(1, Math.round(typeof node['finCount'] === 'number' ? (node['finCount'] as number) : 6));
  // Kernel rule (TubeFinSet.getOuterRadius): fewer than 3 fins auto-size to
  // the body radius — and n=2 would divide by zero below (sin π/2 = 1).
  if (n < 3) return bodyRadius;
  const s = Math.sin(Math.PI / n);
  return (bodyRadius * s) / (1 - s);
}

/**
 * The largest tube radius (m) at which N tubes around a body of radius R
 * don't collide — the touching radius. Undefined (null) below 3 fins:
 * 1–2 tubes can never meet each other around the body.
 */
export function tubeFinMaxRadius(finCount: number, bodyRadius: number): number | null {
  const n = Math.round(finCount);
  if (n < 3) return null;
  const s = Math.sin(Math.PI / n);
  return (bodyRadius * s) / (1 - s);
}

/**
 * The largest fin count for which tubes of radius r around a body of radius R
 * don't collide: N ≤ π / asin(r / (R + r)). Never below 2.
 */
export function tubeFinMaxCount(outerRadius: number, bodyRadius: number): number {
  if (!(outerRadius > 0) || !(bodyRadius > 0)) return 2;
  const ratio = Math.min(1, outerRadius / (bodyRadius + outerRadius));
  return Math.max(2, Math.floor(Math.PI / Math.asin(ratio) + 1e-9));
}
