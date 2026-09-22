import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { defaultParams, FIELDS, finCountDefault, interleaveRotation } from './schema.js';
import { shroudEnds } from './shroud.js';
import { protuberanceClass } from './treeModel.js';
import { clusterCount } from './cluster.js';
import { tabOutline } from '../services/finTemplate.js';

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
   * ⚠ THIS IS NOT THE SAME ANSWER AS THE ONE ABOVE, AND IT MUST NOT BE MADE TO
   * MATCH IT. What an ABSENT end means is shroudEnds' call alone — the panel
   * resolves both selects through it — while the creation default is what a
   * new part is born with. Aligning the two "for consistency" would silently
   * re-shape every saved shroud that carries no explicit end shape.
   *
   * The two fields carry no `dflt` for the same reason (audit 2026-09-22): one
   * sat here unread, and the fore end's said 'streamlined' against
   * shroudEnds' 'halfround'. A second declaration can only drift.
   */
  it('still reads an absent end as half-round, and declares it only in shroudEnds', () => {
    expect(shroudEnds({ id: 'x', type: 'fairing', name: 'S' })).toEqual({ fore: 'halfround', aft: 'halfround' });
    expect(field('fairing', 'fairingForeShape')?.dflt).toBeUndefined();
    expect(field('fairing', 'fairingAftShape')?.dflt).toBeUndefined();
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

/**
 * An unset <select> shows `dflt ?? options[0]`, and that has to be what the
 * READERS do with the absent key (audit 2026-09-22). Two did not: a fin tab
 * with no method showed "Front of fin" while the kernel, the drawing, the cut
 * template and the .ork writer all placed it mid-fin — and picking "Front of
 * fin" then fired no change, so the displayed state was unreachable. A
 * transition with no shape showed Ogive where every reader draws a cone.
 */
describe('an unset select shows what the readers do with the absent key', () => {
  const shown = (type: string, key: string) => {
    const f = field(type, key)!;
    return String(f.dflt ?? f.options![0]![0]);
  };

  /**
   * Every select field, and the value its readers fall back to. A new select
   * with no entry fails here, which is the point: decide what absent means.
   * The two camera-shroud ends are resolved through shroudEnds instead, which
   * migrates the legacy single shape (PropertyPanel's RESOLVE_SELECT).
   */
  const READER_FALLBACK: Record<string, string> = {
    finish: 'normal',                 // the engine's regular paint
    separationEvent: 'ejection',      // orkFile.ts writer and the kernel default
    shape: 'ogive',                   // nose cone; the transition is below
    crossSection: 'square',           // dxfExport, finTemplate, orkFile writer
    airfoilSection: '',               // unset = classic, from the cross section
    tabOffsetMethod: 'middle',        // finTemplate.tabOutline, TreeSchematic, orkFile
    cluster: 'single',                // clusterCount(undefined) === 1
    deployEvent: 'ejection',          // orkFile reader and writer
    massComponentType: 'masscomponent', // orkFile writer
    dragClass: 'streamlinedbase',     // treeModel.protuberanceClass
    radiusMethod: 'relative',         // assembly.ts
    angleMethod: 'relative',          // orkFile writer
  };

  it('holds for every select field in the schema', () => {
    for (const [type, fs] of Object.entries(FIELDS)) {
      for (const f of fs.filter((x) => x.options)) {
        if (f.key === 'fairingForeShape' || f.key === 'fairingAftShape') continue;
        const want = type === 'transition' && f.key === 'shape' ? 'conical' : READER_FALLBACK[f.key];
        expect(want, `no reader fallback declared for ${type}.${f.key}`).toBeDefined();
        expect(shown(type, f.key), `${type}.${f.key}`).toBe(want);
      }
    }
  });

  it('agrees with the readers themselves where they are callable', () => {
    // A tab placed with the method the panel SHOWS lands where the absent key does.
    const fin = { id: 'f', type: 'trapezoidfinset', tabHeight: 0.005, tabLength: 0.02, tabOffset: 0 };
    const method = shown('trapezoidfinset', 'tabOffsetMethod');
    expect(tabOutline({ ...fin, tabOffsetMethod: method } as unknown as ComponentNode, 0.06))
      .toEqual(tabOutline(fin as unknown as ComponentNode, 0.06));
    expect(shown('protuberance', 'dragClass'))
      .toBe(protuberanceClass({ id: 'p', type: 'fairing' } as ComponentNode));
    expect(clusterCount(shown('innertube', 'cluster'))).toBe(clusterCount(undefined));
  });
});

/**
 * A fin set added beside an existing one starts half a pitch round, between
 * its fins. The existing set's count was read with a flat fallback of 3, so
 * beside a tube-fin set with no `finCount` — six tubes to the kernel — the
 * new set landed ON a tube (audit 2026-09-22).
 */
describe('a new fin set starts between the existing set\'s fins', () => {
  it('reads an absent count the way the kernel builds it: 3 fins, 6 tubes', () => {
    for (const type of ['trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset'] as const) {
      expect(finCountDefault(type), type).toBe(defaultParams(type)['finCount']);
    }
  });

  it('turns 30° beside six tubes with no finCount, not 60°', () => {
    const tubes = { id: 't', type: 'tubefinset', length: 0.1 } as unknown as ComponentNode;
    expect(interleaveRotation(tubes)).toBeCloseTo(Math.PI / 6, 12);
  });

  it('turns half a pitch past the existing rotation for a stated count', () => {
    const fins = { id: 'f', type: 'trapezoidfinset', finCount: 4, rotation: 0.1 } as unknown as ComponentNode;
    expect(interleaveRotation(fins)).toBeCloseTo(0.1 + Math.PI / 4, 12);
    const bare = { id: 'g', type: 'trapezoidfinset' } as unknown as ComponentNode;
    expect(interleaveRotation(bare)).toBeCloseTo(Math.PI / 3, 12);
  });
});
