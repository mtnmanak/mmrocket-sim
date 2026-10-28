import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import {
  explainBuildFailure, limitPatch, partBlockingBuild, sanitizeTree, separationEventOrDefault, treeProblems,
} from './sanitize.js';
import { defaultTree, engineTree, normalizeTree } from './treeModel.js';
import { noteFlags, tierLines } from '../services/importNotes.js';

it.each(['centeringring', 'tubecoupler', 'bulkhead', 'bodytube'] as const)(
  'removes JSON-overflow radii from %s with a repair note', type => {
    const notes: string[] = [];
    const raw = JSON.parse('{"outerRadius":1e999,"innerRadius":-1e999}');
    const fixed = sanitizeTree({ components: [{ type, ...raw }] }, notes);
    expect(fixed.components[0]!['outerRadius']).toBeUndefined();
    expect(fixed.components[0]!['innerRadius']).toBeUndefined();
    expect(notes.join(' ')).toMatch(/radius.*could not be read/i);
    expect(treeProblems(fixed)).toEqual([]);
  });

it.each(['rounded', 'airfoil'])('keeps an origin-only %s outline informational after importer sanitization', crossSection => {
  const input: RocketTree = { components: [{ type: 'stage', id: 's', children: [
    { type: 'freeformfinset', id: 'f', name: 'Fins', crossSection,
      points: [[0.01, 0], [0.03, 0.03], [0.07, 0]] },
  ] }] };
  const notes: string[] = [];
  expect(treeProblems(input)).toEqual([]);
  const fixed = normalizeTree(sanitizeTree(input, notes), notes);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('its points were moved to the origin to match desktop OR');
  expect(tierLines(notes, noteFlags(notes))[0]?.tier).toBe('information');
  expect(fixed.components[0]!.children![0]!['points']).toEqual([[0, 0], [0.03 - 0.01, 0.03], [0.07 - 0.01, 0]]);
});
import {
  FIELDS, fieldLimit, KERNEL_MAX_FINS, MAX_ASSEMBLY_INSTANCES, MAX_DIMENSION_M,
  MAX_SHROUD_LINES, MIN_POSITIVE_DIMENSION_M, MAX_BULK_DENSITY, type EditorComponentType,
} from './schema.js';

/**
 * The load boundary's sanitize pass (audit 2026-09-22, Step 2 item 12): one
 * limits table in schema.ts, applied in normalizeTree — the chokepoint for a
 * file, a share link and a restored session — with one note per repair.
 */

/** A body tube carrying `kids`, under one stage, plus any extra stages. */
const rocket = (kids: Record<string, unknown>[], extraStages: Record<string, unknown>[] = []): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage', name: 'Sustainer',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012, thickness: 0.002 },
      { id: 'b1', type: 'bodytube', name: 'Body tube', length: 0.3, outerRadius: 0.012, thickness: 0.0005, children: kids },
    ],
  }, ...extraStages],
}) as unknown as RocketTree;

const kid = (tree: RocketTree, i = 0): ComponentNode => tree.components[0]!.children![1]!.children![i]!;

it.each(['rounded', 'airfoil'])('loads an unchanged dense %s outline with linear coordinate reads', crossSection => {
  let reads = 0;
  const points = Array.from({ length: 512 }, (_, i) => {
    const x = i * 0.0001, y = i === 0 || i === 511 ? 0 : 0.02;
    return Object.defineProperties([x, y], {
      0: { get: () => { reads++; return x; } },
      1: { get: () => { reads++; return y; } },
    });
  });
  const notes: string[] = [];
  const fixed = normalizeTree(rocket([{ type: 'freeformfinset', crossSection, points }]), notes);
  // Allow shape repair and both sanitize passes, but not segment-pair checks.
  expect(reads).toBeLessThan(points.length * 100);
  expect(kid(fixed)['points']).toBe(points);
  expect(notes).toEqual([]);
});

it.each([Infinity, -Infinity])('repairs an overflowed JSON position %s', offset => {
  const notes: string[] = [];
  const fixed = normalizeTree(rocket([{ type: 'masscomponent', position: { method: 'top', offset } }]), notes);
  expect(Number.isFinite(kid(fixed).position!.offset)).toBe(true);
  expect(notes.join(' ')).toMatch(/position/);
});

it.each([{ method: 'absolute' }, { method: 'absolute', offset: 'bad' }])(
  'repairs unreadable absolute offsets before converting position %j', position => {
    const notes: string[] = [];
    const fixed = normalizeTree(rocket([{ type: 'masscomponent', id: 'bad', position }]), notes);
    expect(kid(fixed).position!.method).toBe('top');
    // The body starts 0.1 m aft of the nose; rocket station 0 is -0.1 m from it.
    expect(kid(fixed).position!.offset).toBeCloseTo(-0.1, 10);
    expect(notes.join(' ')).toMatch(/position.*could not be read/);
  },
);

it('repairs a parent offset before converting an absolute child', () => {
  const notes: string[] = [];
  const fixed = normalizeTree(rocket([{ type: 'innertube', id: 'parent', position: { method: 'top' },
    children: [{ type: 'masscomponent', id: 'absolute', position: { method: 'absolute', offset: 0.25 } }] }]), notes);
  expect(kid(fixed).position).toEqual({ method: 'top', offset: 0 });
  expect(kid(fixed).children![0]!.position!.offset).toBeCloseTo(0.15, 10);
  expect(notes.join(' ')).toMatch(/position.*could not be read/);
});

it.each([{ method: 'top' }, { method: 'top', offset: '0.2' }, { method: 'bogus', offset: 0 },
  { method: 'bogus', offset: 1e6 }, 'bad'])(
  'S4a-3 repairs an unreadable restored position %j', position => {
    const notes: string[] = [];
    const fixed = normalizeTree(rocket([{ id: 'bad', type: 'masscomponent', position }]), notes);
    expect(kid(fixed).position).toEqual({ method: 'top', offset: 0 });
    expect(notes.join(' ')).toMatch(/position.*could not be read/);
  },
);

it.each(['length', 'position'])('S4a-6 does not claim to repair a NaN %s', field => {
  const node: ComponentNode = { type: 'bodytube', id: 'nan',
    ...(field === 'length' ? { length: NaN } : { position: { method: 'top', offset: NaN } }) };
  const tree: RocketTree = { components: [node] };
  const notes: string[] = [];
  expect(sanitizeTree(tree, notes)).toBe(tree);
  expect(notes).toEqual([]);
});

it('S4a-6 preserves an unrepairable NaN patch without a bogus note', () => {
  const patch = { length: NaN };
  const notes: string[] = [];
  expect(limitPatch({ type: 'bodytube' }, patch, notes)).toBe(patch);
  expect(notes).toEqual([]);
});

/** Build the way services/buildDesign.ts does; the kernel's message, or null. */
function build(tree: RocketTree): string | null {
  try {
    resetEngine();
    OrkRocket.buildTree(engineTree(tree)).staticInfo();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

it('R10 normalizes negative wall residue before a kernel build', () => {
  const tree = rocket([]);
  tree.components[0]!.children![1]!['thickness'] = -1e-12;
  const notes: string[] = [];
  const fixed = normalizeTree(tree, notes);
  expect(build(fixed)).toBeNull();
  expect(fixed.components[0]!.children![1]!['thickness']).toBe(0);
  expect(notes).toEqual([]);
});

describe('sanitizeTree — bulk density', () => {
  it('clamps bulk and fillet density with one note per repair, and normalizes idempotently', () => {
    const notes: string[] = [];
    const tree = rocket([{ id: 'f1', type: 'trapezoidfinset', name: 'Fins', density: 1e33,
      filletDensity: 1e30, rootChord: 0.05, height: 0.03 }]);
    const fixed = sanitizeTree(tree, notes);
    expect(kid(fixed)['density']).toBe(MAX_BULK_DENSITY);
    expect(kid(fixed)['filletDensity']).toBe(MAX_BULK_DENSITY);
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(note).toMatch(/density .* is over the limit of 30000 kg\/m³ \(1872\.84 lb\/ft³\) — set to 30000 kg\/m³ \(1872\.84 lb\/ft³\)\./);
    expect(kid(normalizeTree(tree))['density']).toBe(MAX_BULK_DENSITY);
    const again: string[] = [];
    sanitizeTree(fixed, again);
    expect(again).toEqual([]);
  });

  it.each([0, 8906.2656504, 22_600, 30_000])('preserves a legitimate bulk density of %s without a note', (density) => {
    const notes: string[] = [];
    const fixed = sanitizeTree(rocket([{ id: 'i1', type: 'innertube', density }]), notes);
    expect(kid(fixed)['density']).toBe(density);
    expect(notes).toEqual([]);
  });

  it('does not apply a volume-density ceiling to area or line density', () => {
    expect(fieldLimit('parachute', 'surfaceDensity')?.hmax).toBeUndefined();
    expect(fieldLimit('shockcord', 'lineDensity')?.hmax).toBeUndefined();
  });
});

describe('sanitizeTree — counts', () => {
  it('brings every count inside the kernel\'s (or the app\'s) ceiling, one note each', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket([
      { id: 'f1', type: 'trapezoidfinset', name: 'Fins', finCount: 70_000, rootChord: 0.05, height: 0.03 },
      { id: 't1', type: 'tubefinset', name: 'Tubes', finCount: 12, length: 0.1 },
      { id: 'c1', type: 'parachute', name: 'Chute', lineCount: 1_000_000, diameter: 0.3 },
      { id: 'l1', type: 'launchlug', name: 'Lug', instanceCount: 20_000 },
      { id: 'p1', type: 'podset', name: 'Pods', instanceCount: 1e8, children: [] },
      { id: 'x1', type: 'protuberance', name: 'Bump', count: 5000 },
    ]), notes);
    expect(kid(t, 0)['finCount']).toBe(KERNEL_MAX_FINS);
    expect(kid(t, 1)['finCount']).toBe(8);
    expect(kid(t, 2)['lineCount']).toBe(MAX_SHROUD_LINES);
    expect(kid(t, 3)['instanceCount']).toBe(64);
    expect(kid(t, 4)['instanceCount']).toBe(MAX_ASSEMBLY_INSTANCES);
    expect(kid(t, 5)['count']).toBe(1000);
    expect(notes).toHaveLength(6);
    expect(notes[0]).toMatch(/^“Fins”: fin count 70000 is over the limit of 8 \(.*\) — set to 8\.$/);
    expect(notes[2]).toBe('“Chute”: line count 1000000 is over the limit of 256 (over ten times the most lines'
      + ' of any parachute in the parts database, and every line is weighed) — set to 256.');
  });

  it('rounds a fractional count, and raises a zero fin count to one', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket([
      { id: 'f1', type: 'ellipticalfinset', name: 'Fins', finCount: 3.6 },
      { id: 'f2', type: 'freeformfinset', name: 'Other fins', finCount: 0 },
    ]), notes);
    expect(kid(t, 0)['finCount']).toBe(4);
    expect(kid(t, 1)['finCount']).toBe(1);
    expect(notes).toEqual([
      '“Fins”: fin count 3.6 is not a whole number — set to 4.',
      '“Other fins”: fin count 0 is below the minimum of 1 — set to 1.',
    ]);
  });
});

describe('sanitizeTree — dimensions', () => {
  it('S4a-g8 reports line and bulk density repairs in their physical units', () => {
    const notes: string[] = [];
    const tree = sanitizeTree(rocket([
      { id: 'cord', type: 'shockcord', name: 'Cord', lineDensity: -0.001 },
      { id: 'tube', type: 'bodytube', name: 'Tube', density: -1 },
    ]), notes);
    expect(kid(tree, 0)['lineDensity']).toBe(0);
    expect(notes).toContain('“Cord”: line material density -0.001 kg/m (-0.000672 lb/ft) cannot be negative — set to 0 kg/m (0 lb/ft).');
    expect(notes).toContain('“Tube”: material density -1 kg/m³ (-0.062 lb/ft³) cannot be negative — set to 0 kg/m³ (0 lb/ft³).');
  });
  it('raises a negative dimension to zero and a kernel-fatal zero to the hard minimum', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket([
      { id: 'f1', type: 'trapezoidfinset', name: 'Fins', height: -0.03, rootChord: 0.05 },
      { id: 't1', type: 'tubefinset', name: 'Tubes', length: 0 },
      { id: 'sh', type: 'fairing', name: 'Shroud', height: 0, fairingForeShape: 'box', fairingAftShape: 'box' },
      { id: 'st', type: 'streamer', name: 'Streamer', stripLength: -0.5, surfaceDensity: -0.067 },
    ]), notes);
    expect(kid(t, 0)['height']).toBe(0);
    expect(kid(t, 1)['length']).toBe(MIN_POSITIVE_DIMENSION_M);
    expect(kid(t, 2)['height']).toBe(MIN_POSITIVE_DIMENSION_M);
    expect(kid(t, 3)['stripLength']).toBe(0);
    expect(kid(t, 3)['surfaceDensity']).toBe(0);
    expect(notes).toContain('“Fins”: height -30 mm (-1.181 in) cannot be negative — set to 0 mm (0 in).');
    expect(notes).toContain('“Tubes”: length 0 mm (0 in) is below the minimum of 0.1 mm (0.00394 in) — set to 0.1 mm (0.00394 in).');
    expect(notes).toContain('“Streamer”: canopy material density -0.067 kg/m² (-0.0137 lb/ft²) cannot be negative — set to 0 kg/m² (0 lb/ft²).');
    expect(notes).toHaveLength(5);
  });

  it('keeps a length whose sign means something, and caps anything past a kilometre', () => {
    const notes: string[] = [];
    const input = rocket([
      { id: 'f1', type: 'trapezoidfinset', name: 'Fins', sweep: -0.02, position: { method: 'bottom', offset: -0.01 } },
      { id: 'm1', type: 'masscomponent', name: 'Ballast', length: 1e6, position: { method: 'top', offset: 1e9 } },
    ]);
    const t = sanitizeTree(input, notes);
    expect(kid(t, 0)).toBe(kid(input, 0)); // nothing to repair: the very same node
    expect(kid(t, 0)['sweep']).toBe(-0.02);
    expect(kid(t, 1)['length']).toBe(MAX_DIMENSION_M);
    expect(kid(t, 1).position).toEqual({ method: 'top', offset: MAX_DIMENSION_M });
    expect(notes).toEqual([
      '“Ballast”: length 1000000000 mm (39370100 in) is over the limit of 1000000 mm (39370.1 in) — set to 1000000 mm (39370.1 in).',
      '“Ballast”: position 1000000000000 mm (39370100000 in) is over the limit of 1000000 mm (39370.1 in) — set to 1000000 mm (39370.1 in).',
    ]);
  });
});

describe('sanitizeTree — enum strings', () => {
  // S3a-1 (audit 2026-10-17): preserve the kernel's section choice while repairing stored spellings.
  const finTypes = ['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'];
  const knownSections = ['square', 'rounded', 'airfoil', 'Rounded', 'ROUNDED', 'AirFoil'];
  const unknownSections = ['round_ed', 'rounded ', ' airfoil', 'hex', '__proto__', 'constructor', 'toString'];
  const kernelSection = (raw: unknown): string => {
    const sections: Record<string, string> = { rounded: 'rounded', airfoil: 'airfoil' };
    const key = String(raw).toLowerCase();
    return Object.hasOwn(sections, key) ? sections[key]! : 'square';
  };

  it.each(finTypes)('preserves kernel cross-section semantics when repairing %s', type => {
    for (const raw of [...knownSections, ...unknownSections]) {
      const fixed = kid(sanitizeTree(rocket([{ id: 'f', type, crossSection: raw }])));
      expect(kernelSection(fixed['crossSection'] ?? 'square'), raw).toBe(kernelSection(raw));
      // The equivalence alone would also pass if the repair never ran.
      if (knownSections.includes(raw)) expect(fixed['crossSection'], raw).toBe(raw.toLowerCase());
      else expect(fixed, raw).not.toHaveProperty('crossSection');
    }
  });

  it.each(finTypes)('silently canonicalizes known cross-sections and empty values on %s', type => {
    for (const raw of [...knownSections, '', '  ']) {
      const notes: string[] = [];
      const fixed = kid(sanitizeTree(rocket([{ id: 'f', type, crossSection: raw }]), notes));
      if (raw.trim() === '') expect(fixed).not.toHaveProperty('crossSection');
      else expect(fixed['crossSection']).toBe(raw.toLowerCase());
      expect(notes, raw).toEqual([]);
      expect(noteFlags(notes), raw).toEqual([]);
    }
  });

  it.each(finTypes)('reports each unknown cross-section once with the existing repair category on %s', type => {
    for (const raw of unknownSections) {
      const notes: string[] = [];
      const fixed = sanitizeTree(rocket([{ id: 'f', type, name: 'Fins', crossSection: raw }]), notes);
      expect(kid(fixed)).not.toHaveProperty('crossSection');
      const text = `“Fins”: Cross section “${raw}” is not one the simulation knows — it now uses`
        + ' a square cross-section, which is what the simulation was already using.';
      expect(notes).toEqual([text]);
      expect(noteFlags(notes)).toEqual([{ kind: 'I04.limits', tier: 'caution', text }]);
      const again: string[] = [];
      expect(sanitizeTree(fixed, again)).toBe(fixed);
      expect(again).toEqual([]);
    }
  });

  it('drops a value the kernel refuses, with desktop\'s default and a note', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket(
      [
        { id: 'f1', type: 'trapezoidfinset', name: 'Fins', airfoilSection: 'wedgie' },
        { id: 'm1', type: 'innertube', name: 'Mount', cluster: 'ninefold' },
      ],
      [{ id: 's2', type: 'stage', name: 'Booster', separationEvent: 'sometime', children: [] }],
    ), notes);
    expect(kid(t, 0)).not.toHaveProperty('airfoilSection');
    expect(kid(t, 1)).not.toHaveProperty('cluster');
    expect(t.components[1]).not.toHaveProperty('separationEvent');
    expect(notes).toEqual([
      '“Fins”: supersonic airfoil section “wedgie” is not one the simulation knows — it now uses the classic cross-section drag.',
      '“Mount”: cluster pattern “ninefold” is not one the simulation knows — it now uses a single tube.',
      '“Booster”: separation event “sometime” is not one the simulation knows — it now uses this stage’s ejection charge, desktop OpenRocket’s default.',
    ]);
  });

  it('leaves a recovery device\'s deploy event exactly as it was written', () => {
    // Not one the pass repairs: the bridge never throws on a deploy event
    // (ComponentFactory.deployEventOf flies any value it does not name as the
    // ejection charge), and desktop 24.12 writes one the app's menu lacks —
    // "lowerstageseparation". Deleting it lost it on save, and an ABSENT key
    // does not mean one thing everywhere: the .ork writer reads it as
    // ejection, the .CDX1 writer as apogee.
    const notes: string[] = [];
    const input = rocket([
      { id: 'c1', type: 'parachute', name: 'Chute', deployEvent: 'lowerstageseparation' },
      { id: 'c2', type: 'streamer', name: 'Streamer', deployEvent: 'whenever' },
      { id: 'c3', type: 'parachute', name: 'Drogue', deployEvent: 'Apogee' },
    ]);
    const t = sanitizeTree(input, notes);
    expect(t).toBe(input);
    expect(notes).toEqual([]);
    expect(treeProblems(input)).toEqual([]);
  });

  it('respells a value the kernel reads case- and underscore-blind, silently', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket(
      [
        { id: 'f1', type: 'trapezoidfinset', airfoilSection: 'HEX_BLUNT_BASE' },
        { id: 'f2', type: 'trapezoidfinset', airfoilSection: '' },
      ],
      [{ id: 's2', type: 'stage', separationEvent: 'ALTITUDE_ASCENDING', children: [] }],
    ), notes);
    expect(kid(t, 0)['airfoilSection']).toBe('hexbluntbase');
    expect(kid(t, 1)).not.toHaveProperty('airfoilSection'); // the panel's "Classic" option
    expect(t.components[1]!['separationEvent']).toBe('altitudeascending');
    expect(notes).toEqual([]);
  });

  it('gives a per-configuration separation the same answer', () => {
    expect(separationEventOrDefault('UPPER_IGNITION')).toBe('upperignition');
    expect(separationEventOrDefault('bogus')).toBe('ejection');
  });
});

describe('sanitizeTree — identity and the load boundary', () => {
  it('returns the same tree object for a clean design, and is idempotent', () => {
    const clean = defaultTree();
    expect(sanitizeTree(clean)).toBe(clean);
    const notes: string[] = [];
    const once = sanitizeTree(rocket([{ id: 'f1', type: 'trapezoidfinset', finCount: 12 }]), notes);
    expect(notes).toHaveLength(1);
    const again: string[] = [];
    expect(sanitizeTree(once, again)).toBe(once);
    expect(again).toEqual([]);
  });

  it('runs inside normalizeTree, so a restored session or share link is repaired too', () => {
    const t = normalizeTree(rocket([{ id: 'f1', type: 'trapezoidfinset', finCount: 70_000 }]));
    expect(kid(t)['finCount']).toBe(8);
  });
});

describe('the degenerate values that failed the whole build now build', () => {
  // Each of these threw from the kernel at a7756c5 (single-field fuzz, audit
  // 2026-09-22): InertiaMatrix for the negatives, `%g` for the zero-height
  // blunt shroud. The zero tube-fin length (NaN→BigInt) is its own case below.
  const cases: [string, Record<string, unknown>][] = [
    ['negative fin height', { id: 'k', type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: -0.03, thickness: 0.003 }],
    ['negative elliptical fin height', { id: 'k', type: 'ellipticalfinset', rootChord: 0.05, height: -0.03, thickness: 0.003 }],
    ['negative lug length', { id: 'k', type: 'launchlug', length: -0.05, outerRadius: 0.0022, thickness: 0.0003 }],
    ['negative tube-fin length', { id: 'k', type: 'tubefinset', finCount: 6, length: -0.1, thickness: 0.0005 }],
    ['zero-height blunt shroud', { id: 'k', type: 'fairing', length: 0.08, width: 0.025, height: 0, fairingForeShape: 'box', fairingAftShape: 'box' }],
    ['negative shroud length', { id: 'k', type: 'fairing', length: -0.08, width: 0.025, height: 0.02 }],
    ['negative streamer strip', { id: 'k', type: 'streamer', stripLength: -0.5, stripWidth: 0.05 }],
    ['negative chute line length', { id: 'k', type: 'parachute', diameter: 0.3, lineCount: 6, lineLength: -1 }],
    ['negative canopy density', { id: 'k', type: 'parachute', diameter: 0.3, surfaceDensity: -0.067 }],
    ['negative shock-cord density', { id: 'k', type: 'shockcord', cordLength: 0.5, lineDensity: -0.0018 }],
  ];
  for (const [what, node] of cases) {
    it(what, () => {
      const raw = rocket([node]);
      expect(build(raw), 'the unsanitised tree should still fail').not.toBeNull();
      expect(build(normalizeTree(raw))).toBeNull();
    });
  }

  it('zero tube-fin length: the kernel builds it with no CP, and the repaired tree has one', () => {
    // It threw too, until 2026-10-11, but from a debug line: TubeFinSetCalc
    // formatted its forces as text on every call, and the NaN CP of a
    // zero-length tube failed TeaVM's number formatting. That text is no longer
    // built (engine-java/patches/LEDGER.md), as desktop OR never failed on it,
    // so the raw tree builds, with no CP at all, which is why the length is
    // still raised to the minimum.
    const raw = rocket([{ id: 'k', type: 'tubefinset', finCount: 6, length: 0, thickness: 0.0005 }]);
    const cpOf = (t: RocketTree): number | null => { resetEngine(); return OrkRocket.buildTree(engineTree(t)).staticInfo().cp; };
    // The kernel's NaN arrives as null (the bridge speaks JSON).
    expect(cpOf(raw)).toBeNull();
    expect(Number.isFinite(cpOf(normalizeTree(raw)))).toBe(true);
  });

  it('a negative body-tube wall', () => {
    const raw = rocket([]);
    raw.components[0]!.children![1]!['thickness'] = -0.0005;
    expect(build(raw)).not.toBeNull();
    expect(build(normalizeTree(raw))).toBeNull();
  });

  it('the panel\'s "Classic" airfoil (the empty string) no longer fails the build', () => {
    // Pick a section, then Classic again: the select stores ''. setTree does
    // not normalise, so the engine boundary has to read '' as "none" itself.
    const t = rocket([{ id: 'f', type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, airfoilSection: '' }]);
    expect(build(t)).toBeNull();
  });
});

describe('explainBuildFailure — naming the part (audit 2026-09-22)', () => {
  it('leads with the part and the field, and keeps the kernel\'s words for a bug report', () => {
    // A negative length: a zero one no longer fails the build (see above).
    const t = rocket([{ id: 't', type: 'tubefinset', name: 'Tube fins', length: -0.1 }]);
    const kernel = build(t)!;
    expect(kernel).toMatch(/InertiaMatrix/);
    const msg = explainBuildFailure(t, kernel);
    expect(msg).toBe('This design could not be built. The likely cause: “Tube fins”: length -100 mm (-3.937 in) is below'
      + ' the minimum of 0.1 mm (0.00394 in). (The simulation reported: ' + kernel + ')');
  });

  it('names at most three, and counts the rest', () => {
    const t = rocket([
      { id: 'a', type: 'trapezoidfinset', name: 'A', height: -0.01 },
      { id: 'b', type: 'trapezoidfinset', name: 'B', height: -0.01 },
      { id: 'c', type: 'trapezoidfinset', name: 'C', height: -0.01 },
      { id: 'd', type: 'trapezoidfinset', name: 'D', height: -0.01 },
    ]);
    const msg = explainBuildFailure(t, 'kernel text');
    expect(msg).toMatch(/^This design could not be built\. The likely causes: “A”: .*; “B”: .*; “C”: .*; and 1 more\. \(The simulation reported: kernel text\)$/);
    expect(msg).not.toContain('“D”');
  });

  it('names a freeform outline the kernel refuses', () => {
    const t = rocket([{ id: 'f', type: 'freeformfinset', name: 'Canards', points: [[0, 0], [0.02, 0.03], [0.02, 0.03], [0.05, 0]] }]);
    expect(treeProblems(t)).toEqual(['“Canards”: Points 2 and 3 are in the same place — move one of them or delete it']);
  });

  it('returns the kernel text unchanged when nothing in the table explains it', () => {
    expect(explainBuildFailure(defaultTree(), 'Unknown component type: \'x\'')).toBe('Unknown component type: \'x\'');
  });

  it('never throws itself — it runs inside the app\'s build catch', () => {
    // A child list holding a null: malformed enough to fail any walk.
    const broken = { name: 'R', components: [{ id: 's', type: 'stage', children: [null] }] } as unknown as RocketTree;
    expect(() => treeProblems(broken)).toThrow();
    expect(explainBuildFailure(broken, 'kernel text')).toBe('kernel text');
    expect(explainBuildFailure(broken, 'kernel text', () => false)).toBe('kernel text');
  });
});

describe('explainBuildFailure — the omit-one-part fallback (audit 2026-09-22)', () => {
  /** The kernel's buildTree alone, the way buildDesign's catch passes it. */
  let calls = 0;
  const buildsBare = (t: RocketTree): boolean => {
    calls++;
    try {
      resetEngine();
      OrkRocket.buildTree(engineTree(t));
      return true;
    } catch {
      return false;
    }
  };

  it('names the part the design builds without, when the table has nothing to say', () => {
    // A restored session can carry a component type this build does not know:
    // no limit covers it, and the kernel's words name nothing on screen.
    const t = rocket([{ id: 'w', type: 'widget', name: 'Widget' }]);
    const kernel = build(t)!;
    expect(kernel).toBe('Unknown component type: \'widget\'');
    expect(treeProblems(t)).toEqual([]);
    expect(explainBuildFailure(t, kernel)).toBe(kernel); // no builder: as before
    // Its body tube also builds once dropped (the widget goes with it), but a
    // part's children are tried before it, so the widget itself is named.
    expect(explainBuildFailure(t, kernel, buildsBare)).toBe('This design could not be built. The likely cause:'
      + ' “Widget” — the rest of the design builds without it. (The simulation reported: ' + kernel + ')');
  });

  it('says "or a part inside it" when only a whole assembly clears it', () => {
    // Two unknown parts on one tube: neither alone clears the build, the tube does.
    const t = rocket([{ id: 'w', type: 'widget', name: 'W1' }, { id: 'g', type: 'gizmo', name: 'W2' }]);
    expect(explainBuildFailure(t, 'k', buildsBare)).toBe('This design could not be built. The likely cause:'
      + ' “Body tube” or a part inside it — the rest of the design builds without it. (The simulation reported: k)');
  });

  it('blames no part when the rocket itself builds — the failure lay elsewhere, one build to find out', () => {
    calls = 0;
    expect(explainBuildFailure(defaultTree(), 'kernel text', buildsBare)).toBe('kernel text');
    expect(calls).toBe(1);
  });

  it('blames no part when no single omission clears it', () => {
    const t = rocket([{ id: 'w', type: 'widget', name: 'W1' }],
      [{ id: 's2', type: 'stage', name: 'Booster', children: [{ id: 'g', type: 'gizmo', name: 'W2' }] }]);
    expect(explainBuildFailure(t, 'kernel text', buildsBare)).toBe('kernel text');
  });

  it('stops after a bounded number of trial builds', () => {
    calls = 0;
    // Post-order: nose, widget — the widget is the second part tried.
    const t = rocket([{ id: 'w', type: 'widget', name: 'Widget' }]);
    expect(partBlockingBuild(t, buildsBare, 1)).toBeNull();
    expect(calls).toBe(2); // the whole tree, then one omission
    expect(partBlockingBuild(t, buildsBare, 2)?.name).toBe('Widget');
  });
});

describe('the limits table and the panel agree', () => {
  it('every count field has a hard limit, and no slider offers past it', () => {
    for (const [type, fields] of Object.entries(FIELDS)) {
      for (const f of fields) {
        if (f.unit !== 'count') continue;
        const lim = fieldLimit(type as EditorComponentType, f.key);
        expect(lim, `${type}.${f.key}`).toBeDefined();
        expect(f.smax!, `${type}.${f.key}`).toBeLessThanOrEqual(lim!.hmax!);
        expect(f.smin!, `${type}.${f.key}`).toBeGreaterThanOrEqual(lim!.hmin);
      }
    }
  });
});

// An empty list is an unfinished outline in the fin editor and is kept (session.test.ts pins it); the fin template guards it.
it.each([{ points: undefined }, { points: null }])('materializes the kernel freeform outline for absent points %j', ({ points }) => {
  const input = rocket([{ type: 'freeformfinset', id: 'f', points }]);
  const out = sanitizeTree(input);
  expect(kid(out)['points']).toEqual([[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]]);
  expect(kid(input)['points']).toBe(points);
  expect(sanitizeTree(out)).toBe(out);
});

// Only a finding that leaves its node as it was is said once per notes array
// (audit S8-1): a repair a later pass makes is a new repair, and says so.
it('reports each repair made, even when an earlier pass said the same line', () => {
  const notes: string[] = [];
  // Beside a kept outline (a point past 2.5 m on both axes), which is said once.
  const raw = (): RocketTree => ({ components: [{ type: 'trapezoidfinset', name: 'Fins', finCount: 70_000 },
    { type: 'freeformfinset', name: 'Far', points: [[0, 0], [3, 3], [3.5, 0]] }] });
  sanitizeTree(raw(), notes);
  sanitizeTree(raw(), notes);
  expect(notes.filter(n => n.startsWith('“Fins”: fin count'))).toHaveLength(2);
  expect(notes.filter(n => n.startsWith('“Far”:'))).toHaveLength(1);
  expect(noteFlags(notes).map(r => r.kind)).toEqual(['I04.limits', 'I04.limits', 'I04.limits']);
});
