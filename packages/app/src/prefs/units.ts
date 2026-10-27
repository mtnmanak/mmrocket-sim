/**
 * Unit system mirroring the desktop's UnitGroup (info.openrocket.core.unit).
 * Quantities are the desktop's unit groups (the ones this UI uses); factors
 * are copied from UnitGroup.java 24.12. Conversion convention matches the
 * desktop: si = (ui + offset) * toSI  (offset is only used by temperature).
 *
 * The engine stays pure SI/radians — these conversions live at the UI edge
 * only (lesson from upstream bug #2475).
 */

import { DECIMAL } from './decimal.js';

export type Quantity =
  | 'length'          // rocket dimensions (UNITS_LENGTH)
  | 'motorDimensions' // motor diameters/lengths (UNITS_MOTOR_DIMENSIONS)
  | 'altitude'        // vertical heights, including site elevation (N032)
  | 'distance'        // horizontal range and drift (UNITS_DISTANCE)
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

const DISTANCE_UNITS: UnitDef[] = [
  { symbol: 'm', toSI: 1 },
  { symbol: 'km', toSI: 1000 },
  { symbol: 'ft', toSI: 0.3048 },
  { symbol: 'yd', toSI: 0.9144 },
  { symbol: 'mi', toSI: 1609.344 },
];

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
  altitude: DISTANCE_UNITS,
  distance: DISTANCE_UNITS,
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
  altitude: 'm',
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
  altitude: 'm',
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
  altitude: 'ft',
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
  altitude: 'Altitude',
  distance: 'Horizontal distance',
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

/** Equality for notice decisions, including arithmetic residue around zero (SI). */
export function noticeEqual(a: number, b: number): boolean {
  return a === b || (Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= Math.max(1e-12, 8 * Number.EPSILON * Math.max(Math.abs(a), Math.abs(b))));
}

/** Notice numbers keep field precision and never exceed six significant digits. */
export function noticeNumber(value: number, digits?: number): string {
  if (!Number.isFinite(value)) return '—';
  const a = Math.abs(value);
  const places = digits ?? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  return String(Number(Number(value.toFixed(Math.min(20, places))).toPrecision(6)));
}

/** A physical quantity in advice: selected unit first, other system second.
 * Say just above/below when display rounding would hide a threshold crossing. */
export function noticeQuantity(quantity: Quantity | 'area' | 'surfaceDensity' | 'lineDensity', si: number, units: UnitSelection | string = INITIAL_UNITS,
  options: { digits?: number; otherDigits?: number; otherUnit?: string; against?: number; grouped?: boolean; parenthesized?: boolean; signed?: boolean; preserveSmall?: boolean; defined?: { value: number; symbol: string } } = {}): string {
  if (si === null || si === undefined || !Number.isFinite(si)) return '—';
  if (quantity === 'angle') {
    const symbol = typeof units === 'string' ? units : units.angle;
    const text = (sym: string) => `${noticeNumber(siToUi('angle', sym, si), sym === 'rad' ? 3 : 1)}${sym === '°' ? '' : ' '}${sym}`;
    return symbol === 'rad' ? `${text(symbol)} (${text('°')})` : text('°');
  }
  const derived = quantity === 'area' || quantity === 'surfaceDensity' || quantity === 'lineDensity';
  const selected = typeof units === 'string' ? units : units[quantity === 'area' ? 'length' : derived ? 'density' : quantity as Quantity];
  const imperial = ['in', 'ft', 'yd', 'mi', 'ft/s', 'mph', 'kt', 'oz', 'lb', '°F', 'inHg', 'psi', 'ft/s²', 'oz/in³', 'lb/ft³'].includes(selected);
  const counterpart = {
    length: imperial ? 'mm' : 'in', motorDimensions: imperial ? 'mm' : 'in',
    altitude: imperial ? 'm' : 'ft', distance: imperial ? 'm' : 'ft',
    velocity: imperial ? 'm/s' : 'ft/s', windspeed: imperial ? 'm/s' : 'ft/s',
    mass: imperial ? (Math.abs(si) >= 1 ? 'kg' : 'g') : (Math.abs(si) >= 0.45359237 ? 'lb' : 'oz'),
    temperature: imperial ? '°C' : '°F', pressure: imperial ? 'mbar' : 'inHg',
    acceleration: imperial ? 'm/s²' : 'ft/s²', density: imperial ? 'kg/m³' : 'lb/ft³',
    area: imperial ? 'mm' : 'in', surfaceDensity: imperial ? 'kg/m³' : 'lb/ft³', lineDensity: imperial ? 'kg/m³' : 'lb/ft³',
  };
  const other = options.otherUnit ?? counterpart[quantity];
  const converted = (symbol: string, value: number): number => {
    if (quantity === 'area') return value / unitDef('length', symbol).toSI ** 2;
    if (quantity === 'surfaceDensity' || quantity === 'lineDensity') {
      const length = ({ 'kg/m³': 1, 'g/cm³': 0.01, 'oz/in³': 0.0254, 'lb/ft³': 0.3048 } as Record<string, number>)[symbol] ?? 1;
      return value / (unitDef('density', symbol).toSI * length ** (quantity === 'surfaceDensity' ? 1 : 2));
    }
    return siToUi(quantity, symbol, value);
  };
  const label = (symbol: string) => quantity === 'area' ? `${symbol}²`
    : derived ? symbol.replace('³', quantity === 'surfaceDensity' ? '²' : '') : symbol;
  const digitsFor = (symbol: string): number | undefined => {
    if (derived) return 3;
    if (symbol === 'ft/s') return 0;
    if (symbol === 'm/s') return 1;
    if (symbol === 'mph') return 2;
    if (quantity === 'altitude' || quantity === 'distance') return symbol === 'km' || symbol === 'mi' ? 3 : 1;
    if (['length', 'motorDimensions', 'density', 'pressure'].includes(quantity)) return 3;
    if (quantity === 'temperature') return 1;
    return undefined;
  };
  const shown = (symbol: string, value: number, digits = digitsFor(symbol)): string => {
    const convertedValue = converted(symbol, value);
    const zeroTolerance = quantity === 'temperature' ? 1e-12
      : converted(symbol, 1e-12 * (quantity === 'area' ? 1e-6 : derived ? 1 : unitDef(quantity as Quantity, INITIAL_UNITS[quantity as Quantity]).toSI));
    const residue = Math.abs(convertedValue) <= zeroTolerance;
    const number = residue ? 0 : convertedValue;
    const preserveSmall = options.preserveSmall !== false && !options.signed && !residue && (derived || !(unitDef(quantity as Quantity, symbol).offset ?? 0));
    if (preserveSmall && (derived
      || ((quantity === 'length' || quantity === 'motorDimensions') && Math.abs(number) < 1)
      || ((quantity === 'altitude' || quantity === 'distance') && Math.abs(number) < 1)
      || Number(noticeNumber(number, digits)) === 0)) {
      const text = fmtSig(number, 3, digits ?? 0);
      const capped = Number(Number(text).toPrecision(6));
      return Number(text) === capped ? text : String(capped);
    }
    return noticeNumber(number, digits);
  };
  const against = options.against;
  if (against !== undefined && Number.isFinite(against) && !noticeEqual(si, against)
    && shown(selected, si, options.digits) === shown(selected, against, options.digits)) {
    return `just ${si > against ? 'above' : 'below'} ${noticeQuantity(quantity, against, units, { ...options, against: undefined })}`;
  }
  const value = (symbol: string, digits?: number) => {
    const text = shown(symbol, si, digits);
    const display = options.grouped ? Number(text).toLocaleString('en-US', { maximumSignificantDigits: 6 }) : text;
    const n = Number(display.replaceAll(',', ''));
    return `${options.signed ? `${n < 0 ? '−' : '+'}${display.replace(/^-/, '')}` : display} ${label(symbol)}`;
  };
  const definition = options.defined;
  const suffix = definition && selected !== definition.symbol && other !== definition.symbol
    ? ` ${options.parenthesized ? '[' : '('}defined as ${noticeNumber(definition.value)} ${definition.symbol}${options.parenthesized ? ']' : ')'}` : '';
  return `${value(selected, options.digits)}${options.parenthesized ? ' [' : ' ('}${value(other, options.otherDigits)}${options.parenthesized ? ']' : ')'}${suffix}`;
}

/** A pair uses normal field precision, with a direction when rounding hides it.
 * The bound is always numeric; callers must name it only once. */
export function noticeComparison(
  quantity: Parameters<typeof noticeQuantity>[0], actual: number, limit: number,
  units: UnitSelection | string = INITIAL_UNITS,
  options: Parameters<typeof noticeQuantity>[3] = {},
): [string, string] {
  const selected = typeof units === 'string' ? units : units.mass;
  const magnitude = Math.max(Math.abs(actual), Math.abs(limit));
  const otherUnit = options.otherUnit ?? (quantity === 'mass'
    ? ['oz', 'lb'].includes(selected) ? magnitude >= 1 ? 'kg' : 'g' : magnitude >= 0.45359237 ? 'lb' : 'oz'
    : undefined);
  const bound = noticeQuantity(quantity, limit, units, { ...options, otherUnit, against: undefined });
  return [noticeEqual(actual, limit) ? bound : noticeQuantity(quantity, actual, units, { ...options, otherUnit, against: limit }), bound];
}

/** A real change whose normal displays coincide names the new value once. */
export function noticeChange(before: string, after: string, displayEqual = false): string {
  return before === after || displayEqual ? `changed slightly (now ${after})` : `${before} → ${after}`;
}
/**
 * An ALTITUDE for reading, not for editing: whole metres, feet or yards, and
 * two decimals of a kilometre or a mile. The density-altitude readout's
 * formatter, and the one a readout that can sit at or cross zero should use.
 *
 * Why not `fmtSi`'s own ladder: it grows decimals as a value shrinks, so a
 * readout sitting exactly on its site altitude of 0 printed "0.000", and float
 * noise either side of it "-0.000". With a fixed `digits`, `fmtSi` goes through
 * `Number(x.toFixed(d))`, which turns −0 (and anything that rounds to it) into
 * a plain "0"; a non-finite value is "—", as everywhere.
 */
export function fmtAltitude(symbol: string, si: number): string {
  return fmtSi('altitude', symbol, si, symbol === 'km' || symbol === 'mi' ? 2 : 0);
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
  // Only a string WITH a point has trailing zeros to lose ("100" must stay),
  // and toFixed answers in exponential form from 1e21, whose exponent's zeros
  // are not trailing decimals ("1e+30" read "1e+3").
  const text = d > 0 && !s.includes('e') ? s.replace(/\.?0+$/, '') : s;
  return Number(text) === 0 ? '0' : text;
}

/**
 * A value ALREADY IN ITS DISPLAY UNIT, exactly as a NumField box shows it:
 * the selected decimals (auto keeps three), or three significant figures
 * where those decimals would round it away. Exported so that text
 * quoting a box's value prints the digits the box does — the weather UI's
 * wind and σ lines (review of 2026-09-23: the gust chip printed "0.9 m/s"
 * under a Wind gusts σ box reading 0.95, the value the chip had just written).
 */
export const fmtFieldValue = (v: number, precision: 'auto' | 3 | 4 = 'auto'): string =>
  fmtSig(v, 3, precision === 4 ? 4 : 3);

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
 *  - no comma: a plain decimal (`DECIMAL`, prefs/decimal.ts), as a file reads it;
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
  // Number() alone also reads 0x10 as 16, 0b110 as 6 and 0o7 as 7, which
  // every file reader refuses (parseDecimal); a field must not commit a
  // number the same text would be refused as in a file.
  if (!DECIMAL.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}
