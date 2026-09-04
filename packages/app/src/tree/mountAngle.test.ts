import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import {
  angleGap, betweenFinAnglesAmong, betweenFinAnglesOn, finAnglesAmong, finAnglesOn,
  frameContaining, IN_LINE_TOLERANCE, nearestAngle, railInterferenceWarnings, reducePi,
  wakeShadowWarnings, WAKE_REACH_HEIGHTS,
} from './mountAngle.js';
import { defaultParams } from './schema.js';

const D = (deg: number) => (deg * Math.PI) / 180;
const asDeg = (rad: number) => Math.round(((reducePi(rad) * 180) / Math.PI) * 1e6) / 1e6;

const body = (kids: Record<string, unknown>[]): ComponentNode => ({
  type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.027, thickness: 0.001,
  children: kids,
} as unknown as ComponentNode);

const tree = (kids: Record<string, unknown>[]): RocketTree => ({
  name: 'T', components: [{ type: 'stage', id: 's1', children: [body(kids)] }],
} as unknown as RocketTree);

const FINS3 = { type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.05, height: 0.04 };

describe('where the fins are', () => {
  it('places N fins evenly from the set rotation — the kernel formula', () => {
    expect(finAnglesOn(body([FINS3])).map(asDeg).sort((a, b) => a - b))
      .toEqual([-120, 0, 120]);
    expect(finAnglesOn(body([{ ...FINS3, finCount: 4, rotation: D(45) }])).map(asDeg).sort((a, b) => a - b))
      .toEqual([-135, -45, 45, 135]);
  });

  it('puts "between" exactly midway, which for 3 fins is 60 degrees off each', () => {
    const between = betweenFinAnglesOn(body([FINS3])).map(asDeg).sort((a, b) => a - b);
    expect(between).toEqual([-180, -60, 60]);
    // Every midpoint is the same distance from its two neighbours.
    for (const b of betweenFinAnglesOn(body([FINS3]))) {
      const gaps = finAnglesOn(body([FINS3])).map((f) => angleGap(f, b)).sort((x, y) => x - y);
      expect(gaps[0]).toBeCloseTo(gaps[1]!, 12);
    }
  });

  it('has no answer when the parent carries no fins', () => {
    expect(finAnglesOn(body([{ type: 'railbutton', id: 'r1' }]))).toHaveLength(0);
    expect(nearestAngle([], 0)).toBeNull();
  });

  it('snaps to the NEAREST target, not the first one', () => {
    const fins = finAnglesOn(body([FINS3]));
    expect(asDeg(nearestAngle(fins, D(100))!)).toBe(120);
    expect(asDeg(nearestAngle(fins, D(-100))!)).toBe(-120);
    // From 179 the fin at 120 is 59 away and the one at -120 is 61 — near the
    // boundary, but 120 wins. The point is that it does NOT pick 0 (179 away).
    expect(asDeg(nearestAngle(fins, D(179))!)).toBe(120);
    expect(asDeg(nearestAngle(betweenFinAnglesOn(body([FINS3])), D(50))!)).toBe(60);

    // The real wrap case: a 4-fin set has a fin at 180, and from -175 the
    // short way round is 5 degrees. Comparing raw numbers instead of the
    // reduced difference would make that look like 355 and pick -90.
    const four = finAnglesOn(body([{ ...FINS3, finCount: 4 }]));
    expect(Math.abs(asDeg(nearestAngle(four, D(-175))!))).toBe(180);
  });

  it('reads a tube fin set as 6 fins, its own default', () => {
    expect(finAnglesOn(body([{ type: 'tubefinset', id: 't1' }]))).toHaveLength(6);
  });
});

describe('rail interference', () => {
  const warn = (kids: Record<string, unknown>[]) => railInterferenceWarnings(tree(kids));

  it('flags a rail button sitting on a fin line', () => {
    const w = warn([FINS3, { type: 'railbutton', id: 'r1', name: 'Button', angleOffset: 0 }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('in line with a fin');
    expect(w[0]).toContain('fouls it');
  });

  it('says nothing when the button is between the fins — the correct build', () => {
    expect(warn([FINS3, { type: 'railbutton', id: 'r1', angleOffset: D(60) }])).toHaveLength(0);
  });

  it('flags NEAR misses too, and names the actual separation', () => {
    const w = warn([FINS3, { type: 'railbutton', id: 'r1', angleOffset: D(6) }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('6°');
    // …but not a deliberate offset well clear of the fin.
    expect(warn([FINS3, { type: 'railbutton', id: 'r1', angleOffset: D(25) }])).toHaveLength(0);
  });

  it('flags a camera shroud or lug sharing the rail line', () => {
    const w = warn([
      { type: 'railbutton', id: 'r1', name: 'Button', angleOffset: D(180) },
      { type: 'fairing', id: 'sh', name: 'GoPro', angleOffset: D(180) },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('GoPro');
  });

  it('flags two rail buttons that disagree, and accepts two that agree', () => {
    const disagree = warn([
      { type: 'railbutton', id: 'r1', angleOffset: D(180) },
      { type: 'railbutton', id: 'r2', angleOffset: D(90) },
    ]);
    expect(disagree.some((s) => s.includes('different angles'))).toBe(true);

    expect(warn([
      { type: 'railbutton', id: 'r1', angleOffset: D(180) },
      { type: 'railbutton', id: 'r2', angleOffset: D(180) },
    ])).toHaveLength(0);
  });

  it('says each thing once, however many buttons raise it', () => {
    const w = warn([
      FINS3,
      { type: 'railbutton', id: 'r1', angleOffset: 0 },
      { type: 'railbutton', id: 'r2', angleOffset: 0 },
    ]);
    expect(w).toHaveLength(1);
  });

  /**
   * v0.104 — assemblies are surface parts too, and the largest ones there are.
   *
   * `collectFrame` has always pushed a podset/parallelstage NODE into the
   * frame's members (its `angleOffset` is a clock angle in the PARENT's frame),
   * but the classifier tested railbutton → isFinSet → SURFACE and an assembly
   * matched none of the three, so it was silently dropped. The fixture below is
   * built from the app's OWN defaults, which is what makes it the case that
   * matters: `defaultParams('parallelstage')` is instanceCount 2 / angleOffset
   * 0 and `defaultParams('railbutton')` is angleOffset π, so a booster added
   * with two clicks puts its second strap-on exactly on the rail line for the
   * full length of the airframe — and the same function warned about a 4 mm
   * launch lug in the same place.
   */
  it('flags a strap-on booster on the rail line, at the app\'s own defaults', () => {
    const boosterAngle = defaultParams('parallelstage')['angleOffset'] as number;
    const buttonAngle = defaultParams('railbutton')['angleOffset'] as number;
    expect(boosterAngle).toBe(0);
    expect(buttonAngle).toBe(Math.PI);
    const w = warn([
      { type: 'railbutton', id: 'r1', name: 'Button', angleOffset: buttonAngle },
      {
        type: 'parallelstage', id: 'ps1', name: 'Strap-on',
        instanceCount: 2, angleOffset: boosterAngle,
        children: [{ type: 'bodytube', id: 'pb', length: 0.3, outerRadius: 0.02 }],
      },
    ]);
    // ONE sentence, not two: instance 0 is at 0° and clear of the π button; it
    // is instance 1, at π, that fouls the rail.
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('Strap-on');
    expect(w[0]).toContain("both sit on the rail's line");
  });

  it('names an unnamed assembly rather than its type', () => {
    // The same courtesy the wake sentence already does for an unnamed shroud —
    // "podset" is not a word the app shows anywhere.
    const w = warn([
      { type: 'railbutton', id: 'r1', angleOffset: Math.PI },
      {
        type: 'parallelstage', id: 'ps1', instanceCount: 2, angleOffset: 0,
        children: [{ type: 'bodytube', id: 'pb', length: 0.3, outerRadius: 0.02 }],
      },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"Booster"');
    expect(w[0]).not.toContain('"parallelstage"');
  });

  it('tests every instance of a pod set, not just the node\'s own angle', () => {
    // A 3-up pod ring clocked 30° off puts instances at 30, 150 and −90. The
    // button at 150° is on the second of them — invisible if only the node's
    // own 30° were compared.
    const podAt = (angleOffset: number, count: number) => ({
      type: 'podset', id: 'p1', name: 'Pods', instanceCount: count, angleOffset,
      children: [{ type: 'bodytube', id: 'pb', length: 0.2, outerRadius: 0.015 }],
    });
    expect(warn([
      { type: 'railbutton', id: 'r1', angleOffset: D(150) },
      podAt(D(30), 3),
    ])).toHaveLength(1);
    // …and the same ring with the button in one of the gaps stays silent.
    expect(warn([
      { type: 'railbutton', id: 'r1', angleOffset: D(90) },
      podAt(D(30), 3),
    ])).toHaveLength(0);
  });

  it('does not compare across frames: a fin inside a POD is not on the core airframe', () => {
    // The pod rotates its whole sub-chain, so its fins are not measured from
    // the core's zero. Comparing the raw numbers would invent a collision.
    const t = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.027, thickness: 0.001,
        children: [
          { type: 'railbutton', id: 'r1', angleOffset: 0 },
          { type: 'podset', id: 'p1', instanceCount: 2, angleOffset: D(90),
            children: [{ type: 'bodytube', id: 'pb', length: 0.1, outerRadius: 0.01,
              children: [FINS3] }] },
        ],
      }] }],
    } as unknown as RocketTree;
    expect(railInterferenceWarnings(t)).toHaveLength(0);
  });
});

describe('a freshly added rail button is not on a fin line', () => {
  it('defaults to the kernel angle (PI), not to 0 = fin 1', () => {
    // Until v0.088 both defaulted to an absent angle, read everywhere as 0 —
    // the top of the side view, and exactly where an unrotated fin set puts
    // its first fin.
    expect(defaultParams('railbutton')['angleOffset']).toBeCloseTo(Math.PI, 12);
    expect(defaultParams('launchlug')['angleOffset']).toBeCloseTo(Math.PI, 12);
    // And the check agrees: adding one to a 3-fin airframe raises nothing.
    const t = tree([FINS3, { type: 'railbutton', id: 'r1', ...defaultParams('railbutton') }]);
    expect(railInterferenceWarnings(t)).toHaveLength(0);
  });
});

/**
 * Two things the v0.088 review found, pinned so they cannot come back.
 */
describe('review fixes (v0.088)', () => {
  it('never offers a "between fins" position that sits on ANOTHER set\'s fin', () => {
    // A 3-fin main set at 0/120/-120 and a 4-fin canard set at 0/90/180/-90.
    // The 3-set's midpoint at 180 lands exactly on a canard fin, so a naive
    // per-set calculation would offer to put the camera straight behind it.
    const twoSets = body([
      { type: 'trapezoidfinset', id: 'main', finCount: 3, rootChord: 0.05, height: 0.04 },
      { type: 'trapezoidfinset', id: 'canard', finCount: 4, rootChord: 0.04, height: 0.03 },
    ]);
    // Non-vacuous: the un-filtered list DOES contain a clashing midpoint.
    expect(finAnglesOn(twoSets).some((f) => angleGap(f, Math.PI) <= IN_LINE_TOLERANCE)).toBe(true);
    const fins = finAnglesOn(twoSets);
    for (const m of betweenFinAnglesOn(twoSets)) {
      for (const f of fins) {
        expect(angleGap(m, f), `midpoint ${asDeg(m)} sits on a fin at ${asDeg(f)}`)
          .toBeGreaterThan(IN_LINE_TOLERANCE);
      }
    }
  });

  it('falls back rather than returning nothing when every midpoint is taken', () => {
    // Two 3-fin sets 60 degrees apart: each set's midpoints are exactly the
    // other set's fins, so there IS no clear position anywhere. A button that
    // does something imperfect beats one that silently does nothing.
    const packed = body([
      { type: 'trapezoidfinset', id: 'a', finCount: 3, rootChord: 0.04, height: 0.03 },
      { type: 'trapezoidfinset', id: 'b', finCount: 3, rootChord: 0.04, height: 0.03,
        rotation: D(60) },
    ]);
    const fins = finAnglesOn(packed);
    const mids = betweenFinAnglesOn(packed);
    expect(mids.length).toBeGreaterThan(0);
    // Every one of them clashes — that is what makes this the fallback case.
    expect(mids.every((m) => fins.some((f) => angleGap(m, f) <= IN_LINE_TOLERANCE))).toBe(true);
  });

  it('checks the rail line down the WHOLE airframe, not just one body tube', () => {
    // The ordinary high-power layout: fins on the fin can, rail button on the
    // tube above it. They are not siblings, but the rail is one straight line
    // down the rocket, so they are absolutely on it together.
    const twoTubes = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'bodytube', id: 'upper', length: 0.5, outerRadius: 0.027,
          children: [{ type: 'railbutton', id: 'rb', angleOffset: 0 }] },
        { type: 'bodytube', id: 'fincan', length: 0.3, outerRadius: 0.027,
          children: [FINS3] },
      ] }],
    } as unknown as RocketTree;
    const w = railInterferenceWarnings(twoTubes);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('in line with a fin');

    // …and moving the button off the fin line clears it.
    const cleared = JSON.parse(JSON.stringify(twoTubes)) as RocketTree;
    (cleared.components[0]!.children![0]!.children![0]! as Record<string, unknown>)['angleOffset'] = D(60);
    expect(railInterferenceWarnings(cleared)).toHaveLength(0);
  });
});

/**
 * 2026-08-31b — the snap buttons and the warnings must agree on what a FRAME
 * is: the whole inline stack. The owner's report: a pre-existing rail button on
 * the tube ABOVE the fin can got no snap buttons, while a freshly added one
 * (born a sibling of the fins) did.
 */
describe('the angular frame spans the whole inline stack', () => {
  const twoTubeStage = {
    name: 'T', components: [{ type: 'stage', id: 's1', children: [
      { type: 'bodytube', id: 'upper', length: 0.5, outerRadius: 0.027,
        children: [{ type: 'railbutton', id: 'rb', angleOffset: 0 }] },
      { type: 'bodytube', id: 'fincan', length: 0.3, outerRadius: 0.027,
        children: [FINS3] },
    ] }],
  } as unknown as RocketTree;

  it('finds the fin can\'s fins for a part on the tube above', () => {
    const members = frameContaining(twoTubeStage, 'rb')!;
    expect(members).not.toBeNull();
    expect(finAnglesAmong(members)).toHaveLength(3);
    expect(betweenFinAnglesAmong(members)).toHaveLength(3);
  });

  it('crosses STAGE boundaries — the stack shares one zero on the pad', () => {
    const twoStage = {
      name: 'T', components: [
        { type: 'stage', id: 'sust', children: [
          { type: 'bodytube', id: 'payload', length: 0.5, outerRadius: 0.027,
            children: [{ type: 'fairing', id: 'cam', angleOffset: 0, length: 0.08, width: 0.03, height: 0.02 }] },
        ] },
        { type: 'stage', id: 'boost', children: [
          { type: 'bodytube', id: 'bfincan', length: 0.3, outerRadius: 0.027, children: [FINS3] },
        ] },
      ],
    } as unknown as RocketTree;
    const members = frameContaining(twoStage, 'cam')!;
    expect(finAnglesAmong(members)).toHaveLength(3);
    // …and the rail check sees across stages too: a booster fin on the rail
    // line of a sustainer's button is flagged, because the rail is engaged
    // with the whole stack assembled.
    const withButton = JSON.parse(JSON.stringify(twoStage)) as RocketTree;
    (withButton.components[0]!.children![0]!.children as unknown as Record<string, unknown>[])
      .push({ type: 'railbutton', id: 'rb2', angleOffset: 0 });
    expect(railInterferenceWarnings(withButton).some((w) => w.includes('in line with a fin'))).toBe(true);
  });

  it('still cuts at an assembly: a pod part sees the POD frame, not the core', () => {
    const podded = {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.027,
        children: [
          FINS3,
          { type: 'podset', id: 'p1', instanceCount: 2, angleOffset: D(90),
            children: [{ type: 'bodytube', id: 'pb', length: 0.1, outerRadius: 0.01,
              children: [{ type: 'railbutton', id: 'podrb', angleOffset: 0 }] }] },
        ],
      }] }],
    } as unknown as RocketTree;
    const members = frameContaining(podded, 'podrb')!;
    // The pod's own chain carries no fins, so the snap question has no answer
    // there — and crucially the CORE's fins are not offered.
    expect(finAnglesAmong(members)).toHaveLength(0);
  });
});

/**
 * C5 — a camera shroud standing in front of a fin.
 *
 * The app charges that fin its full normal force as if the shroud were not
 * there, and MEASURED on this very geometry the shroud's clock angle is
 * invisible to every number the app shows (cpWorst 0.623443963, cnaWorst
 * 10.160125562, CD at M 0.3 0.693915199 — the same to ~15 significant digits
 * at 0/30/45/60/90/180°). Nothing here changes a number; these tests pin what
 * the app now SAYS, and in particular they pin the two thresholds, because
 * both are easy to "simplify" back into something that never fires.
 *
 * The fixture is the one the investigation measured: nose 150 mm, body tube
 * 700 mm at r 27 mm, 3 fins of 100 mm root chord at the tail, and the app's own
 * default 80 × 25 × 20 mm shroud 300 mm down the tube — leaving exactly 220 mm
 * of clear tube between the shroud's trailing edge and the fin leading edge.
 */
describe('a shroud in a fin\'s wake', () => {
  const camTree = (opts: {
    shroud?: Record<string, unknown>;
    fins?: Record<string, unknown>;
    tubeRadius?: number;
  } = {}): RocketTree => {
    const r = opts.tubeRadius ?? 0.027;
    return {
      name: 'T', components: [{ type: 'stage', id: 's1', children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: r },
        { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: r, thickness: 0.001, children: [
          {
            type: 'fairing', id: 'cam', name: 'Camera shroud',
            length: 0.08, width: 0.025, height: 0.02, angleOffset: 0,
            position: { method: 'top', offset: 0.30 },
            ...(opts.shroud ?? {}),
          },
          {
            type: 'trapezoidfinset', id: 'f1', name: 'Fins',
            finCount: 3, rootChord: 0.10, height: 0.055,
            position: { method: 'bottom', offset: 0 },
            ...(opts.fins ?? {}),
          },
        ] },
      ] }],
    } as unknown as RocketTree;
  };

  it('flags the shroud the app\'s own "on a fin" button produces', () => {
    const w = wakeShadowWarnings(camTree());
    expect(w).toHaveLength(1);
    // Names both parts, and states the geometry rather than a verdict.
    expect(w[0]).toContain('"Camera shroud" at 0°');
    expect(w[0]).toContain('a fin of "Fins"');
    expect(w[0]).toContain('220 mm ahead');
    expect(w[0]).toContain('11 times its own height');
    expect(w[0]).toContain('0° off that fin\'s line');
    expect(w[0]).toContain('not modelled');
    expect(w[0]).toContain('Clocking it between the fins');
    // THE COPY RULE, pinned: this term moves CP forward and the sentence says
    // so, but it must never claim the app's margin is optimistic OVERALL —
    // @Buckeye's own CFD puts Barrowman CP up to 2.3 calibers TOO FAR FORWARD,
    // an order of magnitude the other way. This is safety-adjacent copy on a
    // beta with real flyers reading it.
    expect(w[0]).toContain('moves CP forward');
    expect(w[0]).not.toContain('optimistic');
    // And it quotes no size, because nothing in the record sizes it.
    expect(w[0]).not.toMatch(/calib/i);
  });

  it('says nothing when the shroud is clocked between the fins', () => {
    // The fix the sentence recommends, and the pair the investigation measured
    // as identical in every number the app shows.
    expect(wakeShadowWarnings(camTree({ shroud: { angleOffset: D(60) } }))).toHaveLength(0);
    // A 4-fin set is 90° apart, so its own "between" at 45° is clear too.
    expect(wakeShadowWarnings(camTree({
      fins: { finCount: 4 }, shroud: { angleOffset: D(45) },
    }))).toHaveLength(0);
  });

  /**
   * THE ASSERTION THAT FAILS IF SOMEONE REVERTS TO A BARE IN_LINE_TOLERANCE.
   * That 10° is derived from a 1010 rail's slot — a rail is a line. A shroud is
   * a body: the app's default 25 mm shroud subtends asin(25/54) = 27.6° of
   * half-angle on a 54 mm airframe, so a 10° window would stay silent on a
   * shroud whose own body physically covers the fin.
   */
  it('measures the window from the shroud\'s own width, not the rail tolerance', () => {
    // 20° off the fin line: outside 10°, inside 27.6 + 10 = 37.6°.
    expect(angleGap(D(20), 0)).toBeGreaterThan(IN_LINE_TOLERANCE); // non-vacuous
    expect(wakeShadowWarnings(camTree({ shroud: { angleOffset: D(20) } }))).toHaveLength(1);
    // 45° off: outside the window, and a deliberate placement.
    expect(wakeShadowWarnings(camTree({ shroud: { angleOffset: D(45) } }))).toHaveLength(0);
    // The SAME shroud on a 152 mm airframe subtends only 9.5°, so the window is
    // 19.5° and 20° now falls outside it. The window scales with the body.
    expect(wakeShadowWarnings(camTree({
      tubeRadius: 0.076, shroud: { angleOffset: D(20) },
    }))).toHaveLength(0);
  });

  it('says nothing when the shroud is not upstream of the fin at all', () => {
    // Trailing edge at 850 mm, fin leading edge at 750 mm. A wake needs
    // somewhere downstream to go. (NOT a claim about the physics of an axial
    // overlap — see the note in mountAngle.ts.)
    expect(wakeShadowWarnings(camTree({
      shroud: { position: { method: 'top', offset: 0.62 } },
    }))).toHaveLength(0);
  });

  it('stops at the stated cutoff of twenty shroud heights', () => {
    expect(WAKE_REACH_HEIGHTS).toBe(20);
    // 420 mm ahead of the fins on a 20 mm shroud = 21 heights: silent.
    expect(wakeShadowWarnings(camTree({
      shroud: { position: { method: 'top', offset: 0.10 } },
    }))).toHaveLength(0);
    // A nose-mounted camera is well outside it (500 mm = 25 heights).
    expect(wakeShadowWarnings(camTree({
      shroud: { position: { method: 'top', offset: 0.02 } },
    }))).toHaveLength(0);
    // …but a TALLER bump reaches further on the same geometry: 40 mm high at
    // the same 500 mm gap is 12.5 heights.
    const tall = wakeShadowWarnings(camTree({
      shroud: { position: { method: 'top', offset: 0.02 }, height: 0.04 },
    }));
    expect(tall).toHaveLength(1);
    expect(tall[0]).toContain('12.5 times its own height');
  });

  it('treats a protuberance the same, and a launch lug not at all', () => {
    const bump = wakeShadowWarnings(camTree({
      shroud: {
        type: 'protuberance', name: 'Cable tunnel', dragClass: 'streamlinedbase',
        width: 0.025, height: 0.02, length: 0.08,
      },
    }));
    expect(bump).toHaveLength(1);
    expect(bump[0]).toContain('"Cable tunnel"');
    // A lug is a slender streamwise tube, not a bluff bump — deliberately out.
    expect(wakeShadowWarnings(camTree({
      shroud: { type: 'launchlug', name: 'Lug', outerRadius: 0.0022, thickness: 0.0003 },
    }))).toHaveLength(0);
  });

  it('says nothing about a TUBE fin ring downstream — a duct, not a plate', () => {
    expect(wakeShadowWarnings(camTree({
      fins: { type: 'tubefinset', finCount: 6, length: 0.10, outerRadius: 0.02 },
    }))).toHaveLength(0);
  });

  it('names an unnamed shroud rather than its type', () => {
    const w = wakeShadowWarnings(camTree({ shroud: { name: undefined } }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"Camera shroud"');
    expect(w[0]).not.toContain('"fairing"');
  });

  it('says it once for a 6-fin set with two instances inside the window', () => {
    // Fins at 0/60/120/…; a shroud at 25° is 25° from one and 35° from the
    // next, and BOTH are inside the 37.6° window. One piece of geometry, one
    // sentence — and it names the nearest fin.
    const w = wakeShadowWarnings(camTree({
      fins: { finCount: 6 }, shroud: { angleOffset: D(25) },
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('25° off that fin\'s line');
  });

  it('does not compare across frames: a POD\'s fins are not behind a core shroud', () => {
    // The pod rotates its whole sub-chain, so its fins are not measured from
    // the core's zero. The same trap the rail check was built to avoid.
    const pod = (shroudInsidePod: boolean) => {
      const shroud = {
        type: 'fairing', id: 'cam', name: 'Camera shroud',
        length: 0.08, width: 0.025, height: 0.02, angleOffset: 0,
        position: { method: 'top', offset: shroudInsidePod ? 0 : 0.30 },
      };
      const podKids = [{
        type: 'bodytube', id: 'pb', length: 0.2, outerRadius: 0.027, children: [
          ...(shroudInsidePod ? [shroud] : []),
          { type: 'trapezoidfinset', id: 'pf', name: 'Pod fins', finCount: 3,
            rootChord: 0.05, position: { method: 'bottom', offset: 0 } },
        ],
      }];
      return {
        name: 'T', components: [{ type: 'stage', id: 's1', children: [
          { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
          { type: 'bodytube', id: 'b1', length: 0.7, outerRadius: 0.027, children: [
            ...(shroudInsidePod ? [] : [shroud]),
            { type: 'podset', id: 'p1', instanceCount: 2, angleOffset: 0,
              position: { method: 'bottom', offset: 0 }, children: podKids },
          ] },
        ] }],
      } as unknown as RocketTree;
    };
    // Core shroud, pod fins: aligned at 0° and only 270 mm apart, so the ONLY
    // thing keeping this quiet is the frame cut.
    expect(wakeShadowWarnings(pod(false))).toHaveLength(0);
    // Move the same shroud INSIDE the pod and the pod's own frame speaks —
    // which is what makes the case above non-vacuous.
    expect(wakeShadowWarnings(pod(true))).toHaveLength(1);
  });

  it('sees across a STAGE joint — the stack is assembled during boost', () => {
    // A shroud on the sustainer's payload bay, fins on the booster. The margin
    // this bears on is the boost-phase margin, when the two are one airframe —
    // the same whole-stack frame the rail check uses.
    const twoStage = {
      name: 'T', components: [
        { type: 'stage', id: 'sust', children: [
          { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.027 },
          { type: 'bodytube', id: 'pay', length: 0.5, outerRadius: 0.027, children: [
            { type: 'fairing', id: 'cam', name: 'Camera shroud', length: 0.08,
              width: 0.025, height: 0.02, angleOffset: 0,
              position: { method: 'bottom', offset: 0 } },
          ] },
        ] },
        { type: 'stage', id: 'boost', children: [
          { type: 'bodytube', id: 'bfin', length: 0.3, outerRadius: 0.027, children: [
            { type: 'trapezoidfinset', id: 'bf', name: 'Booster fins', finCount: 3,
              rootChord: 0.10, position: { method: 'bottom', offset: 0 } },
          ] },
        ] },
      ],
    } as unknown as RocketTree;
    const w = wakeShadowWarnings(twoStage);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"Booster fins"');
    expect(w[0]).toContain('200 mm ahead');
  });

  it('leaves the rail check exactly where it was', () => {
    // The baseline the investigation measured: a shroud sitting on a fin line
    // raises NOTHING from railInterferenceWarnings, because both of its loops
    // key on rail buttons. The new check is additive, not a rewrite.
    expect(railInterferenceWarnings(camTree())).toHaveLength(0);
    // …and a design with no bump raises nothing from the new one.
    expect(wakeShadowWarnings(tree([FINS3]))).toHaveLength(0);
  });
});
