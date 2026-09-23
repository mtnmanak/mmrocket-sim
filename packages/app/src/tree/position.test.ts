import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import {
  absoluteStations, anchorStarts, axialLength, axialStart, drawnExtent, resolveAbsolutePositions,
  startFromPosition,
} from './position.js';
import { engineTree, findNode } from './treeModel.js';

/**
 * `absoluteStations` — where every part sits along the assembled rocket.
 *
 * This walk is what lets the wake check (mountAngle.wakeShadowWarnings) say
 * "220 mm ahead of the fin", so it has to agree with the frame everything else
 * in the app calls a station: the property panel's "starts N mm from nose"
 * and, underneath that, the kernel's own `ComponentInfo.positionX`. The last
 * test here pins it against the kernel directly so the two cannot drift.
 */

const num = (n: ComponentNode, key: string): number => n[key] as number;

describe('absoluteStations', () => {
  it('stacks the chain nose-to-tail and ignores a chain member\'s own position', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027 },
        // A chain member carrying a position field: layout must ignore it, the
        // way resolveAbsolutePositions does (chain members stack).
        { type: 'transition', id: 'tr', length: 0.05, foreRadius: 0.027,
          aftRadius: 0.019, position: { method: 'top', offset: 0.9 } },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('nc')!.start).toBeCloseTo(0, 12);
    expect(st.get('nc')!.end).toBeCloseTo(0.15, 12);
    expect(st.get('b1')!.start).toBeCloseTo(0.15, 12);
    expect(st.get('tr')!.start).toBeCloseTo(0.85, 12);
    expect(st.get('tr')!.end).toBeCloseTo(0.90, 12);
    // A chain member is nobody's child in this frame.
    expect(st.get('b1')!.parent).toBeNull();
  });

  it('places a child by its own method, and records what it is mounted on', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, children: [
          { type: 'fairing', id: 'top', length: 0.08, width: 0.025, height: 0.02,
            position: { method: 'top', offset: 0.30 } },
          { type: 'fairing', id: 'mid', length: 0.08, width: 0.025, height: 0.02,
            position: { method: 'middle', offset: 0 } },
          { type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.10,
            position: { method: 'bottom', offset: 0 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('top')!.start).toBeCloseTo(0.45, 12);   // 0.15 + 0.30
    expect(st.get('top')!.end).toBeCloseTo(0.53, 12);
    expect(st.get('mid')!.start).toBeCloseTo(0.46, 12);   // 0.15 + (0.7-0.08)/2
    expect(st.get('fins')!.start).toBeCloseTo(0.75, 12);  // 0.15 + 0.7 - 0.10
    // A fin set's axial extent IS its root chord — the leading edge is what a
    // wake arrives at, so this is the number wakeShadowWarnings measures to.
    expect(st.get('fins')!.end).toBeCloseTo(0.85, 12);
    expect(axialLength(st.get('fins')!.node)).toBeCloseTo(0.10, 12);
    // The mount: what mountRadiusOf is handed to size the airframe underneath.
    expect(st.get('top')!.parent!.id).toBe('b1');
    expect(num(st.get('top')!.parent!, 'outerRadius')).toBeCloseTo(0.027, 12);
  });

  it('nests: a ring inside an inner tube inside a body tube', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'bodytube', id: 'b1', length: 0.6, outerRadius: 0.027, children: [
          { type: 'innertube', id: 'mmt', length: 0.3, outerRadius: 0.0145,
            position: { method: 'bottom', offset: 0 }, children: [
              { type: 'centeringring', id: 'cr', length: 0.005,
                position: { method: 'top', offset: 0.02 } },
            ] },
        ] },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('mmt')!.start).toBeCloseTo(0.30, 12);
    expect(st.get('cr')!.start).toBeCloseTo(0.32, 12);
    expect(st.get('cr')!.parent!.id).toBe('mmt');
  });

  it('carries on across a STAGE boundary — one assembled stack, one zero', () => {
    const t = {
      name: 'T', components: [
        { type: 'stage', id: 'sust', children: [
          { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
          { type: 'bodytube', id: 'pay', length: 0.5, outerRadius: 0.027 },
        ] },
        { type: 'stage', id: 'boost', children: [
          { type: 'bodytube', id: 'bfin', length: 0.3, outerRadius: 0.027, children: [
            { type: 'trapezoidfinset', id: 'bf', finCount: 3, rootChord: 0.10,
              position: { method: 'bottom', offset: 0 } },
          ] },
        ] },
      ],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    expect(st.get('bfin')!.start).toBeCloseTo(0.65, 12);
    expect(st.get('bf')!.start).toBeCloseTo(0.85, 12);
  });

  /**
   * An `absolute` position is ALREADY in this frame — it is the rocket-origin
   * offset only file importers produce. `resolveAbsolutePositions` rewrites it
   * into a parent-relative `top` at load, and this walk has to land on the same
   * station either way, or a freshly imported design would measure differently
   * from the same design one edit later.
   */
  it('reads an absolute position in the rocket frame, before OR after resolving', () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, children: [
          { type: 'fairing', id: 'cam', length: 0.08, width: 0.025, height: 0.02,
            position: { method: 'absolute', offset: 0.45 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    expect(absoluteStations(t).get('cam')!.start).toBeCloseTo(0.45, 12);
    const resolved = resolveAbsolutePositions(t);
    // Non-vacuous: the rewrite really did happen.
    expect((resolved.components[0]!.children![1]!.children![0]!.position as { method: string }).method)
      .toBe('top');
    expect(absoluteStations(resolved).get('cam')!.start).toBeCloseTo(0.45, 12);
  });

  /**
   * THE PIN THAT STOPS THE TWO DRIFTING. `ComponentInfo.positionX` is "the
   * absolute position of the component's front from the nose tip", computed by
   * the kernel from the tree engineTree() hands it. If this walk and that one
   * ever disagree, the property panel and the wake sentence start quoting
   * different stations for the same part.
   */
  it('agrees with the kernel\'s own positionX', async () => {
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027, shape: 'ogive', thickness: 0.002 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, thickness: 0.001, children: [
          { type: 'innertube', id: 'mmt', length: 0.3, outerRadius: 0.0145, thickness: 0.001,
            position: { method: 'bottom', offset: 0 } },
          { type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.10, tipChord: 0.05,
            sweep: 0.05, height: 0.055, thickness: 0.003,
            position: { method: 'bottom', offset: 0 } },
        ] },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(t));
    for (const id of ['nc', 'b1', 'mmt', 'fins']) {
      expect(rocket.componentInfo(id).positionX, `station of ${id}`)
        .toBeCloseTo(st.get(id)!.start, 9);
    }
  }, 60000);
});

/**
 * THE FREEFORM-FIN SPLIT (2026-09-07). `axialLength` is the kernel's length —
 * `FreeformFinSet.java:448/494/546`: the LAST point's x, the root chord — and
 * `drawnExtent` is the outline's furthest-aft x. From 2026-07-03 to v0.116
 * `axialLength` returned max-x, so a 'bottom'/'middle'-anchored fin whose tip
 * trailing corner overhangs its root was drawn, dragged and exported forward
 * of where the kernel flew it, by the overhang, while the property panel
 * printed the kernel's station beside it. The point list here is the fin in
 * `docs/User files/TRF RASAero Files/ninja_4in_54mm-MMT.ork`, read straight
 * out of the file: root chord 360.76 mm, max-x 480.26 mm, overhang 119.50 mm,
 * on an 866.775 mm tube, 'bottom', offset -104.97 mm.
 */
describe('axialLength vs drawnExtent — a freeform fin whose tip overhangs its root', () => {
  const NINJA: [number, number][] = [
    [0, 0],
    [0.48026079897864005, 0.15594675369134],
    [0.405013311838459, 0.0270298288667628],
    [0.360761749736894, 0],
  ];
  const ROOT = 0.360761749736894;
  const MAXX = 0.48026079897864005;
  const TUBE = 0.866775;
  const OFFSET = -0.1049714752044;
  const fin = (extra: Record<string, unknown> = {}): ComponentNode => ({
    id: 'ff', type: 'freeformfinset', finCount: 3, thickness: 0.0047625, points: NINJA,
    position: { method: 'bottom', offset: OFFSET }, ...extra,
  } as unknown as ComponentNode);
  const rocket = (f: ComponentNode): RocketTree => ({
    name: 'ninja', components: [{ type: 'stage', id: 's1', children: [
      { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.0508, shape: 'ogive', thickness: 0.002 },
      { type: 'bodytube', id: 'b1', length: TUBE, outerRadius: 0.0508, thickness: 0.0015, children: [f] },
    ] }],
  } as unknown as RocketTree);

  it('axialLength is the root chord (the last point), drawnExtent the furthest-aft point', () => {
    expect(axialLength(fin())).toBeCloseTo(ROOT, 12);
    expect(drawnExtent(fin())).toBeCloseTo(MAXX, 12);
    expect(drawnExtent(fin()) - axialLength(fin())).toBeCloseTo(0.11949904924174605, 12);
  });

  it('a Bottom-anchored fin starts at parentLength - rootChord + offset', () => {
    const start = startFromPosition({ method: 'bottom', offset: OFFSET }, axialLength(fin()), TUBE);
    expect(start).toBeCloseTo(TUBE - ROOT + OFFSET, 12);      // 401.04 mm from the tube's front
    expect(start).toBeCloseTo(0.401041775058706, 9);
    // The station the max-x frame drew it at, 119.50 mm forward — the bug.
    expect(start - (TUBE - MAXX + OFFSET)).toBeCloseTo(0.11949904924174605, 12);
    // Middle moves by half the overhang; Top does not move at all.
    expect(startFromPosition({ method: 'middle', offset: 0 }, axialLength(fin()), TUBE))
      .toBeCloseTo((TUBE - ROOT) / 2, 12);
    expect(startFromPosition({ method: 'top', offset: 0.3 }, axialLength(fin()), TUBE))
      .toBeCloseTo(0.3, 12);
  });

  it('absoluteStations: start from the root chord, end from the extent', () => {
    const st = absoluteStations(rocket(fin())).get('ff')!;
    expect(st.start).toBeCloseTo(0.15 + TUBE - ROOT + OFFSET, 12);
    expect(st.end - st.start).toBeCloseTo(MAXX, 12);
    // Top-anchored: unchanged by the split, and the end still reaches the tip.
    const top = absoluteStations(rocket(fin({ position: { method: 'top', offset: 0.3 } }))).get('ff')!;
    expect(top.start).toBeCloseTo(0.45, 12);
    expect(top.end).toBeCloseTo(0.45 + MAXX, 12);
  });

  it('a fin with NO overhang answers the same for both — nothing else moved', () => {
    const plain = fin({ points: [[0, 0], [0.02, 0.05], [0.06, 0.05], [0.08, 0]] });
    expect(axialLength(plain)).toBeCloseTo(0.08, 12);
    expect(drawnExtent(plain)).toBeCloseTo(0.08, 12);
    const trap = { id: 't', type: 'trapezoidfinset', rootChord: 0.1 } as unknown as ComponentNode;
    expect(drawnExtent(trap)).toBe(axialLength(trap));
  });

  it('the snap ladder anchors a Bottom fin at the kernel station', () => {
    const tube = rocket(fin()).components[0]!.children![1]!;
    // `pLen - cLen` is the "flush with the aft end" anchor: it must be built
    // from the root chord or a fin snapped there lands 119.5 mm short of it.
    expect(anchorStarts(tube, fin())).toContainEqual(expect.closeTo(TUBE - ROOT, 12));
  });

  /**
   * THE PIN. The property panel's "starts N mm from nose" is the kernel's
   * `positionX`; the canvas draws at `absoluteStations().start`. On this fin
   * the two used to differ by 119.50 mm on one screen. The kernel is the
   * REAL OpenRocket code, so this is also the proof that the kernel anchors a
   * freeform fin by its root chord — measured, not read.
   */
  it('agrees with the kernel positionX for the ninja fin', async () => {
    const t = rocket(fin());
    const st = absoluteStations(t);
    resetEngine();
    const r = OrkRocket.buildTree(engineTree(t));
    const info = r.componentInfo('ff');
    expect(info.length).toBeCloseTo(ROOT, 9);
    expect(info.positionX).toBeCloseTo(st.get('ff')!.start, 9);
    // The whole-rocket length the kernel reports runs to the fin TIP, which on
    // this fin sits past the tube's tail — so it exceeds nose + tube, by
    // exactly the amount the fin overhangs the airframe.
    const tipPast = (info.positionX + MAXX) - (0.15 + TUBE);
    expect(tipPast).toBeCloseTo(MAXX - ROOT + OFFSET, 9);
    expect(r.staticInfo().length).toBeCloseTo(0.15 + TUBE + tipPast, 9);
  }, 60000);
});

/**
 * A rail button's axial length used to be THREE different numbers in one app:
 * the drawings resolved its station with the outer diameter (9.7 mm by
 * default), the drag/slider/auto-place math with `axialLength`'s 25 mm
 * `packedLength` fallback, and the kernel with 0. v0.105 pinned the one answer
 * in `kernelLength.ts`; the freeform split folded that branch into
 * `axialLength` itself, and these are that file's pins, moved.
 */
describe('axialLength — a rail button is ZERO, the kernel\'s own', () => {
  const button = (extra: Record<string, unknown> = {}) =>
    ({ id: 'rb', type: 'railbutton', outerDiameter: 0.0097, ...extra } as unknown as ComponentNode);

  it('is zero whatever the node carries', () => {
    expect(axialLength(button())).toBe(0);
    // Even a button that somehow acquired a length key: the kernel's
    // RocketComponent.length is 0 and RailButton never assigns it.
    expect(axialLength(button({ length: 0.05, totalHeight: 0.01142 }))).toBe(0);
    expect(drawnExtent(button())).toBe(0);
  });

  it('puts the station where the kernel puts it, for all three methods', () => {
    // Parent tube 300 mm long. The kernel resolves a zero-length component,
    // so 'bottom' offset 0 lands ON the aft end and 'middle' dead centre.
    const pLen = 0.3;
    const at = (method: string, offset: number) =>
      startFromPosition({ method, offset } as never, axialLength(button()), pLen);
    expect(at('top', 0)).toBeCloseTo(0, 12);
    expect(at('middle', 0)).toBeCloseTo(0.15, 12);
    expect(at('bottom', 0)).toBeCloseTo(0.3, 12);
  });

  it('builds the snap ladder in the same frame — no node rewriting needed', () => {
    const tube = {
      id: 'b1', type: 'bodytube', length: 0.3,
      children: [button(), { id: 'cr', type: 'centeringring', length: 0.003 }],
    } as unknown as ComponentNode;
    // The button's "flush aft" anchor is the tube's end itself, and 'middle'
    // is dead centre — what the 25 mm frame put 25 mm and 12.5 mm forward.
    expect(anchorStarts(tube, button())).toContainEqual(expect.closeTo(0.3, 12));
    expect(anchorStarts(tube, button())).toContainEqual(expect.closeTo(0.15, 12));
  });
});

/**
 * `axialStart` — the ONE placement step the schematic, the 3D pieces and
 * `absoluteStations` share (audit 2026-09-22). The two view copies it replaced
 * disagreed about 'absolute': the schematic added the offset to the parent's
 * start, the 3D view took it literally.
 */
describe('axialStart', () => {
  const child = (method: string, offset: number) =>
    ({ type: 'centeringring', length: 0.01, position: { method, offset } } as unknown as ComponentNode);

  it('is the parent start plus startFromPosition for the parent-relative methods', () => {
    for (const [method, offset] of [['top', 0.02], ['middle', -0.01], ['bottom', 0.005]] as const) {
      const c = child(method, offset);
      expect(axialStart(c, 0.01, 0.4, 0.3), method)
        .toBeCloseTo(0.4 + startFromPosition(c.position as never, 0.01, 0.3), 12);
    }
  });

  it('takes an absolute offset literally — it is already the rocket-origin frame', () => {
    expect(axialStart(child('absolute', 0.55), 0.01, 0.4, 0.3)).toBeCloseTo(0.55, 12);
  });

  it('defaults a child with no position to top, offset 0', () => {
    expect(axialStart({ type: 'bulkhead', length: 0.003 } as unknown as ComponentNode, 0.003, 0.25, 0.3)).toBe(0.25);
  });
});

/**
 * A POD'S OWN CHAIN STACKS (audit 2026-09-22, row 360). Inside a pod set or a
 * strap-on, the kernel positions the nose, tubes and transitions the way it
 * positions a stage's — each AFTER the one before it (`RocketComponent.setAfter`,
 * the default axial method of every body component) — and the assembly is as
 * long as that chain (`ComponentAssembly.updateBounds`). The station walkers
 * placed every child of an assembly at the assembly's own start instead, so
 * everything inside a pod's SECOND tube was one tube-length forward of where
 * it flies, and `normalizeTree` rewrote an 'absolute' part there against the
 * wrong start and moved it in the kernel. Pinned against `positionX`.
 */
describe('absoluteStations — a pod set’s own chain stacks as the kernel stacks it', () => {
  const podded = (type: 'podset' | 'parallelstage', finPos: Record<string, unknown>): RocketTree => ({
    name: 'P', components: [{ type: 'stage', id: 's1', children: [
      { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027, shape: 'ogive', thickness: 0.002 },
      { type: 'bodytube', id: 'b1', length: 1.2, outerRadius: 0.027, thickness: 0.001, children: [
        {
          type, id: 'pod', instanceCount: 2, radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
          ...(type === 'parallelstage' ? { separationEvent: 'never' } : {}),
          position: { method: 'bottom', offset: 0.1 },
          children: [
            { type: 'nosecone', id: 'pn', length: 0.08, aftRadius: 0.012, thickness: 0.002 },
            { type: 'bodytube', id: 'pt1', length: 0.2, outerRadius: 0.012, thickness: 0.0005 },
            { type: 'bodytube', id: 'pt2', length: 0.25, outerRadius: 0.012, thickness: 0.0005, children: [
              { type: 'trapezoidfinset', id: 'pf', finCount: 3, rootChord: 0.06, tipChord: 0.03,
                sweep: 0.02, height: 0.03, thickness: 0.002, position: finPos },
              { type: 'innertube', id: 'pm', length: 0.1, outerRadius: 0.009, thickness: 0.0005,
                motorMount: true, position: { method: 'bottom', offset: 0 } },
            ] },
          ],
        },
      ] },
    ] }],
  } as unknown as RocketTree);

  const againstKernel = (t: RocketTree, ids: string[]) => {
    const st = absoluteStations(t);
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(t));
    for (const id of ids) {
      expect(st.get(id)!.start, `station of ${id}`).toBeCloseTo(rocket.componentInfo(id).positionX, 9);
    }
    return st;
  };

  for (const type of ['podset', 'parallelstage'] as const) {
    it(`stacks nose, first tube and second tube, and places what is inside them (${type})`, () => {
      const st = againstKernel(podded(type, { method: 'bottom', offset: 0 }), ['pod', 'pn', 'pt1', 'pt2', 'pf', 'pm']);
      // The pod is 0.08 + 0.2 + 0.25 = 0.53 long, bottom-anchored 0.1 past a
      // 1.2 m tube that starts at 0.15: 0.15 + 1.2 − 0.53 + 0.1 = 0.92.
      expect(st.get('pod')!.start).toBeCloseTo(0.92, 12);
      expect(st.get('pt1')!.start).toBeCloseTo(1.00, 12);
      expect(st.get('pt2')!.start).toBeCloseTo(1.20, 12);
      expect(st.get('pf')!.start).toBeCloseTo(1.39, 12);
    });
  }

  it('resolves an absolute part inside the second tube to where the file puts it', () => {
    // A file's 'absolute' offset is the rocket-origin station (only importers
    // write one). normalizeTree rewrites it to 'top' against the part's parent
    // before anything reaches the kernel — so the rewrite has to use where the
    // SECOND tube really starts, or the kernel flies the fin elsewhere.
    const t = podded('podset', { method: 'absolute', offset: 1.35 });
    expect(absoluteStations(t).get('pf')!.start).toBeCloseTo(1.35, 12);
    const resolved = resolveAbsolutePositions(t);
    const fin = findNode(resolved, 'pf')!;
    expect(fin.position).toEqual({ method: 'top', offset: expect.closeTo(0.15, 12) }); // 1.35 − 1.20
    const st = againstKernel(resolved, ['pf', 'pt2']);
    expect(st.get('pf')!.start).toBeCloseTo(1.35, 12);
  });
});

/**
 * THE KERNEL'S OWN DEFAULT LENGTH, per type (audit 2026-09-22, row 373). A
 * cleared length is the bridge's `dbl(node, "length", …)` default in the
 * kernel — 50 mm for a lug, 70 mm for an inner tube, 100 mm for a tube-fin
 * set, and the shroud's 80 mm through engineTree's lowering — where
 * `axialLength` answered a generic 25 mm, so a 'bottom' or 'middle' anchored
 * part was stationed 25–75 mm (or 12.5–37.5 mm) away from where it flies.
 */
describe('axialLength — a cleared length is the kernel’s default for the type', () => {
  it('stations cleared-length parts where the kernel does', () => {
    const t = {
      name: 'D', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027, shape: 'ogive', thickness: 0.002 },
        // A body tube with no length of its own: the kernel builds 0.3 m.
        { type: 'bodytube', id: 'b0', outerRadius: 0.027, thickness: 0.001 },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, thickness: 0.001, children: [
          { type: 'launchlug', id: 'lug', outerRadius: 0.003, thickness: 0.0005, position: { method: 'bottom', offset: 0 } },
          { type: 'innertube', id: 'mmt', outerRadius: 0.0145, thickness: 0.001, position: { method: 'bottom', offset: 0 } },
          { type: 'tubefinset', id: 'tf', finCount: 6, outerRadius: 0.01, position: { method: 'bottom', offset: 0 } },
          { type: 'fairing', id: 'cam', width: 0.025, height: 0.02, position: { method: 'middle', offset: 0 } },
          { type: 'masscomponent', id: 'mass', mass: 0.05, radius: 0.01, position: { method: 'bottom', offset: 0 } },
          { type: 'tubecoupler', id: 'cp', thickness: 0.001, position: { method: 'bottom', offset: 0 } },
          { type: 'engineblock', id: 'eb', thickness: 0.002, position: { method: 'bottom', offset: 0 } },
          { type: 'bulkhead', id: 'bh', position: { method: 'bottom', offset: 0 } },
          { type: 'centeringring', id: 'cr', position: { method: 'bottom', offset: 0 } },
        ] },
        { type: 'transition', id: 'tr', foreRadius: 0.027, aftRadius: 0.02, thickness: 0.002 },
        { type: 'bodytube', id: 'b2', length: 0.2, outerRadius: 0.02, thickness: 0.001 },
      ] }],
    } as unknown as RocketTree;
    const st = absoluteStations(t);
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(t));
    for (const id of ['b0', 'b1', 'lug', 'mmt', 'tf', 'cam', 'mass', 'cp', 'eb', 'bh', 'cr', 'tr', 'b2']) {
      expect(st.get(id)!.start, `station of ${id}`).toBeCloseTo(rocket.componentInfo(id).positionX, 9);
    }
  }, 60000);
});
