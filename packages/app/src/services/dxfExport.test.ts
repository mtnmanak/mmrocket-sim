/**
 * R12 DXF writer tests. The parser below is written independently of the
 * writer — it knows only the published rule that a DXF is a flat stream of
 * (integer group code, value) LINE PAIRS — so a shared encoding bug cannot
 * self-verify. Everything the format promises a CAM package (AC1009, no
 * LWPOLYLINE, defined layers, exact millimetres, extents that bound the
 * geometry) is asserted here rather than eyeballed in LightBurn.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import type { SolidContext } from '../tree/solidMesh.js';
import { finOutline, tabOutline } from './finTemplate.js';
import { componentDxf, DXF_CUTTABLE, DXF_MIME } from './dxfExport.js';

interface Pair { code: number; value: string }
interface Ent { type: string; groups: Pair[] }

const node = (type: string, params: Record<string, unknown> = {}): ComponentNode =>
  ({ type, ...params } as unknown as ComponentNode);

/** Split the stream into group-code pairs, proving the pairing as it goes. */
const parse = (text: string): Pair[] => {
  const lines = text.split('\r\n');
  // The file ends with a terminator, so the final split element is empty.
  expect(lines[lines.length - 1]).toBe('');
  lines.pop();
  expect(lines.length % 2).toBe(0);
  const pairs: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = lines[i]!;
    const value = lines[i + 1]!;
    expect(code).toMatch(/^-?\d+$/);
    // A stray newline inside a value would silently reframe every later pair.
    expect(value).not.toMatch(/[\r\n]/);
    pairs.push({ code: Number(code), value });
  }
  return pairs;
};

/** Entities in the ENTITIES section, split on their leading code-0 marker. */
const entities = (pairs: Pair[]): Ent[] => {
  const start = pairs.findIndex((p, i) =>
    p.code === 2 && p.value === 'ENTITIES' && pairs[i - 1]?.code === 0 && pairs[i - 1]?.value === 'SECTION');
  expect(start).toBeGreaterThan(0);
  const out: Ent[] = [];
  for (let i = start + 1; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code === 0) {
      if (p.value === 'ENDSEC') return out;
      out.push({ type: p.value, groups: [] });
    } else {
      expect(out.length).toBeGreaterThan(0);
      out[out.length - 1]!.groups.push(p);
    }
  }
  throw new Error('ENTITIES section never closed');
};

/** Names defined in one TABLES sub-table (LAYER, LTYPE, STYLE). */
const tableNames = (pairs: Pair[], table: string): string[] => {
  const start = pairs.findIndex((p, i) =>
    p.code === 2 && p.value === table && pairs[i - 1]?.code === 0 && pairs[i - 1]?.value === 'TABLE');
  expect(start).toBeGreaterThan(0);
  const names: string[] = [];
  let inEntry = false;
  for (let i = start + 1; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code === 0) {
      if (p.value === 'ENDTAB') return names;
      inEntry = p.value === table;
    } else if (inEntry && p.code === 2) {
      names.push(p.value);
      inEntry = false;
    }
  }
  throw new Error(`${table} table never closed`);
};

const first = (e: Ent, code: number): string | undefined => e.groups.find((g) => g.code === code)?.value;
const real = (e: Ent, code: number): number => Number(first(e, code));

/** Header variable's following group values, e.g. hdr(pairs, '$EXTMIN', 10). */
const hdr = (pairs: Pair[], name: string, code: number): number => {
  const at = pairs.findIndex((p) => p.code === 9 && p.value === name);
  expect(at).toBeGreaterThanOrEqual(0);
  for (let i = at + 1; i < pairs.length && pairs[i]!.code !== 9; i++) {
    if (pairs[i]!.code === code) return Number(pairs[i]!.value);
  }
  throw new Error(`${name} has no group ${code}`);
};

/** Every (x, y) a reader would draw, in millimetres. */
const points = (ents: Ent[]): Array<[number, number]> => {
  const pts: Array<[number, number]> = [];
  for (const e of ents) {
    if (e.type === 'VERTEX') pts.push([real(e, 10), real(e, 20)]);
    else if (e.type === 'LINE') pts.push([real(e, 10), real(e, 20)], [real(e, 11), real(e, 21)]);
    else if (e.type === 'CIRCLE') {
      const [cx, cy, r] = [real(e, 10), real(e, 20), real(e, 40)];
      pts.push([cx - r, cy - r], [cx + r, cy + r]);
    }
  }
  return pts;
};

// A 100 mm root x 50 mm span trapezoid: every dimension is a round number in
// millimetres, so a doubled or missing x1000 shows up as a wrong integer.
const FIN = node('trapezoidfinset', {
  name: 'Main fins', finCount: 4,
  rootChord: 0.1, tipChord: 0.05, sweep: 0.03, height: 0.05, thickness: 0.003,
  crossSection: 'airfoil',
});
const TABBED = node('trapezoidfinset', {
  ...FIN, tabHeight: 0.012, tabLength: 0.04, tabOffsetMethod: 'middle', tabOffset: 0,
});
/** BT-60 airframe (24.5 mm bore) around a 29 mm motor mount. */
const RING_CTX: SolidContext = { parentInnerRadius: 0.0245, mountOuterRadius: 0.0146, bodyRadius: 0.0262 };

const dxf = (n: ComponentNode, ctx: SolidContext = {}): string => {
  const out = componentDxf(n, ctx, 'WM Goblin');
  expect(out).not.toBeNull();
  return out!.text;
};

/** The contour a reader would trace, in millimetres and in file order. */
const finVerts = (n: ComponentNode): Array<[number, number]> =>
  entities(parse(dxf(n))).filter((e) => e.type === 'VERTEX')
    .map((e) => [real(e, 10), real(e, 20)] as [number, number]);

/** Every TEXT string in the drawing, newline-joined. */
const labelText = (n: ComponentNode, ctx: SolidContext = {}): string =>
  entities(parse(dxf(n, ctx))).filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join('\n');

/**
 * A CLOSED contour must have no zero-length segment anywhere — including the
 * wrap from the last vertex back to the first, which the file never writes but
 * every reader draws. A degenerate edge has an undefined normal, which is what
 * kerf/cutter compensation consumes; Fusion 360 and LightBurn read the profile
 * as an error or as unclosed and the single-closed-path guarantee is gone.
 */
const noDegenerateEdges = (verts: Array<[number, number]>): void => {
  expect(verts.length).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    const [ax, ay] = verts[i]!;
    const [bx, by] = verts[j]!;
    expect(Math.hypot(bx - ax, by - ay), `segment ${i}->${j} of ${JSON.stringify(verts)}`)
      .toBeGreaterThan(1e-9);
  }
};

describe('DXF stream shape', () => {
  it('is a balanced group-code stream: HEADER first, ENDSEC before EOF', () => {
    const pairs = parse(dxf(FIN));
    expect(pairs[0]).toEqual({ code: 0, value: 'SECTION' });
    expect(pairs[1]).toEqual({ code: 2, value: 'HEADER' });
    expect(pairs[pairs.length - 1]).toEqual({ code: 0, value: 'EOF' });
    expect(pairs[pairs.length - 2]).toEqual({ code: 0, value: 'ENDSEC' });

    let depth = 0;
    let sections = 0;
    for (const p of pairs) {
      if (p.code !== 0) continue;
      if (p.value === 'SECTION') { depth++; sections++; }
      if (p.value === 'ENDSEC') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(depth).toBe(0);
    expect(sections).toBe(3); // HEADER, TABLES, ENTITIES

    const names = pairs.filter((p, i) => p.code === 2 && pairs[i - 1]?.value === 'SECTION').map((p) => p.value);
    expect(names).toEqual(['HEADER', 'TABLES', 'ENTITIES']);
  });

  it('declares R12 and millimetres, and never emits an LWPOLYLINE', () => {
    const text = dxf(FIN);
    const pairs = parse(text);
    const acad = pairs[pairs.findIndex((p) => p.code === 9 && p.value === '$ACADVER') + 1]!;
    expect(acad).toEqual({ code: 1, value: 'AC1009' });
    expect(hdr(pairs, '$INSUNITS', 70)).toBe(4);
    // LWPOLYLINE is an R14+ entity — an R12-only reader rejects the file.
    expect(text).not.toContain('LWPOLYLINE');
    expect(entities(pairs).some((e) => e.type === 'POLYLINE')).toBe(true);
  });

  it('stays 7-bit ASCII even when the design name is not', () => {
    const out = componentDxf(FIN, {}, 'Größe — “Ø75” pathfinder')!;
    expect(out.text).toMatch(/^[\x20-\x7e\r\n]*$/);
    const label = entities(parse(out.text)).filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join(' ');
    expect(label).toContain('Gr??e - "?75" pathfinder');
  });

  it('defines every layer, linetype and text style its entities reference', () => {
    for (const [n, ctx] of [[FIN, {}], [node('bulkhead'), RING_CTX], [node('centeringring'), RING_CTX]] as const) {
      const pairs = parse(dxf(n, ctx));
      const ents = entities(pairs);
      const layers = new Set(tableNames(pairs, 'LAYER'));
      const ltypes = new Set(tableNames(pairs, 'LTYPE'));
      const styles = new Set(tableNames(pairs, 'STYLE'));
      expect(ents.length).toBeGreaterThan(0);
      for (const e of ents) {
        expect(first(e, 8), `${e.type} has no layer`).toBeDefined();
        expect(layers).toContain(first(e, 8)!);
        const lt = first(e, 6);
        if (lt !== undefined) expect(ltypes).toContain(lt);
        const st = first(e, 7);
        if (st !== undefined) expect(styles).toContain(st);
      }
      expect([...layers].sort()).toEqual(['CUT', 'REFERENCE', 'TEXT']);
    }
  });

  it('$EXTMIN/$EXTMAX bound every emitted vertex', () => {
    for (const [n, ctx] of [[TABBED, {}], [node('centeringring'), RING_CTX], [node('tubecoupler'), RING_CTX]] as const) {
      const pairs = parse(dxf(n, ctx));
      const box = {
        minX: hdr(pairs, '$EXTMIN', 10), minY: hdr(pairs, '$EXTMIN', 20),
        maxX: hdr(pairs, '$EXTMAX', 10), maxY: hdr(pairs, '$EXTMAX', 20),
      };
      expect(box.maxX).toBeGreaterThan(box.minX);
      expect(box.maxY).toBeGreaterThan(box.minY);
      const pts = points(entities(pairs));
      expect(pts.length).toBeGreaterThan(0);
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(box.minX);
        expect(x).toBeLessThanOrEqual(box.maxX);
        expect(y).toBeGreaterThanOrEqual(box.minY);
        expect(y).toBeLessThanOrEqual(box.maxY);
      }
      expect(hdr(pairs, '$EXTMIN', 30)).toBe(0);
      expect(hdr(pairs, '$EXTMAX', 30)).toBe(0);
    }
  });

  it('$EXTMIN clears the label descenders, not just the text baseline', () => {
    const pairs = parse(dxf(FIN));
    const texts = entities(pairs).filter((e) => e.type === 'TEXT');
    expect(texts.length).toBeGreaterThan(0);
    const h = real(texts[0]!, 40);
    expect(h).toBeCloseTo(3.2, 9);
    const lowestBaseline = Math.min(...texts.map((t) => real(t, 20)));
    expect(lowestBaseline).toBe(-23); // last label line of an untabbed fin
    // Groups 10/20 give a TEXT's BASELINE, not the bottom of its glyphs: a
    // 3.2 mm STANDARD (txt) letter hangs ~0.8 mm below it. An extents box that
    // stops at the baseline makes "zoom extents" clip the tails off the line
    // that tells the operator to cut the CUT layer only.
    expect(hdr(pairs, '$EXTMIN', 20)).toBeLessThan(lowestBaseline);
    expect(hdr(pairs, '$EXTMIN', 20)).toBeCloseTo(lowestBaseline - h * 0.25, 4);
  });
});

describe('fin cut profiles', () => {
  it('applies the meters -> millimetres conversion exactly once', () => {
    const ents = entities(parse(dxf(FIN)));
    const verts = ents.filter((e) => e.type === 'VERTEX').map((e) => [real(e, 10), real(e, 20)] as const);
    expect(verts).toEqual([[0, 0], [30, 50], [80, 50], [100, 0]]);
    // Root chord and span land on the nominal numbers, not 0.1/0.05 or 1e5.
    expect(Math.max(...verts.map((v) => v[0]))).toBe(100);
    expect(Math.max(...verts.map((v) => v[1]))).toBe(50);
  });

  it('keeps DXF Y up: span is +Y, chord +X, no SVG-style flip', () => {
    const ents = entities(parse(dxf(FIN)));
    const ys = ents.filter((e) => e.type === 'VERTEX').map((e) => real(e, 20));
    expect(Math.max(...ys)).toBe(50);
    expect(Math.min(...ys)).toBe(0); // untabbed fin never dips below the root
  });

  it('merges a TTW tab into ONE closed contour that dips below y=0', () => {
    const ents = entities(parse(dxf(TABBED)));
    const polys = ents.filter((e) => e.type === 'POLYLINE');
    expect(polys.length).toBe(1);
    // 70 bit 1 = closed polyline; 66 = "vertices follow" (mandatory in R12).
    expect(Number(first(polys[0]!, 70)) & 1).toBe(1);
    expect(first(polys[0]!, 66)).toBe('1');
    expect(ents.filter((e) => e.type === 'SEQEND').length).toBe(1);

    const verts = ents.filter((e) => e.type === 'VERTEX').map((e) => [real(e, 10), real(e, 20)] as const);
    expect(verts.length).toBe(8); // 4 outline + 4 tab corners
    expect(verts.slice(0, 4)).toEqual([[0, 0], [30, 50], [80, 50], [100, 0]]);
    // 40 mm tab centred on a 100 mm root, 12 mm deep, below the root line.
    expect(verts).toContainEqual([70, -12]);
    expect(verts).toContainEqual([30, -12]);
    expect(Math.min(...verts.map((v) => v[1]))).toBe(-12);
  });

  it('dedups the merged contour: a "bottom" tab at offset 0 lands on the root corner', () => {
    // The tab's first corner is the trailing root corner, so the raw merge
    // emitted [100,0] twice — a zero-length segment in the middle of a closed
    // profile, on the single most common tab anchoring.
    const verts = finVerts(node('trapezoidfinset', {
      ...FIN, tabHeight: 0.012, tabLength: 0.04, tabOffsetMethod: 'bottom', tabOffset: 0,
    }));
    expect(verts).toEqual([[0, 0], [30, 50], [80, 50], [100, 0], [100, -12], [60, -12], [60, 0]]);
    noDegenerateEdges(verts);
  });

  it('a full-root tab closes without a zero-length wrap segment', () => {
    // tabLength === rootChord: the raw merge duplicated the trailing corner
    // AND closed back onto the leading one, so the degenerate edge straddled
    // the wrap where a naive consecutive-pairs check would never look.
    const verts = finVerts(node('trapezoidfinset', {
      ...FIN, tabHeight: 0.012, tabLength: 0.1, tabOffsetMethod: 'top', tabOffset: 0,
    }));
    expect(verts).toEqual([[0, 0], [30, 50], [80, 50], [100, 0], [100, -12], [0, -12]]);
    noDegenerateEdges(verts);
  });

  it('no tab anchoring produces a degenerate edge, wrap included', () => {
    for (const method of ['top', 'middle', 'bottom']) {
      for (const tabLength of [0.04, 0.1, 0.12]) {
        for (const tabOffset of [-0.02, 0, 0.02]) {
          noDegenerateEdges(finVerts(node('trapezoidfinset', {
            ...FIN, tabHeight: 0.012, tabLength, tabOffsetMethod: method, tabOffset,
          })));
        }
      }
    }
    // Freeform outlines go through the same merge — an L-shaped fin whose
    // trailing root corner is where the tab starts is the same collision.
    noDegenerateEdges(finVerts(node('freeformfinset', {
      points: [[0, 0], [0, 0.04], [0.02, 0.04], [0.02, 0.01], [0.05, 0.01], [0.05, 0]],
      tabHeight: 0.006, tabLength: 0.05, tabOffsetMethod: 'top', tabOffset: 0,
    })));
  });

  it('elliptical planform is a TRUE ellipse and matches the SVG template exactly', () => {
    // OpenRocket 24.12 EllipticalFinSet.java lines 17-25 sweep x as cos and y
    // as sin over ONE parameter. The sine hump this replaced walked x linearly
    // and sat at (22.5, 28.28) a quarter of the way along, where the ellipse
    // is at (21.87, 34.31) — 6 mm of span, 19% of enclosed area.
    const ell = node('ellipticalfinset', { rootChord: 0.09, height: 0.04 });
    const verts = finVerts(ell);
    for (const [x, y] of verts) {
      expect(((x - 45) / 45) ** 2 + (y / 40) ** 2, `(${x}, ${y}) off the ellipse`)
        .toBeCloseTo(1, 4);
    }
    expect(verts[21]![0]).toBeCloseTo(21.87, 2);
    expect(verts[21]![1]).toBeCloseTo(34.31, 2);

    // Vertex-for-vertex with the printable template, so the DXF, the SVG and
    // the extruded prism can never drift onto three different curves again.
    const want = finOutline(ell);
    expect(verts.length).toBe(want.length);
    for (const i of [0, 8, 16, 21, 32, 48, verts.length - 1]) {
      expect(verts[i]![0], `x at ${i}`).toBeCloseTo(want[i]!.x * 1000, 3);
      expect(verts[i]![1], `y at ${i}`).toBeCloseTo(want[i]!.y * 1000, 3);
    }
  });

  it('labels the tab extent that was CUT, not the one that was designed', () => {
    // A 40 mm 'top' tab starting 20 mm ahead of the root: OpenRocket (and the
    // SVG template) place it at [-20, +20] mm, the cut profile clamps it into
    // the root at [0, 20]. Printing the design length would send the operator
    // to cut a 40 mm airframe slot for a 20 mm tab.
    const clamped = node('trapezoidfinset', {
      ...FIN, tabHeight: 0.012, tabLength: 0.04, tabOffsetMethod: 'top', tabOffset: -0.02,
    });
    expect(tabOutline(clamped, 0.1)).toEqual({ x0: -0.02, x1: 0.02, depth: 0.012 });
    const label = labelText(clamped);
    expect(label).toContain('TTW tab 12.0 mm deep x 20.0 mm long at x 0.0-20.0 mm');
    expect(label).not.toContain('40.0 mm long');
    // The lowest emitted vertex agrees with what the label claims.
    const tabPts = finVerts(clamped).filter((p) => p[1] < 0);
    expect(Math.min(...tabPts.map((p) => p[0]))).toBe(0);
    expect(Math.max(...tabPts.map((p) => p[0]))).toBe(20);

    // An unclamped tab reports its full designed run.
    expect(labelText(TABBED)).toContain('TTW tab 12.0 mm deep x 40.0 mm long at x 30.0-70.0 mm');
  });

  it('draws the root chord as a dashed REFERENCE line, not a cut', () => {
    const ents = entities(parse(dxf(TABBED)));
    const lines = ents.filter((e) => e.type === 'LINE');
    expect(lines.length).toBe(1);
    expect(first(lines[0]!, 8)).toBe('REFERENCE');
    expect(first(lines[0]!, 6)).toBe('DASHED');
    expect([real(lines[0]!, 10), real(lines[0]!, 20)]).toEqual([0, 0]);
    expect([real(lines[0]!, 11), real(lines[0]!, 21)]).toEqual([100, 0]);
  });

  it('labels the part on the TEXT layer with the cut count and dimensions', () => {
    const texts = entities(parse(dxf(TABBED))).filter((e) => e.type === 'TEXT');
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) {
      expect(first(t, 8)).toBe('TEXT');
      expect(real(t, 40)).toBeCloseTo(3.2, 9); // 3.2 mm glyph height
    }
    const all = texts.map((t) => first(t, 1)).join('\n');
    expect(all).toContain('WM Goblin - Main fins (cut 4)');
    expect(all).toContain('root 100.0 mm');
    expect(all).toContain('span 50.0 mm');
    expect(all).toContain('stock thickness 3.0 mm');
    expect(all).toContain('airfoil cross-section');
    expect(all).toContain('TTW tab 12.0 mm deep');
    expect(all).toContain('1:1 in millimetres');
  });

  it('handles elliptical and freeform planforms', () => {
    const ell = entities(parse(dxf(node('ellipticalfinset', { rootChord: 0.09, height: 0.04 }))));
    const ey = ell.filter((e) => e.type === 'VERTEX').map((e) => real(e, 20));
    expect(Math.max(...ey)).toBeCloseTo(40, 3);

    const free = entities(parse(dxf(node('freeformfinset', {
      points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.06, 0]],
    }))));
    expect(free.filter((e) => e.type === 'VERTEX').length).toBe(4);

    // A freeform fin with too few points has no contour to cut.
    expect(componentDxf(node('freeformfinset', { points: [[0, 0]] }), {}, 'X')).toBeNull();
  });
});

describe('disc cut profiles', () => {
  it('centering ring: concentric CIRCLEs at the tube bore and the mount OD', () => {
    const ents = entities(parse(dxf(node('centeringring', { length: 0.003 }), RING_CTX)));
    const circles = ents.filter((e) => e.type === 'CIRCLE');
    expect(circles.length).toBe(2);
    const radii = circles.map((c) => real(c, 40)).sort((a, b) => a - b);
    expect(radii).toEqual([14.6, 24.5]);
    expect(radii[0]).toBeLessThan(radii[1]!); // bore strictly inside the OD
    for (const c of circles) {
      expect(first(c, 8)).toBe('CUT');
      expect([real(c, 10), real(c, 20), real(c, 30)]).toEqual([0, 0, 0]);
    }
    const all = ents.filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join('\n');
    expect(all).toContain('OD 49.0 mm');
    expect(all).toContain('bore 29.2 mm');
    expect(all).toContain('stock thickness 3.0 mm');
    expect(all).not.toContain('ASSUMED');
  });

  it('centering ring with no motor mount falls back and says so', () => {
    const out = componentDxf(node('centeringring'), { parentInnerRadius: 0.0245 }, 'WM Goblin')!;
    expect(out.label).toBe('Centering ring (assumed bore)');
    const ents = entities(parse(out.text));
    const radii = ents.filter((e) => e.type === 'CIRCLE').map((c) => real(c, 40)).sort((a, b) => a - b);
    expect(radii).toEqual([12.25, 24.5]); // half-radius bore, as componentSolid assumes
    expect(ents.filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join('\n')).toContain('BORE ASSUMED');
  });

  it('bulkhead: one cut circle plus centre cross-hairs on REFERENCE', () => {
    const ents = entities(parse(dxf(node('bulkhead', { length: 0.005 }), RING_CTX)));
    const circles = ents.filter((e) => e.type === 'CIRCLE');
    expect(circles.length).toBe(1);
    expect(real(circles[0]!, 40)).toBe(24.5);
    const lines = ents.filter((e) => e.type === 'LINE');
    expect(lines.length).toBe(2);
    for (const l of lines) expect(first(l, 8)).toBe('REFERENCE');
    // The cross-hairs straddle the origin on both axes.
    expect(lines.map((l) => real(l, 10) + real(l, 11))).toEqual([0, 0]);
    expect(lines.map((l) => real(l, 20) + real(l, 21))).toEqual([0, 0]);
  });

  it('coupler / engine block: an annulus at the parent bore and wall', () => {
    for (const t of ['tubecoupler', 'engineblock']) {
      const ents = entities(parse(dxf(node(t, { thickness: 0.0015, length: 0.05 }), RING_CTX)));
      const radii = ents.filter((e) => e.type === 'CIRCLE').map((c) => real(c, 40)).sort((a, b) => a - b);
      expect(radii).toEqual([23, 24.5]);
      expect(ents.filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join('\n'))
        .toContain('50.0 mm long');
    }
  });

  it('a wall at or past the radius reads as a solid disc, never a negative ID', () => {
    // discEnts() silently refuses an impossible bore, so the label has to be
    // derived from the bore it ACCEPTED — otherwise a 50 mm wall on a 24.5 mm
    // radius draws one circle and prints "ID -51.0 mm | wall 50.0 mm" beside
    // it. ringSolid() degrades the printed twin to a solid rod for the same
    // input, so the solid-disc reading is also the one that agrees with STL.
    for (const t of ['tubecoupler', 'engineblock']) {
      for (const thickness of [0.05, 0.0245, 0]) {
        const ents = entities(parse(dxf(node(t, { thickness, length: 0.05 }), RING_CTX)));
        const circles = ents.filter((e) => e.type === 'CIRCLE');
        expect(circles.length, `${t} @ ${thickness}`).toBe(1);
        expect(real(circles[0]!, 40)).toBe(24.5);
        const label = ents.filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join('\n');
        expect(label).toContain('OD 49.0 mm | ID 0.0 mm | wall 24.5 mm');
        expect(label).not.toContain('ID -');
      }
    }
  });

  it('OD/ID/wall always describe the circles that were emitted', () => {
    for (const thickness of [0.0005, 0.0015, 0.012, 0.02, 0.0245, 0.05]) {
      const ents = entities(parse(dxf(node('tubecoupler', { thickness, length: 0.05 }), RING_CTX)));
      const radii = ents.filter((e) => e.type === 'CIRCLE').map((c) => real(c, 40)).sort((a, b) => b - a);
      const label = ents.filter((e) => e.type === 'TEXT').map((e) => first(e, 1)).join('\n');
      const od = radii[0]! * 2;
      const id = radii.length > 1 ? radii[1]! * 2 : 0;
      expect(label, `thickness ${thickness}`)
        .toContain(`OD ${od.toFixed(1)} mm | ID ${id.toFixed(1)} mm | wall ${((od - id) / 2).toFixed(1)} mm`);
    }
  });

  it('sizes to the shared fallback radius when the parent gives nothing', () => {
    const radii = entities(parse(dxf(node('bulkhead'), {}))).filter((e) => e.type === 'CIRCLE')
      .map((c) => real(c, 40));
    expect(radii).toEqual([12]); // solidMesh's FALLBACK_RADIUS, in mm
  });
});

describe('DXF_CUTTABLE', () => {
  it('is exactly the set componentDxf can build', () => {
    const params: Record<string, unknown> = {
      rootChord: 0.08, height: 0.04, points: [[0, 0], [0.02, 0.03], [0.05, 0]],
    };
    for (const t of DXF_CUTTABLE) {
      expect(componentDxf(node(t, params), RING_CTX, 'X'), t).not.toBeNull();
    }
    for (const t of ['nosecone', 'bodytube', 'transition', 'innertube', 'tubefinset', 'launchlug']) {
      expect(componentDxf(node(t, params), RING_CTX, 'X'), t).toBeNull();
      expect(DXF_CUTTABLE.has(t)).toBe(false);
    }
  });

  it('exports the registered DXF media type', () => {
    expect(DXF_MIME).toBe('image/vnd.dxf');
  });
});
