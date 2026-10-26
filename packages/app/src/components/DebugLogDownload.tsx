import { useId, useState } from 'react';
import { sessionDebugLog } from '../services/sessionDebugLog.js';
import { saveFile, saveOutcomeNote } from '../services/saveFile.js';
import { Note } from './Note.js';

/** C-H3: the same local export and privacy explanation in Feedback and crash panels. */
export function DebugLogDownload() {
  const description = useId();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const download = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    try {
      sessionDebugLog.record('debug-log-download');
      const outcome = await saveFile(sessionDebugLog.text(), {
        suggestedName: 'mmrocket-sim-session-debug.txt', mime: 'text/plain;charset=utf-8',
        extensions: ['.txt'], description: 'Session debug log',
      });
      setNote(saveOutcomeNote(outcome)?.text ?? null);
    } catch {
      setNote('The debug log could not be downloaded. Try again, or describe the problem in your report.');
    } finally { setBusy(false); }
  };
  return <div className="debug-log-download" onClick={e => e.stopPropagation()}>
    <button className="file-btn" disabled={busy} aria-describedby={description}
      onClick={() => { void download(); }}>Download session debug log</button>
    <Note as="p" id={description} tier="information" className="comp-stats">
      Contains the app version, browser UA, viewport size, display, unit, aerodynamics, tour and configuration-sort
      preferences, elapsed app events and privacy-filtered errors from this tab. No design, file names or contents,
      coordinates or weather searches. Keeps up to the last 200 events in memory until reload; the file is at most 64 KiB, so long messages can push older events out sooner.
      It leaves your browser only if you attach it to a report or email. Unknown messages and error stacks are omitted;
      errors before capture loaded are unavailable.
    </Note>
    <div role="status">{note && <p className="comp-stats">{note}</p>}</div>
  </div>;
}
