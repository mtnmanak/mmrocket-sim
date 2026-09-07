import { describe, expect, it } from 'vitest';
import { BULK_MATERIALS, LINE_MATERIALS, SURFACE_MATERIALS, type MaterialDef } from './materials.js';

/**
 * THE FIVE ELASTIC-CORD LINE DENSITIES ARE PINNED HERE BECAUSE TWO OF THEM ARE
 * WRONG — AND WRONG UPSTREAM, WHICH IS WHY THEY MUST NOT BE "FIXED" HERE.
 *
 * The series rises with width and then collapses:
 *
 *      2 mm round  0.0018 kg/m
 *      6 mm flat   0.0043
 *     12 mm flat   0.0080
 *     19 mm flat   0.0012   <-- a 3/4 in flat elastic, lighter than the 1/16 in round
 *     25 mm flat   0.0016   <-- ditto
 *
 * A linear fit through the table's own 6 mm and 12 mm points gives 0.0123 kg/m
 * at 19 mm and 0.0160 at 25 mm: the listed values with the decimal point moved
 * one place. The consequence is real — 30 ft (9.14 m) of 3/4 in flat elastic,
 * an ordinary mid/high-power harness, weighs 11.0 g in the app against ~112 g
 * on a scale, and `recoveryMass.ts` derives the recovery weight from
 * `massEmpty`, so the chute is then sized against a rocket ~100 g light: the
 * direction that UNDERSIZES a canopy.
 *
 * It is still not ours to change. These names and values are transcribed
 * verbatim from OpenRocket 24.12 —
 * `core/src/main/java/info/openrocket/core/database/Databases.java:86-90`,
 * re-read 2026-09-04 — and `.ork` exchange matches materials by NAME carrying
 * a density; diverging silently would make our files disagree with desktop's
 * on the same named material. It belongs in the upstream-vigilance channel
 * (`scripts/check-upstream.mjs`, the owner's 2026-08-31 standing ruling), not
 * in an edit here.
 *
 * So this test exists to make the number VISIBLE and to fail loudly in EITHER
 * direction: if someone "corrects" 0.0012 to 0.0123 without a ruling, and if
 * upstream ever fixes it and a re-transcription lands here unannounced.
 */
const ELASTIC_CORD: [string, number][] = [
  ['Elastic cord (round 2 mm, 1/16 in)', 0.0018],
  ['Elastic cord (flat 6 mm, 1/4 in)', 0.0043],
  ['Elastic cord (flat 12 mm, 1/2 in)', 0.008],
  // Upstream Databases.java:89-90. Believed ~10x light; NOT to be edited here.
  ['Elastic cord (flat 19 mm, 3/4 in)', 0.0012],
  ['Elastic cord (flat 25 mm, 1 in)', 0.0016],
];

const byName = (list: MaterialDef[], name: string): MaterialDef | undefined =>
  list.find((m) => m.name === name);

describe('elastic shock-cord line densities (upstream 24.12, known-bad, pinned)', () => {
  it('carries exactly the five upstream entries, at the upstream values', () => {
    for (const [name, density] of ELASTIC_CORD) {
      const m = byName(LINE_MATERIALS, name);
      expect(m, `${name} is gone from LINE_MATERIALS`).toBeDefined();
      expect(m!.density, name).toBe(density);
      expect(m!.group, name).toBe('THREADS_LINES');
    }
    expect(LINE_MATERIALS.filter((m) => m.name.startsWith('Elastic cord (')))
      .toHaveLength(ELASTIC_CORD.length);
  });

  it('still shows the upstream break in the series — this is the DEFECT, held in place', () => {
    const d = (name: string) => byName(LINE_MATERIALS, name)!.density;
    // Monotonic while upstream is right...
    expect(d('Elastic cord (flat 6 mm, 1/4 in)')).toBeGreaterThan(d('Elastic cord (round 2 mm, 1/16 in)'));
    expect(d('Elastic cord (flat 12 mm, 1/2 in)')).toBeGreaterThan(d('Elastic cord (flat 6 mm, 1/4 in)'));
    // ...and then it is not. If either of these two flips, upstream changed (or
    // someone edited the table); either way it needs a ruling, not a green run.
    expect(d('Elastic cord (flat 19 mm, 3/4 in)')).toBeLessThan(d('Elastic cord (flat 12 mm, 1/2 in)'));
    expect(d('Elastic cord (flat 25 mm, 1 in)')).toBeLessThan(d('Elastic cord (flat 12 mm, 1/2 in)'));
  });

  it('states the size of the error, so nobody has to re-derive it to argue about it', () => {
    // Linear fit through the table's OWN 6 mm and 12 mm points.
    const d6 = 0.0043, d12 = 0.008;
    const fit = (mm: number) => d6 + ((d12 - d6) / 6) * (mm - 6);
    expect(fit(19)).toBeCloseTo(0.0123, 4);
    expect(fit(25)).toBeCloseTo(0.0160, 4);
    // 30 ft of 3/4 in flat elastic: what the app weighs it at, and what a fit
    // through its own neighbours says it should weigh.
    const cordLength = 30 * 0.3048;
    expect(cordLength * byName(LINE_MATERIALS, 'Elastic cord (flat 19 mm, 3/4 in)')!.density)
      .toBeCloseTo(0.01097, 5);
    expect(cordLength * fit(19)).toBeCloseTo(0.11262, 5);
  });
});

/**
 * The rest of the table is only sanity-checked: names are the .ork exchange
 * key, so a duplicate name makes a material ambiguous on load, and a
 * non-positive density is a divide waiting to happen in a mass calculation.
 */
describe('the built-in material tables', () => {
  const TABLES: [string, MaterialDef[]][] = [
    ['BULK_MATERIALS', BULK_MATERIALS],
    ['SURFACE_MATERIALS', SURFACE_MATERIALS],
    ['LINE_MATERIALS', LINE_MATERIALS],
  ];

  /**
   * Rows this project adds that are NOT in OpenRocket 24.12, each with the
   * ruling that put it there. Everything else must be a verbatim upstream row.
   *
   * Keeping the list explicit is the point: the count assertion below used to
   * be a bare 31/8/42, which meant "matches upstream" and "nothing local was
   * added" were the same number and neither could move without the other
   * looking like the other's failure.
   */
  const LOCAL_ADDITIONS: Record<string, string[]> = {
    BULK_MATERIALS: [],
    SURFACE_MATERIALS: [],
    // Owner's ruling 2026-09-07 — an opt-in corrected pair beside the two
    // upstream rows that are ~10x light. NEW names, so no existing design and
    // no `.ork` round trip changes meaning. See materials.ts for the derivation.
    LINE_MATERIALS: [
      'Elastic cord, corrected (flat 19 mm, 3/4 in)',
      'Elastic cord, corrected (flat 25 mm, 1 in)',
    ],
  };

  it('carries every row OpenRocket 24.12 Databases.java declares — 31 bulk, 8 surface, 42 line', () => {
    // The header calls this table a verbatim transcription. The 2026-09-05
    // audit diffed it row by row against Databases.java and found exactly one
    // row missing (Styrofoam "Blue foam" (XPS), 32 kg/m3). Pinning the counts
    // makes the next omission — or the next upstream addition — a failing test
    // instead of a quiet divergence.
    //
    // The counts are of UPSTREAM rows, so a deliberate local addition does not
    // read as an upstream drift and cannot hide one either.
    for (const [label, table] of TABLES) {
      const upstream = table.filter((m) => !LOCAL_ADDITIONS[label]!.includes(m.name));
      const expected = { BULK_MATERIALS: 31, SURFACE_MATERIALS: 8, LINE_MATERIALS: 42 }[label]!;
      expect(upstream, `${label} upstream rows`).toHaveLength(expected);
      // ...and every declared local addition really is present, so the list
      // cannot rot into an allowance for rows that no longer exist.
      for (const name of LOCAL_ADDITIONS[label]!) {
        expect(byName(table, name), `${label} is missing declared local row ${name}`).toBeDefined();
      }
    }
    expect(byName(BULK_MATERIALS, 'Styrofoam "Blue foam" (XPS)')?.density).toBe(32);
  });

  /**
   * The corrected elastic pair, and the parity argument that makes it safe.
   */
  it('the corrected elastic rows sit beside the upstream ones, never replacing them', () => {
    const up19 = byName(LINE_MATERIALS, 'Elastic cord (flat 19 mm, 3/4 in)')!;
    const up25 = byName(LINE_MATERIALS, 'Elastic cord (flat 25 mm, 1 in)')!;
    const fixed19 = byName(LINE_MATERIALS, 'Elastic cord, corrected (flat 19 mm, 3/4 in)')!;
    const fixed25 = byName(LINE_MATERIALS, 'Elastic cord, corrected (flat 25 mm, 1 in)')!;

    // The upstream values are untouched — that is what keeps `.ork` files
    // agreeing with the desktop on a shared material name.
    expect(up19.density).toBe(0.0012);
    expect(up25.density).toBe(0.0016);

    // The corrected ones restore the monotonic series the table should have had.
    const d12 = byName(LINE_MATERIALS, 'Elastic cord (flat 12 mm, 1/2 in)')!.density;
    expect(fixed19.density).toBeGreaterThan(d12);
    expect(fixed25.density).toBeGreaterThan(fixed19.density);

    // And they are the straight line through upstream's own 6 mm and 12 mm
    // points, not a guess: 0.000617 kg/m per mm, offset 0.0006.
    const slope = (0.008 - 0.0043) / (12 - 6);
    const at = (mm: number) => 0.0043 + slope * (mm - 6);
    expect(fixed19.density).toBeCloseTo(at(19), 4);
    expect(fixed25.density).toBeCloseTo(at(25), 4);

    // 30 ft of 3/4 in: 11 g upstream against 112 g corrected. That gap is the
    // whole reason the pair exists, so it is stated as a number here.
    const thirtyFt = 9.144;
    expect(up19.density * thirtyFt * 1000).toBeCloseTo(11.0, 1);
    expect(fixed19.density * thirtyFt * 1000).toBeCloseTo(112.5, 1);
  });

  it('names every material once per table', () => {
    for (const [label, list] of TABLES) {
      expect(new Set(list.map((m) => m.name)).size, label).toBe(list.length);
    }
  });

  it('gives every material a finite positive density and a group', () => {
    for (const [label, list] of TABLES) {
      for (const m of list) {
        expect(Number.isFinite(m.density) && m.density > 0, `${label}: ${m.name}`).toBe(true);
        expect(m.group.length, `${label}: ${m.name}`).toBeGreaterThan(0);
      }
    }
  });
});
