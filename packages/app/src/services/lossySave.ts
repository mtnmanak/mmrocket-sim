import type { DesignFileRef } from './designFileName.js';
import { formatExtension, type FormatLossReport } from './formatLoss.js';

/** Synchronous on purpose: a clean gate must preserve the picker’s click activation. */
export function gateLossySave(report: FormatLossReport, save: () => void, show: (report: FormatLossReport) => void): void {
  if (report.refused || report.losses.length) show(report);
  else save();
}
export interface LossySaveMark { mark: string; flights: number; format: 'rkt' | 'cdx1'; lossCount: number }
/** Autosave provenance, accepted only for the saved file and snapshot it describes. */
export function validLossySaveMark(value: unknown, file: DesignFileRef | undefined, current: string): LossySaveMark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !file || file.via === 'opened') return null;
  const v = value as Partial<LossySaveMark>;
  if ((v.format !== 'rkt' && v.format !== 'cdx1') || v.format !== file.format || v.mark !== current
    || !Number.isSafeInteger(v.flights) || v.flights! < 0 || !Number.isSafeInteger(v.lossCount) || v.lossCount! < 0) return null;
  return { mark: current, flights: v.flights!, format: v.format, lossCount: v.lossCount! };
}
export function lossySaveStatus(saved: LossySaveMark | null, current: string, flights: number): string | null {
  if (!saved) return null;
  if (saved.mark !== current || saved.flights !== flights) return 'Unsaved changes';
  const ext = formatExtension(saved.format);
  return saved.lossCount ? `Saved as ${ext} — ${saved.lossCount} not kept` : `Saved as ${ext}, not .ork`;
}
export function replacementLossNote(file: DesignFileRef | null, report: FormatLossReport | null): string | null {
  if (!file || file.format === 'ork' || !report?.losses.length || report.format !== file.format) return null;
  return `You ${file.via === 'opened' ? 'opened' : 'saved'} “${file.name}”, but it does not keep: `
    + report.losses.slice(0, 3).join('; ') + (report.losses.length > 3 ? '…' : '');
}
