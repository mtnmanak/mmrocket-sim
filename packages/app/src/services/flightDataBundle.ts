import { strToU8, zipSync } from 'fflate';
import type { FlightResult } from '@online-openrocket/engine';
import { APP_VERSION } from '../version.js';
import { exportOrk, type OrkTreeExportInput } from './orkFile.js';
import type { SimRun } from './simReport.js';
import { runsToCsv } from './simStore.js';
import { flightDataCsv } from './flightDataCsv.js';
import { CSV_BOM, stampedName } from './fileName.js';
import { validRunExportContext } from './runExportContext.js';
import { WEATHER_CREDIT } from './weatherSnapshot.js';

export interface FlightMeasurements {
  altimeterType: string;
  apogeeM: number | null;
  maxVelocityMs: number | null;
  liftoffMassKg: number | null;
  notes: string;
}
export interface FlightDataBundleInput {
  design: OrkTreeExportInput;
  run: SimRun;
  changedSince: string[] | null;
  /** Already held for this selected run; exporting never re-flies a rocket. */
  result?: FlightResult;
  includeCoordinates: boolean;
  measurements: FlightMeasurements;
  attachment?: { name: string; bytes: Uint8Array };
}

function attachmentPath(name: string): string {
  const base = name.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'data-log';
  return `attachment/${base}`;
}

export function flightDataBundleFiles(hasSeries: boolean, attachmentName?: string) {
  return [
    { path: 'manifest.json', description: 'App versions, selected run, design comparison, units and file list' },
    { path: 'design.ork', description: 'Current design, motors and saved configurations, as the app writes them' },
    { path: 'run.json', description: 'Selected saved run: recorded inputs, results, model and provenance' },
    { path: 'run.csv', description: 'Existing run-table export, one selected row; fixed flight-day columns and SI detail columns, with units in headers' },
    { path: 'launch-and-weather.json', description: 'Launch settings and applied weather receipt recorded with this run, or null if unavailable' },
    { path: 'measurements.json', description: 'Your measured values and notes; blank values are null' },
    ...(hasSeries ? [{ path: 'flight-data.csv', description: 'Available per-step simulation data, SI units; may be sampled' }] : []),
    ...(attachmentName !== undefined ? [{ path: attachmentPath(attachmentName), description: 'Your chosen data-log file, unchanged' }] : []),
  ];
}

// Coordinates can also live in weather receipts, profile place labels and keys.
// Remove structured location data throughout; user-authored text/files stay intact.
function withoutCoordinates(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCoordinates);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => {
    if (/latitude|longitude/i.test(key) || ['φ', 'λ', 'place', 'grid', 'windProfileSource'].includes(key)) return [];
    if (key === 'conditionsKey' && typeof v === 'string') {
      return [[key, v.split('|').filter(p => !/^(latitude|longitude)/i.test(p)).join('|')]];
    }
    return [[key, withoutCoordinates(v)]];
  }));
}

export function flightDataBundleContents(input: FlightDataBundleInput): { files: Record<string, Uint8Array>; filename: string; notices: string[] } {
  const { includeCoordinates, attachment, result } = input;
  const context = validRunExportContext(input.run.exportContext) ? input.run.exportContext : null;
  const clean = <T,>(v: T): T => includeCoordinates ? v : withoutCoordinates(v) as T;
  // Only the ordinary writer receives the current design; no run is relabelled
  // as that design's flight. Keep its normal flightdata guards at the caller.
  const design = clean(input.design);
  const designExportNotes = [...(design.notes ?? [])];
  let xml = exportOrk({ ...design, notes: designExportNotes, onOmittedMotor: () => {
    designExportNotes.push('A motor could not be included in the design file. Review its motor assignments before using the file for another simulation.');
  } });
  if (!includeCoordinates) xml = xml.replace(/<launch(?:latitude|longitude)\b[^>]*>[^<]*<\/launch(?:latitude|longitude)>\s*/g, '');
  const files: Record<string, Uint8Array> = {};
  const json = (path: string, value: unknown) => { files[path] = strToU8(JSON.stringify(value, (_key, v: unknown) => v === Infinity ? 'Infinity' : v, 2) + '\n'); };
  files['design.ork'] = strToU8(xml);
  const run = clean(input.run);
  json('run.json', run);
  files['run.csv'] = strToU8(CSV_BOM + runsToCsv([run]));
  json('launch-and-weather.json', clean(context));
  for (const key of ['apogeeM', 'maxVelocityMs', 'liftoffMassKg'] as const) {
    const n = input.measurements[key];
    if (n !== null && (!Number.isFinite(n) || n < 0)) throw new Error('Measured values must be zero or greater, or left blank.');
  }
  json('measurements.json', input.measurements);
  if (result) files['flight-data.csv'] = strToU8(CSV_BOM + flightDataCsv(clean(result)));
  if (attachment) files[attachmentPath(attachment.name)] = attachment.bytes;
  json('manifest.json', {
    format: 'mmrocket-flight-data-bundle', schemaVersion: 1,
    exportedAt: new Date().toISOString(), appVersionAtExport: APP_VERSION,
    appVersionAtRun: context?.appVersion ?? null,
    selectedRunId: input.run.id, runTimeUnixMs: input.run.when,
    design: 'current design at export', changedSince: input.changedSince,
    designExportNotes: [...new Set(designExportNotes)],
    runSource: input.run.importedSummary ? 'imported summary' : 'saved simulation',
    series: result ? 'available in memory; may be sampled' : 'not available',
    launchAndWeather: context ? 'recorded with selected run' : 'not recorded',
    coordinatesIncluded: includeCoordinates,
    units: 'JSON and flight-data.csv: SI (m, kg, s, N, rad), except field names ending Deg (degrees), temperatureC (Celsius), pressureHPa (hPa). run.csv retains the existing fixed ft/mph/G/g flight-day columns and SI detail columns; every CSV header names its unit.',
    measurements: 'User measurements, separate from simulation predictions; null means unknown',
    privacy: 'User text and attachment contents are unchanged and may contain location or other personal details.',
    weatherCredit: context?.weather ? WEATHER_CREDIT : null,
    attachment: attachment ? { path: attachmentPath(attachment.name), originalName: attachment.name, bytes: attachment.bytes.byteLength } : null,
    files: flightDataBundleFiles(!!result, attachment?.name),
  });
  return { files, filename: stampedName(input.design.name, 'flight-data-bundle', 'zip'), notices: [...new Set(designExportNotes)] };
}

export function buildFlightDataBundle(input: FlightDataBundleInput): { bytes: Uint8Array; filename: string } {
  const { files, filename } = flightDataBundleContents(input);
  return { bytes: zipSync(files), filename };
}
