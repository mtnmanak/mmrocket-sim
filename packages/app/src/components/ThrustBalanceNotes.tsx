import type { EngineWarning } from '@online-openrocket/engine';
import { formatWarning } from '../services/simWarnings.js';
import { Note, NoteLabel, noteClass } from './Note.js';

const thrustWarnings = (warnings: readonly EngineWarning[]) => warnings.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_'));

export function ThrustBalanceNotes({ warnings }: { warnings: readonly EngineWarning[] }) {
  return <div role="status" aria-live="polite" aria-atomic="true">{thrustWarnings(warnings).map((warning, i) => {
    const shown = formatWarning(warning);
    return <Note key={`${warning.key}:${i}`} as="p" tier={shown.tier}>
      <strong>{shown.label}.</strong> {shown.detail}
    </Note>;
  })}</div>;
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
