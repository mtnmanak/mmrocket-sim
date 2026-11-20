import type { EngineWarning } from '@online-openrocket/engine';
import { formatWarning } from '../services/simWarnings.js';
import { Note, NoteLabel, noteClass } from './Note.js';

const thrustWarnings = (warnings: readonly EngineWarning[]) => warnings.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_'));
const fitWarnings = (warnings: readonly EngineWarning[]) => warnings.filter(w => w.key === 'MOTOR_TOO_LONG' || w.key === 'MOTOR_TOO_WIDE');

export function ThrustBalanceNotes({ warnings }: { warnings: readonly EngineWarning[] }) {
  return <div role="status" aria-live="polite" aria-atomic="true">{thrustWarnings(warnings).map((warning, i) => {
    const shown = formatWarning(warning);
    return <Note key={`${warning.key}:${i}`} as="p" tier={shown.tier}>
      <strong>{shown.label}.</strong> {shown.detail}
    </Note>;
  })}</div>;
}

/** Ruling 153/156: a motor that does not fit its mount is marked on its Batch row, beside the verdict, without changing it. */
export function MotorFitMark({ warnings }: { warnings: readonly EngineWarning[] }) {
  const shown = fitWarnings(warnings).map(w => formatWarning(w));
  if (!shown.length) return null;
  const text = shown.map(w => `${w.label}. ${w.detail ?? ''}`).join(' ');
  return <details className={noteClass('caution')}>
    <summary><NoteLabel tier="caution" />motor fit</summary>
    <p>{text}</p>
  </details>;
}

/** A warning beside the verdict, independent of the row's acceptance grade. */
export function ThrustBalanceMark({ warnings }: { warnings: readonly EngineWarning[] }) {
  const shown = thrustWarnings(warnings).map(w => formatWarning(w));
  if (!shown.length) return null;
  const tier = shown.some(w => w.tier === 'danger') ? 'danger' : 'caution';
  const text = shown.map(w => `${w.label}. ${w.detail ?? ''}`).join(' ');
  return <details className={noteClass(tier)}>
    <summary><NoteLabel tier={tier} />thrust balance</summary>
    <p>{text}</p>
  </details>;
}
