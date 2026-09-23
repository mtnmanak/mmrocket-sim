/**
 * Unit system mirroring the desktop's UnitGroup (info.openrocket.core.unit).
 * Quantities are the desktop's unit groups (the ones this UI uses); factors
 * are copied from UnitGroup.java 24.12. Conversion convention matches the
 * desktop: si = (ui + offset) * toSI  (offset is only used by temperature).
 *
 * The engine stays pure SI/radians — these conversions live at the UI edge
 * only (lesson from upstream bug #2475).
 */

export type Quantity =
  | 'length'          // rocket dimensions (UNITS_LENGTH)
  | 'motorDimensions' // motor diameters/lengths (UNITS_MOTOR_DIMENSIONS)
  | 'distance'        // altitudes, apogee (UNITS_DISTANCE)
  | 'mass'            // UNITS_MASS
  | 'velocity'        // UNITS_VELOCITY
  | 'windspeed'       // UNITS_WINDSPEED
  | 'acceleration'    // UNITS_ACCELERATION
  | 'angle'           // UNITS_ANGLE
  | 'density'         // UNITS_DENSITY_BULK
  | 'temperature'     // UNITS_TEMPERATURE
  | 'pressure';       // UNITS_PRESSURE

export interface UnitDef {
  symbol: string;
  /** SI units per 1 of this unit. */
  toSI: number;
  /** Added to the UI value before scaling (temperature only). */
  offset?: number;
}

const VELOCITY_UNITS: UnitDef[] = [
  { symbol: 'm/s', toSI: 1 },
  { symbol: 'km/h', toSI: 1 / 3.6 },
  { symbol: 'ft/s', toSI: 0.3048 },
  { symbol: 'mph', toSI: 0.44704 },
  { symbol: 'kt', toSI: 0.51444445 },
];

export const UNITS: Record<Quantity, UnitDef[]> = {
  length: [
    { symbol: 'mm', toSI: 0.001 },
    { symbol: 'cm', toSI: 0.01 },
    { symbol: 'm', toSI: 1 },
    { symbol: 'in', toSI: 0.0254 },
    { symbol: 'ft', toSI: 0.3048 },
  ],
  motorDimensions: [
    { symbol: 'mm', toSI: 0.001 },
    { symbol: 'cm', toSI: 0.01 },
    { symbol: 'in', toSI: 0.0254 },
  ],
  distance: [
    { symbol: 'm', toSI: 1 },
    { symbol: 'km', toSI: 1000 },
    { symbol: 'ft', toSI: 0.3048 },
    { symbol: 'yd', toSI: 0.9144 },
    { symbol: 'mi', toSI: 1609.344 },
  ],
  mass: [
    { symbol: 'g', toSI: 0.001 },
    { symbol: 'kg', toSI: 1 },
    { symbol: 'oz', toSI: 0.0283495231 },
    { symbol: 'lb', toSI: 0.45359237 },
  ],
  velocity: VELOCITY_UNITS,
  windspeed: VELOCITY_UNITS,
  acceleration: [
    { symbol: 'm/s²', toSI: 1 },
    { symbol: 'ft/s²', toSI: 0.3048 },
    { symbol: 'G', toSI: 9.80665 },
  ],
  angle: [
    { symbol: '°', toSI: Math.PI / 180 },
    { symbol: 'rad', toSI: 1 },
  ],
  density: [
    { symbol: 'kg/m³', toSI: 1 },
    { symbol: 'g/cm³', toSI: 1000 },
    { symbol: 'oz/in³', toSI: 1729.99404 },
    { symbol: 'lb/ft³', toSI: 16.0184634 },
  ],
  temperature: [
    { symbol: '°C', toSI: 1, offset: 273.15 },
    { symbol: '°F', toSI: 5 / 9, offset: 459.67 },
    { symbol: 'K', toSI: 1 },
  ],
  pressure: [
    { symbol: 'mbar', toSI: 100 },
    { symbol: 'bar', toSI: 1.0e5 },
    { symbol: 'atm', toSI: 1.01325e5 },
    { symbol: 'mmHg', toSI: 101325.0 / 760.0 },
    { symbol: 'inHg', toSI: 3386.389 },
    { symbol: 'psi', toSI: 6894.75729 },
    { symbol: 'Pa', toSI: 1 },
  ],
};

export type UnitSelection = Record<Quantity, string>;

/** What the app displayed before the unit system existed — the startup default. */
export const INITIAL_UNITS: UnitSelection = {
  length: 'mm',
  motorDimensions: 'mm',
  distance: 'm',
  mass: 'g',
  velocity: 'm/s',
  windspeed: 'm/s',
  acceleration: 'm/s²',
  angle: '°',
  density: 'kg/m³',
  temperature: '°C',
  pressure: 'mbar',
};

/** Desktop UnitGroup.setDefaultMetricUnits(). */
export const METRIC_UNITS: UnitSelection = {
  length: 'cm',
  motorDimensions: 'mm',
  distance: 'm',
  mass: 'g',
  velocity: 'm/s',
  windspeed: 'm/s',
  acceleration: 'm/s²',
  angle: '°',
  density: 'g/cm³',
  temperature: '°C',
  pressure: 'mbar',
};

/** Desktop UnitGroup.setDefaultImperialUnits(). */
export const IMPERIAL_UNITS: UnitSelection = {
  length: 'in',
  motorDimensions: 'in',
  distance: 'ft',
  mass: 'oz',
  velocity: 'ft/s',
  windspeed: 'mph',
  acceleration: 'ft/s²',
  angle: '°',
  density: 'oz/in³',
  temperature: '°F',
  pressure: 'mbar',
};

export const QUANTITY_LABEL: Record<Quantity, string> = {
  length: 'Rocket dimensions',
  motorDimensions: 'Motor dimensions',
  distance: 'Altitude / distance',
  mass: 'Mass',
  velocity: 'Velocity',
  windspeed: 'Wind speed',
  acceleration: 'Acceleration',
  angle: 'Angle',
  density: 'Bulk density',
  temperature: 'Temperature',
  pressure: 'Pressure',
};

function unitDef(quantity: Quantity, symbol: string): UnitDef {
  return UNITS[quantity].find((u) => u.symbol === symbol) ?? UNITS[quantity][0]!;
}

export function siToUi(quantity: Quantity, symbol: string, si: number): number {
  const u = unitDef(quantity, symbol);
  return si / u.toSI - (u.offset ?? 0);
}

export function uiToSi(quantity: Quantity, symbol: string, ui: number): number {
  const u = unitDef(quantity, symbol);
  return (ui + (u.offset ?? 0)) * u.toSI;
}

/** Rounds a converted step/range to a "nice" 1–2–5 value so spinners feel sane. */
export function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / mag;
  const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return nice * mag;
}

/**
 * Format an SI value in the selected unit with a sensible precision.
 * With `digits`, shows UP TO that many decimals (trailing zeros stripped) —
 * used for CP/CG/length/diameter readouts, which the owner wants to 3 decimals
 * regardless of magnitude (the default ladder capped ≥10 at 1 dp, so inch
 * readouts lost real precision).
 */
export function fmtSi(quantity: Quantity, symbol: string, si: number, digits?: number): string {
  // The kernel bridge emits null for any NaN or Infinity, and `null / toSI`
  // is 0 — so an ABSENT value printed as a confident zero: a landing rate of
  // 0 ft/s, an apogee of 0 ft. An em dash is the honest answer, and matches
  // fmtInertia, which already guards exactly this.
  if (si === null || si === undefined || !Number.isFinite(si)) return '—';
  const v = siToUi(quantity, symbol, si);
  if (digits !== undefined) return String(Number(v.toFixed(digits)));
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
}

/**
 * A value ALREADY IN ITS DISPLAY UNIT, rounded to `places` decimals — or to
 * `sig` significant figures wherever `places` would leave fewer — with
 * trailing zeros stripped. The integer part is never rounded away: 1219 at
 * three figures is "1219", not "1220".
 *
 * Why it exists (audit 2026-09-22). A fixed decimal count is chosen for
 * millimetres, and every other length unit inherits it: at one decimal a
 * 98 mm airframe is "0.1 m" and the Scale dialog read "1 × 0.1 m becomes
 * 2 × 0.2 m"; at two, the catalogue's 215 tube sizes printed as 22 distinct
 * labels in metres ("0.03 m" named 30 of them); at NumField's three, a 0.4 mm
 * wall displayed as "0". `places` keeps what those sites showed in mm, and
 * `sig` stops a small number in a big unit collapsing to nothing.
 */
export function fmtSig(v: number, sig: number, places = 0): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const forSig = a > 0 ? sig - 1 - Math.floor(Math.log10(a)) : 0;
  const d = Math.min(20, Math.max(places, forSig));
  const s = v.toFixed(d);
  // Only a string WITH a point has trailing zeros to lose ("100" must stay).
  return d > 0 ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Whether this browser's own locale writes 1.5 as "1,5". Read once; any
 * failure (an engine without Intl) answers no, which is the stricter reading
 * in `readDecimal` below.
 * @internal Exported for components/DragPanel.test.tsx and components/NumField.test.tsx; no other module imports it.
 */
export const LOCALE_DECIMAL_COMMA: boolean = (() => {
  try {
    return new Intl.NumberFormat().formatToParts(1.5)
      .find((p) => p.type === 'decimal')?.value === ',';
  } catch {
    return false;
  }
})();

/**
 * A typed number, accepting a single `,` as the decimal separator — or null
 * when the text is not one number. The one parser every numeric input goes
 * through (audit 2026-09-22).
 *
 * `Number()` alone reads "1,5" as NaN, so in a comma-decimal locale no
 * fraction could be typed at all — an iPhone's decimal pad there has no "."
 * key. But each separator is ALSO the other locale's thousands separator:
 * reading "10,000" ft as 10.000 would silently fly sea level instead of ten
 * thousand feet, and in a decimal-comma locale "10.000" is how ten thousand
 * is written. So:
 *
 *  - one comma and no point: a decimal comma — "1,5", "0,25", "12,3456";
 *  - no comma: exactly `Number()`, as before;
 *  - EXCEPT, either way, a lone separator that could be a thousands group —
 *    one to three digits not starting with 0, the separator, exactly three
 *    digits: "1,500", "10,000", "10.000". That is ambiguous wherever the
 *    separator is the OTHER locale's: "10,000" is refused in a decimal-point
 *    locale and "10.000" in a decimal-comma one, while each reads the way the
 *    user's own keyboard means it at home. A leading 0 ("0,125", "0.125")
 *    cannot be a group, so it never is;
 *  - two commas, or a comma and a point: grouping, refused.
 *
 * A refused draft shows the input's error border and commits nothing, which is
 * the one safe answer to a number the app cannot read with certainty.
 */
export function readDecimal(text: string, decimalComma = LOCALE_DECIMAL_COMMA): number | null {
  let t = text.trim();
  if (t === '') return null;
  const commas = t.split(',').length - 1;
  if (commas > 1 || (commas === 1 && t.includes('.'))) return null;
  if (commas === 1) {
    if (!decimalComma && /^[-+]?[1-9]\d{0,2},\d{3}$/.test(t)) return null;
    t = t.replace(',', '.');
  } else if (decimalComma && /^[-+]?[1-9]\d{0,2}\.\d{3}$/.test(t)) {
    return null;
  }
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
