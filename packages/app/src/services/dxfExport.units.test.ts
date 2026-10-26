/**
 * The DXF drawing unit follows the Rocket dimensions (`prefs.units.length`) preference (@atestani, TRF
 * 2026-10-11: "the DXF export doesn't respect my units preference"). Imperial
 * draws in inches; metric retains the v0.179 files except the engine-block
 * wall label corrected from 0.9 to 0.95 mm (fabrication precision audit).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import type { SolidContext } from '../tree/solidMesh.js';
import { componentDxf, dxfUnitFor, dxfUnitWord, type DxfUnit } from './dxfExport.js';

const node = (type: string, p: Record<string, unknown> = {}): ComponentNode =>
  ({ type, ...p } as unknown as ComponentNode);

const FIN = node('trapezoidfinset', {
  name: 'Main fins', finCount: 4, rootChord: 0.1, tipChord: 0.05, sweep: 0.03, height: 0.05,
  thickness: 0.003, crossSection: 'airfoil',
});
const TABBED = node('trapezoidfinset', {
  ...FIN, tabHeight: 0.012, tabLength: 0.04, tabOffsetMethod: 'middle', tabOffset: 0,
});
const RING_CTX: SolidContext = { parentInnerRadius: 0.0245, mountOuterRadius: 0.0146, bodyRadius: 0.0262 };

/** [case, node, ctx, millimetre file sha256, length]; engine-block label corrected. */
const GOLDEN: Array<[string, ComponentNode, SolidContext, string, number]> = [
  ['trapezoid', FIN, {}, '9c85132824dfa25ef1137c5d83f1e2370b1bb2571ab65350ba0d4e39a7f6d19e', 1638],
  ['trapezoid with tab', TABBED, {}, 'da621933a525436bc482cd681a2c2373efa6fb2570eb45d31cf8952220ab4028', 1922],
  ['elliptical', node('ellipticalfinset', { rootChord: 0.08, height: 0.06, thickness: 0.0032 }), {},
    '024a3020ffdc6c84891083852653274ef081434ab8ea3f06944ef699345a1a3f', 5096],
  ['freeform', node('freeformfinset', {
    points: [[0, 0], [0.02, 0.05], [0.07, 0.055], [0.09, 0]], thickness: 0.002,
  }), {}, 'f5f0a76968d682d97b29fdc37ce743fddf9527a1c23428dcd5fae72dc290c768', 1637],
  ['centering ring', node('centeringring', { length: 0.003 }), RING_CTX,
    '8b8c410e6bdb8629369ed3907f733f0f1b7e65d2add73d0a5875b4c189e4285a', 1520],
  ['ring, no mount', node('centeringring'), { parentInnerRadius: 0.0245 },
    'fbb171eeef1d1951401c34e311474193dffd9f229a60a39872ab7baba4fb6c41', 1612],
  ['ring, mount too big', node('centeringring'), { parentInnerRadius: 0.0145, mountOuterRadius: 0.0146 },
    'e101a7b7774e1b16eff71f5b3651882ad5fc4c64df6bf93c4dce40ce5ea86819', 1631],
  ['bulkhead', node('bulkhead', { length: 0.005 }), { parentInnerRadius: 0.0245 },
    'c7e80a2104dd60c44242cc7d607e3cea09649637942bdbe961108bf89c4b0d18', 1476],
  ['coupler', node('tubecoupler', { thickness: 0.0015, length: 0.05 }), { parentInnerRadius: 0.0245 },
    'ff9a323e5639ec890c16df3a68e6f7cd12e607220cea23c5bb9349202c3bd772', 1569],
  ['engine block, assumed size', node('engineblock'), {},
    'e0aad791e45bc78c62e09c42222bfadf08f7bc07ea7e5e476b1b70e902156369', 1669],
];

const NAME = 'Gö “Rocket”';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const draw = (n: ComponentNode, ctx: SolidContext, unit?: DxfUnit): string => {
  const out = unit === undefined ? componentDxf(n, ctx, NAME) : componentDxf(n, ctx, NAME, unit);
  expect(out).not.toBeNull();
  return out!.text;
};

interface Pair { code: number; value: string }
const pairs = (text: string): Pair[] => {
  const lines = text.split('\r\n');
  lines.pop();
  const out: Pair[] = [];
  for (let i = 0; i < lines.length; i += 2) out.push({ code: Number(lines[i]), value: lines[i + 1]! });
  return out;
};
/** The value after a header variable, e.g. $INSUNITS's group 70. */
const hdr = (ps: Pair[], name: string, code: number): string => {
  const at = ps.findIndex((p) => p.code === 9 && p.value === name);
  expect(at).toBeGreaterThanOrEqual(0);
  return ps.slice(at + 1).find((p) => p.code === code)!.value;
};
/**
 * Every real-valued group (10/11/20/21/30/31/40 coordinates and sizes, the
 * DASHED pattern's 40/49, the style's 42) after the HEADER, in file order,
 * with its code. The header extents are checked on their own: $EXTMAX's x is
 * often the end of the longest label line, and the inch labels are worded
 * with different lengths.
 */
const reals = (text: string): Array<[number, number]> => pairs(text)
  .slice(pairs(text).findIndex((p) => p.code === 0 && p.value === 'ENDSEC'))
  .filter((p) => [10, 11, 20, 21, 30, 31, 40, 42, 49].includes(p.code) && /^-?\d+\.\d+$/.test(p.value))
  .map((p) => [p.code, Number(p.value)]);
const texts = (text: string): string[] => {
  const ps = pairs(text);
  return ps.filter((p, i) => p.code === 1 && ps.slice(0, i).reverse().find((q) => q.code === 0)?.value === 'TEXT')
    .map((p) => p.value);
};

describe('dxfUnitFor — the Rocket dimensions (`prefs.units.length`) preference picks the drawing unit', () => {
  it.each([['in', 'inches'], ['mm', 'millimetres']] as const)('CR-5: %s exposes the word used by the drawing labels', (unit, word) => {
    expect(dxfUnitWord, 'the shared drawing-unit word helper').toBeTypeOf('function');
    expect(dxfUnitWord(unit)).toBe(word);
    expect(draw(FIN, {}, unit)).toContain(`1:1 in ${word}`);
  });

  it('in and ft draw in inches; mm, cm and m in millimetres', () => {
    expect(dxfUnitFor('in')).toBe('in');
    expect(dxfUnitFor('ft')).toBe('in');
    for (const s of ['mm', 'cm', 'm']) expect(dxfUnitFor(s)).toBe('mm');
  });
});

describe('metric DXF preserves its golden files and corrected wall label', () => {
  it.each(GOLDEN)('%s', (_k, n, ctx, hash, length) => {
    for (const text of [draw(n, ctx), draw(n, ctx, 'mm')]) {
      expect(text.length).toBe(length);
      expect(sha(text)).toBe(hash);
    }
  });
});

describe('imperial DXF draws in inches', () => {
  it.each(GOLDEN)('%s: every number is the millimetre one / 25.4, and $INSUNITS is 1', (_k, n, ctx) => {
    const mmText = draw(n, ctx, 'mm');
    const inText = draw(n, ctx, 'in');
    expect(hdr(pairs(mmText), '$INSUNITS', 70)).toBe('4');
    expect(hdr(pairs(inText), '$INSUNITS', 70)).toBe('1');
    // Same entities, same order: only the numbers and the label words differ.
    expect(pairs(inText).map((p) => p.code)).toEqual(pairs(mmText).map((p) => p.code));
    const a = reals(mmText);
    const b = reals(inText);
    expect(b.length).toBe(a.length);
    expect(a.length).toBeGreaterThan(10);
    // Geometry, extents, text height, label gaps, dash pattern and the style
    // height all scale — so the drawing LOOKS the same, only its unit moves.
    // Tolerance: the mm file's own 4-decimal (0.1 µm) rounding, and the table
    // figures' 1-decimal (0.05 mm) one.
    // The extents: the bottom-left corner and the top are geometry (or the
    // last label's descender, a scaled fixed figure), so they scale; the
    // right edge only has to cover every x drawn.
    for (const [name, code] of [['$EXTMIN', 10], ['$EXTMIN', 20], ['$EXTMAX', 20]] as const) {
      expect(Math.abs(Number(hdr(pairs(inText), name, code)) * 25.4 - Number(hdr(pairs(mmText), name, code))),
        `${name} ${code}`).toBeLessThan(1e-4);
    }
    const xs = b.filter(([code]) => code === 10 || code === 11).map(([, v]) => v);
    expect(Number(hdr(pairs(inText), '$EXTMAX', 10))).toBeGreaterThanOrEqual(Math.max(...xs));
    b.forEach(([code, v], i) => {
      const [code0, mm] = a[i]!;
      expect(code).toBe(code0);
      const tol = code === 42 || code === 49 || (code === 40 && Math.abs(mm - 3.5) < 1e-9) ? 0.06 : 1e-4;
      expect(Math.abs(v * 25.4 - mm), `group ${code} #${i}: ${v} in vs ${mm} mm`).toBeLessThan(tol);
    });
  });

  it('labels a fin in inches, to the thousandth', () => {
    const t = texts(draw(TABBED, {}, 'in')).join('\n');
    expect(t).toContain('root 3.937 in | span 1.969 in | stock thickness 0.118 in | airfoil cross-section');
    expect(t).toContain('TTW tab 0.472 in deep x 1.575 in long at x 1.181-2.756 in');
    expect(t).toContain('1:1 in inches - cut the CUT layer only');
    expect(t).not.toMatch(/\bmm\b|millimetres/);
  });

  it('labels discs in inches, the bore warning included', () => {
    const ring = texts(draw(node('centeringring', { length: 0.003 }), RING_CTX, 'in')).join('\n');
    expect(ring).toContain('OD 1.929 in | bore 1.150 in | stock thickness 0.118 in');
    const bad = texts(draw(node('centeringring'), { parentInnerRadius: 0.0145, mountOuterRadius: 0.0146 }, 'in')).join('\n');
    expect(bad).toContain("motor mount dia 1.150 in does not fit this ring's 1.142 in OD");
    const coupler = texts(draw(node('tubecoupler', { thickness: 0.0015, length: 0.05 }), RING_CTX, 'in')).join('\n');
    expect(coupler).toContain('OD 1.929 in | ID 1.811 in | wall 0.059 in | 1.969 in long');
    for (const t of [ring, bad, coupler]) expect(t).not.toMatch(/\bmm\b|millimetres/);
  });

  it('a 100 mm root lands on 3.937008 in — converted once, not twice or never', () => {
    const ps = pairs(draw(FIN, {}, 'in'));
    const xs = ps.filter((p, i) => p.code === 10 && ps[i - 2]?.value === 'VERTEX').map((p) => Number(p.value));
    expect(xs).toHaveLength(4);
    expect(Math.max(...xs)).toBeCloseTo(0.1 / 0.0254, 6);
  });

  it('keeps the dash pattern at 2 mm / 1.5 mm, written in inches', () => {
    const ps = pairs(draw(FIN, {}, 'in'));
    const at = ps.findIndex((p) => p.code === 2 && p.value === 'DASHED');
    const dash = ps.slice(at).filter((p) => p.code === 40 || p.code === 49).slice(0, 3).map((p) => p.value);
    expect(dash).toEqual(['0.1378', '0.0787', '-0.0591']);
  });
});

it.each([
  ['mm', "motor mount is just over this ring's 29.0 mm OD and does not fit"],
  ['in', "motor mount is just over this ring's 1.142 in OD and does not fit"],
] as const)('keeps a close ring/motor refusal distinct in %s drawing units', (unit, expected) => {
  const text = texts(draw(node('centeringring'), { parentInnerRadius: 0.0145, mountOuterRadius: 0.01450001 }, unit)).join(' ');
  expect(text).toContain(expected);
});
