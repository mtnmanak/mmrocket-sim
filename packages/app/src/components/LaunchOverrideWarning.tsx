import type { FlightOverrideSummary } from '../services/flightOverrideSummary.js';

export interface LaunchOverrideProps {
  overrideSummary?: FlightOverrideSummary | null;
  onShowOverride?: (target: FlightOverrideSummary['first']) => void;
}

/** Persistent flight state, not a dismissible notice. The full description is never title-only. */
export function LaunchOverrideWarning({ id, summary, onShow, compact = false }: {
  id: string; summary: FlightOverrideSummary | null | undefined;
  onShow: LaunchOverrideProps['onShowOverride']; compact?: boolean;
}) {
  if (!summary) return null;
  return <div className={`launch-override-warning launch-override-callout${compact ? ' launch-override-compact' : ''}`}>
    <span className="launch-override-icon" aria-hidden="true">⚠</span>{' '}
    {compact && <span className="launch-override-short" aria-hidden="true">{summary.shortText}</span>}
    <span id={id} className={compact ? 'sr-only' : undefined}>{summary.text}</span>
    {' '}<button type="button" className="file-btn" onClick={() => onShow?.(summary.first)}
      aria-describedby={id}>Show</button>
  </div>;
}
