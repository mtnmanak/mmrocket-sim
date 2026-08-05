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
  const s = Math.sin(Math.PI / n);
  return n === 1 ? bodyRadius : (bodyRadius * s) / (1 - s);
}
