import notes from '../data/motorStatusNotes.json';
import { useCatalogue } from './useCatalogue.js';

/** "TRF post 1956714" from a rocketryforum.com permalink; the URL itself otherwise. */
function sourceLabel(url: string): string {
  const post = /\/posts\/(\d+)\/?$/.exec(url)?.[1];
  return post === undefined ? url : `TRF post ${post}`;
}

/** Interim evidence, separate from ThrustCurve's catalogue availability. */
export function MotorStatusNote({ motorId }: { motorId?: string }) {
  const catalogue = useCatalogue();
  if (!motorId || !Object.hasOwn(notes, motorId)) return null;
  // A live upstream correction retires the interim claim about regular status.
  if (catalogue.find((motor) => motor.motorId === motorId)?.availability !== 'regular') return null;
  const note = notes[motorId as keyof typeof notes];
  // The claim reads first and the sources follow it, each named by its forum post.
  return (
    <p className="motor-status-note">
      <strong>Status note:</strong>{' '}
      <span className="motor-status-note-text">{note.text}</span>{' '}
      {note.sources.length === 1 ? 'Source: ' : 'Sources: '}
      {note.sources.map((source, index) => (
        <span key={source.url}>
          {index > 0 && ', '}
          <a href={source.url} target="_blank" rel="noopener noreferrer"
            aria-label={`${sourceLabel(source.url)}, ${source.date}, source for the ${note.designation} status note`}>
            {sourceLabel(source.url)}
          </a>
        </span>
      ))}
      .
    </p>
  );
}
