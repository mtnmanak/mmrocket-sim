import { APP_VERSION } from '../version.js';
import type { LaunchConditions } from './launchConditions.js';
import { validWeatherSnapshot, type WeatherSnapshot } from './weatherSnapshot.js';
import { validWindLevels, validWindProfileSource } from './windProfile.js';

/** Empirical flight-data collection (open-items §4): provenance only, never a physics or .ork input. */
export interface RunExportContext {
  appVersion: string;
  launch: LaunchConditions;
  weather: WeatherSnapshot | null;
}

export function runExportContext(launch: LaunchConditions, weather: WeatherSnapshot | null = null): RunExportContext {
  return structuredClone({ appVersion: APP_VERSION, launch, weather });
}

export function validRunExportContext(value: unknown): value is RunExportContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['appVersion'] !== 'string' || !v['launch'] || typeof v['launch'] !== 'object' || Array.isArray(v['launch'])) return false;
  const launch = v['launch'] as Record<string, unknown>;
  for (const key of ['launchRodLengthM', 'launchRodAngleDeg', 'windAverage', 'windStdDev', 'launchAltitudeM', 'latitudeDeg']) {
    if (typeof launch[key] !== 'number' || !Number.isFinite(launch[key])) return false;
  }
  for (const key of ['temperatureC', 'pressureHPa']) {
    if (launch[key] !== null && (typeof launch[key] !== 'number' || !Number.isFinite(launch[key]))) return false;
  }
  for (const key of ['longitudeDeg', 'launchRodAimDeg', 'timeStepS']) {
    if (launch[key] != null && (typeof launch[key] !== 'number' || !Number.isFinite(launch[key]))) return false;
  }
  if (launch['launchGuideAllowance'] !== undefined && typeof launch['launchGuideAllowance'] !== 'boolean') return false;
  if (launch['geodeticMethod'] !== undefined && (typeof launch['geodeticMethod'] !== 'string'
    || !['flat', 'spherical', 'wgs84'].includes(launch['geodeticMethod']))) return false;
  if (launch['windLevels'] !== undefined && !validWindLevels(launch['windLevels'])) return false;
  if (launch['windProfileSource'] !== undefined
    && (!Array.isArray(launch['windLevels']) || !launch['windLevels'].length
      || !validWindProfileSource(launch['windProfileSource']))) return false;
  return v['weather'] === null || validWeatherSnapshot(v['weather']) !== null;
}
