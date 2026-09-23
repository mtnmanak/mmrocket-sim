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

  it('takes the first inner tube that states a usable radius as the mount', () => {
    const fit = finTabFit(FIN, tube([
      node({ id: 'a', type: 'innertube' }), node({ id: 'n', type: 'innertube', outerRadius: NaN }),
      node({ id: 'c', type: 'coupler', outerRadius: 0.04 }), node({ id: 'm', type: 'innertube', outerRadius: 0.019 }),
    ]))!;
    expect(fit.depth).toBeCloseTo(0.0508 - 0.019, 15);
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
});
