import type { DesignFileRef } from './designFileName.js';
import { formatExtension, type CheckedFormatLossReport, type FormatLossReport } from './formatLoss.js';

/** Synchronous on purpose: a clean gate must preserve the picker’s click activation. */
export function gateLossySave(report: FormatLossReport, save: () => void, show: (report: FormatLossReport) => void): void {
  if (report.refused || report.losses.length) show(report);
  else save();
}
/** `incomplete`: the loss check did not finish, so lossCount is not a count of what the file lost. */
export interface LossySaveMark { mark: string; flights: number; format: 'rkt' | 'cdx1'; lossCount: number; incomplete?: true }
/** Autosave provenance, accepted only for the saved file and snapshot it describes. */
export function validLossySaveMark(value: unknown, file: DesignFileRef | undefined, current: string): LossySaveMark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !file || file.via === 'opened') return null;
  const v = value as Partial<LossySaveMark>;
  if ((v.format !== 'rkt' && v.format !== 'cdx1') || v.format !== file.format || v.mark !== current
    || !Number.isSafeInteger(v.flights) || v.flights! < 0 || !Number.isSafeInteger(v.lossCount) || v.lossCount! < 0) return null;
  return { mark: current, flights: v.flights!, format: v.format, lossCount: v.lossCount!, ...(v.incomplete === true ? { incomplete: true } : {}) };
}
export function lossySaveStatus(saved: LossySaveMark | null, current: string, flights: number): string | null {
  if (!saved) return null;
  if (saved.mark !== current || saved.flights !== flights) return 'Unsaved changes';
  const ext = formatExtension(saved.format);
  if (saved.incomplete) return `Saved as ${ext} — not fully checked`;
  return saved.lossCount ? `Saved as ${ext} — ${saved.lossCount} not kept` : `Saved as ${ext}, not .ork`;
}
export function replacementLossNote(file: DesignFileRef | null, report: CheckedFormatLossReport | null): string | null {
  if (!file || file.format === 'ork' || !report?.losses.length || report.format !== file.format) return null;
  const named = `You ${file.via === 'opened' ? 'opened' : 'saved'} “${file.name}”`;
  // A check that did not finish has no list, only its one sentence saying so.
  if (report.incomplete) return `${named}. ${report.losses[0]!}`;
  return `${named}, but it does not keep: `
    + report.losses.slice(0, 3).join('; ') + (report.losses.length > 3 ? '…' : '');
}
