import notes from '../data/motorStatusNotes.json';
import { useCatalogue } from './useCatalogue.js';

/** Interim evidence, separate from ThrustCurve's catalogue availability. */
export function MotorStatusNote({ motorId }: { motorId?: string }) {
  const catalogue = useCatalogue();
  if (!motorId || !Object.hasOwn(notes, motorId)) return null;
  // A live upstream correction retires the interim claim about regular status.
  if (catalogue.find((motor) => motor.motorId === motorId)?.availability !== 'regular') return null;
  const note = notes[motorId as keyof typeof notes];
  return (
    <p className="motor-status-note">
      <strong>Status note:</strong>{' '}
      {note.sources.map((source, index) => (
        <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer"
          aria-label={`Status source ${index + 1} for ${note.designation}, ${source.date}`}>
          {index === 0 ? 'Source' : `; source ${index + 1}`}
        </a>
      ))}
      {' — '}{note.text}
    </p>
  );
}
