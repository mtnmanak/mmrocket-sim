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

/** Format an SI value in the selected unit with a sensible precision. */
export function fmtSi(quantity: Quantity, symbol: string, si: number, digits?: number): string {
  const v = siToUi(quantity, symbol, si);
  if (digits !== undefined) return v.toFixed(digits);
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
}
