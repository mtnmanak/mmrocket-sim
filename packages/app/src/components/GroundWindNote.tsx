import { usePrefs } from '../prefs/PrefsContext.js';
import { groundWindAdvice } from '../services/flightAdvisories.js';
import { Note } from './Note.js';

/** N004: the same surface advisory beside conditions on Motors and phone Fly. */
export function GroundWindNote({ wind }: { wind: number }) {
  const { prefs } = usePrefs();
  const advice = groundWindAdvice(wind, prefs.units);
  return advice ? <Note tier="caution" as="p" className="comp-stats"
    style={{ gridColumn: '1 / -1', margin: 0 }}>{advice}</Note> : null;
}
