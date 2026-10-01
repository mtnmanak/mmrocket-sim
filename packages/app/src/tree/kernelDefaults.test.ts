import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { componentLoop, finCutOutline } from './solidMesh.js';
import { buildPieces } from './pieces.js';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';
import { finOutline } from '../services/finTemplate.js';
import { componentDxf } from '../services/dxfExport.js';
import { kernelDefault } from './kernelDefaults.js';
import { engineTree, protuberanceFrontalArea } from './treeModel.js';

/**
 * WHAT AN ABSENT DIMENSION IS, read off the kernel bridge itself (audit
 * 2026-09-30). A node that carries no `length`, `thickness`, `outerRadius`,
 * `tipChord`… flies the bridge's own `dbl(node, key, default)`
 * (ComponentFactory.java) — and the printable STL, the DXF, the paper template,
 * the 3D shell and the side view each kept a fallback of their own: an engine
 * block printed 50 mm long where 5 mm flies, a body tube 100 mm with a 1 mm
 * wall where 300 mm with 0.3 mm flies, a trapezoid's tip 25 mm in the STL and
 * DXF but 30 mm on the paper template. Since v0.138 the panel commits no empty
 * field and the importers write full values, so the trigger is an older
 * session or a hand-edited file — and then nothing said the part differed.
 *
 * This reads the defaults out of the committed Java source (CI has it) and
 * builds each consumer from a part with NO dimension keys at all, so a drifted
 * fallback anywhere fails here against the kernel, not against a copy of it.
 */
const javaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'engine-java', 'src',
  'api', 'java', 'api', 'ComponentFactory.java');
const java = readFileSync(javaPath, 'utf8');

/** Every `dbl(node, "key", <literal>)` in each `case "type":` region of the bridge. */
function bridgeDefaults(): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  let type: string | null = null;
  for (const line of java.split('\n')) {
    const c = /^\s*case "([a-z]+)":/.exec(line);
    if (c) { type = c[1]!; continue; }
    if (/^\s*default:/.test(line) || /^\s{4}(private |static |public )/.test(line)) { type = null; continue; }
    if (!type) continue;
    for (const m of line.matchAll(/dbl\(node, "([A-Za-z]+)", (-?\d+(?:\.\d+)?(?:[eE]-?\d+)?)\)/g)) {
      if (!out.has(type)) out.set(type, new Map());
      out.get(type)!.set(m[1]!, Number(m[2]));
    }
  }
  return out;
}
const BRIDGE = bridgeDefaults();
/** The kernel's default for `key` on `type`, straight from the bridge. */
const k = (type: string, key: string): number => {
  const v = BRIDGE.get(type)?.get(key);
  if (v === undefined) throw new Error(`no dbl(node, "${key}", …) default under case "${type}"`);
  return v;
};

const bare = (type: string, extra: Record<string, unknown> = {}): ComponentNode =>
  ({ type, id: type, ...extra } as unknown as ComponentNode);

/** A ring loop [[0, ri], [0, R], [L, R], [L, ri]] read back as its three dimensions. */
const ringDims = (loop: Array<[number, number]>) =>
  ({ L: loop[2]![0], R: loop[1]![1], wall: loop[1]![1] - loop[0]![1] });

describe('the bridge parse finds the defaults it needs', () => {
  it('reads ComponentFactory.java', () => {
    // A guard on the parser itself: a silent parse failure would make every
    // check below vacuous.
    expect(k('bodytube', 'length')).toBe(0.3);
    expect(k('engineblock', 'length')).toBe(0.005);
    expect(k('trapezoidfinset', 'tipChord')).toBe(0.03);
  });
});

/**
 * The dimensions a node can omit and the kernel still fly one value for — and
 * a mass component's mass, which Scale rocket multiplies as it does them.
 */
const DIMENSIONS = ['length', 'outerRadius', 'aftRadius', 'radius', 'thickness',
  'rootChord', 'tipChord', 'sweep', 'height',
  'diameter', 'lineLength', 'stripLength', 'stripWidth', 'cordLength', 'mass'];

describe('the table IS the bridge (tree/kernelDefaults.ts)', () => {
  it('every entry for a kernel part is the bridge\'s own default', () => {
    for (const [type, keys] of BRIDGE) {
      for (const key of DIMENSIONS) {
        if (!keys.has(key)) continue;
        expect(kernelDefault(type, key), `${type}.${key}`).toBe(keys.get(key));
      }
    }
  });

  it('holds a default for every dimension the bridge defaults — nothing left to a guess', () => {
    const missing: string[] = [];
    for (const [type, keys] of BRIDGE) {
      for (const key of keys.keys()) {
        if (DIMENSIONS.includes(key) && kernelDefault(type, key) === undefined) missing.push(`${type}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('holds NO value where the kernel has none: an automatic radius stays the caller\'s placeholder', () => {
    // NaN in the bridge means "automatic" (setXAutomatic) or "inherit".
    expect(kernelDefault('transition', 'foreRadius')).toBeUndefined();
    expect(kernelDefault('transition', 'aftRadius')).toBeUndefined();
    expect(kernelDefault('tubecoupler', 'outerRadius')).toBeUndefined();
    expect(kernelDefault('tubefinset', 'thickness')).toBeUndefined();
    expect(kernelDefault('parachute', 'length')).toBeUndefined();
    // And the table cannot be reached through Object.prototype.
    expect(kernelDefault('constructor', 'length')).toBeUndefined();
    expect(kernelDefault('bodytube', 'constructor')).toBeUndefined();
  });

  it('the two app-only parts\' entries are what engineTree lowers them with', () => {
    // A camera shroud flies as a one-fin strake: points end at its length,
    // its thickness is the shroud's width, its peak is the shroud's height.
    const lowered = engineTree({
      name: 'R',
      components: [{ id: 's1', type: 'stage', children: [
        { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.025, children: [{ id: 'f', type: 'fairing' }] },
      ] }],
    } as unknown as RocketTree);
    const strake = (lowered.components[0]!.children![0]!.children ?? []).find((c) => c.id === 'f')!;
    const pts = strake['points'] as [number, number][];
    expect(pts[pts.length - 1]![0]).toBeCloseTo(kernelDefault('fairing', 'length')!, 12);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(kernelDefault('fairing', 'height')!, 12);
    expect(strake['thickness']).toBeCloseTo(kernelDefault('fairing', 'width')!, 12);
    // A protuberance's frontal area is width x height.
    expect(protuberanceFrontalArea(bare('protuberance')))
      .toBeCloseTo(kernelDefault('protuberance', 'width')! * kernelDefault('protuberance', 'height')!, 15);
  });
});

describe('every printed, cut and drawn part with no dimension keys is the part the kernel flies', () => {
  it('the printable STL: nose cone, transition, tubes, lug, coupler, rings, block', () => {
    const nose = componentLoop(bare('nosecone'), {})!;
    expect(nose.bodySpan[1]).toBeCloseTo(k('nosecone', 'length'), 12);
    expect(nose.wall).toBeCloseTo(k('nosecone', 'thickness'), 12);

    const trans = componentLoop(bare('transition', { foreRadius: 0.02, aftRadius: 0.015 }), {})!;
    expect(trans.bodySpan[1]).toBeCloseTo(k('transition', 'length'), 12);
    expect(trans.wall).toBeCloseTo(k('transition', 'thickness'), 12);

    for (const type of ['bodytube', 'innertube', 'launchlug']) {
      const d = ringDims(componentLoop(bare(type), {})!.loop);
      expect(d.L, `${type} length`).toBeCloseTo(k(type, 'length'), 12);
      expect(d.R, `${type} outer radius`).toBeCloseTo(k(type, 'outerRadius'), 12);
      expect(d.wall, `${type} wall`).toBeCloseTo(k(type, 'thickness'), 12);
    }

    // Automatic outer radii: sized by the bore they sit in, which ctx carries.
    const ctx = { parentInnerRadius: 0.02, mountOuterRadius: 0.01 };
    for (const type of ['tubecoupler', 'engineblock']) {
      const d = ringDims(componentLoop(bare(type), ctx)!.loop);
      expect(d.L, `${type} length`).toBeCloseTo(k(type, 'length'), 12);
      expect(d.wall, `${type} wall`).toBeCloseTo(k(type, 'thickness'), 12);
    }
    for (const type of ['centeringring', 'bulkhead']) {
      expect(ringDims(componentLoop(bare(type), ctx)!.loop).L, `${type} length`)
        .toBeCloseTo(k(type, 'length'), 12);
    }
  });

  it('the fin outlines: the STL/DXF contour and the paper template', () => {
    const want: Array<[number, number]> = [
      [0, 0],
      [k('trapezoidfinset', 'sweep'), k('trapezoidfinset', 'height')],
      [k('trapezoidfinset', 'sweep') + k('trapezoidfinset', 'tipChord'), k('trapezoidfinset', 'height')],
      [k('trapezoidfinset', 'rootChord'), 0],
    ];
    const cut = finCutOutline(bare('trapezoidfinset'))!;
    const tpl = finOutline(bare('trapezoidfinset')).map((p): [number, number] => [p.x, p.y]);
    for (const [i, [x, y]] of want.entries()) {
      expect(cut[i]![0], `cut x${i}`).toBeCloseTo(x, 12);
      expect(cut[i]![1], `cut y${i}`).toBeCloseTo(y, 12);
      expect(tpl[i]![0], `template x${i}`).toBeCloseTo(x, 12);
      expect(tpl[i]![1], `template y${i}`).toBeCloseTo(y, 12);
    }
    const ell = finCutOutline(bare('ellipticalfinset'))!;
    expect(Math.max(...ell.map((p) => p[0]))).toBeCloseTo(k('ellipticalfinset', 'rootChord'), 12);
    expect(Math.max(...ell.map((p) => p[1]))).toBeCloseTo(k('ellipticalfinset', 'height'), 12);
  });

  it('the DXF labels: a ring\'s stock, a block\'s length and a coupler\'s wall', () => {
    const ctx = { parentInnerRadius: 0.02, mountOuterRadius: 0.01 };
    const label = (type: string) => componentDxf(bare(type), ctx, 'R')!.text;
    const mm = (m: number) => (m * 1000).toFixed(1);
    expect(label('centeringring')).toContain(`stock thickness ${mm(k('centeringring', 'length'))} mm`);
    expect(label('bulkhead')).toContain(`stock thickness ${mm(k('bulkhead', 'length'))} mm`);
    expect(label('engineblock')).toContain(`${mm(k('engineblock', 'length'))} mm long`);
    expect(label('tubecoupler')).toContain(`wall ${mm(k('tubecoupler', 'thickness'))} mm`);
  });

  const onTube = (child: Record<string, unknown>): RocketTree => ({
    name: 'R',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.025, children: [child] },
    ] }],
  } as unknown as RocketTree);

  it('the 3D shell: an inner tube and a launch lug', () => {
    type Cyl = { parameters: { height: number; radiusTop: number } };
    const cyl = (child: Record<string, unknown>, prefix: string) =>
      buildPieces(onTube(child)).pieces.find((p) => p.key.startsWith(prefix))!.geometry as unknown as Cyl;
    const mmt = cyl({ id: 'm', type: 'innertube', position: { method: 'bottom', offset: 0 } }, 'inner');
    expect(mmt.parameters.height).toBeCloseTo(k('innertube', 'length'), 12);
    expect(mmt.parameters.radiusTop).toBeCloseTo(k('innertube', 'outerRadius'), 12);
    const lug = cyl({ id: 'l', type: 'launchlug', position: { method: 'top', offset: 0 } }, 'lug');
    expect(lug.parameters.height).toBeCloseTo(k('launchlug', 'length'), 12);
    expect(lug.parameters.radiusTop).toBeCloseTo(k('launchlug', 'outerRadius'), 12);
  });

  it('the side view: a trapezoid with only a root chord, and a launch lug', () => {
    const FRAME = { cw: 640, chPx: 480, maxHeight: 480, rulers: false, rollW: 0, rollBar: 0, lanes: false, topReserve: 0 };
    const lay = (child: Record<string, unknown>) => {
      const t = onTube(child);
      const f = schematicFrame(t, FRAME);
      return { f, l: layoutSchematic(t, { scale: f.scale, cy: f.cy, x0: f.x0, roll: 0, idPrefix: 't' }) };
    };
    // 100 mm root, no tip: the kernel flies a 30 mm tip; this drew 0.6 x root.
    const { f, l } = lay({ id: 'f', type: 'trapezoidfinset', finCount: 1, rootChord: 0.1, position: { method: 'top', offset: 0 } });
    const pts = String(l.shapes.find((s) => s.key === 'f:fin0')!.attrs['points']).split(' ')
      .map((p) => Number(p.split(',')[0]));
    expect((pts[2]! - pts[1]!) / f.scale).toBeCloseTo(k('trapezoidfinset', 'tipChord'), 9);
    const { f: g, l: m } = lay({ id: 'l', type: 'launchlug', angleOffset: 0, position: { method: 'top', offset: 0 } });
    const lug = m.shapes.find((s) => s.key === 'l:lug0')!;
    // Standing off the tube by its own diameter.
    expect(Number(lug.attrs['height']) / g.scale).toBeCloseTo(2 * k('launchlug', 'outerRadius'), 9);
  });
});
