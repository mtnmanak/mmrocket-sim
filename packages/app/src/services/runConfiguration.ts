import { changedSinceRun, listAnd, type DesignMatchKey, type SimRun } from './simReport.js';
import { describeRecordedOverride } from './flightOverrideSummary.js';

type ConfigurationRecord = Pick<SimRun, 'flightConfig' | 'flightConfigId' | 'flightOverrides' | 'batch'>;

export function runConfigurationLabel(run: ConfigurationRecord): string {
  if (run.flightConfig === undefined) return '—';
  return `${run.batch ? 'Batch · ' : ''}${run.flightConfig}`;
}

export function runOverrideText(run: ConfigurationRecord, unit: string): string {
  if (run.flightOverrides === undefined) return 'not recorded';
  if (!run.flightOverrides.length) return 'none';
  return run.flightOverrides.map(r => `${r.partName}: ${describeRecordedOverride(r, 'flies', unit)} (own: ${describeRecordedOverride(r, 'own', unit)})`).join('; ');
}

export function runConfigurationHeading(run: ConfigurationRecord, unit: string): string {
  if (run.flightConfig === undefined) return 'Configuration not recorded';
  const flown = run.batch ? `Batch from “${run.flightConfig}”`
    : !run.flightConfigId && run.flightConfig === 'none' ? 'Flown with no configuration'
    : !run.flightConfigId && run.flightConfig === 'working settings' ? 'Flown with working settings' : `Flown in “${run.flightConfig}”`;
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
