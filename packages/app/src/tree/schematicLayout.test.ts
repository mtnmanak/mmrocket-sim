import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { layoutSchematic, schematicFrame, type SchematicFrameOptions } from './schematicLayout.js';
import { updateNode } from './treeModel.js';

/**
 * The side view's layout as DATA (audit 2026-09-22). Until the extraction the
 * only way to test a drawn coordinate was to render the component and parse it
 * back out of an SVG attribute; these read it straight off the shapes. What
 * the drawing looks like is pinned in TreeSchematic.golden.test.tsx — these
 * pin the properties the drag preview and the renderer depend on.
 */

const R = 0.012;
const rocket = (children: Record<string, unknown>[]): RocketTree => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: R },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: R, children },
    ],
  }],
} as unknown as RocketTree);

const FRAME: SchematicFrameOptions = {
  cw: 640, chPx: 480, maxHeight: 480, rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0,
};
const lay = (tree: RocketTree, roll = 0) => {
  const f = schematicFrame(tree, FRAME);
  return { f, l: layoutSchematic(tree, { scale: f.scale, cy: f.cy, x0: f.x0, roll, idPrefix: 't' }) };
};

const busy = rocket([
  { id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02,
    height: 0.03, tabHeight: 0.004, tabLength: 0.03, position: { method: 'bottom', offset: 0 } },
  { id: 'mt', type: 'innertube', length: 0.08, outerRadius: 0.004, cluster: '3-ring',
    position: { method: 'bottom', offset: 0 } },
  { id: 'rb', type: 'railbutton', outerDiameter: 0.01, instanceCount: 2, instanceSeparation: 0.1,
    position: { method: 'top', offset: 0.05 } },
  { id: 'p1', type: 'podset', instanceCount: 2, radiusOffset: 0.02,
    children: [{ id: 'pb', type: 'bodytube', length: 0.1, outerRadius: 0.006,
      children: [{ id: 'pf', type: 'trapezoidfinset', finCount: 3, rootChord: 0.02, height: 0.01 }] }] },
]);

describe('keys are identities', () => {
  it('every shape has a distinct key', () => {
    for (const roll of [0, 0.7]) {
      const keys = lay(busy, roll).l.shapes.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('a part drawn once per pod instance is keyed per instance', () => {
    const keys = lay(busy).l.shapes.map((s) => s.key);
    expect(keys).toContain('p1#0/pb:body');
    expect(keys).toContain('p1#1/pb:body');
  });

  it('moving a part moves its shapes and renames nothing', () => {
    // The drag preview re-lays the design out on every move, so a move must
    // rename nothing and redraw nothing but the part. (A move adds and removes
    // no shape, so a list-position key would pass this too — the case after
    // it is the one that tells an identity key from a counter.)
    const before = lay(busy).l;
    const moved = updateNode(busy, 'f1', { position: { method: 'bottom', offset: -0.04 } });
    const after = lay(moved).l;
    expect(after.shapes.map((s) => s.key)).toEqual(before.shapes.map((s) => s.key));
    const fin = (l: typeof before) => l.shapes.find((s) => s.key === 'f1:fin0')!;
    const xs = (pts: unknown) => String(pts).split(' ').map((p) => Number(p.split(',')[0]));
    const { f } = lay(busy);
    const dx = xs(fin(after).attrs['points'])[0]! - xs(fin(before).attrs['points'])[0]!;
    expect(dx).toBeCloseTo(-0.04 * f.scale, 9);
    // …and nothing else moved.
    const others = (l: typeof before) => l.shapes.filter((s) => !s.key.startsWith('f1:'))
      .map((s) => JSON.stringify(s.attrs));
    expect(others(after)).toEqual(others(before));
  });

  it('a shape that appears ahead of a part renames nothing drawn after it', () => {
    // A motor loaded into b1 draws its case right after the tube — ahead of
    // the tube's fins, inner tubes and lugs. The counter the old render body
    // keyed with renumbered every one of those, and React remounted them all.
    const f = schematicFrame(busy, FRAME);
    const at = (motors?: Record<string, { length: number; diameter: number; label?: string }>) =>
      layoutSchematic(busy, { scale: f.scale, cy: f.cy, x0: f.x0, roll: 0, idPrefix: 't', motors }).shapes;
    const plain = at();
    const loaded = at({ b1: { length: 0.07, diameter: 0.018, label: 'F42' } });
    const added = loaded.filter((s) => !plain.some((p) => p.key === s.key)).map((s) => s.key);
    expect(added.length).toBeGreaterThan(0);
    for (const k of added) expect(k).toMatch(/^b1:motor/);
    const idx = (k: string) => loaded.findIndex((s) => s.key === k);
    expect(idx(added[0]!)).toBeLessThan(idx('f1:fin0'));
    // Every shape already drawn keeps its key AND what that key draws.
    const byKey = new Map(loaded.map((s) => [s.key, s]));
    for (const s of plain) {
      expect(JSON.stringify(byKey.get(s.key)?.attrs), s.key).toBe(JSON.stringify(s.attrs));
    }
  });

  it('a duplicated id still gets distinct keys', () => {
    const twin = rocket([
      { id: 'd', type: 'launchlug', length: 0.03, outerRadius: 0.002, position: { method: 'top', offset: 0 } },
      { id: 'd', type: 'launchlug', length: 0.03, outerRadius: 0.002, position: { method: 'top', offset: 0.1 } },
    ]);
    const keys = lay(twin).l.shapes.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the frame reads sizes, never positions', () => {
  it('a moved part leaves the frame exactly as it was', () => {
    const moved = updateNode(busy, 'rb', { position: { method: 'top', offset: 0.22 } });
    expect(schematicFrame(moved, FRAME)).toEqual(schematicFrame(busy, FRAME));
  });
});

describe('parts, grips and extents', () => {
  const { l } = lay(busy, 0.7);

  it('a child is a grip in its parent\'s frame; the axial chain is not', () => {
    expect(l.grips.get('f1')?.parent.id).toBe('b1');
    expect(l.grips.get('f1')?.pLen).toBe(0.3);
    expect(l.grips.get('pf')?.parent.id).toBe('pb');
    expect(l.grips.has('b1')).toBe(false);
    expect(l.grips.has('n1')).toBe(false);
    const body = l.shapes.find((s) => s.key === 'b1:body')!;
    expect(body.part).toEqual({ id: 'b1', name: 'Body tube', grip: false });
  });

  it('a rolled fin is an outline plus a hit surface that never takes the keyboard', () => {
    const wires = l.shapes.filter((s) => s.part?.id === 'f1' && s.layer === 'wires');
    expect(wires.filter((s) => s.attrs['data-fin'] === 'wire')).toHaveLength(3);
    const hits = wires.filter((s) => 'data-fin-hit' in s.attrs);
    expect(hits).toHaveLength(3);
    expect(hits.every((s) => s.part?.hit === true && s.sel !== true)).toBe(true);
  });

  it('a clustered tube\'s extent is the union of every copy', () => {
    const copies = l.shapes.filter((s) => s.key.startsWith('mt:inner'));
    expect(copies).toHaveLength(3);
    const ys = copies.map((s) => Number(s.attrs['y']));
    const hs = copies.map((s) => Number(s.attrs['height']));
    const ext = l.extents.get('mt')!;
    expect(ext.y0).toBeCloseTo(Math.min(...ys), 9);
    expect(ext.y1).toBeCloseTo(Math.max(...ys.map((y, i) => y + hs[i]!)), 9);
    expect(ext.name).toBe('Inner tube');
  });

  it('decoration belongs to no part', () => {
    const tabs = l.shapes.filter((s) => s.key.startsWith('f1:tab'));
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.every((s) => s.part === undefined)).toBe(true);
  });

  it('a part with no id is drawn but cannot be hovered, selected or dragged', () => {
    const anon = rocket([{ type: 'launchlug', length: 0.03, outerRadius: 0.002 } as Partial<ComponentNode>]);
    const { l: a } = lay(anon);
    const lug = a.shapes.find((s) => s.key.includes(':lug0'))!;
    expect(lug.part).toBeUndefined();
    expect(a.grips.size).toBe(0);
  });
});
