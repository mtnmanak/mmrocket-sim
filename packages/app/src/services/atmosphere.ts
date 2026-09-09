import { G0, ISA_SEA_LEVEL } from '@online-openrocket/engine';

/**
 * THE PAD'S OWN AIR — one definition, shared by the Launch panel's caution and
 * the RASAero import note, so the two can never disagree about what counts as
 * a wrong pad pressure.
 *
 * Why this module exists (2026-09-08). The kernel takes the launch-site
 * temperature and pressure as a PAIR: `OrkEngine.simulateJson` (ll. 919-926)
 * builds `ExtendedISAModel(launchAltitude, T, p)` as soon as EITHER field is
 * given, and fills the missing one with the STANDARD SEA-LEVEL value — applied
 * at the site altitude, not reduced to it. `ExtendedISAModel(alt, T, p)` writes
 * that value straight into `baseTemperature[1]` / `basePressure[1]` at
 * `layer[1] = alt` (24.12, ll. 108-140), so whatever was substituted is what
 * the pad reads.
 *
 * IT IS A TRAP WITH TWO HALVES, and both are live:
 *
 *  - PRESSURE BLANK, temperature typed: 101,325 Pa at the pad however high the
 *    site. Measured, a 1,190 m pad reads 87,823 Pa with both fields blank and
 *    101,325 Pa with only a temperature typed, and a 2,682 m pad reads
 *    72,990 Pa against 101,325 Pa. The air then comes out ~15 % too dense and
 *    the motor loses the pressure-thrust credit thin air owes it (v0.119's
 *    term), which on the MESOS file was worth 29.7 % of apogee.
 *
 *  - TEMPERATURE BLANK, pressure typed: 288.15 K (15 °C) at the pad however
 *    high the site — NOT the lapsed value. This half was mis-stated in the
 *    v0.120 field help, which promised "the ISA standard 15 °C at sea level,
 *    lapsing with your site altitude" while the same help steered users into
 *    typing a station pressure, which is exactly what switches the lapse off.
 *    Measured: at 1,190 m the pad reads 288.15 K against 280.42 K, density
 *    1.0618 against 1.0910 kg/m³ (2.68 % thin) and the speed of sound 340.3
 *    against 335.7 m/s (1.37 % high); at 2,682 m, 288.15 K against 270.72 K,
 *    density 0.8824 against 0.9393 kg/m³ (6.05 % thin) and the speed of sound
 *    3.17 % high, which moves every Mach number the drag curve is read at.
 *
 * That matters most on imported RASAero files, because RASAero writes a
 * temperature into every file and a pressure into fewer than half: of the 60
 * tester .CDX1 files measured for the user guide, all 60 state a temperature
 * and 25 state a pressure, and 24 of the 33 flown from 1,000 ft or higher
 * state none.
 *
 * `siteAirDensity` in recoverySizing.ts mirrors the same kernel branch and
 * takes its barometric formula and its two constants from here rather than
 * keeping a second copy.
 */

/**
 * Specific gas constant for dry air (J/kg/K) — the kernel's
 * `AtmosphericConditions.R`, and the same constant the shipped kernel divides
 * by (`packages/engine/vendor/orkengine.mjs`, `getPressure() / (287.053 *
 * getTemperature())`). Exported because recoverySizing.ts needs the same one:
 * two constants for one physical quantity is how a number starts disagreeing
 * with itself across screens.
 */
export const R_AIR = 287.053;

/**
 * ISA TROPOSPHERIC lapse rate as a positive number (K/m). Valid to 11 km only
 * — above that the profile turns isothermal and then rises; use
 * `isaTemperatureK` for anything that is not certainly below the tropopause.
 * Exported for recoverySizing.ts, which reads it at launch-site altitudes.
 */
export const LAPSE = -ISA_SEA_LEVEL.lapseRateKPerM;

/** One ISA layer: where it starts, how warm it is there, and how it lapses. */
interface IsaLayer {
  /** Altitude the layer starts at (m). */
  readonly baseM: number;
  /** Temperature at that altitude (K). */
  readonly baseK: number;
  /** dT/dh inside the layer (K/m); 0 in an isothermal one, and in the topmost. */
  readonly lapseKPerM: number;
  /** Pressure at that altitude (Pa) — chained up from sea level once, below. */
  basePa: number;
}

/**
 * Pressure at `h` from a layer's own base — the barometric formula in both its
 * forms, exactly as `ExtendedISAModel.calculatePressure` splits them: the power
 * law inside a lapsing layer, the exponential inside an isothermal one.
 * Dividing by a lapse rate of zero is what the split is there to avoid.
 */
function pressureInLayer(l: IsaLayer, h: number): number {
  if (Math.abs(l.lapseKPerM) < 1e-9) return l.basePa * Math.exp(-G0 * (h - l.baseM) / (R_AIR * l.baseK));
  const t = l.baseK + l.lapseKPerM * (h - l.baseM);
  return l.basePa * Math.pow(t / l.baseK, -G0 / (l.lapseKPerM * R_AIR));
}

/**
 * The ISA layer table — base altitudes (m) and base temperatures (K), copied
 * from the kernel's own `ExtendedISAModel.STANDARD_LAYERS` /
 * `STANDARD_TEMPERATURES` (24.12, ll. 53-59) so that what this module calls a
 * standard day and what the kernel flies with both launch fields blank are one
 * profile, not two.
 *
 * Layer 0's temperature and pressure come from `ISA_SEA_LEVEL` rather than
 * being retyped, so the engine package stays the single source for them; every
 * base pressure above it is chained up from there with the same formula the
 * lookup uses, so the table cannot disagree with itself.
 */
const ISA_LAYERS: readonly IsaLayer[] = (() => {
  const baseM = [0, 11000, 20000, 32000, 47000, 51000, 71000, 84852];
  const baseK = [ISA_SEA_LEVEL.temperatureK, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 186.95];
  const out: IsaLayer[] = baseM.map((h0, i) => {
    const t0 = baseK[i]!; // the two literals above are the same length by construction
    const nextM = baseM[i + 1];
    const nextK = baseK[i + 1];
    return {
      baseM: h0,
      baseK: t0,
      // The topmost layer has nothing above it to lapse toward, so it is
      // isothermal — which is also how the kernel treats it, by clamping.
      lapseKPerM: nextM === undefined || nextK === undefined ? 0 : (nextK - t0) / (nextM - h0),
      basePa: ISA_SEA_LEVEL.pressurePa,
    };
  });
  for (let i = 1; i < out.length; i++) {
    const below = out[i - 1]!;
    out[i]!.basePa = pressureInLayer(below, out[i]!.baseM);
  }
  return out;
})();

/** Top of the modelled profile (m). Above it the model is clamped, as the kernel clamps. */
export const ISA_TOP_M = ISA_LAYERS[ISA_LAYERS.length - 1]!.baseM;

/**
 * The layer an altitude sits in — clamped into the profile at both ends, so
 * this is total: a non-finite altitude reads as sea level, anything above the
 * table reads as its top.
 */
function layerAt(altitudeM: number): { layer: IsaLayer; h: number } {
  const h = Number.isFinite(altitudeM) ? Math.min(Math.max(0, altitudeM), ISA_TOP_M) : 0;
  let i = 0;
  while (i < ISA_LAYERS.length - 1 && ISA_LAYERS[i + 1]!.baseM <= h) i++;
  return { layer: ISA_LAYERS[i]!, h };
}

/**
 * Standard (ISA) temperature at an altitude, in kelvin.
 *
 * The half of a standard day the pad-temperature caution quotes: what the pad
 * WOULD read with both launch fields blank, against the flat 288.15 K the
 * kernel substitutes when only the pressure is typed.
 */
export function isaTemperatureK(altitudeM: number): number {
  const { layer, h } = layerAt(altitudeM);
  return layer.baseK + layer.lapseKPerM * (h - layer.baseM);
}

/**
 * Standard (ISA) station pressure at a site altitude, in pascals — what a
 * barometer standing at that altitude reads on a standard day.
 *
 * LAYERED, not a single power law (2026-09-08, from review). It used to apply
 * the tropospheric formula at any altitude with only a lower clamp, which is
 * wrong the moment the profile stops lapsing and NaN once the extrapolated
 * temperature goes negative — `T = 288.15 − 0.0065 h` reaches 0 K at 44,331 m,
 * and `Math.pow` of a negative base to a fractional exponent is NaN. That was
 * reachable: the RASAero importer feeds `<Altitude>` straight through with no
 * clamp (rasaeroFile.ts:787) and the Site altitude field's 0-10,000 m `max`
 * only rejects TYPED text, so a .CDX1 stating 150,000 ft made the import note
 * read "about NaN mbar (NaN in-Hg) there on a standard day". Measured against
 * the published ISA, the old formula quoted 61.87 mbar at 60,000 ft where the
 * truth is 71.72 (−13.7 %) and 2.24 mbar at 100,000 ft where the truth is
 * 10.90 (−79 %).
 *
 * Fixed by MODELLING the real profile rather than refusing to quote outside
 * the troposphere: this function is now total — finite for every input,
 * including NaN and altitudes past the top of the table — so no caller can
 * render a NaN, including the two (rasaeroFile.ts, recoverySizing.ts) that
 * never guarded one. Refusing instead would have needed a new "no figure
 * available" branch at all three call sites for a case none of them wants.
 *
 * Reproduces the published ISA layer base pressures exactly: 22,632.06 Pa at
 * 11 km, 5,474.89 at 20 km, 868.02 at 32 km, 110.91 at 47 km. The kernel
 * interpolates the same profile on a 500 m grid, which differs by at most
 * 0.06 % over the site-altitude field's 0-10,000 m range.
 */
export function isaPressurePa(altitudeM: number): number {
  const { layer, h } = layerAt(altitudeM);
  return pressureInLayer(layer, h);
}

/**
 * The site altitude above which a wrong pad pressure is worth saying out loud.
 *
 * 600 m is the owner's call (2026-09-08). It is where the standard station
 * pressure has fallen to 94,322 Pa — 6.9 % below sea level, so ~7 % on air
 * density — which is the point at which "the app is flying sea-level air at
 * your pad" stops being a rounding error. Below it the note would fire on the
 * majority of files for a difference nobody could read in a result.
 *
 * The temperature half of the pair uses the SAME gate, deliberately, even
 * though it bites more slowly (1.35 % on density at 600 m against 7.4 %, and
 * 6.05 % only by 2,682 m). Two reasons: it is the same mistake — one of a pair
 * left blank — so one threshold keeps the panel's story straight; and the
 * app's own Station pressure help now tells people to type a pressure, so the
 * gate has to catch everyone the app steered. The caution quotes both
 * temperatures, which is what lets a reader at 700 m judge the size for
 * themselves.
 */
export const PAD_PRESSURE_SITE_M = 600;

/**
 * How far above the site's OWN standard pressure a stated reading may sit
 * before it is an altimeter setting rather than a barometer reading.
 *
 * 5 %. Station pressure moves with the weather, so the test has to clear real
 * weather by a margin: at the 600 m threshold, ISA is 943.2 mbar and +5 % is
 * 990.4 mbar, which is a sea-level-equivalent of about 1,064 mbar — higher
 * than anything ever recorded outside a Siberian winter (the world record is
 * 1,084.8 mbar, Agata 1968). Nothing a real barometer reads at a real launch
 * site reaches it, so a reading that does was reduced to sea level before it
 * was typed. One-sided on purpose: a LOW reading is what a genuine high site
 * or a deep low actually looks like.
 */
export const PAD_PRESSURE_SEA_LEVEL_MARGIN = 0.05;

/**
 * What is wrong with this site's pad air, if anything.
 *
 * NARROWED 2026-09-08b to the ONE case that is still a mistake.
 *
 * Through v0.120 this reported three, and two of them — a blank pressure beside
 * a typed temperature, and its mirror — were warnings about the APP's own
 * behaviour rather than about the user's input. `kernelSimOptions` now fills a
 * blank field from the site altitude independently, so neither is wrong any
 * more and neither has anything to caution about: blank is correct input and
 * always was, which is exactly what Eric said when he asked why the app used
 * sea level for a field the user had left for it to work out.
 *
 * - `'sea-level'` — a pressure IS given, but it is more than
 *   `PAD_PRESSURE_SEA_LEVEL_MARGIN` above what that altitude can read: an
 *   altimeter setting typed into a station-pressure field. This one survives
 *   because it is a real error in a value the user chose to type, and no
 *   default can rescue it — the app cannot tell whether a number it was handed
 *   is the right kind of number without checking it against the site.
 * - `null` — nothing to say: a low site, a blank field (the app computes it), or
 *   a plausible reading.
 */
export type PadPressureIssue = 'sea-level';

/**
 * Structural, not `Partial<LaunchConditions>`: LaunchPanel imports this module
 * for its live caution, and taking the type from there would close a cycle
 * between them for no gain. Every caller's shape satisfies this one.
 */
export interface PadConditions {
  launchAltitudeM?: number | null;
  temperatureC?: number | null;
  pressureHPa?: number | null;
}

export function padPressureIssue(launch: PadConditions): PadPressureIssue | null {
  const h = launch.launchAltitudeM;
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= PAD_PRESSURE_SITE_M) return null;
  const p = launch.pressureHPa;
  // A blank field is CORRECT input and says nothing: kernelSimOptions fills it
  // from the site altitude, independently of whether a temperature is typed
  // beside it. Only a value the user actually typed can be wrong here.
  if (p == null || !Number.isFinite(p)) return null;
  if (p * 100 > isaPressurePa(h) * (1 + PAD_PRESSURE_SEA_LEVEL_MARGIN)) return 'sea-level';
  return null;
}
