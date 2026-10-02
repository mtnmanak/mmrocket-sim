import { useId } from 'react';
import { coordinateLabel } from '../services/coordinates.js';
import type { FileLongitudeCheck } from '../services/longitudeCheck.js';
import type { LaunchConditions } from '../services/launchConditions.js';

export interface LongitudeReview { evidence: FileLongitudeCheck; applied: boolean }

/** Like the gust chip: a suggestion, a deliberate write, and a reversible receipt. */
export function LongitudeCheck({ value, onChange, review, onReview }: {
  value: LaunchConditions;
  onChange: (value: LaunchConditions) => void;
  review: LongitudeReview;
  onReview: (review: LongitudeReview | null) => void;
}) {
  const lineId = useId();
  const { evidence, applied } = review;
  const original = evidence.opened.longitudeDeg;
  const flipped = -original;
  if (value.longitudeDeg !== (applied ? flipped : original)) return null;
  const side = original < 0 ? 'west' : 'east';
  // A full-precision label, using the same hemisphere helper as the fields.
  const label = (n: number) => coordinateLabel(n, 'longitude', (String(n).split('.')[1] ?? '').length);
  return (
    <div className="gust-estimate">
      <span id={lineId} role="status">
        {applied ? <>Set to {flipped} (the file said {original > 0 ? '+' : ''}{original})</>
          : <>Longitude {label(original)} — this file’s other simulations put the site {label(evidence.sibling.longitudeDeg)}.</>}
      </span>
      <button type="button" className="file-btn" aria-describedby={lineId} onClick={() => {
        onChange({ ...value, longitudeDeg: applied ? original : flipped });
        onReview({ evidence, applied: !applied });
      }}>{applied ? 'Put it back' : `Use ${flipped}`}</button>
      {!applied && <button type="button" className="file-btn" onClick={() => onReview(null)}>Keep {side}</button>}
    </div>
  );
}
