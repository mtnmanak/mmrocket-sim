import type { FlightResult, FlightSeries } from '@online-openrocket/engine';
import { csvCell } from './csvUtil.js';

/**
 * Per-timestep flight-data export: every series the kernel recorded, one row
 * per sample, pure SI (m, kg, s, N, rad — the engine's own units; the run
 * table's unit-preference CSV is a different export). Series are NOT stored
 * with run history, so this always describes the in-memory result of the
 * most recent flight.
 */

/** The friendly-named arrays the engine emits first, with their SI units. */
const FRIENDLY: [key: string, header: string][] = [
  ['time', 'Time (s)'],
  ['altitude', 'Altitude (m)'],
  ['velocity', 'Velocity (m/s)'],
  ['acceleration', 'Acceleration (m/s²)'],
  ['mass', 'Mass (kg)'],
  ['thrust', 'Thrust (N)'],
  ['drag', 'Drag force (N)'],
  ['mach', 'Mach number'],
  ['stability', 'Stability margin (cal)'],
  ['cpLocation', 'CP location (m)'],
  ['cgLocation', 'CG location (m)'],
  ['aoa', 'Angle of attack (rad)'],
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
 * FlightDataType catalog: symbol → "full name (SI unit)". Transcribed from
 * the carved FlightDataType.java constructors (each names its type and
 * UnitGroup); latitude/longitude are stored in degrees (storeData records
 * getLatitudeDeg()). Symbols missing here (a future kernel type) still
 * export — the header is then just the symbol.
 */
const SYMBOL_NAME: Record<string, string> = {
  ha: 'Altitude above sea level (m)',
  Vz: 'Vertical velocity (m/s)',
  Az: 'Vertical acceleration (m/s²)',
  Px: 'Position East of launch (m)',
  Py: 'Position North of launch (m)',
  Pl: 'Lateral distance (m)',
  'θl': 'Lateral direction (rad)',
  Vl: 'Lateral velocity (m/s)',
  Al: 'Lateral acceleration (m/s²)',
  'φ': 'Latitude (°)',
  'λ': 'Longitude (°)',
  'dΦ': 'Roll rate (rad/s)',
  'dθ': 'Pitch rate (rad/s)',
  'dΨ': 'Yaw rate (rad/s)',
  'Θ': 'Vertical orientation — zenith (rad)',
  'Φ': 'Lateral orientation — azimuth (rad)',
  mp: 'Motor mass (kg)',
  Il: 'Longitudinal moment of inertia (kg·m²)',
  Ir: 'Rotational moment of inertia (kg·m²)',
  g: 'Gravitational acceleration (m/s²)',
  R: 'Reynolds number',
  Twr: 'Thrust-to-weight ratio',
  Cd: 'Drag coefficient',
  Cdf: 'Friction drag coefficient',
  Cdp: 'Pressure drag coefficient',
  Cdb: 'Base drag coefficient',
  Cda: 'Axial drag coefficient',
  Cn: 'Normal force coefficient',
  'Cθ': 'Pitch moment coefficient',
  'CτΨ': 'Yaw moment coefficient',
  'Cτs': 'Side force coefficient',
  'CτΦ': 'Roll moment coefficient',
  'CfΦ': 'Roll forcing coefficient',
  'CζΦ': 'Roll damping coefficient',
  'Cζθ': 'Pitch damping coefficient',
  'CζΨ': 'Yaw damping coefficient',
  Ac: 'Coriolis acceleration (m/s²)',
  Lr: 'Reference length (m)',
  Ar: 'Reference area (m²)',
  Vw: 'Wind velocity (m/s)',
  'θw': 'Wind direction (rad)',
  T: 'Air temperature (K)',
  P: 'Air pressure (Pa)',
  'ρ': 'Air density (kg/m³)',
  Vs: 'Speed of sound (m/s)',
  dt: 'Simulation time step (s)',
  tc: 'Computation time (s)',
};

const FRIENDLY_KEYS = new Set(FRIENDLY.map(([k]) => k));

interface Column {
  header: string;
  values: (number | null)[];
}

/**
 * Columns for one branch's series: the friendly dozen first (time leading),
 * then every symbol-keyed extra the branch carries — minus the duplicates —
 * in the engine's emit order. Absent/empty series are skipped (old engine
 * artifacts carry no symbol keys at all).
 */
export function seriesColumns(series: FlightSeries, prefix = ''): Column[] {
  const cols: Column[] = [];
  for (const [key, header] of FRIENDLY) {
    const values = series[key];
    if (values && values.length > 0) cols.push({ header: prefix + header, values });
  }
  for (const key of Object.keys(series)) {
    if (FRIENDLY_KEYS.has(key) || DUPLICATE_SYMBOLS.has(key)) continue;
    const values = series[key];
    if (!values || values.length === 0) continue;
    const name = SYMBOL_NAME[key];
    cols.push({ header: prefix + (name ? `${key} — ${name}` : key), values });
  }
  return cols;
}

/**
 * The whole flight as CSV (UTF-8; symbol headers keep their Greek letters).
 * Staged flights land in ONE file: the sustainer's columns first, then each
 * booster branch's columns appended and prefixed with the branch name
 * ("Booster — Time (s)", …). Each branch keeps its OWN time column — the
 * branches are separate flights and their samples don't align. Rows run to
 * the longest branch; shorter branches leave trailing cells empty.
 * NaN samples (kernel: undefined at that step) become empty cells.
 */
export function flightDataCsv(result: FlightResult): string {
  const cols = seriesColumns(result.series);
  for (const b of result.branches?.slice(1) ?? []) {
    cols.push(...seriesColumns(b.series, `${b.name} — `));
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
