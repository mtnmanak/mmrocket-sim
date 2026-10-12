import { changedSinceRun, listAnd, type DesignMatchKey, type SimRun } from './simReport.js';
import { describeRecordedOverride } from './flightOverrideSummary.js';

type ConfigurationRecord = Pick<SimRun, 'flightConfig' | 'flightConfigId' | 'flightOverrides' | 'batch' | 'importedSummary' | 'importedConfigVerified'>;

/** Old imports may have put the simulation name here, even with an unmatched ID. */
export function recordedConfiguration(run: ConfigurationRecord): string | undefined {
  if (run.importedSummary && (run.importedConfigVerified !== true || !run.flightConfigId)) return undefined;
  return run.flightConfig;
}

/**
 * The special labels a flight with no saved configuration records ('none',
 * 'working settings') are not configuration names. A Batch row quoted them as
 * one — "Batch from “none”" — so Batch words them itself (review of b9-int).
 */
const unsaved = (run: ConfigurationRecord, label: 'none' | 'working settings') =>
  !run.flightConfigId && run.flightConfig === label;

export function runConfigurationLabel(run: ConfigurationRecord): string {
  const configuration = recordedConfiguration(run);
  if (configuration === undefined) return '—';
  if (!run.batch) return configuration;
  return `Batch · ${unsaved(run, 'none') ? 'no configuration' : configuration}`;
}

export function runOverrideText(run: ConfigurationRecord, unit: string): string {
  if (run.flightOverrides === undefined) return 'not recorded';
  if (!run.flightOverrides.length) return 'none';
  return run.flightOverrides.map(r => `${r.partName}: ${describeRecordedOverride(r, 'flies', unit)} (own: ${describeRecordedOverride(r, 'own', unit)})`).join('; ');
}

export function runConfigurationHeading(run: ConfigurationRecord, unit: string): string {
  const configuration = recordedConfiguration(run);
  if (configuration === undefined) return 'Configuration not recorded';
  if (unsaved(run, 'none')) return run.batch ? 'Batch with no configuration' : 'Flown with no configuration';
  const flown = unsaved(run, 'working settings') ? `${run.batch ? 'Batch' : 'Flown'} with working settings`
    : run.batch ? `Batch from “${configuration}”` : `Flown in “${configuration}”`;
  if (!run.flightOverrides?.length) return `${flown} · overrides: ${run.flightOverrides ? 'none' : 'not recorded'}`;
  const groups = new Map<string, { count: number; kind: string; value: string }>();
  for (const record of run.flightOverrides) {
    const value = describeRecordedOverride(record, 'flies', unit);
    const key = JSON.stringify([record.family, record.kind, value]);
    const group = groups.get(key) ?? { count: 0, kind: record.kind, value };
    group.count++;
    groups.set(key, group);
  }
  return `${flown} · overrides: ${[...groups.values()].map(g => `${g.count} ${g.kind}${g.count === 1 ? '' : 's'} at ${g.value}`).join('; ')}`;
}

/** Use the same provenance comparison as the selected report and replay guard. */
export function runStatus(run: SimRun, current: DesignMatchKey | null) {
  const changed = changedSinceRun(run, current);
  return changed === null ? { label: 'Unknown', title: 'Not recorded or cannot compare' }
    : changed.length ? { label: 'Changed', title: `${listAnd(changed)} changed since this flight` }
    : { label: 'Current', title: 'Matches the design, motors and launch conditions' };
}
