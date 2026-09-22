import { describe, expect, it } from 'vitest';
import { defaultParams, FIELDS } from './schema.js';
import { shroudEnds } from './shroud.js';

const field = (type: string, key: string) =>
  (FIELDS[type as keyof typeof FIELDS] ?? []).find((f) => f.key === key);

/**
 * Slider stops that carry physics.
 *
 * PropertyPanel renders a ValueSlider whenever a field has BOTH `smin` and
 * `smax`, its left stop IS `smin`, and its `commit` clamps only the maximum. So
 * `smin` is not decoration: it is the value one mouse drag can write with no
 * typing and no confirmation, and on a coefficient field that makes it a
 * physics decision.
 */
describe('the recovery Cd slider cannot be dragged to zero drag', () => {
  it('starts one step above zero on both recovery devices', () => {
    for (const type of ['parachute', 'streamer']) {
      const cd = field(type, 'cd');
      expect(cd, `${type} has no cd field`).toBeDefined();
      // Exactly one step, so the stop is still the lowest coefficient anyone
      // could mean; the point is only that it is not 0.
      expect(cd!.smin, `${type} cd slider can be dragged to zero drag`).toBe(cd!.step);
      expect(cd!.smin!).toBeGreaterThan(0);
    }
  });

  it('is the OPPOSITE call from the protuberance Cd, deliberately', () => {
    // `cdFrontal` keeps smin 0 because 0 there is the "release the override"
    // stop — treeModel.protuberanceExplicitCd falls a 0 through to the drag
    // class, so the left stop restores automatic behaviour rather than zeroing
    // it. A recovery Cd has no class to fall through to: 0 reaches
    // ComponentFactory as a real 0.0, RecoveryDevice.setCD stores it unclamped
    // and clears cdAutomatic, and the canopy makes no drag at all. Two fields
    // of the same shape, two different right answers — pinned together so the
    // next reader sees why they differ.
    expect(field('protuberance', 'cdFrontal')!.smin).toBe(0);
  });
});

/**
 * The stage's nozzle exit diameter (2026-09-08). Its label read
 * "0 = power-off drag" for two months, which since the pressure-thrust term
 * went in is half the truth: the same number also raises thrust as the rocket
 * climbs, under Rogers Kbf or the supersonic model. A value typed on the
 * strength of the old label is now spent on a safety number, so the box has to
 * say what it buys.
 */
describe('the nozzle exit diameter label states both halves', () => {
  const f = () => field('stage', 'nozzleExitDiameter')!;

  it('names thrust as well as drag', () => {
    expect(f().label).toMatch(/thrust/i);
    expect(f().label).toMatch(/drag/i);
  });

  it('no longer promises drag alone', () => {
    expect(f().label).not.toBe('Nozzle exit diameter (0 = power-off drag)');
  });

  it('still says what 0 means — it is the only way back to the published curve on the design', () => {
    expect(f().label).toMatch(/0 = /);
  });

  /**
   * FieldDef has no tooltip, so a label is the ONLY copy the box gets — and
   * the panel lays labels out beside their input. The first draft of this one
   * ran to 76 characters, nearly double the longest label the panel had ever
   * had. The full explanation belongs in the guide and the import note.
   */
  it('stays inside the length band the property panel already lays out', () => {
    const longest = Math.max(...Object.values(FIELDS).flat()
      .filter((x) => x.key !== 'nozzleExitDiameter').map((x) => x.label.length));
    expect(f().label.length).toBeLessThanOrEqual(longest + 12);
  });

  it('is still the same mm field, 1-200, so no stored design is reinterpreted', () => {
    expect(f().unit).toBe('mm');
    expect(f().smin).toBe(0);
    expect(f().smax).toBe(200);
    expect(f().step).toBe(1);
  });
});

/**
 * A NEW camera shroud is born tapered fore and FLAT aft (Eric, 2026-09-18,
 * with photographs: "Most shrouds are flat ended where the camera is … the
 * default config should be tapered at the front and flat at the back").
 *
 * The creation default had never been pinned by anything, which is how it sat
 * at a domed aft end while the guide described what the photographs show.
 */
describe('camera shroud end shapes', () => {
  it('creates a shroud tapered at the front and flat at the back', () => {
    const p = defaultParams('fairing');
    expect(p['fairingForeShape']).toBe('streamlined');
    expect(p['fairingAftShape']).toBe('box');
  });

  /**
   * ⚠ THIS IS NOT THE SAME NUMBER AS THE ONE ABOVE, AND IT MUST NOT BE MADE TO
   * MATCH IT. `dflt` is what an ABSENT key MEANS, so it has to equal the reader
   * fallback in shroudEnds(); the creation default is what a new part is born
   * with. Aligning the two "for consistency" would silently re-shape every
   * saved shroud that carries no explicit end shape.
   */
  it('still reads an absent aft shape as half-round, matching shroudEnds', () => {
    expect(field('fairing', 'fairingAftShape')?.dflt).toBe('halfround');
    expect(shroudEnds({ id: 'x', type: 'fairing', name: 'S' }).aft).toBe('halfround');
  });

  it('offers the flat end as an option at all', () => {
    expect(field('fairing', 'fairingAftShape')?.options?.map((o) => o[0]))
      .toContain('box');
  });
});

/**
 * Which numeric fields may be CLEARED (audit 2026-09-22). Before FieldDef.optional
 * every schema field was clearable, and a cleared required dimension meant a
 * different hidden default in every layer — a body tube's length flew 0.3 m and
 * drew 0. Blank is legitimate only where the panel says what it means.
 */
describe('only a field whose blank means something is optional', () => {
  const numeric = () => Object.entries(FIELDS).flatMap(([type, fs]) =>
    fs.filter((f) => !f.options && !f.bool).map((f) => ({ type, f })));

  it('every label that says what blank means is optional', () => {
    for (const { type, f } of numeric()) {
      if (/blank/i.test(f.label)) expect(f.optional, `${type}.${f.key}`).toBe(true);
    }
  });

  it('the fields whose blank the panel prints as a default are optional', () => {
    // The panel shows "default: …" / "auto: …" placeholders for exactly these.
    for (const type of ['nosecone', 'transition']) {
      expect(field(type, 'shapeParameter')!.optional, type).toBe(true);
    }
    expect(field('tubefinset', 'outerRadius')!.optional).toBe(true);
    for (const key of ['outerDiameter', 'totalHeight', 'innerDiameter', 'baseHeight',
      'flangeHeight', 'screwHeight']) {
      expect(field('railbutton', key)!.optional, key).toBe(true);
    }
    expect(field('stage', 'nozzleExitDiameter')!.optional).toBe(true);
  });

  it('a structural dimension is never optional', () => {
    for (const [type, key] of [
      ['bodytube', 'length'], ['bodytube', 'outerRadius'], ['bodytube', 'thickness'],
      ['nosecone', 'length'], ['innertube', 'outerRadius'], ['trapezoidfinset', 'rootChord'],
      ['trapezoidfinset', 'finCount'], ['parachute', 'diameter'], ['podset', 'instanceCount'],
    ] as const) {
      expect(field(type, key)!.optional, `${type}.${key}`).not.toBe(true);
    }
  });
});
