import { boosterBranches, type FlightResult, type FlightSeries } from '@online-openrocket/engine';
import { siToUi, type Quantity, type UnitSelection } from '../prefs/units.js';
import { csvCell } from './csvUtil.js';

/**
 * Per-timestep flight-data export: every series the kernel recorded, one row
 * per sample. Pass the user's UnitSelection to get each column in their
 * preferred unit for its quantity (header names the unit, desktop
 * CSVExport-style); omitted, everything stays pure SI (m, kg, s, N, rad —
 * the engine's own units). Series are NOT stored with run history, so this
 * always describes the in-memory result of the most recent flight.
 */

/**
 * How one column is labeled and converted: `si` is the unit label baked into
 * the header when no UnitSelection is passed ('' = dimensionless, no
 * parentheses); `quantity` is the unit-preference group. Columns without a
 * quantity always export in `si` — deliberately so for thrust/drag, whose
 * desktop FORCE group defaults to N even under imperial (UnitGroup.java),
 * and for roll/pitch/yaw rates, which have no preference group here.
 */
interface ColSpec {
  name: string;
  si: string;
  quantity?: Quantity;
}

/** The friendly-named arrays the engine emits first. */
const FRIENDLY: [key: string, spec: ColSpec][] = [
  ['time', { name: 'Time', si: 's' }],
  ['altitude', { name: 'Altitude', si: 'm', quantity: 'distance' }],
  ['velocity', { name: 'Velocity', si: 'm/s', quantity: 'velocity' }],
  ['acceleration', { name: 'Acceleration', si: 'm/s²', quantity: 'acceleration' }],
  ['mass', { name: 'Mass', si: 'kg', quantity: 'mass' }],
  ['thrust', { name: 'Thrust', si: 'N' }],
  ['drag', { name: 'Drag force', si: 'N' }],
  ['mach', { name: 'Mach number', si: '' }],
  ['stability', { name: 'Stability margin', si: 'cal' }],
  ['cpLocation', { name: 'CP location', si: 'm', quantity: 'length' }],
  ['cgLocation', { name: 'CG location', si: 'm', quantity: 'length' }],
  ['aoa', { name: 'Angle of attack', si: 'rad', quantity: 'angle' }],
];

/**
 * Symbol-keyed series that are bit-identical duplicates of the friendly
 * dozen (t=time, h=altitude, Vt=velocity, At=acceleration, m=mass,
 * Ft=thrust, Fd=drag, M=mach, S=stability, Cp/Cg, α=aoa — the exact types
 * OrkEngine.appendBranchSeries maps to friendly names). Exporting both
 * would double the file for no information.
 */
const DUPLICATE_SYMBOLS = new Set([
  't', 'h', 'Vt', 'At', 'm', 'Ft', 'Fd', 'M', 'S', 'Cp', 'Cg', 'α',
]);

/**
 * FlightDataType catalog: symbol → full name + units. Transcribed from the
 * carved FlightDataType.java constructors (each names its type and
 * UnitGroup); latitude/longitude are stored in degrees (storeData records
 * getLatitudeDeg()), so they carry no quantity. Moments of inertia and
 * reference area have no preference group in prefs/units and stay
 * SI-labeled. Symbols missing here (a future kernel type) still export —
 * the header is then just the symbol.
 */
const SYMBOL_SPEC: Record<string, ColSpec> = {
  ha: { name: 'Altitude above sea level', si: 'm', quantity: 'distance' },
  Vz: { name: 'Vertical velocity', si: 'm/s', quantity: 'velocity' },
  Az: { name: 'Vertical acceleration', si: 'm/s²', quantity: 'acceleration' },
  Px: { name: 'Position East of launch', si: 'm', quantity: 'distance' },
  Py: { name: 'Position North of launch', si: 'm', quantity: 'distance' },
  Pl: { name: 'Lateral distance', si: 'm', quantity: 'distance' },
  'θl': { name: 'Lateral direction', si: 'rad', quantity: 'angle' },
  Vl: { name: 'Lateral velocity', si: 'm/s', quantity: 'velocity' },
  Al: { name: 'Lateral acceleration', si: 'm/s²', quantity: 'acceleration' },
  'φ': { name: 'Latitude', si: '°' },
  'λ': { name: 'Longitude', si: '°' },
  'dΦ': { name: 'Roll rate', si: 'rad/s' },
  'dθ': { name: 'Pitch rate', si: 'rad/s' },
  'dΨ': { name: 'Yaw rate', si: 'rad/s' },
  'Θ': { name: 'Vertical orientation — zenith', si: 'rad', quantity: 'angle' },
  'Φ': { name: 'Lateral orientation — azimuth', si: 'rad', quantity: 'angle' },
  mp: { name: 'Motor mass', si: 'kg', quantity: 'mass' },
  Il: { name: 'Longitudinal moment of inertia', si: 'kg·m²' },
  Ir: { name: 'Rotational moment of inertia', si: 'kg·m²' },
  g: { name: 'Gravitational acceleration', si: 'm/s²', quantity: 'acceleration' },
  R: { name: 'Reynolds number', si: '' },
  Twr: { name: 'Thrust-to-weight ratio', si: '' },
  Cd: { name: 'Drag coefficient', si: '' },
  Cdf: { name: 'Friction drag coefficient', si: '' },
  Cdp: { name: 'Pressure drag coefficient', si: '' },
  Cdb: { name: 'Base drag coefficient', si: '' },
  Cda: { name: 'Axial drag coefficient', si: '' },
  Cn: { name: 'Normal force coefficient', si: '' },
  'Cθ': { name: 'Pitch moment coefficient', si: '' },
  'CτΨ': { name: 'Yaw moment coefficient', si: '' },
  'Cτs': { name: 'Side force coefficient', si: '' },
  'CτΦ': { name: 'Roll moment coefficient', si: '' },
  'CfΦ': { name: 'Roll forcing coefficient', si: '' },
  'CζΦ': { name: 'Roll damping coefficient', si: '' },
  'Cζθ': { name: 'Pitch damping coefficient', si: '' },
  'CζΨ': { name: 'Yaw damping coefficient', si: '' },
  Ac: { name: 'Coriolis acceleration', si: 'm/s²', quantity: 'acceleration' },
  Lr: { name: 'Reference length', si: 'm', quantity: 'length' },
  Ar: { name: 'Reference area', si: 'm²' },
  Vw: { name: 'Wind velocity', si: 'm/s', quantity: 'windspeed' },
  'θw': { name: 'Wind direction', si: 'rad', quantity: 'angle' },
  T: { name: 'Air temperature', si: 'K', quantity: 'temperature' },
  P: { name: 'Air pressure', si: 'Pa', quantity: 'pressure' },
  'ρ': { name: 'Air density', si: 'kg/m³', quantity: 'density' },
  Vs: { name: 'Speed of sound', si: 'm/s', quantity: 'velocity' },
  dt: { name: 'Simulation time step', si: 's' },
  tc: { name: 'Computation time', si: 's' },
};

const FRIENDLY_KEYS = new Set(FRIENDLY.map(([k]) => k));

interface Column {
  header: string;
  values: (number | null)[];
}

/** "Name (unit)" in the selected unit for the column's quantity, else SI. */
function headerFor(spec: ColSpec, units?: UnitSelection): string {
  const unit = units && spec.quantity ? units[spec.quantity] : spec.si;
  return unit ? `${spec.name} (${unit})` : spec.name;
}

/** Converted copy when a selection applies; the original array otherwise. */
function valuesFor(spec: ColSpec, units: UnitSelection | undefined, values: (number | null)[]): (number | null)[] {
  const q = spec.quantity;
  if (!units || !q) return values;
  const symbol = units[q];
  return values.map((v) => (v == null || !Number.isFinite(v) ? v : siToUi(q, symbol, v)));
}

/**
 * Columns for one branch's series: the friendly dozen first (time leading),
 * then every symbol-keyed extra the branch carries — minus the duplicates —
 * in the engine's emit order (identical order with or without a
 * UnitSelection). Absent/empty series are skipped (old engine artifacts
 * carry no symbol keys at all).
 */
export function seriesColumns(series: FlightSeries, prefix = '', units?: UnitSelection): Column[] {
  const cols: Column[] = [];
  for (const [key, spec] of FRIENDLY) {
    const values = series[key];
    if (values && values.length > 0) {
      cols.push({ header: prefix + headerFor(spec, units), values: valuesFor(spec, units, values) });
    }
  }
  for (const key of Object.keys(series)) {
    if (FRIENDLY_KEYS.has(key) || DUPLICATE_SYMBOLS.has(key)) continue;
    const values = series[key];
    if (!values || values.length === 0) continue;
    const spec = SYMBOL_SPEC[key];
    cols.push({
      header: prefix + (spec ? `${key} — ${headerFor(spec, units)}` : key),
      values: spec ? valuesFor(spec, units, values) : values,
    });
  }
  return cols;
}

/**
 * The whole flight as CSV (UTF-8; symbol headers keep their Greek letters),
 * in the user's units when a UnitSelection is passed, pure SI otherwise.
 * Staged flights land in ONE file: the sustainer's columns first, then each
 * booster branch's columns appended and prefixed with the branch name
 * ("Booster — Time (s)", …). Each branch keeps its OWN time column — the
 * branches are separate flights and their samples don't align. Rows run to
 * the longest branch; shorter branches leave trailing cells empty.
 * NaN samples (kernel: undefined at that step) become empty cells.
 */
export function flightDataCsv(result: FlightResult, units?: UnitSelection): string {
  const cols = seriesColumns(result.series, '', units);
  for (const b of boosterBranches(result)) {
    cols.push(...seriesColumns(b.series, `${b.name} — `, units));
  }
  const rowCount = Math.max(0, ...cols.map((c) => c.values.length));
  const lines = [cols.map((c) => csvCell(c.header)).join(',')];
  for (let i = 0; i < rowCount; i++) {
    lines.push(cols.map((c) => {
      const v = c.values[i];
      return v == null || !Number.isFinite(v) ? '' : String(v);
    }).join(','));
  }
  return lines.join('\n');
}
