import type { ComponentNode, ComponentPosition } from '@online-openrocket/engine';

/**
 * Axial-position math shared by the 2D schematic (drag) and the property
 * panel (slider snapping). All SI. "start" = a child's leading edge measured
 * from its parent's leading edge.
 */

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

/** A component's axial extent used for positioning (fins use root chord). */
export function axialLength(n: ComponentNode): number {
  if (n.type === 'freeformfinset') {
    const pts = (n['points'] as [number, number][] | undefined) ?? [];
    return pts.length ? Math.max(...pts.map((p) => p[0])) : 0.05;
  }
  if (n.type === 'trapezoidfinset' || n.type === 'ellipticalfinset') {
    return num(n, 'rootChord', 0.05);
  }
  return num(n, 'length', num(n, 'packedLength', 0.025));
}

export function startFromPosition(pos: ComponentPosition, childLen: number, pLen: number): number {
  switch (pos.method) {
    case 'middle': return (pLen - childLen) / 2 + pos.offset;
    case 'bottom': return pLen - childLen + pos.offset;
    case 'absolute': return pos.offset;
    case 'top':
    default: return pos.offset;
  }
}

export function offsetForStart(method: ComponentPosition['method'], start: number, childLen: number, pLen: number): number {
  switch (method) {
    case 'middle': return start - (pLen - childLen) / 2;
    case 'bottom': return start - (pLen - childLen);
    case 'absolute': return start;
    case 'top':
    default: return start;
  }
}

/**
 * Candidate snap starts for a child inside its parent: the parent's ends and
 * middle, plus alignment with every sibling's ends — that's where parts sit
 * in the real airframe (centering rings at motor-tube and fin-root ends,
 * couplers butted against tubes, etc.).
 */
export function anchorStarts(parent: ComponentNode, child: ComponentNode): number[] {
  const pLen = num(parent, 'length', 0.2);
  const cLen = axialLength(child);
  const anchors = new Set<number>([0, pLen - cLen, (pLen - cLen) / 2]);
  for (const sib of parent.children ?? []) {
    if (sib.id === child.id) continue;
    const sLen = axialLength(sib);
    const pos = (sib.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
    const sStart = startFromPosition(pos, sLen, pLen);
    anchors.add(sStart);               // align leading edges
    anchors.add(sStart + sLen - cLen); // align trailing edges
    anchors.add(sStart - cLen);        // butt in front of the sibling
    anchors.add(sStart + sLen);        // butt behind the sibling
    // Fin tabs: centering rings butt against the tab's front/rear edges in
    // real builds (the tab passes through the wall between the rings).
    const tabH = num(sib, 'tabHeight', 0);
    const tabLen = num(sib, 'tabLength', 0);
    if (sib.type.endsWith('finset') && tabH > 0 && tabLen > 0) {
      const method = typeof sib['tabOffsetMethod'] === 'string'
        ? (sib['tabOffsetMethod'] as string) : 'middle';
      const off = num(sib, 'tabOffset', 0);
      const tabFront = sStart + (method === 'top' ? off
        : method === 'bottom' ? off + sLen - tabLen
        : off + (sLen - tabLen) / 2);
      anchors.add(tabFront - cLen);          // butt in front of the tab
      anchors.add(tabFront + tabLen);        // butt behind the tab
      anchors.add(tabFront);                 // align with tab front
      anchors.add(tabFront + tabLen - cLen); // align with tab rear
    }
  }
  return [...anchors].sort((a, b) => a - b);
}

/** Snaps a desired start to the nearest anchor within epsilon (else unchanged). */
export function snapStart(desired: number, anchors: number[], epsilon: number): number {
  let best = desired;
  let bestDist = epsilon;
  for (const a of anchors) {
    const d = Math.abs(a - desired);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}
