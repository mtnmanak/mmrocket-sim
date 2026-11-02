import { cautionNote } from './importNotes.js';
import { noteField } from './noteField.js';

/** Format sentinels must be resolved before calling this with a delay in seconds. */
export function importedEjectionDelay(value: number, notes: string[], motor: string, stated = String(value)): number {
  if (!(value < 0)) return value;
  const message = `Motor ${noteField(motor)}: the saved ejection delay ${noteField(stated)} s is negative; `
    + 'it is read as 0 s, so the ejection charge fires at burnout. Recovery set to that charge can open '
    + 'while the rocket is still moving fast. Check the delay before flying.';
  if (!notes.includes(message)) cautionNote(notes, 'I11.negative-delay', message);
  return 0;
}
