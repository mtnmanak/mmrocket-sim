import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { G0, ISA_SEA_LEVEL } from '@online-openrocket/engine';
// The ONE manufacturer alias table, shared with the preset pipeline, so two
// spellings of one company cannot each claim a slot in a list whose whole job
// is to be spread ACROSS companies.
import { mfrKey } from '../../scripts/manufacturers.mjs';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { findParent } from '../tree/treeModel.js';
import type { Preset } from './presets.js';
import type { RecoveryMass } from './recoveryMass.js';
import { SAFETY } from './simReport.js';

/**
 * RECOVERY SIZING — the answer, not the arithmetic.
 *
 * `recoveryMass.ts` works out WHAT comes down; this works out what to hang it
 * under. The owner's ruling (2026-09-04) is that both halves get said, in this
 * order:
 *
 *   1. the SIZE — "you need about 65 inches at Cd 2.2" — which is the answer
 *      for someone sewing their own canopy or shopping outside the catalogue,
 *      and is meaningless without the Cd it was computed at, so the Cd is
 *      always named; and
 *   2. real CATALOGUE PARTS that hit it, each with the descent rate it would
 *      actually give this rocket.
 *
 * Bands, also his (all quoted in ft/s, stored here in SI):
 *
 *   main    15-20 ft/s      drogue   50-75 ft/s
 *
 * Everything below is `sqrt`-law arithmetic on one equation,
 *
 *   v = sqrt( 2 m g / (rho . Cd . A) ),   A = pi D^2 / 4
 *
 * so the three inputs that decide whether the answer is right are m (which
 * `recoveryMass` owns), rho (which the launch SITE owns, not sea level) and
 * the effective Cd.A (which the spill hole owns). Each is handled below and
 * each is a place this feature could quietly be wrong by several percent.
 */

/** Feet per second in m/s. The bands are stated in ft/s; the code is SI. */
const FT_S = 0.3048;

/**
 * Specific gas constant of dry air, J/(kg.K) — `AtmosphericConditions.R` in
 * OpenRocket 24.12, and the same constant the shipped kernel divides by
 * (`packages/engine/vendor/orkengine.mjs:39464`,
 * `getPressure() / (287.053 * getTemperature())`). Not 287.05: a 0.001 %
 * difference is nothing, but two constants for one physical quantity is how a
 * number starts disagreeing with itself across screens.
 */
const R_AIR = 287.053;

/** ISA troposphere lapse rate as a POSITIVE K/m (the engine states it signed). */
const LAPSE = -ISA_SEA_LEVEL.lapseRateKPerM;

/**
 * A recovery band: the accepted descent-rate window, plus the single rate the
 * SIZE line is computed at.
 *
 * The targets are not the arithmetic midpoints, and both have a reason:
 *
 *  - MAIN 18 ft/s sits toward the FAST end of 15-20, because every ft/s slower
 *    is bought with canopy: at Cd 2.2 and 8.786 kg, 15 ft/s asks for 78 in
 *    where 18 ft/s asks for 65 in — a canopy a third larger in area, heavier,
 *    and drifting proportionally further downwind. It is still clear of
 *    `SAFETY.maxLandingRate`, which is the rate the flight report checks.
 *  - DROGUE 60 ft/s is the middle of 50-70, NOT of 50-75. 70 ft/s is
 *    `SAFETY.maxDrogueDescentRate`, the rate above which this app's own launch
 *    report writes "faster than the accepted 70 ft/s drogue band"
 *    (simReport.ts:1237). Sizing at the raw 62.5 ft/s midpoint would put the
 *    app's recommendation within 8 ft/s of the app's own complaint; sizing at
 *    60 cannot.
 */
export interface Band {
  /** Slow edge of the accepted window (m/s). */
  min: number;
  /** Fast edge of the accepted window (m/s). */
  max: number;
  /** The rate the SIZE line is computed at (m/s). */
  target: number;
  /**
   * Rate above which the app's own flight report complains (m/s), or null when
   * the band's own `max` is already that rate. Candidates above it are ordered
   * last and MARKED — never silently dropped and never silently recommended.
   */
  warnAbove: number | null;
}

/**
 * Main: 15-20 ft/s. The fast edge is `SAFETY.maxLandingRate` itself rather
 * than a fresh `20 * FT_S` literal — the constant is 6.1 m/s against 6.096,
 * 4 mm/s apart, and one definition of "too fast to land" is worth more than
 * that rounding: what this panel offers and what the launch report complains
 * about are then the same threshold, on the same rocket.
 *
 * It is not free, and the row it costs is named so nobody has to rediscover
 * it. On the owner's 8.786 kg at sea level the sliver admits exactly ONE
 * canopy: Fruity Chutes CFC-072-N, 6.09833 m/s — 20.008 ft/s. That is the
 * difference between the 33 mains he counted at a literal 20 ft/s and the 34
 * this code finds. Admitting it is the point rather than the price: the app's
 * own report would not complain about a rocket landing at 6.098 m/s either.
 */
export const MAIN_BAND: Band = {
  min: 15 * FT_S,
  max: SAFETY.maxLandingRate,
  target: 18 * FT_S,
  warnAbove: null,
};

/** Drogue: 50-75 ft/s, with the app's own 70 ft/s complaint threshold marked. */
export const DROGUE_BAND: Band = {
  min: 50 * FT_S,
  max: 75 * FT_S,
  target: 60 * FT_S,
  warnAbove: SAFETY.maxDrogueDescentRate,
};

/** The Cd the kernel gives a canopy that states none — `treeModel.ts:968`. */
export const DEFAULT_CANOPY_CD = 0.8;

/** How many candidates a band lists, and how many one manufacturer may own. */
const LIST_LIMIT = 5;
const PER_MANUFACTURER_LIMIT = 2;

// ---------------------------------------------------------------- atmosphere

/**
 * Air density at the LAUNCH SITE (kg/m^3).
 *
 * Descent happens at the field, not at sea level, and the error is not small:
 * rho falls 13.8 % by 5,000 ft (1.2250 -> 1.0555 kg/m^3), and v goes as
 * 1/sqrt(rho), so the same canopy lands 7.7 % faster there. A main sized at
 * sea level for 18 ft/s touches down at 19.4 ft/s in Colorado — still inside
 * the band, but a 20 ft/s sea-level choice is outside it, and the app would
 * have said it was fine.
 *
 * This mirrors what the flight actually flies, branch for branch, from
 * `engine-java/src/api/java/api/OrkEngine.java:919-926`: a launch-site
 * temperature OR pressure switches the kernel to
 * `ExtendedISAModel(launchAltitude, T, p)`, whose values AT that altitude are
 * exactly the given ones — and whose fallback for the field left blank is the
 * STANDARD SEA-LEVEL value applied at the site (that is the kernel's quirk,
 * not ours; matching it is the point). With both blank it is plain ISA at the
 * site altitude.
 *
 * The kernel then interpolates its atmosphere on a 500 m grid
 * (`InterpolatingAtmosphericModel.DELTA`); we evaluate ISA analytically. The
 * two differ by at most 0.059 % in density anywhere in the site-altitude
 * field's 0-10,000 m range (measured, worst case at 9,754 m, mid-cell), which
 * is 0.029 % on a descent rate — far below the spread between two
 * manufacturers' published Cd for the same canopy shape.
 */
export function siteAirDensity(
  launch: Pick<LaunchConditions, 'launchAltitudeM' | 'temperatureC' | 'pressureHPa'>,
): number {
  const h = Number.isFinite(launch.launchAltitudeM) ? Math.max(0, launch.launchAltitudeM) : 0;
  const hasT = launch.temperatureC != null && Number.isFinite(launch.temperatureC);
  const hasP = launch.pressureHPa != null && Number.isFinite(launch.pressureHPa);

  let tempK: number;
  let pressPa: number;
  if (hasT || hasP) {
    tempK = hasT ? launch.temperatureC! + 273.15 : ISA_SEA_LEVEL.temperatureK;
    pressPa = hasP ? launch.pressureHPa! * 100 : ISA_SEA_LEVEL.pressurePa;
  } else {
    tempK = ISA_SEA_LEVEL.temperatureK - LAPSE * h;
    // p = p0 . (T/T0)^(g / (L.R)) — the barometric formula, rearranged from
    // ExtendedISAModel.calculatePressure (24.12, ll. 191-200), whose
    // `1 + (alt2-alt1).tempRate/temp1` collapses to T0/T for a lapse layer.
    pressPa = ISA_SEA_LEVEL.pressurePa
      * Math.pow(tempK / ISA_SEA_LEVEL.temperatureK, G0 / (LAPSE * R_AIR));
  }
  if (!(tempK > 0) || !(pressPa > 0)) return ISA_SEA_LEVEL.pressurePa / (R_AIR * ISA_SEA_LEVEL.temperatureK);
  return pressPa / (R_AIR * tempK);
}

/** ISA sea-level density (kg/m^3), 1.225 — the figure the elevation clause compares against. */
export const SEA_LEVEL_DENSITY = ISA_SEA_LEVEL.pressurePa / (R_AIR * ISA_SEA_LEVEL.temperatureK);

// ------------------------------------------------------------------- physics

/**
 * Effective drag area Cd.A of a catalogue canopy (m^2).
 *
 * THE SPILL HOLE IS NOT OPTIONAL. A manufacturer's Cd is referenced to the
 * canopy area MINUS the vent; ours is referenced to the nominal diameter and
 * scaled by 1 - (d/D)^2, which is algebraically the same area. Taking the Cd
 * and dropping the hole reads ~2 % optimistic on every vented canopy — 68 of
 * the 256 usable rows — and the app would be recommending a canopy on numbers
 * its own simulation would not reproduce. Standing ruling, 2026-09-03.
 *
 * This is the SAME arithmetic as `presets.ts:presetPatch` (which writes both
 * fields onto the node) followed by `treeModel.ts:engineTree` (which folds the
 * hole into the flown Cd), including engineTree's `min(hole, 0.95 D)` clamp —
 * so a candidate's predicted rate here and the rate the same part gives after
 * you apply it in the picker and press Launch are one number, not two.
 *
 * Returns null for a row with no usable Cd: 217 of the 473 catalogue
 * parachutes carry none, and a canopy sized on the kernel's 0.8 default when
 * the real part is a Cd 2.2 elliptical would be recommended 1.66x too small.
 */
export function canopyCdA(p: Preset): number | null {
  const d = typeof p['diameter'] === 'number' ? (p['diameter'] as number) : NaN;
  const cd = typeof p['dragCoefficient'] === 'number' ? (p['dragCoefficient'] as number) : NaN;
  if (!(d > 0) || !(cd > 0)) return null;
  const rawHole = typeof p['spillHoleDiameter'] === 'number' ? (p['spillHoleDiameter'] as number) : 0;
  const hole = Math.min(Math.max(0, Number.isFinite(rawHole) ? rawHole : 0), d * 0.95);
  return cd * (1 - (hole / d) ** 2) * Math.PI * d * d / 4;
}

/** Terminal descent rate (m/s) for a mass under a given Cd.A at a given density. */
export function descentRate(massKg: number, cdA: number, rho: number): number {
  if (!(massKg > 0) || !(cdA > 0) || !(rho > 0)) return NaN;
  return Math.sqrt((2 * massKg * G0) / (rho * cdA));
}

/**
 * The canopy diameter (m) that descends at `rate` — the SIZE line.
 *
 * `G0` rather than the kernel's WGS84 latitude-dependent gravity: at the
 * default 28.61 deg launch latitude WGS84 gives 9.7893 m/s^2, 0.18 % below
 * standard, which is 0.09 % on a rate and 0.09 % on a diameter — 0.06 in on a
 * 65 in main. Using standard g keeps the size line reproducible by hand, which
 * is what a number someone cuts fabric to has to be.
 */
export function diameterForRate(massKg: number, cd: number, rho: number, rate: number): number {
  if (!(massKg > 0) || !(cd > 0) || !(rho > 0) || !(rate > 0)) return NaN;
  return Math.sqrt((8 * massKg * G0) / (Math.PI * rho * cd * rate * rate));
}

// ------------------------------------------------------- the design's chutes

/** Which slot a recovery device fills. */
export type DeviceRole = 'main' | 'drogue';

/**
 * The design's current parachutes, split into the slot each one fills.
 *
 * The rule, in order:
 *  - the device that deploys at ALTITUDE (descending) is the main — that is
 *    what dual-deploy means, and it is the only unambiguous signal in the tree;
 *  - with none set that way, the LARGEST canopy is the main, because in a
 *    single-deploy rocket the apogee chute IS the landing device and calling it
 *    a drogue would size the whole rocket against the wrong band;
 *  - the largest of what remains is the drogue.
 *
 * Streamers are deliberately not classified. A streamer's published Cd is
 * referenced to strip area, not to a diameter, so it cannot be substituted for
 * a canopy in the one-exact-substitution arithmetic below without silently
 * mixing two reference areas.
 */
export function classifyRecoveryDevices(
  tree: RocketTree,
): { main: ComponentNode | null; drogue: ComponentNode | null } {
  const chutes: ComponentNode[] = [];
  const walk = (ns: readonly ComponentNode[] | undefined): void => {
    for (const n of ns ?? []) {
      if (n.type === 'parachute') chutes.push(n);
      walk(n.children);
    }
  };
  walk(tree.components);
  if (chutes.length === 0) return { main: null, drogue: null };

  const dia = (n: ComponentNode): number =>
    typeof n['diameter'] === 'number' ? (n['diameter'] as number) : 0;
  const biggest = (list: ComponentNode[]): ComponentNode | null =>
    list.reduce<ComponentNode | null>((best, n) => (best === null || dia(n) > dia(best) ? n : best), null);

  const atAltitude = chutes.filter((n) => n['deployEvent'] === 'altitude');
  const main = biggest(atAltitude.length > 0 ? atAltitude : chutes);
  const drogue = biggest(chutes.filter((n) => n !== main));
  return { main, drogue };
}

/**
 * The inner diameter (m) a recovery device has to pack into, or null when the
 * design has no tube at all.
 *
 * `mountBore` is reused rather than re-derived: it is the app's ONE reading of
 * "outer radius less wall, doubled", it already carries the 0.5 mm default the
 * kernel applies to a tube stating no thickness, and it already handles the
 * `caseAirframe` case where the outer radius IS the bore. Writing
 * `(or - t) * 2` again here is how the fit filter would start disagreeing with
 * the motor-mount readout about what a tube's inside is
 * (`scaleRocket.ts:248-258`).
 *
 * The device's OWN parent tube wins when there is one, because that is the bay
 * the canopy actually rides in. With no device the widest body tube in the
 * design is the honest upper bound: nothing wider exists to pack into.
 */
export function recoveryBayBore(tree: RocketTree, device: ComponentNode | null): number | null {
  const TUBES = new Set(['bodytube', 'tubecoupler', 'innertube']);
  if (device?.id) {
    const parent = findParent(tree, device.id);
    if (parent && parent !== 'stage' && TUBES.has(parent.type)) {
      const bore = mountBore(parent);
      if (bore > 0) return bore;
    }
  }
  let widest = 0;
  const walk = (ns: readonly ComponentNode[] | undefined): void => {
    for (const n of ns ?? []) {
      if (n.type === 'bodytube') widest = Math.max(widest, mountBore(n));
      walk(n.children);
    }
  };
  walk(tree.components);
  return widest > 0 ? widest : null;
}

// -------------------------------------------------------------------- result

/** One catalogue canopy offered for a band. */
export interface Candidate {
  manufacturer: string;
  partNo: string;
  description: string;
  /** Nominal canopy diameter (m). */
  diameter: number;
  /** Manufacturer's rated Cd, referenced to the vented area. */
  cd: number;
  /** Vent diameter (m); 0 for an unvented canopy. */
  spillHoleDiameter: number;
  /** Published canopy mass (kg), or null when the row states none. */
  mass: number | null;
  packedDiameter: number | null;
  packedLength: number | null;
  /** Descent rate this rocket would have under it (m/s) — see the substitution note. */
  rate: number;
  /**
   * 'fits' — its published packed diameter clears the bay;
   * 'unverified' — the row publishes no packed size, or the design has no tube
   * to measure against. Never a reason to drop a canopy silently.
   */
  fit: 'fits' | 'unverified';
  /** Above the app's own flight-report threshold for this band (drogues only). */
  flagged: boolean;
  /**
   * How many catalogue rows this line stands for — the same canopy in a
   * different fabric weight. 1 means it is the only row of its family.
   */
  variants: number;
}

/** One band's answer. */
export interface BandAdvice {
  role: DeviceRole;
  band: Band;
  /** Diameter (m) that hits `band.target` at `cd`. THE size line. */
  diameter: number;
  /**
   * The Cd the size line was computed at — never omitted from the copy, and
   * VENT-CORRECTED: it is `cdNominal * ventFactor`, so the diameter beside it
   * is reproducible from it by hand.
   */
  cd: number;
  /** The rated Cd before the vent — what the chute's own field says. */
  cdNominal: number;
  /**
   * 1 − (d/D)² of the chute the Cd came from; 1 when it has no spill hole.
   * The UI needs it to say WHICH convention the size line quoted.
   */
  ventFactor: number;
  /** Where that Cd came from, so the UI can say whose number it is. */
  cdSource: 'this device' | 'the design’s other chute' | 'default';
  /** Mass the size line was computed against (kg). */
  massKg: number;
  candidates: Candidate[];
  /** Catalogue canopies whose rate falls inside the band, before any filtering. */
  inBand: number;
  /** Of those, how many were dropped because their packed size will not fit. */
  excludedForFit: number;
  /** Of those, how many were folded into another line as the same canopy. */
  mergedVariants: number;
}

export type RecoverySizing =
  | { state: 'no-motor' }
  | { state: 'unavailable'; reason: string }
  | {
    state: 'ok';
    /** Recovery weight as the design stands (kg) — `recoveryMass`'s number. */
    massKg: number;
    /** Site air density used (kg/m^3). */
    rho: number;
    /** Site elevation used (m). Zero means the clause about it stays off. */
    elevationM: number;
    /** How much faster this site lands the rocket than sea level, as a ratio. */
    siteRateFactor: number;
    /** Bay bore the fit filter used (m), or null when nothing was filtered. */
    boreM: number | null;
    main: BandAdvice;
    drogue: BandAdvice;
  };

export interface RecoverySizingInput {
  /** The answer from `recoveryMass` — reused, never recomputed. */
  recovery: RecoveryMass;
  /** The design tree, for the current chutes and the bay bore. */
  tree: RocketTree;
  /**
   * Per-role mass of the chute already in the design (kg), from the kernel's
   * `componentInfo(id).mass`. Null when unknown, which turns the substitution
   * off for that role rather than guessing.
   */
  deviceMass: (node: ComponentNode) => number | null;
  /** The catalogue. Rows of other kinds are ignored. */
  presets: readonly Preset[];
  /** Launch conditions, for the site density. */
  launch: Pick<LaunchConditions, 'launchAltitudeM' | 'temperatureC' | 'pressureHPa'>;
}

// ------------------------------------------------------------------ the work

/**
 * The product family a catalogue row belongs to: manufacturer, the letters
 * before the first digit of the part number, and the nominal diameter.
 *
 * This is what stops the list being five spellings of one canopy. Fruity
 * Chutes sell the 72 in Iris Ultra as IFC-072-N, IFC-072-S and IFC-72-SUL —
 * one canopy in three fabric weights, identical Cd, rates within 0.2 ft/s of
 * each other — and all three otherwise qualify. Spherachutes' HS-108-CL and
 * HS-108-UL are the same pair of shoes. Keying on the alpha prefix keeps them
 * apart from genuinely different products at the same size: Rocketman's LS-08
 * and PX-08 are both 96 in at Cd 0.97 but are a parabolic and a Pro-X, weigh
 * 138 g and 519 g, and both deserve a line.
 */
function familyKey(p: Preset): string {
  const prefix = String(p.partNo ?? '').toUpperCase().match(/^[^0-9]*/)?.[0] ?? '';
  const mm = Math.round((typeof p['diameter'] === 'number' ? (p['diameter'] as number) : 0) * 1000);
  return `${mfrKey(p.manufacturer)}|${prefix.replace(/[^A-Z]/g, '')}|${mm}`;
}

/** Manufacturer-published mass of a catalogue row (kg), or null. */
function presetMass(p: Preset): number | null {
  return typeof p.mass === 'number' && Number.isFinite(p.mass) && p.mass >= 0 ? p.mass : null;
}

function num(n: ComponentNode | null, key: string): number | null {
  if (!n) return null;
  const v = n[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The vent factor 1 − (d/D)² of a chute already in the design.
 *
 * THE SIZE LINE OWES THE SPILL HOLE THE SAME DEBT `canopyCdA` DOES. The Cd on
 * a chute that came from the catalogue is the maker's, referenced to the canopy
 * area MINUS the vent (`presets.ts` writes `cd` and `spillHoleDiameter`
 * together for exactly that reason), so feeding it to `diameterForRate` — which
 * has no vent term — quotes a diameter against the full nominal disc. On the
 * owner's 8.786 kg at sea level with Cd 2.2 and the 18 ft/s main target that
 * printed "about 64.75 in"; a canopy built to it with the same 17.6–20 % vent
 * the Cd was measured against lands at 18.29–18.37 ft/s, and the diameter that
 * really hits 18 is 65.8–66.1 in. The number a user sews fabric to was 1.0–1.3 in
 * small, and the candidate list directly beneath it — which DOES apply the vent —
 * was on a different convention from the headline.
 *
 * Mirrors `treeModel.ts:engineTree` branch for branch, INCLUDING its
 * `min(hole, 0.95 D)` clamp and its `D > 0` divide guard, so the size line, the
 * candidate rates and the flight are one convention rather than three.
 */
function ventFactor(n: ComponentNode | null): number {
  const D = num(n, 'diameter');
  const dh = num(n, 'spillHoleDiameter');
  if (D === null || !(D > 0) || dh === null || !(dh > 0)) return 1;
  return 1 - (Math.min(dh, D * 0.95) / D) ** 2;
}

/**
 * Build one band's advice.
 *
 * THE SUBSTITUTION (requirement B, and the subtle half of this feature). The
 * chute already in the design is inside `massEmpty`, and therefore inside the
 * recovery weight. Swapping it for a different canopy changes the very weight
 * being sized against, so each candidate is weighed as
 *
 *     recoveryMass - (the chute in that slot now) + (this candidate)
 *
 * This is ONE EXACT SUBSTITUTION, not an iteration: the two masses are known
 * numbers, so the result is closed-form and converged on the first evaluation.
 * There is nothing to iterate — the candidate's mass does not depend on the
 * rate it produces.
 *
 * It is not a rounding correction either. A Fruity Chutes 96 in Classic
 * Elliptical weighs 851 g; on a 3 kg rocket that is a 28 % mass swing and 13 %
 * on the descent rate. Ignoring it is the difference between a canopy that
 * makes the band and one that misses it.
 *
 * When either mass is unknown the substitution is skipped for that candidate
 * rather than half-applied: subtracting the old canopy without adding the new
 * one understates the rocket, and understating buys a canopy that is too small
 * — the direction that breaks airframes.
 */
function bandAdvice(
  role: DeviceRole,
  band: Band,
  opts: {
    massKg: number;
    rho: number;
    boreM: number | null;
    device: ComponentNode | null;
    otherDevice: ComponentNode | null;
    currentMass: number | null;
    canopies: readonly Preset[];
  },
): BandAdvice {
  const { massKg, rho, boreM, device, otherDevice, currentMass, canopies } = opts;

  // --- the size line -------------------------------------------------------
  // Quoted at the Cd of the chute in THIS slot when there is one (it is the
  // number they are already flying); failing that the design's other chute,
  // which is still their own fabric; failing that the kernel's 0.8. A diameter
  // with no Cd beside it is not an answer, so the source travels with it — and
  // so does that chute's SPILL HOLE, folded into the quoted Cd (see
  // `ventFactor`), because the rated figure is referenced to the vented area.
  const own = num(device, 'cd');
  const other = num(otherDevice, 'cd');
  const cdNominal = own ?? other ?? DEFAULT_CANOPY_CD;
  const cdSource: BandAdvice['cdSource'] = own !== null ? 'this device'
    : other !== null ? 'the design’s other chute'
      : 'default';
  // The vent travels with the Cd it was measured against — from the SAME chute,
  // never a mix of one canopy's coefficient and another's hole. The
  // DEFAULT_CANOPY_CD fallback is deliberately left at 1: the kernel's 0.8 is
  // not a manufacturer's figure and implies no vent.
  const vent = own !== null ? ventFactor(device)
    : other !== null ? ventFactor(otherDevice)
      : 1;
  const cd = cdNominal * vent;
  // The size line uses the recovery weight AS THE DESIGN STANDS. A canopy that
  // has not been chosen has no mass to substitute, so there is nothing honest
  // to swap; the candidate list below is where the substitution belongs.
  const diameter = diameterForRate(massKg, cd, rho, band.target);

  // --- the candidates ------------------------------------------------------
  interface Scored { p: Preset; rate: number; fits: boolean; known: boolean }
  const scored: Scored[] = [];
  for (const p of canopies) {
    const cdA = canopyCdA(p);
    if (cdA === null) continue;
    const cm = presetMass(p);
    const m = cm !== null && currentMass !== null ? massKg - currentMass + cm : massKg;
    if (!(m > 0)) continue;
    const rate = descentRate(m, cdA, rho);
    if (!Number.isFinite(rate) || rate < band.min || rate > band.max) continue;
    const packed = typeof p['packedDiameter'] === 'number' ? (p['packedDiameter'] as number) : null;
    const known = packed !== null && packed > 0 && boreM !== null;
    scored.push({ p, rate, fits: !known || packed! <= boreM! + 1e-9, known });
  }
  const inBand = scored.length;
  const kept = scored.filter((s) => s.fits);
  const excludedForFit = inBand - kept.length;

  // --- collapse the fabric-weight variants of one canopy -------------------
  // The survivor of a family is the row we can VERIFY fits (an unverified row
  // being preferred would make the whole fit filter cosmetic), then the
  // lighter one — lighter packs smaller and, under the substitution above,
  // descends slightly slower, which is the forgiving direction.
  const families = new Map<string, { best: Scored; count: number }>();
  for (const s of kept) {
    const key = familyKey(s.p);
    const prev = families.get(key);
    if (!prev) { families.set(key, { best: s, count: 1 }); continue; }
    prev.count += 1;
    const better = (a: Scored, b: Scored): boolean => {
      if (a.known !== b.known) return a.known;
      return (presetMass(a.p) ?? Infinity) < (presetMass(b.p) ?? Infinity);
    };
    if (better(s, prev.best)) prev.best = s;
  }
  const mergedVariants = kept.length - families.size;

  // --- order, then spread across manufacturers -----------------------------
  // A drogue above SAFETY.maxDrogueDescentRate goes LAST, not away: the owner's
  // band reaches 75 ft/s and the app's launch report complains above 70, and
  // the resolution he can act on is to see both facts on the same line.
  const ranked = [...families.values()].sort((a, b) => {
    const fa = band.warnAbove !== null && a.best.rate > band.warnAbove ? 1 : 0;
    const fb = band.warnAbove !== null && b.best.rate > band.warnAbove ? 1 : 0;
    if (fa !== fb) return fa - fb;
    const da = Math.abs(a.best.rate - band.target);
    const db = Math.abs(b.best.rate - band.target);
    if (Math.abs(da - db) > 1e-9) return da - db;
    return a.best.p.partNo.localeCompare(b.best.p.partNo);
  });

  // Round-robin by manufacturer: every company gets its best line before any
  // company gets a second. Five near-misses from one catalogue is a list that
  // looks like a search result, not a recommendation.
  const byMfr = new Map<string, typeof ranked>();
  for (const r of ranked) {
    const k = mfrKey(r.best.p.manufacturer);
    const list = byMfr.get(k);
    if (list) list.push(r); else byMfr.set(k, [r]);
  }
  const picked: typeof ranked = [];
  for (let round = 0; round < PER_MANUFACTURER_LIMIT && picked.length < LIST_LIMIT; round++) {
    for (const list of byMfr.values()) {
      if (picked.length >= LIST_LIMIT) break;
      const r = list[round];
      if (r) picked.push(r);
    }
  }
  picked.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));

  const candidates: Candidate[] = picked.map(({ best, count }) => ({
    manufacturer: best.p.manufacturer,
    partNo: best.p.partNo,
    description: best.p.description,
    diameter: best.p['diameter'] as number,
    cd: best.p['dragCoefficient'] as number,
    spillHoleDiameter: typeof best.p['spillHoleDiameter'] === 'number'
      ? (best.p['spillHoleDiameter'] as number) : 0,
    mass: presetMass(best.p),
    packedDiameter: typeof best.p['packedDiameter'] === 'number'
      ? (best.p['packedDiameter'] as number) : null,
    packedLength: typeof best.p['packedLength'] === 'number'
      ? (best.p['packedLength'] as number) : null,
    rate: best.rate,
    fit: best.known ? 'fits' : 'unverified',
    flagged: band.warnAbove !== null && best.rate > band.warnAbove,
    variants: count,
  }));

  return {
    role, band, diameter, cd, cdNominal, ventFactor: vent, cdSource, massKg,
    candidates, inBand, excludedForFit, mergedVariants,
  };
}

/**
 * The whole answer for one design.
 *
 * Gated on `recoveryMass`: with no motor loaded there is no recovery weight,
 * so there is no canopy to recommend, and the panel says the same thing the
 * Recovery weight tile says rather than inventing a second vocabulary for the
 * same absence.
 */
export function recoverySizing(input: RecoverySizingInput): RecoverySizing {
  const { recovery, tree, deviceMass, presets, launch } = input;
  if (recovery.state === 'no-motor') return { state: 'no-motor' };
  if (recovery.state === 'unavailable') return { state: 'unavailable', reason: recovery.reason };

  const rho = siteAirDensity(launch);
  if (!(rho > 0)) return { state: 'unavailable', reason: 'the launch conditions give no air density' };

  const { main, drogue } = classifyRecoveryDevices(tree);
  // The bay is the MAIN's tube when there is one — it is the bigger canopy, so
  // it is the binding constraint, and in almost every dual-deploy design both
  // devices ride in the same diameter airframe anyway.
  const boreM = recoveryBayBore(tree, main ?? drogue);

  const canopies = presets.filter((p) => p.kind === 'Parachute');

  return {
    state: 'ok',
    massKg: recovery.mass,
    rho,
    elevationM: Number.isFinite(launch.launchAltitudeM) ? Math.max(0, launch.launchAltitudeM) : 0,
    siteRateFactor: Math.sqrt(SEA_LEVEL_DENSITY / rho),
    boreM,
    main: bandAdvice('main', MAIN_BAND, {
      massKg: recovery.mass, rho, boreM, device: main, otherDevice: drogue,
      currentMass: main ? deviceMass(main) : null, canopies,
    }),
    drogue: bandAdvice('drogue', DROGUE_BAND, {
      massKg: recovery.mass, rho, boreM, device: drogue, otherDevice: main,
      currentMass: drogue ? deviceMass(drogue) : null, canopies,
    }),
  };
}
