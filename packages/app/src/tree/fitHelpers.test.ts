import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finTabFit, shoulderFit } from './fitHelpers.js';

/**
 * The two fit rules on their own. The panel's buttons — their words, and that
 * each writes exactly `patch` — are pinned in PropertyPanel.oneShots.test.tsx.
 */
const node = (o: Record<string, unknown>) => o as unknown as ComponentNode;

describe('finTabFit', () => {
  const FIN = node({
    id: 'f1', type: 'trapezoidfinset', rootChord: 0.1, tipChord: 0.05, sweep: 0.03, height: 0.06,
  });
  const MMT = node({ id: 'mmt', type: 'innertube', outerRadius: 0.0286 });
  const tube = (children: ComponentNode[], extra: Record<string, unknown> = {}) =>
    node({ id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.0508, thickness: 0.0015, children, ...extra });

  it('reaches the motor tube, and sizes and centres a new tab', () => {
    const fit = finTabFit(FIN, tube([MMT, FIN]))!;
    expect(fit.toMount).toBe(true);
    expect(fit.depth).toBe(0.0508 - 0.0286);
    expect(fit.patch).toEqual({ tabHeight: 0.0508 - 0.0286, tabLength: 0.1 * 0.6, tabOffsetMethod: 'middle', tabOffset: 0 });
  });

  it('sizes a freeform tab off the ROOT chord, not an overhanging tip', () => {
    const ff = node({ id: 'ff', type: 'freeformfinset', points: [[0, 0], [0.48, 0.156], [0.405, 0.027], [0.36, 0]] });
    expect(finTabFit(ff, tube([MMT, ff]))!.patch['tabLength']).toBeCloseTo(0.36 * 0.6, 15);
  });

  it('goes to the wall with no motor tube, and to 1 mm with no wall stated', () => {
    expect(finTabFit(FIN, tube([FIN]))).toMatchObject({ toMount: false, depth: 0.0015 });
    expect(finTabFit(FIN, tube([FIN], { thickness: undefined }))!.depth).toBe(0.001);
  });

  it('keeps a tab already sized and a tab offset method already chosen', () => {
    const fin = node({ ...FIN, tabLength: 0.04, tabOffsetMethod: 'top' });
    expect(finTabFit(fin, tube([MMT, fin]))!.patch).toEqual({ tabHeight: 0.0508 - 0.0286 });
  });

  it('takes an inner tube that states a usable radius as the mount', () => {
    const fit = finTabFit(FIN, tube([
      node({ id: 'a', type: 'innertube' }), node({ id: 'n', type: 'innertube', outerRadius: NaN }),
      node({ id: 'c', type: 'coupler', outerRadius: 0.04 }), node({ id: 'm', type: 'innertube', outerRadius: 0.019 }),
    ]))!;
    expect(fit.depth).toBeCloseTo(0.0508 - 0.019, 15);
  });

  /** A 3" airframe 0.8 m long, the layout of the 2026-09-30 review. */
  const air = (children: ComponentNode[]) =>
    node({ id: 'b2', type: 'bodytube', length: 0.8, outerRadius: 0.0381, thickness: 0.001, children });
  const AFT_FINS = node({ ...FIN, position: { method: 'bottom', offset: 0 } });
  // Both marked as motor mounts, as the Add menu marks every inner tube.
  const PAYLOAD = node({
    id: 'pl', type: 'innertube', length: 0.2, outerRadius: 0.0095, motorMount: true, position: { method: 'top', offset: 0.1 },
  });
  const MOUNT = node({
    id: 'mm', type: 'innertube', length: 0.3, outerRadius: 0.0153, motorMount: true, position: { method: 'bottom', offset: 0 },
  });

  it('reaches the motor tube alongside the fins, not the first one listed', () => {
    // A forward 18 mm payload tube LISTED FIRST and a 29 mm motor mount at the
    // aft end, fins at the aft end: the fit took the payload tube, 28.6 mm,
    // and ran the tab 5.8 mm into the mount. The tab meets the mount at
    // 38.1 - 15.3 = 22.8 mm.
    const fit = finTabFit(AFT_FINS, air([PAYLOAD, MOUNT, AFT_FINS]))!;
    expect(fit.toMount).toBe(true);
    expect(fit.depth).toBeCloseTo(0.0381 - 0.0153, 15);
  });

  it('places a mount with no position where the kernel flies it, at the bottom', () => {
    // An inner tube with no `position` flies at Bottom +0 (InternalComponent's
    // default; positionOf). Read as Top +0, it sat 0-0.3 m, clear of fins at
    // 0.7-0.8 m, and the fit fell back to the wall (merge of the 2026-10-01
    // position and fit fixes).
    const unplaced = node({ id: 'mu', type: 'innertube', length: 0.3, outerRadius: 0.0153, motorMount: true });
    const fit = finTabFit(AFT_FINS, air([unplaced, AFT_FINS]))!;
    expect(fit.toMount).toBe(true);
    expect(fit.depth).toBeCloseTo(0.0381 - 0.0153, 15);
  });

  it('prefers the motor tube alongside the fins over a wider piston beside them', () => {
    // The RockSim corpus's kit layouts (Hydra, Matrix, Pterodactyl, 1/2-scale
    // Patriot): a piston or insulator tube nearly as wide as the airframe
    // overlaps the fins' forward root. The widest tube alongside — desktop's
    // own rule — would stop the tab 1.6 mm in; the button reaches the MOTOR tube.
    const piston = node({
      id: 'pi', type: 'innertube', length: 0.1, outerRadius: 0.0365, position: { method: 'bottom', offset: -0.06 },
    });
    expect(finTabFit(AFT_FINS, air([piston, MOUNT, AFT_FINS]))!.depth).toBeCloseTo(0.0381 - 0.0153, 15);
    // A tube that HOLDS the marked mount — a 38 mm tube around a 29 mm adapter,
    // as the corpus's adapter variants of those kits carry it — is the motor tube too.
    const holder = node({
      ...MOUNT, id: 'm38', motorMount: false,
      children: [node({ id: 'ad', type: 'innertube', length: 0.3, outerRadius: 0.0145, motorMount: true })],
    });
    expect(finTabFit(AFT_FINS, air([piston, holder, AFT_FINS]))!.depth).toBeCloseTo(0.0381 - 0.0153, 15);
  });

  it('with no motor tube alongside, reaches the widest tube there, as desktop does', () => {
    // Two unmarked tubes alongside the fins: the tab meets the wider one first.
    const tube29 = node({ ...MOUNT, motorMount: undefined });
    const sleeve = node({ ...tube29, id: 'sl', length: 0.15, outerRadius: 0.0175 });
    expect(finTabFit(AFT_FINS, air([tube29, sleeve, AFT_FINS]))).toMatchObject({ toMount: true, depth: expect.closeTo(0.0381 - 0.0175, 15) });
  });

  it('a tube clear of the fins is not their mount — strictly, as desktop tests the fin span', () => {
    // Canards at 0.25-0.375 m: the aft mount is nowhere near them, so the tab
    // goes to the wall, as with no tube at all.
    const canards = node({ ...FIN, rootChord: 0.125, position: { method: 'top', offset: 0.25 } });
    expect(finTabFit(canards, air([MOUNT, canards]))).toMatchObject({ toMount: false, depth: 0.001 });
    // A tube that starts exactly where the fin ends only touches it
    // (FinSetConfig.isComponentInsideFinSpan); one 1 mm further forward is alongside.
    const touching = node({ ...MOUNT, length: 0.2, position: { method: 'top', offset: 0.375 } });
    expect(finTabFit(canards, air([touching, canards]))!.toMount).toBe(false);
    const overlapping = node({ ...touching, position: { method: 'top', offset: 0.374 } });
    expect(finTabFit(canards, air([overlapping, canards]))!.depth).toBeCloseTo(0.0381 - 0.0153, 15);
  });

  it('offers nothing off a body tube, without its radius, or with no depth to fill', () => {
    expect(finTabFit(FIN, null)).toBeNull();
    expect(finTabFit(FIN, 'stage')).toBeNull();
    expect(finTabFit(FIN, node({ id: 't', type: 'transition', foreRadius: 0.03 }))).toBeNull();
    expect(finTabFit(FIN, tube([FIN], { outerRadius: undefined }))).toBeNull();
    expect(finTabFit(FIN, tube([FIN], { outerRadius: NaN }))).toBeNull(); // no NaN depth offered
    expect(finTabFit(FIN, tube([node({ ...MMT, outerRadius: 0.0508 })]))).toBeNull();
    expect(finTabFit(FIN, tube([FIN], { thickness: 0 }))).toBeNull();
  });

  it('offers nothing on a SOLID tube: no wall to pass through, no motor tube inside', () => {
    // A dowel ticked Solid (filled) — withheld, as on a nose cone or transition,
    // which can be solid too. Read through the wall it states, it offered that
    // 1.5 mm; with a mount listed inside it, the depth to the mount.
    expect(finTabFit(FIN, tube([FIN], { filled: true }))).toBeNull();
    expect(finTabFit(FIN, tube([MMT, FIN], { filled: true }))).toBeNull();
    // The .ork reader's solid tube states no wall at all.
    expect(finTabFit(FIN, tube([FIN], { filled: true, thickness: undefined }))).toBeNull();
    // `filled: false` is the hollow tube it always was.
    expect(finTabFit(FIN, tube([FIN], { filled: false }))!.depth).toBe(0.0015);
  });
});

describe('shoulderFit', () => {
  const NOSE = node({ id: 'n1', type: 'nosecone', length: 0.1, aftRadius: 0.027 });
  const tree = (children: ComponentNode[]): RocketTree =>
    ({ name: 'R', components: [node({ id: 's1', type: 'stage', children })] }) as RocketTree;
  const fit = (children: ComponentNode[]) => {
    const t = tree(children);
    return shoulderFit(t, NOSE, t.components[0]!);
  };

  it('is the inner radius of the next body tube behind the nose', () => {
    expect(fit([NOSE, node({ id: 'b1', type: 'bodytube', outerRadius: 0.027, thickness: 0.001 })]))
      .toEqual({ innerR: 0.027 - 0.001, patch: { shoulderRadius: 0.027 - 0.001 } });
  });

  it('skips other parts and never looks forward of the nose', () => {
    expect(fit([
      node({ id: 'b0', type: 'bodytube', outerRadius: 0.05, thickness: 0.002 }), NOSE,
      node({ id: 't1', type: 'transition' }), node({ id: 'b1', type: 'bodytube', outerRadius: 0.03, thickness: 0.0015 }),
    ])!.innerR).toBe(0.03 - 0.0015);
  });

  it('a tube with no wall stated is its own outer radius', () => {
    expect(fit([NOSE, node({ id: 'b1', type: 'bodytube', outerRadius: 0.027 })])!.innerR).toBe(0.027);
  });

  it('reads the rocket top level when the nose has no parent node', () => {
    const t = { name: 'R', components: [NOSE, node({ id: 'b1', type: 'bodytube', outerRadius: 0.02 })] } as RocketTree;
    expect(shoulderFit(t, NOSE, 'stage')!.innerR).toBe(0.02);
  });

  it('offers nothing with no tube behind, or one without a usable radius', () => {
    expect(fit([NOSE])).toBeNull();
    expect(fit([NOSE, node({ id: 'b1', type: 'bodytube' })])).toBeNull();
    expect(fit([NOSE, node({ id: 'b1', type: 'bodytube', outerRadius: NaN })])).toBeNull();
  });

  it('marks a SOLID tube: its bore is 0, and the panel refuses the fit', () => {
    // BodyTube.getInnerRadius is 0 when filled. Read through the wall it states,
    // a solid rod of 30 mm radius with a 1 mm wall fitted a shoulder of 29 mm
    // radius; the .ork reader's solid tube, which states no wall, the full 30 mm.
    const refused = { innerR: 0, patch: { shoulderRadius: 0 }, solid: true };
    const rod = { id: 'b1', type: 'bodytube', outerRadius: 0.03, thickness: 0.001 };
    expect(fit([NOSE, node({ ...rod, filled: true })])).toEqual(refused);
    expect(fit([NOSE, node({ ...rod, filled: true, thickness: undefined })])).toEqual(refused);
    // A tail cone's shoulder fits the tube AHEAD, so that is the one refused.
    const tail = node({ ...NOSE, flipped: true });
    const t = tree([node({ ...rod, filled: true }), tail]);
    expect(shoulderFit(t, tail, t.components[0]!)).toEqual(refused);
    // `filled: false` is the hollow tube it always was.
    expect(fit([NOSE, node({ ...rod, filled: false })]))
      .toEqual({ innerR: 0.03 - 0.001, patch: { shoulderRadius: 0.03 - 0.001 } });
  });
});
