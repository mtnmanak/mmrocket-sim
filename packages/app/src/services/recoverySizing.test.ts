import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import presetsJson from '../data/presets.json';
import type { Preset } from './presets.js';
import { presetPatch } from './presets.js';
import { engineTree } from '../tree/treeModel.js';
import { SAFETY } from './simReport.js';
import {
  canopyCdA, classifyRecoveryDevices, DEFAULT_CANOPY_CD, descentRate, diameterForRate,
  DROGUE_BAND, MAIN_BAND, recoveryBayBore, recoverySizing, SEA_LEVEL_DENSITY, siteAirDensity,
} from './recoverySizing.js';

const db = (presetsJson as { presets: Preset[] }).presets;
const canopies = db.filter((p) => p.kind === 'Parachute');

/** The owner's Wildman: 8.786 kg comes down, which is where this feature started. */
const WILDMAN_KG = 8.786;

const FPS = 1 / 0.3048;
const fps = (v: number): number => v * FPS;
const IN = 1 / 0.0254;

const SEA_LEVEL = { launchAltitudeM: 0, temperatureC: null, pressureHPa: null };

/** A tree with one body tube and, optionally, chutes inside it. */
const tube = (bore: number, chutes: Partial<ComponentNode>[] = []): RocketTree => ({
  name: 'test',
  components: [{
    type: 'stage', id: 's0', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'bt', name: 'Body', length: 1,
      // mountBore = (outerRadius - thickness) * 2
      outerRadius: bore / 2 + 0.001, thickness: 0.001,
      children: chutes.map((c, i) => ({ type: 'parachute', id: `p${i}`, ...c } as ComponentNode)),
    } as ComponentNode],
  } as ComponentNode],
});

const ok = (r: ReturnType<typeof recoverySizing>) => {
  if (r.state !== 'ok') throw new Error(`expected ok, got ${r.state}`);
  return r;
};

const sizing = (over: Partial<Parameters<typeof recoverySizing>[0]> = {}) => recoverySizing({
  recovery: { state: 'ok', mass: WILDMAN_KG, multiStage: false },
  tree: tube(0.3),
  deviceMass: () => null,
  presets: canopies,
  launch: SEA_LEVEL,
  ...over,
});

describe('the catalogue this rests on', () => {
  it('carries 473 parachutes, 256 of them with a usable Cd', () => {
    // The gate on the whole feature: a canopy with no published Cd would be
    // sized on the kernel's 0.8 default and recommended up to 1.66x too small.
    expect(canopies.length).toBe(473);
    expect(canopies.filter((p) => canopyCdA(p) !== null).length).toBe(256);
  });
});

describe('canopyCdA — a Cd and its spill hole are ONE fact (2026-09-03)', () => {
  it('scales the rated Cd by 1 - (d/D)^2', () => {
    const vented = canopies.find((p) => typeof p['spillHoleDiameter'] === 'number'
      && (p['spillHoleDiameter'] as number) > 0 && canopyCdA(p) !== null)!;
    const D = vented['diameter'] as number;
    const d = vented['spillHoleDiameter'] as number;
    const cd = vented['dragCoefficient'] as number;
    expect(canopyCdA(vented)).toBeCloseTo(cd * (1 - (d / D) ** 2) * Math.PI * D * D / 4, 12);
  });

  it('reads ~2 % slow if the hole is dropped — the error this rule prevents', () => {
    const vented = canopies.filter((p) => typeof p['spillHoleDiameter'] === 'number'
      && (p['spillHoleDiameter'] as number) > 0 && canopyCdA(p) !== null);
    expect(vented.length).toBe(68);
    for (const p of vented) {
      const D = p['diameter'] as number;
      const noHole = (p['dragCoefficient'] as number) * Math.PI * D * D / 4;
      // Vented area is smaller, so the honest rate is FASTER than the naive one.
      const ratio = descentRate(WILDMAN_KG, canopyCdA(p)!, SEA_LEVEL_DENSITY)
        / descentRate(WILDMAN_KG, noHole, SEA_LEVEL_DENSITY);
      expect(ratio).toBeGreaterThan(1);
    }
    // The published Fruity Chutes vents run 1.5-2.5 % on the rate.
    const worst = Math.max(...vented.map((p) => {
      const D = p['diameter'] as number;
      const noHole = (p['dragCoefficient'] as number) * Math.PI * D * D / 4;
      return descentRate(WILDMAN_KG, canopyCdA(p)!, SEA_LEVEL_DENSITY)
        / descentRate(WILDMAN_KG, noHole, SEA_LEVEL_DENSITY);
    }));
    expect(worst).toBeLessThan(1.05);
  });

  it('is the SAME number the flown design would use — presetPatch then engineTree', () => {
    // The claim that makes a recommendation trustworthy: apply the part in the
    // picker, press Launch, and the kernel flies the Cd this panel predicted.
    const vented = canopies.find((p) => typeof p['spillHoleDiameter'] === 'number'
      && (p['spillHoleDiameter'] as number) > 0 && canopyCdA(p) !== null)!;
    const patch = presetPatch('parachute', vented) as Record<string, unknown>;
    const tree: RocketTree = {
      name: 't',
      components: [{
        type: 'stage', id: 's', children: [
          { type: 'parachute', id: 'p', ...patch } as ComponentNode,
        ],
      } as ComponentNode],
    };
    const flown = engineTree(tree).components[0]!.children![0]!;
    const D = flown['diameter'] as number;
    const flownCdA = (flown['cd'] as number) * Math.PI * D * D / 4;
    expect(flownCdA).toBeCloseTo(canopyCdA(vented)!, 12);
  });

  it('refuses a row with no Cd rather than defaulting it', () => {
    const bare = canopies.find((p) => typeof p['dragCoefficient'] !== 'number')!;
    expect(canopyCdA(bare)).toBeNull();
  });
});

describe('siteAirDensity — the field, not sea level', () => {
  it('is ISA sea level with nothing set', () => {
    expect(siteAirDensity(SEA_LEVEL)).toBeCloseTo(1.225, 4);
    expect(SEA_LEVEL_DENSITY).toBeCloseTo(1.225, 4);
  });

  it('falls 13.8 % at 5,000 ft, landing the same canopy 7.7 % faster', () => {
    const rho = siteAirDensity({ launchAltitudeM: 1524, temperatureC: null, pressureHPa: null });
    expect(rho).toBeCloseTo(1.0555, 4);
    expect(Math.sqrt(SEA_LEVEL_DENSITY / rho)).toBeCloseTo(1.0773, 4);
  });

  it('uses a stated launch-site temperature and pressure directly', () => {
    // Both given: rho = p/(R.T), which is exactly what ExtendedISAModel reports
    // AT the site altitude it was constructed with.
    const rho = siteAirDensity({ launchAltitudeM: 1200, temperatureC: 32, pressureHPa: 875 });
    expect(rho).toBeCloseTo(87500 / (287.053 * 305.15), 9);
  });

  it('matches the kernel’s quirk when only one of the two is given', () => {
    // OrkEngine.java:919-926 fills the MISSING field with the ISA SEA-LEVEL
    // value and applies it at the site altitude. Reproducing that is the point:
    // the panel must predict the flight the app would actually fly.
    const rho = siteAirDensity({ launchAltitudeM: 2000, temperatureC: 35, pressureHPa: null });
    expect(rho).toBeCloseTo(101325 / (287.053 * 308.15), 9);
  });
});

describe('the bands', () => {
  it('are the owner’s 15-20 and 50-75 ft/s, in SI', () => {
    expect(fps(MAIN_BAND.min)).toBeCloseTo(15, 6);
    expect(fps(DROGUE_BAND.min)).toBeCloseTo(50, 6);
    expect(fps(DROGUE_BAND.max)).toBeCloseTo(75, 6);
    // The main's fast edge is the app's own landing limit, not a fresh literal.
    expect(MAIN_BAND.max).toBe(SAFETY.maxLandingRate);
    expect(fps(MAIN_BAND.max)).toBeCloseTo(20, 1);
  });

  it('flags a drogue against the app’s OWN 70 ft/s report threshold', () => {
    expect(DROGUE_BAND.warnAbove).toBe(SAFETY.maxDrogueDescentRate);
    // 21.34 m/s is 70.013 ft/s — the app's own rounding, kept as the app's.
    expect(fps(DROGUE_BAND.warnAbove!)).toBeCloseTo(70, 1);
    // The conflict, stated: the band reaches past the threshold.
    expect(DROGUE_BAND.max).toBeGreaterThan(DROGUE_BAND.warnAbove!);
    // And the drogue size line lands below it, so the app's own recommendation
    // can never be one its own launch report complains about.
    expect(DROGUE_BAND.target).toBeLessThan(DROGUE_BAND.warnAbove!);
  });
});

describe('the size line — the owner’s worked example, 8.786 kg at sea level', () => {
  const inches = (cd: number, rate: number) =>
    Math.round(diameterForRate(WILDMAN_KG, cd, SEA_LEVEL_DENSITY, rate) * IN);

  it('is a 65 in main and a 19 in drogue at Cd 2.2', () => {
    expect(inches(2.2, MAIN_BAND.target)).toBe(65);
    expect(inches(2.2, DROGUE_BAND.target)).toBe(19);
  });

  it('is 78 in and 24 in at Cd 1.5', () => {
    expect(inches(1.5, MAIN_BAND.target)).toBe(78);
    expect(inches(1.5, DROGUE_BAND.target)).toBe(24);
  });

  it('is 107 in and 32 in at Cd 0.8', () => {
    expect(inches(0.8, MAIN_BAND.target)).toBe(107);
    expect(inches(0.8, DROGUE_BAND.target)).toBe(32);
  });

  it('round-trips: the size it names really does descend at the target rate', () => {
    const D = diameterForRate(WILDMAN_KG, 2.2, SEA_LEVEL_DENSITY, MAIN_BAND.target);
    const cdA = 2.2 * Math.PI * D * D / 4;
    expect(descentRate(WILDMAN_KG, cdA, SEA_LEVEL_DENSITY)).toBeCloseTo(MAIN_BAND.target, 9);
  });
});

describe('the catalogue, sized for the same 8.786 kg rocket', () => {
  it('has 33 mains in the band and 28 drogues', () => {
    // The owner's own measurement, reproduced from the shipped presets.json.
    const count = (min: number, max: number) => canopies.filter((p) => {
      const cdA = canopyCdA(p);
      if (cdA === null) return false;
      const v = descentRate(WILDMAN_KG + (p.mass ?? 0), cdA, SEA_LEVEL_DENSITY) * FPS;
      return v >= min && v <= max;
    }).length;
    expect(count(15, 20)).toBe(33);
    expect(count(50, 75)).toBe(28);
  });

  it('finds ONE more main through SAFETY.maxLandingRate, and it is nameable', () => {
    // MAIN_BAND.max is SAFETY.maxLandingRate, 6.1 m/s = 20.013 ft/s, 4 mm/s
    // above a literal 20 ft/s. Exactly one catalogue canopy lands in that
    // sliver on this rocket, so the count is 34 rather than the owner's 33 —
    // and it is admitted deliberately: at 6.098 m/s the app's own launch
    // report would not complain either. A silent off-by-one is what this test
    // exists to prevent.
    const r = ok(sizing({ tree: tube(10) }));
    expect(r.main.inBand).toBe(34);
    expect(r.drogue.inBand).toBe(28);

    const sliver = canopies.filter((p) => {
      const cdA = canopyCdA(p);
      if (cdA === null) return false;
      const v = descentRate(WILDMAN_KG, cdA, SEA_LEVEL_DENSITY);
      return v > 20 / FPS && v <= MAIN_BAND.max;
    });
    expect(sliver.map((p) => p.partNo)).toEqual(['CFC-072-N']);
    expect(descentRate(WILDMAN_KG, canopyCdA(sliver[0]!)!, SEA_LEVEL_DENSITY))
      .toBeCloseTo(6.09833, 5);
  });
});

describe('recoverySizing — the gates', () => {
  it('says nothing at all with no motor loaded', () => {
    expect(sizing({ recovery: { state: 'no-motor' } })).toEqual({ state: 'no-motor' });
  });

  it('passes recoveryMass’s own reason through rather than inventing one', () => {
    expect(sizing({ recovery: { state: 'unavailable', reason: 'the masses do not add up' } }))
      .toEqual({ state: 'unavailable', reason: 'the masses do not add up' });
  });

  it('never recomputes the mass — the recovery weight is the recovery weight', () => {
    const r = ok(sizing({ recovery: { state: 'ok', mass: 3.21, multiStage: true } }));
    expect(r.massKg).toBe(3.21);
    expect(r.main.massKg).toBe(3.21);
  });
});

describe('the candidate’s own mass — one exact substitution', () => {
  it('weighs each candidate as recovery − current chute + candidate', () => {
    // A 300 g chute in the design, swapped for a catalogue canopy: the rocket
    // that flies under the candidate is 300 g lighter plus the candidate.
    const withChute = tube(0.3, [{ diameter: 0.6, cd: 1.5, deployEvent: 'altitude' }]);
    const r = ok(sizing({ tree: withChute, deviceMass: () => 0.3 }));
    const first = r.main.candidates[0]!;
    const row = canopies.find((p) => p.partNo === first.partNo
      && p.manufacturer === first.manufacturer)!;
    const m = WILDMAN_KG - 0.3 + (row.mass as number);
    expect(first.rate).toBeCloseTo(descentRate(m, canopyCdA(row)!, SEA_LEVEL_DENSITY), 12);
  });

  it('skips the substitution rather than half-applying it when a mass is unknown', () => {
    // Subtracting the old canopy without adding the new one understates the
    // rocket, and understating buys a canopy that is too small.
    const withChute = tube(0.3, [{ diameter: 0.6, cd: 1.5, deployEvent: 'altitude' }]);
    const r = ok(sizing({ tree: withChute, deviceMass: () => null }));
    const first = r.main.candidates[0]!;
    const row = canopies.find((p) => p.partNo === first.partNo
      && p.manufacturer === first.manufacturer)!;
    expect(first.rate).toBeCloseTo(
      descentRate(WILDMAN_KG, canopyCdA(row)!, SEA_LEVEL_DENSITY), 12);
  });

  it('matters: a 96 in Classic Elliptical moves a 3 kg rocket’s rate by >10 %', () => {
    const big = canopies.find((p) => p.manufacturer === 'Fruity Chutes' && p.partNo === 'CFC-096-N')!;
    expect(big.mass).toBeGreaterThan(0.8);
    const cdA = canopyCdA(big)!;
    const naive = descentRate(3, cdA, SEA_LEVEL_DENSITY);
    const honest = descentRate(3 + (big.mass as number), cdA, SEA_LEVEL_DENSITY);
    expect(honest / naive).toBeGreaterThan(1.1);
  });
});

describe('the 70-vs-75 ft/s conflict — ordered and marked, never dropped or hidden', () => {
  /**
   * 0.9 kg is chosen, not arbitrary: it is a mass where the catalogue offers
   * only THREE drogues in the 50-75 band, one of them (Rocketman HX-009, 71.4
   * ft/s) above the app's own 70 ft/s complaint threshold. Under five
   * unflagged candidates is the only way a flagged one is ever SHOWN — at
   * 8.786 kg there are six over 70 and all six are correctly pushed off the
   * end of the list — so this is the case that proves the marked path renders
   * at all rather than merely existing.
   */
  const light = () => ok(sizing({
    recovery: { state: 'ok', mass: 0.9, multiStage: false },
    tree: tube(10),
  }));

  it('keeps candidates above the app’s 70 ft/s threshold, marked', () => {
    const r = light();
    const flagged = r.drogue.candidates.filter((c) => c.flagged);
    expect(flagged.length).toBeGreaterThan(0);
    for (const c of flagged) expect(fps(c.rate)).toBeGreaterThan(70);
    // Whatever this design offers, nothing above the owner's 75 is ever shown.
    for (const c of r.drogue.candidates) expect(fps(c.rate)).toBeLessThanOrEqual(75.000001);
  });

  it('orders every unflagged candidate ahead of every flagged one', () => {
    const r = light();
    const firstFlagged = r.drogue.candidates.findIndex((c) => c.flagged);
    expect(firstFlagged).toBeGreaterThan(0);
    expect(r.drogue.candidates.slice(firstFlagged).every((c) => c.flagged)).toBe(true);
  });

  it('drops a flagged candidate off the end rather than off the list', () => {
    // The owner's own rocket: six catalogue drogues sit between 70 and 75
    // ft/s, and none of them reaches the visible five because ordering, not
    // exclusion, is what keeps them back.
    const r = ok(sizing({ tree: tube(10) }));
    const over70 = canopies.filter((p) => {
      const cdA = canopyCdA(p);
      if (cdA === null) return false;
      const v = descentRate(WILDMAN_KG, cdA, SEA_LEVEL_DENSITY);
      return v > DROGUE_BAND.warnAbove! && v <= DROGUE_BAND.max;
    });
    expect(over70.length).toBe(6);
    expect(r.drogue.candidates.some((c) => c.flagged)).toBe(false);
    expect(r.drogue.candidates).toHaveLength(5);
  });

  it('marks nothing in the main band — its own edge IS the threshold', () => {
    const r = ok(sizing({ tree: tube(10) }));
    expect(r.main.candidates.some((c) => c.flagged)).toBe(false);
  });
});

describe('the fit filter', () => {
  it('drops a canopy that will not pack into the bay, and counts what it dropped', () => {
    const wide = ok(sizing({ tree: tube(10) }));
    const narrow = ok(sizing({ tree: tube(0.054) }));
    expect(wide.main.excludedForFit).toBe(0);
    expect(narrow.main.excludedForFit).toBeGreaterThan(0);
    expect(narrow.main.inBand).toBe(wide.main.inBand);
    for (const c of narrow.main.candidates) {
      if (c.packedDiameter !== null) expect(c.packedDiameter).toBeLessThanOrEqual(0.054);
    }
  });

  it('keeps a canopy whose packed size is unpublished, marked unverified', () => {
    // 26 of the 256 usable rows publish no packed diameter. Silently excluding
    // them would make the list look arbitrary and hide real answers.
    const narrow = ok(sizing({ tree: tube(0.054) }));
    const unpublished = canopies.filter((p) => canopyCdA(p) !== null
      && typeof p['packedDiameter'] !== 'number');
    expect(unpublished.length).toBe(26);
    const shown = narrow.main.candidates.concat(narrow.drogue.candidates);
    for (const c of shown) {
      expect(c.fit).toBe(c.packedDiameter === null ? 'unverified' : 'fits');
    }
  });

  it('filters nothing when the design has no tube to measure', () => {
    const noTube: RocketTree = {
      name: 'bare',
      components: [{ type: 'stage', id: 's', children: [] } as unknown as ComponentNode],
    };
    const r = ok(sizing({ tree: noTube }));
    expect(r.boreM).toBeNull();
    expect(r.main.excludedForFit).toBe(0);
    expect(r.main.candidates.every((c) => c.fit === 'unverified')).toBe(true);
  });

  it('measures the bay through mountBore, so a wall is a wall', () => {
    // 4 in tube, 1 mm wall -> 99.6 mm of bore, not 101.6.
    const t = tube(0.0996);
    expect(recoveryBayBore(t, null)).toBeCloseTo(0.0996, 9);
  });

  it('prefers the tube the chute actually lives in', () => {
    const t: RocketTree = {
      name: 'two tubes',
      components: [{
        type: 'stage', id: 's', children: [
          { type: 'bodytube', id: 'fat', outerRadius: 0.101, thickness: 0.001, length: 0.5 },
          {
            type: 'bodytube', id: 'thin', outerRadius: 0.031, thickness: 0.001, length: 0.5,
            children: [{ type: 'parachute', id: 'p', diameter: 0.5 }],
          },
        ],
      } as unknown as ComponentNode],
    };
    const { main } = classifyRecoveryDevices(t);
    expect(recoveryBayBore(t, main)).toBeCloseTo(0.06, 9);
    // Nothing selected: the widest tube is the honest upper bound.
    expect(recoveryBayBore(t, null)).toBeCloseTo(0.2, 9);
  });
});

describe('dedupe — five canopies, not six spellings of one', () => {
  const wide = () => ok(sizing({ tree: tube(10) }));

  it('shows at most five per band and at most two per manufacturer', () => {
    const r = wide();
    for (const advice of [r.main, r.drogue]) {
      expect(advice.candidates.length).toBeLessThanOrEqual(5);
      const perMfr = new Map<string, number>();
      for (const c of advice.candidates) {
        perMfr.set(c.manufacturer, (perMfr.get(c.manufacturer) ?? 0) + 1);
      }
      for (const [, n] of perMfr) expect(n).toBeLessThanOrEqual(2);
    }
  });

  it('spreads across manufacturers rather than filling from one catalogue', () => {
    const r = wide();
    expect(new Set(r.main.candidates.map((c) => c.manufacturer)).size).toBeGreaterThanOrEqual(3);
  });

  it('folds one canopy’s fabric weights into a single line and says how many', () => {
    // Fruity Chutes sell the 72 in Iris Ultra as -N, -S and -SUL: one canopy,
    // three fabrics, rates within 0.2 ft/s. Three lines would be three lies
    // about how much choice there is.
    const r = wide();
    expect(r.main.mergedVariants).toBeGreaterThan(0);
    const iris = r.main.candidates.find((c) => c.manufacturer === 'Fruity Chutes'
      && Math.abs(c.diameter - 72 * 0.0254) < 1e-6);
    if (iris) expect(iris.variants).toBeGreaterThan(1);
  });

  it('never lists the same part twice', () => {
    const r = wide();
    for (const advice of [r.main, r.drogue]) {
      const keys = advice.candidates.map((c) => `${c.manufacturer}|${c.partNo}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('every listed candidate really is inside its band', () => {
    const r = wide();
    for (const advice of [r.main, r.drogue]) {
      for (const c of advice.candidates) {
        expect(c.rate).toBeGreaterThanOrEqual(advice.band.min - 1e-9);
        expect(c.rate).toBeLessThanOrEqual(advice.band.max + 1e-9);
      }
    }
  });
});

describe('classifyRecoveryDevices', () => {
  it('calls a lone apogee chute the MAIN — it is what lands the rocket', () => {
    const t = tube(0.3, [{ diameter: 0.9, cd: 1.5, deployEvent: 'apogee' }]);
    const { main, drogue } = classifyRecoveryDevices(t);
    expect(main?.id).toBe('p0');
    expect(drogue).toBeNull();
  });

  it('reads dual deploy from the altitude trigger, not from size', () => {
    const t = tube(0.3, [
      { diameter: 0.4, cd: 2.2, deployEvent: 'altitude' },
      { diameter: 0.9, cd: 1.5, deployEvent: 'apogee' },
    ]);
    const { main, drogue } = classifyRecoveryDevices(t);
    // The SMALLER canopy is the main here, because it is the one on the
    // altitude trigger. Sizing by diameter alone would swap the two bands.
    expect(main?.id).toBe('p0');
    expect(drogue?.id).toBe('p1');
  });

  it('falls back to the largest canopy when nothing states a trigger', () => {
    const t = tube(0.3, [{ diameter: 0.4 }, { diameter: 0.9 }]);
    const { main, drogue } = classifyRecoveryDevices(t);
    expect(main?.id).toBe('p1');
    expect(drogue?.id).toBe('p0');
  });

  it('ignores streamers — their Cd is referenced to strip area, not a diameter', () => {
    const t: RocketTree = {
      name: 's', components: [{
        type: 'stage', id: 's', children: [
          { type: 'streamer', id: 'st', cd: 0.75 },
        ],
      } as unknown as ComponentNode],
    };
    expect(classifyRecoveryDevices(t)).toEqual({ main: null, drogue: null });
  });
});

describe('the Cd the size line is quoted at — never a bare diameter', () => {
  it('uses this slot’s own chute', () => {
    const t = tube(0.3, [
      { diameter: 0.4, cd: 2.2, deployEvent: 'altitude' },
      { diameter: 0.9, cd: 1.4, deployEvent: 'apogee' },
    ]);
    const r = ok(sizing({ tree: t }));
    expect(r.main.cd).toBe(2.2);
    expect(r.main.cdSource).toBe('this device');
    expect(r.drogue.cd).toBe(1.4);
  });

  it('borrows the design’s other chute when the slot is empty', () => {
    const t = tube(0.3, [{ diameter: 0.9, cd: 2.2, deployEvent: 'apogee' }]);
    const r = ok(sizing({ tree: t }));
    expect(r.drogue.cd).toBe(2.2);
    expect(r.drogue.cdSource).toBe('the design’s other chute');
  });

  it('falls back to the kernel’s own 0.8, and says so', () => {
    const r = ok(sizing({ tree: tube(0.3) }));
    expect(r.main.cd).toBe(DEFAULT_CANOPY_CD);
    expect(r.main.cd).toBe(0.8);
    expect(r.main.cdSource).toBe('default');
    // …which is the 107 in main of the owner's worked example.
    expect(Math.round(r.main.diameter * IN)).toBe(107);
  });
});

describe('site elevation reaches the answer', () => {
  it('names a smaller canopy at sea level than at 5,000 ft', () => {
    const sea = ok(sizing({ tree: tube(0.3) }));
    const denver = ok(sizing({
      tree: tube(0.3),
      launch: { launchAltitudeM: 1524, temperatureC: null, pressureHPa: null },
    }));
    expect(denver.main.diameter).toBeGreaterThan(sea.main.diameter);
    expect(denver.main.diameter / sea.main.diameter).toBeCloseTo(1.0773, 3);
    expect(denver.siteRateFactor).toBeCloseTo(1.0773, 4);
    expect(sea.siteRateFactor).toBeCloseTo(1, 6);
  });

  it('thins the field of catalogue mains that still make the band', () => {
    const sea = ok(sizing({ tree: tube(10) }));
    const denver = ok(sizing({
      tree: tube(10),
      launch: { launchAltitudeM: 1524, temperatureC: null, pressureHPa: null },
    }));
    expect(denver.main.inBand).toBeLessThan(sea.main.inBand);
  });
});

/**
 * The SIZE line owes the spill hole the same debt canopyCdA does
 * (services-rest-3, 2026-09-04).
 *
 * `diameterForRate` has no vent term, so feeding it a manufacturer's Cd — which
 * is referenced to the canopy area MINUS the vent — quoted the headline against
 * the full nominal disc while the candidate list directly beneath it applied
 * 1 − (d/D)². Two conventions in one panel, and the headline was the optimistic
 * one: the number a user sews fabric to came out small.
 */
describe('the size line carries the design chute’s spill hole', () => {
  const inches = (m: number) => m * IN;
  /** The owner's case: 8.786 kg, Cd 2.2, sea level, the 18 ft/s main target. */
  const wildman = (over: Partial<ComponentNode>) =>
    ok(sizing({ tree: tube(0.3, [{ diameter: 1.0, cd: 2.2, deployEvent: 'altitude', ...over }]) }));

  it('is unchanged for an UNVENTED canopy — the fix costs the plain case nothing', () => {
    const r = wildman({});
    expect(r.main.ventFactor).toBe(1);
    expect(r.main.cd).toBe(2.2);
    expect(r.main.cdNominal).toBe(2.2);
    expect(inches(r.main.diameter)).toBeCloseTo(64.748, 3);
  });

  it('grows the main from 64.75 in to 65.78 in at the catalogue’s median 17.6 % vent', () => {
    const r = wildman({ spillHoleDiameter: 0.176 });
    expect(r.main.cdNominal).toBe(2.2);
    expect(r.main.ventFactor).toBeCloseTo(1 - 0.176 ** 2, 12);
    expect(r.main.cd).toBeCloseTo(2.2 * (1 - 0.176 ** 2), 12);
    expect(inches(r.main.diameter)).toBeCloseTo(65.775, 3);
  });

  it('grows it to 66.08 in at the catalogue’s worst 20 % vent', () => {
    const r = wildman({ spillHoleDiameter: 0.20 });
    expect(r.main.ventFactor).toBeCloseTo(0.96, 9);
    expect(inches(r.main.diameter)).toBeCloseTo(66.083, 3);
  });

  it('round-trips: the size it names really does descend at the target rate', () => {
    // The old size line did not. A 64.748 in canopy built with the same 17.6 %
    // vent its Cd was measured against lands at 18.29 ft/s, not 18.
    const D = wildman({ spillHoleDiameter: 0.176 }).main.diameter;
    const cdA = 2.2 * (1 - 0.176 ** 2) * Math.PI * D * D / 4;
    expect(descentRate(WILDMAN_KG, cdA, SEA_LEVEL_DENSITY)).toBeCloseTo(MAIN_BAND.target, 9);

    const old = diameterForRate(WILDMAN_KG, 2.2, SEA_LEVEL_DENSITY, MAIN_BAND.target);
    const oldCdA = 2.2 * (1 - 0.176 ** 2) * Math.PI * old * old / 4;
    expect(fps(descentRate(WILDMAN_KG, oldCdA, SEA_LEVEL_DENSITY))).toBeCloseTo(18.285, 3);
  });

  it('agrees with the candidate list — one convention, not two', () => {
    // A catalogue row whose Cd and vent are exactly the ones the chute states:
    // the size line's diameter and canopyCdA's must produce the same rate.
    const r = wildman({ spillHoleDiameter: 0.176 });
    const asRow = {
      kind: 'Parachute', manufacturer: 'X', partNo: 'Y', description: '',
      diameter: r.main.diameter, dragCoefficient: 2.2,
      spillHoleDiameter: 0.176 * (r.main.diameter / 1.0),
    } as unknown as Preset;
    expect(descentRate(WILDMAN_KG, canopyCdA(asRow)!, SEA_LEVEL_DENSITY))
      .toBeCloseTo(MAIN_BAND.target, 9);
  });

  it('takes the vent from the SAME chute the Cd came from, borrowed or not', () => {
    // One chute in the design: the drogue slot borrows the main's Cd, and must
    // borrow the main's hole with it rather than quoting a bare 2.2.
    const r = wildman({ spillHoleDiameter: 0.176 });
    expect(r.drogue.cdSource).toBe('the design’s other chute');
    expect(r.drogue.cdNominal).toBe(2.2);
    expect(r.drogue.ventFactor).toBeCloseTo(1 - 0.176 ** 2, 12);
  });

  it('leaves the kernel’s 0.8 default unvented — it is not a maker’s figure', () => {
    const r = ok(sizing({ tree: tube(0.3) }));
    expect(r.main.cdSource).toBe('default');
    expect(r.main.ventFactor).toBe(1);
    expect(r.main.cd).toBe(DEFAULT_CANOPY_CD);
    expect(Math.round(inches(r.main.diameter))).toBe(107);
  });

  it('clamps a vent wider than the canopy exactly as engineTree does', () => {
    // min(hole, 0.95 D): the same guard, so a nonsense entry cannot make the
    // size line and the flown coefficient disagree.
    const r = wildman({ spillHoleDiameter: 5 });
    expect(r.main.ventFactor).toBeCloseTo(1 - 0.95 ** 2, 12);
    expect(Number.isFinite(r.main.diameter)).toBe(true);
  });

  it('ignores a vent on a canopy with no diameter rather than dividing by zero', () => {
    const r = ok(sizing({
      tree: tube(0.3, [{ cd: 2.2, spillHoleDiameter: 0.1, deployEvent: 'altitude' }]),
    }));
    expect(r.main.ventFactor).toBe(1);
    expect(Number.isFinite(r.main.diameter)).toBe(true);
  });
});
