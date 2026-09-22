import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree, StaticInfo } from '@online-openrocket/engine';
import type { UnitSelection } from '../prefs/units.js';
import { dataHeaderLines, EXPORT_VARS, IMAGE_FORMAT_EXT, IMAGE_WIDTHS } from './schematicExport.js';
import { shownCp } from './simReport.js';

/**
 * EXPORT_VARS IS A HAND-MAINTAINED MIRROR OF ANOTHER FILE, AND A MISS IS
 * INVISIBLE.
 *
 * `schematicSvg` bakes the theme's CSS custom properties into the standalone
 * SVG by literal string replacement over the serialized markup. A var left out
 * of the list resolves to nothing in a standalone SVG, and for `stroke` and
 * `fill` that means the initial value — the element simply is not there. On
 * screen the same variable resolves normally, so there is no error, no console
 * warning and no visual cue in the app: TreeSchematic.tsx is 1,600 lines and
 * under active edit, and adding one new token to a callout would make that
 * element vanish from every ⬇ SVG and ⬇ Image export. The affected artifact is
 * the one the guide points at L3 / Tripoli Class 3 documentation packets, so
 * the first person to notice would be a cert reviewer looking at a drawing with
 * a missing CP marker.
 *
 * This turns that silent rendering failure into a red suite. The fix when it
 * fails is to add the new var and its light-theme value to EXPORT_VARS — never
 * to relax the assertion.
 */
const SCHEMATIC_SRC = readFileSync(
  fileURLToPath(new URL('../components/TreeSchematic.tsx', import.meta.url)), 'utf8');

const varsIn = (src: string): Set<string> =>
  new Set(Array.from(src.matchAll(/var\(--[a-z0-9-]+\)/g), (m) => m[0]));

describe('EXPORT_VARS covers every CSS variable the schematic emits', () => {
  it('read the schematic source at all — a silent empty read would pass vacuously', () => {
    expect(SCHEMATIC_SRC.length).toBeGreaterThan(1000);
    expect(varsIn(SCHEMATIC_SRC).size).toBeGreaterThan(5);
  });

  it('bakes a value for every var TreeSchematic uses', () => {
    const declared = new Set(EXPORT_VARS.map(([v]) => v));
    const missing = [...varsIn(SCHEMATIC_SRC)].filter((v) => !declared.has(v)).sort();
    expect(missing,
      'these resolve to nothing in a standalone SVG — invisible strokes and fills')
      .toEqual([]);
  });

  it('gives every entry a concrete light-theme colour, not another var', () => {
    for (const [name, value] of EXPORT_VARS) {
      expect(name, `${name} is not a var() reference`).toMatch(/^var\(--[a-z0-9-]+\)$/);
      expect(value, `${name} bakes to something that is not a literal colour`)
        .toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  it('names each var once — a duplicate would make the second replacement dead', () => {
    expect(new Set(EXPORT_VARS.map(([v]) => v)).size).toBe(EXPORT_VARS.length);
  });
});

describe('the export format table', () => {
  it('gives JPEG the extension people expect, not the format id', () => {
    expect(IMAGE_FORMAT_EXT.png).toBe('png');
    expect(IMAGE_FORMAT_EXT.jpeg).toBe('jpg');
  });

  it('offers ascending widths', () => {
    expect([...IMAGE_WIDTHS]).toEqual([...IMAGE_WIDTHS].sort((a, b) => a - b));
  });
});

/**
 * THE CERT-PACKET HEADER PRINTS THE CP THE MARGIN IS MEASURED FROM (audit
 * 2026-09-22), through the real kernel.
 *
 * It printed the theta = 0 single-plane `cp` beside the roll-swept margin, so
 * a design whose fins are not symmetric about every roll plane got a header
 * that contradicted itself and the CP marker drawn under it. And a design with
 * no lift at all got a CP of 0 and a margin, both artefacts.
 */
describe('dataHeaderLines — CP and margin, real kernel', () => {
  const units = { length: 'mm', mass: 'g' } as UnitSelection;
  const twoFins = (rotation: number): ComponentNode => ({
    type: 'trapezoidfinset', finCount: 2, rootChord: 0.05, tipChord: 0.03, sweep: 0.02,
    height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 }, rotation,
  } as unknown as ComponentNode);
  const staticOf = async (...parts: unknown[]): Promise<StaticInfo> => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const tree = { name: 'T', components: [{ type: 'stage', children: parts }] } as unknown as RocketTree;
    return OrkRocket.buildTree(tree).staticInfo();
  };
  const header = (info: StaticInfo) =>
    dataHeaderLines({ name: 'T', info, units, withMotors: false, appVersion: 'x' })[3]!;
  const nose = { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' };
  const tube = (kids: unknown[]) =>
    ({ type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, children: kids });

  it('two fins clocked 90 degrees: the forward CP, not the fins\' plane', async () => {
    const info = await staticOf(nose, tube([twoFins(Math.PI / 2)]));
    // The premise: the single plane and the swept CP really are far apart here.
    expect(info.cp * 1000).toBeCloseTo(301.611, 2);
    expect(shownCp(info) * 1000).toBeCloseTo(32.356, 2);
    const line = header(info);
    expect(line).toContain('CP 32.356 mm from nose tip');
    expect(line).not.toContain('301.611');
    expect(line).toContain('margin -7.47 cal');
  }, 30000);

  it('a three-fin rocket is unchanged — the two CPs are one', async () => {
    const info = await staticOf(nose, tube([{ ...twoFins(0), finCount: 3 }]));
    expect(shownCp(info)).toBeCloseTo(info.cp, 12);
    expect(header(info)).toBe('CG 232.57 mm, CP 291.012 mm from nose tip, margin 2.44 cal · 15.8%');
  }, 30000);

  it('no lift at any roll angle: no CP and no margin, and it says why', async () => {
    const info = await staticOf(tube([]));
    // It used to print "CP 0 mm from nose tip, margin -6.25 cal · -50.0%".
    expect(header(info)).toBe('CG 150 mm from nose tip, no CP or margin — no lift yet');
  }, 30000);
});
