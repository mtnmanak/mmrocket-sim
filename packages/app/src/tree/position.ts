import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { assemblyChainLength, isAssembly } from './assembly.js';
import { num } from './nodeNum.js';

/**
 * Axial-position math shared by the 2D schematic (drag) and the property
 * panel (slider snapping). All SI. "start" = a child's leading edge measured
 * from its parent's leading edge.
 */


/**
 * The axial length a component is POSITIONED by — `RocketComponent.getLength()`
 * as the kernel reads it when it resolves a station
 * (`RocketComponent.java:1618`, `AxialMethod.java:74/94`: 'middle' and
 * 'bottom' both subtract this from the parent's length). It is the ANCHORING
 * question only; "how far aft does the drawn shape reach" is `drawnExtent`
 * below, and the two differ for exactly one shape.
 *
 * FREEFORM FIN: the ROOT CHORD — the last point's x (`FreeformFinSet.java:448`,
 * re-asserted at `:494` and `:546`), NOT the furthest-aft point of the outline.
 * They differ when the tip's trailing corner overhangs the root's, a shape the
 * fin editor draws without complaint. From 2026-07-03 (`e360a43`) to v0.116
 * this returned max-x, so every 'bottom'/'middle'-anchored overhanging fin was
 * drawn, dragged and exported FORWARD of where the kernel flew it, by the
 * overhang — 119.50 mm on `ninja_4in_54mm-MMT.ork`, 12.70 mm on `Wildman Mach
 * 2 this one.ork` — while the property panel printed the kernel's station two
 * inches away. Nothing about the flight changes with this line: the kernel
 * never read it (docs/research/freeform-fin-axiallength-2026-09-07.md).
 *
 * RAIL BUTTON: ZERO, the kernel's own (`RocketComponent.java:86` declares
 * `length = 0` and RailButton never assigns it; its bounding box sits ±OD/2
 * ABOUT the station, so the station is the button's centre). A button carries
 * no `length` key, so the tail below used to answer 25 mm and "Auto-place rail
 * buttons" missed the CG by half that. The branch lived in `kernelLength.ts`
 * (v0.105) until the freeform split above made this function the one place
 * for the kernel's frame; that file's own comment asked for the fold.
 */
export function axialLength(n: ComponentNode): number {
  if (n.type === 'freeformfinset') {
    const pts = (n['points'] as [number, number][] | undefined) ?? [];
    return pts.length ? pts[pts.length - 1]![0] : 0.05;
  }
  if (n.type === 'trapezoidfinset' || n.type === 'ellipticalfinset') {
    return num(n, 'rootChord', 0.05);
  }
  if (n.type === 'railbutton') return 0;
  if (isAssembly(n.type)) return assemblyChainLength(n);
  return num(n, 'length', num(n, 'packedLength', 0.025));
}

/**
 * How far aft of its OWN leading edge a component's drawn shape reaches — the
 * EXTENT question, for the silhouette's hover box, the fin-overlap tests that
 * auto-rotate a second fin set (finAlign.ts, rocksimFile.ts) and the trailing
 * edge `absoluteStations` reports. Only a freeform fin answers differently
 * from `axialLength`: its outline may overhang its root, and the overhang is
 * real geometry that another fin can collide with even though the kernel's
 * length stops at the root trailing corner. Never use this to resolve a
 * station — that is `axialLength`, and the split is the whole point.
 */
export function drawnExtent(n: ComponentNode): number {
  if (n.type === 'freeformfinset') {
    const pts = (n['points'] as [number, number][] | undefined) ?? [];
    return pts.length ? Math.max(...pts.map((p) => p[0])) : 0.05;
  }
  return axialLength(n);
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
 * Rewrites every 'absolute' axial position (rocket-origin frame — only file
 * importers produce it) into the equivalent parent-relative 'top' offset.
 * The UI edits positions in the parent frame only: leaving 'absolute' in the
 * tree makes the schematic/property panel (parent frame) disagree with the
 * engine (rocket frame), so geometry drawn ≠ geometry simulated.
 */
export function resolveAbsolutePositions(tree: RocketTree): RocketTree {
  let changed = false;
  const chainTypes = new Set(['nosecone', 'bodytube', 'transition']);

  const fixChildren = (parent: ComponentNode, pStart: number, pLen: number): ComponentNode => {
    if (!parent.children?.length) return parent;
    const children = parent.children.map((child) => {
      let next = child;
      const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      if (pos.method === 'absolute') {
        changed = true;
        next = { ...child, position: { method: 'top', offset: pos.offset - pStart } } as ComponentNode;
      }
      const cLen = axialLength(next);
      const nextPos = (next.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      const start = pStart + startFromPosition(nextPos, cLen, pLen);
      return fixChildren(next, start, cLen);
    });
    return { ...parent, children } as ComponentNode;
  };

  // Stages flatten into one nose-to-tail chain; chain members stack
  // sequentially (their own position field is not used for layout).
  let x = 0;
  const components = tree.components.map((stage) => {
    const kids = stage.type === 'stage' ? stage.children ?? [] : [stage];
    const fixedKids = kids.map((n) => {
      const len = chainTypes.has(n.type) ? (typeof n['length'] === 'number' ? (n['length'] as number) : 0) : 0;
      const fixed = fixChildren(n, x, len);
      x += len;
      return fixed;
    });
    return stage.type === 'stage'
      ? ({ ...stage, children: fixedKids } as ComponentNode)
      : fixedKids[0]!;
  });
  return changed ? { ...tree, components } : tree;
}

/** Where one component sits along the assembled rocket, and what it sits on. */
export interface AbsoluteStation {
  /** Leading edge, metres aft of the nose tip of the assembled stack. */
  start: number;
  /**
   * Trailing edge — `start + drawnExtent(node)`. The START is the kernel's
   * station (anchored by `axialLength`); the END is where the drawn shape
   * stops, which for an overhanging freeform fin is further aft than the
   * root chord the kernel calls its length. One record, two lengths, on
   * purpose: a wake arrives at the leading edge, a collision reaches the tip.
   */
  end: number;
  node: ComponentNode;
  /**
   * The component this one is mounted INSIDE or ON, null for a stage's own
   * chain members. It is here because the only thing that can answer "how big
   * is the airframe under this shroud" is the part it is attached to
   * (treeModel.mountRadiusOf takes exactly this node).
   */
  parent: ComponentNode | null;
}

/**
 * Every component's axial station in the WHOLE assembled stack, nose tip = 0.
 *
 * This is the walk `resolveAbsolutePositions` already performs inside
 * `fixChildren` (ll. 57–71 above) and throws away once it has rewritten the
 * positions: chain members (nose cone, body tube, transition) stack nose-to-
 * tail and ignore their own position field, everything else is placed inside
 * its parent by `startFromPosition`, and stages continue the same `x` rather
 * than restarting — which is what makes this the rocket frame the property
 * panel prints ("starts N mm from nose", PropertyPanel.tsx:553) and the frame
 * the kernel's own `ComponentInfo.positionX` reports.
 *
 * WHOLE STACK, NOT PER STAGE — stated because the repo already carries a
 * per-stage version of the same walk, `stationsInStage` in motorRoom.ts
 * (ll. 104–123), and the difference will otherwise be rediscovered as a bug.
 * That one restarts at each stage's fore end ON PURPOSE: it answers how long a
 * motor fits, and a motor cannot cross a stage joint because stages separate.
 * The questions this one is for — where a part sits relative to another part
 * on the pad, what is upstream of what during boost — are asked of the rocket
 * as assembled, which is the same frame `railInterferenceWarnings` chose for
 * the rail line (mountAngle.ts, `checkFrame(tree.components)`). motorRoom's
 * copy should be folded into this one as `stationsInStage(stage) =
 * absoluteStations({components:[stage]})`; it is left standing here only
 * because this sitting did not own that file.
 *
 * The one place this walk is stricter than `startFromPosition` alone: an
 * `absolute` position is ALREADY in this frame (it is the rocket-origin offset
 * only file importers produce — see `resolveAbsolutePositions` above), so it is
 * taken literally instead of being added to the parent's start. Feeding a tree
 * through `resolveAbsolutePositions` first therefore does not move any station,
 * which `position.test.ts` pins.
 */
export function absoluteStations(tree: RocketTree): Map<string, AbsoluteStation> {
  const out = new Map<string, AbsoluteStation>();
  const chainTypes = new Set(['nosecone', 'bodytube', 'transition']);

  const descend = (parent: ComponentNode, pStart: number, pLen: number): void => {
    for (const child of parent.children ?? []) {
      // cLen anchors (and is the parent length its own children are placed
      // against — the kernel's getLength() either way); the END is the extent.
      const cLen = axialLength(child);
      const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      const start = pos.method === 'absolute'
        ? pos.offset
        : pStart + startFromPosition(pos, cLen, pLen);
      if (child.id) out.set(child.id, { start, end: start + drawnExtent(child), node: child, parent });
      descend(child, start, cLen);
    }
  };

  let x = 0;
  for (const top of tree.components ?? []) {
    // A stage contributes its children to the chain; a bare component at the
    // top level (older trees, and the shape resolveAbsolutePositions handles at
    // l. 82) is its own single member.
    const members = top.type === 'stage' ? top.children ?? [] : [top];
    for (const member of members) {
      // Only a chain member has axial extent OF ITS OWN in this frame, and only
      // a chain member advances x — the same rule both existing walkers use, so
      // a stage-level part that is not a tube reads as a zero-length station at
      // the current x rather than displacing everything behind it.
      const len = chainTypes.has(member.type) ? axialLength(member) : 0;
      if (member.id) out.set(member.id, { start: x, end: x + len, node: member, parent: null });
      descend(member, x, len);
      x += len;
    }
  }
  return out;
}

/**
 * Candidate snap starts for a child inside its parent: the parent's ends and
 * middle, plus alignment with every sibling's ends — that's where parts sit
 * in the real airframe (centering rings at motor-tube and fin-root ends,
 * couplers butted against tubes, etc.).
 *
 * Every length here is `axialLength` — the KERNEL's frame — because the drag
 * (TreeSchematic onMove) and the slider (PropertyPanel) resolve the snapped
 * start back into an offset with the same length, and a ladder built in any
 * other frame lands the part somewhere other than the anchor it snapped to.
 * For a fin that also stations its tab against the root chord, which is what
 * the kernel's tab offset is measured from.
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
