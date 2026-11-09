import { displayEcho } from './filenameEcho.js';
import { noteField, noteText } from '../../app/src/services/noteField.js';

/** Per-entry bound: the structured aggregate is rebuilt without a combined cut. */
export const NOTE_ECHO_MAX = 4000;
/** Warning messages may contain names without quotes; bound the entire message. */
export const WARNING_ECHO_MAX = 1000;
/** Strip file line controls; only structured note boundaries add newlines. */
export function noteEcho(text: string, max = NOTE_ECHO_MAX): string {
  const points = Array.from(text);
  const cut = points.length > max ? points.slice(0, max - 1).join('').replace(/\[(?:U(?:\+(?:[0-9A-F]*))?)?$/, '') + '\u2026' : text;
  const safe = noteText(cut);
  if (Array.from(safe).length <= max) return safe;
  let shown = '';
  let size = 0;
  for (const token of safe.match(/\[U\+[0-9A-F]+\]|[^]/gu) ?? []) {
    const length = token.startsWith('[U+') ? token.length : 1;
    if (size + length >= max) break;
    shown += token;
    size += length;
  }
  return shown + '\u2026';
}
/** Notes have nested groups and line arrays; no importer-specific shape can skip the boundary. */
export function noteStrings<T>(value: T): T {
  if (typeof value === 'string') return noteEcho(value) as T;
  if (Array.isArray(value)) return value.map(item => noteStrings(item)) as T;
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'part' && typeof item === 'string' ? warningName(item)
        : key === 'configuration' && typeof item === 'string' ? displayEcho(item) : noteStrings(item)]));
    const group = result.group as { heading?: string; lines?: { text: string }[] } | undefined;
    if (typeof result.text === 'string' && Array.isArray(group?.lines)) {
      const raw = value as unknown as { text: string; group: { heading?: string; lines: { text: string }[] } };
      const entries = [...(raw.group.heading === undefined ? [] : [raw.group.heading]), ...raw.group.lines.map(line => line.text)];
      let at = 0;
      let text = '';
      let aligned = true;
      for (const [i, entry] of entries.entries()) {
        const start = raw.text.indexOf(entry, at + (i ? 1 : 0));
        const gap = raw.text.slice(at, start);
        if (start < at || (i ? !/^\n+$/.test(gap) : !/^\n*$/.test(gap))) { aligned = false; break; }
        text += gap + noteEcho(entry);
        at = start + entry.length;
      }
      // Empty entries are absent from the display group, but remain in the app's text.
      result.text = aligned && /^\n*$/.test(raw.text.slice(at)) ? text + raw.text.slice(at)
        : [group.heading, ...group.lines.map(line => line.text)].filter(item => item !== undefined).join('\n');
    }
    return result as T;
  }
  return value;
}

/** A quoted name: a straight "\u2026" pair, or \u201c\u2026\u201d paired by direction; an opening quote with no close runs to the end. */
const NAME_SPAN = /"([^"]*)("|$)|\u201c([^\u201d]*)(\u201d|$)/g;
/** Project source metadata exactly as quoted warning names will be shown. */
export function warningName(name: string): string {
  // Supply the delimiters used in messages so boundary ASCII joiners are
  // marked here too, before either carrier is sanitized again.
  return noteEcho(noteField(`"${displayEcho(name)}"`).slice(1, -1), 200);
}
/**
 * Bound each quoted name to the display rule and the whole message to WARNING_ECHO_MAX.
 * App text outside a span is cut only by the message bound: \u2019 is the app's own
 * apostrophe, so single quotes delimit nothing. A name that itself holds a closing
 * quote splits its span, and the part outside is held only by the message bound.
 */
export function warningEcho(text: string): string {
  return noteEcho(text.replace(NAME_SPAN, (_span: string, straight: string | undefined, straightEnd: string | undefined,
    curly: string | undefined, curlyEnd: string | undefined) => straight !== undefined
    ? `"${noteEcho(noteField(straight), 200)}${straightEnd ?? ''}` : `\u201c${noteEcho(noteField(curly ?? ''), 200)}${curlyEnd ?? ''}`), WARNING_ECHO_MAX);
}
