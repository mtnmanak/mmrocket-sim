import { fmtSi, type Quantity, type UnitSelection } from '../prefs/units.js';
import type { SimRun } from './simReport.js';

interface RunColumn {
  id: string;
  label: string;
  quantity?: Quantity;
  unit?: string;
  loadWindow?: boolean;
  value: (run: SimRun) => unknown;
}

/** N058: only recorded, sustainer/stack summaries; no new flight statistics. */
export const RUN_SUMMARY_COLUMNS: RunColumn[] = [
  { id: 'maxAltitude', label: 'Apogee', quantity: 'altitude', value: r => r.maxAltitude },
  { id: 'maxVelocity', label: 'Max V', quantity: 'velocity', value: r => r.maxVelocity },
  { id: 'optimumDelayS', label: 'Opt. delay', unit: 's', value: r => r.optimumDelayS },
  { id: 'recommendedDelayS', label: 'Recommended delay', unit: 's', value: r => r.recommendedDelayS },
  { id: 'rodExitVelocity', label: 'Rod exit', quantity: 'velocity', value: r => r.rodExitVelocity },
  { id: 'maxMach', label: 'Max Mach', value: r => r.maxMach },
  { id: 'maxAcceleration', label: 'Max acceleration', quantity: 'acceleration', value: r => r.maxAcceleration },
  { id: 'timeToApogee', label: 'Time to apogee', unit: 's', value: r => r.timeToApogee },
  { id: 'timeToBurnout', label: 'Time to first burnout', unit: 's', value: r => r.timeToBurnout },
  { id: 'timeToRodDeparture', label: 'Time to guide exit', unit: 's', value: r => r.timeToRodDeparture },
  { id: 'velocityAtDeployment', label: 'First deployment speed', quantity: 'velocity', value: r => r.velocityAtDeployment },
  { id: 'altitudeAtDeployment', label: 'First deployment altitude', quantity: 'altitude', value: r => r.altitudeAtDeployment },
  { id: 'groundHitVelocity', label: 'Ground-hit speed', quantity: 'velocity', value: r => r.groundHitVelocity },
  { id: 'landingRate', label: 'Final descent rate', quantity: 'velocity', value: r => r.landingRate },
  { id: 'totalFlightTime', label: 'Flight time', unit: 's', value: r => r.totalFlightTime },
  { id: 'landingDistanceM', label: 'Landing drift', quantity: 'distance', value: r => r.landingDistanceM },
  { id: 'landingBearingDeg', label: 'Landing bearing', unit: '°', value: r => r.landingBearingDeg },
  { id: 'maxRollRateRadS', label: 'Max absolute roll rate', unit: 'rad/s', value: r => r.maxRollRateRadS },
  { id: 'launchMass', label: 'Launch mass', quantity: 'mass', value: r => r.launchMass },
  { id: 'burnoutMass', label: 'Recovery mass', quantity: 'mass', value: r => r.burnoutMass },
  { id: 'launchCG', label: 'Launch CG', quantity: 'length', value: r => r.launchCG },
  { id: 'launchCP', label: 'Launch CP', quantity: 'length', value: r => r.launchCP },
  { id: 'launchStaticMarginCal', label: 'Launch stability', unit: 'cal', value: r => r.launchStaticMarginCal },
  { id: 'launchStaticMarginPct', label: 'Launch stability by length', unit: '%', value: r => r.launchStaticMarginPct },
  { id: 'rodExitAoa', label: 'Guide exit angle of attack', quantity: 'angle', value: r => r.rodExitAoa },
  { id: 'thrustToWeightAtRod', label: 'Thrust / weight at guide exit', value: r => r.thrustToWeightAtRod },
  { id: 'maxQ', label: 'Max dynamic pressure (ascent)', loadWindow: true, quantity: 'pressure', value: r => r.loads?.maxQ?.value },
  { id: 'maxQAlpha', label: 'Max q·α (ascent)', loadWindow: true, quantity: 'pressure', unit: '·rad', value: r => r.loads?.maxQAlpha?.value },
  { id: 'maxQTime', label: 'Time at max Q (ascent)', loadWindow: true, unit: 's', value: r => r.loads?.maxQ?.time },
  { id: 'maxQAltitude', label: 'Altitude at max Q (ascent)', loadWindow: true, quantity: 'altitude', value: r => r.loads?.maxQ?.altitude },
  { id: 'maxQMach', label: 'Mach at max Q (ascent)', loadWindow: true, value: r => r.loads?.maxQ?.mach },
  { id: 'maxQAoa', label: 'Angle of attack at max Q (ascent)', loadWindow: true, quantity: 'angle', value: r => r.loads?.maxQ?.aoa },
  { id: 'maxQAlphaTime', label: 'Time at max q·α (ascent)', loadWindow: true, unit: 's', value: r => r.loads?.maxQAlpha?.time },
  { id: 'maxQAlphaAltitude', label: 'Altitude at max q·α (ascent)', loadWindow: true, quantity: 'altitude', value: r => r.loads?.maxQAlpha?.altitude },
  { id: 'maxQAlphaMach', label: 'Mach at max q·α (ascent)', loadWindow: true, value: r => r.loads?.maxQAlpha?.mach },
  { id: 'maxQAlphaAoa', label: 'Angle of attack at max q·α (ascent)', loadWindow: true, quantity: 'angle', value: r => r.loads?.maxQAlpha?.aoa },
];

export const DEFAULT_RUN_COLUMNS = ['maxAltitude', 'maxVelocity', 'optimumDelayS', 'rodExitVelocity'];

export function normalizeRunColumns(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return undefined;
  const known = new Set(RUN_SUMMARY_COLUMNS.map(c => c.id));
  return [...new Set(value.filter(v => known.has(v)))];
}

export function summaryCell(column: RunColumn, run: SimRun, units: UnitSelection): string {
  const value = column.value(run);
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (column.quantity) return fmtSi(column.quantity, units[column.quantity], value);
  return column.id === 'optimumDelayS' ? `${value.toFixed(1)}s` : String(Math.round(value * 1000) / 1000);
}
