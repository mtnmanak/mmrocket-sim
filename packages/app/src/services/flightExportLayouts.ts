import { exportColumnCatalog } from './flightDataCsv.js';

export interface FlightExportLayout {
  id: string;
  name: string;
  columns: { key: string; unit: string }[];
  events: { from?: string; to?: string };
}

export const EXPORT_EVENTS = [
  ['LAUNCH', 'Launch'], ['IGNITION', 'Ignition'], ['LIFTOFF', 'Lift-off'],
  ['LAUNCHROD', 'Launch guide exit'], ['BURNOUT', 'Burnout'],
  ['EJECTION_CHARGE', 'Ejection charge'], ['STAGE_SEPARATION', 'Stage separation'],
  ['APOGEE', 'Apogee'], ['RECOVERY_DEVICE_DEPLOYMENT', 'Recovery deployment'],
  ['TUMBLE', 'Tumbling'], ['GROUND_HIT', 'Ground hit'], ['SIMULATION_END', 'Simulation end'],
] as const;

/** N038: a stored unit must be convertible for that column, never just printable. */
export function normalizeExportLayouts(value: unknown): FlightExportLayout[] {
  if (!Array.isArray(value)) return [];
  const catalog = new Map(exportColumnCatalog().map(c => [c.key, c]));
  const ids = new Set<string>();
  const out: FlightExportLayout[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || !r['id'].trim() || ids.has(r['id'])
      || typeof r['name'] !== 'string' || !r['name'].trim() || !Array.isArray(r['columns']) || !r['columns'].length) continue;
    const columns: FlightExportLayout['columns'] = [];
    const keys = new Set<string>();
    let valid = true;
    for (const c of r['columns']) {
      if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.key !== 'string' || typeof c.unit !== 'string'
        || keys.has(c.key) || !catalog.get(c.key)?.units.includes(c.unit)) { valid = false; break; }
      columns.push({ key: c.key, unit: c.unit });
      keys.add(c.key);
    }
    const e = r['events'];
    if (!valid || !e || typeof e !== 'object' || Array.isArray(e)) continue;
    const events = e as Record<string, unknown>;
    if (['from', 'to'].some(k => events[k] !== undefined && !EXPORT_EVENTS.some(([key]) => key === events[k]))) continue;
    ids.add(r['id']);
    out.push({ id: r['id'], name: r['name'].trim(), columns, events: {
      ...(typeof events['from'] === 'string' ? { from: events['from'] } : {}),
      ...(typeof events['to'] === 'string' ? { to: events['to'] } : {}),
    } });
  }
  return out;
}
