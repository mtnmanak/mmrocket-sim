import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_VARS, IMAGE_FORMAT_EXT, IMAGE_WIDTHS } from './schematicExport.js';

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
