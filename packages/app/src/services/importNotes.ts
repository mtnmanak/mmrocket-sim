import type { NoteTier } from '../components/Note.js';

/**
 * PER-LINE CONSEQUENCE TIERS FOR FILE-OPEN AND RESTORE NOTES (D7 §4, Eric
 * 2026-10-12, ruling 3).
 *
 * An open's note used to be one string with one severity for the whole box,
 * so a routine translation and a dropped flight input looked the same. Each
 * line is now an entry whose tier is set by the PRODUCER, at the point the
 * condition is known — never inferred by reading the English afterwards. A
 * line nobody flagged is Information, whatever it says: that is how a stored
 * or replayed plain string (an older autosave, a motor's persisted openNote)
 * renders, and why rewording a message can never change its tier.
 *
 * WHY A SIDE RECORD AND NOT A NEW ARRAY TYPE. The three readers and the tree
 * normaliser share `notes: string[]` with dozens of helpers and hundreds of
 * test assertions; a flagged line is pushed into that same array AND recorded
 * against it here (`flagNote`), so every existing reader of the text is
 * untouched. The reader hands its records across with `noteFlags(notes)`, and
 * `tierLines` pairs each record with ITS OWN pushed line — an identity join on
 * the exact string the producer wrote in the same call, consumed once per
 * occurrence, not a search for words.
 */
export interface ImportNote {
  /** Stable producer kind (R6 id plus a slug); N046 shows typed codes beside the line. */
  kind: string;
  tier: NoteTier;
  text: string;
  /** The part the line is about, when the producer knows it. */
  part?: string;
  /** The flight configuration the line is about, when the producer knows it. */
  configuration?: string;
}

const RANK: Record<NoteTier, number> = { information: 0, caution: 1, danger: 2 };

const flags = new WeakMap<string[], ImportNote[]>();

export function zeroBulkDensityNote(notes: string[], part: string): void {
  cautionNote(notes, 'I21.zero-bulk-density', `“${part}”: zero bulk density cannot be flown by the app's engine; it uses 680 kg/m³ instead, adding mass. Saving replaces the zero density. Check the part mass before flying.`);
}

/** Push a flagged line: the text into `notes`, the entry into its record. */
export function flagNote(notes: string[], entry: ImportNote): void {
  notes.push(entry.text);
  const list = flags.get(notes);
  if (list) list.push(entry); else flags.set(notes, [entry]);
}

/** Shorthand for the common case: a Caution line of `kind`. */
export function cautionNote(notes: string[], kind: string, text: string, extra?: Pick<ImportNote, 'part' | 'configuration'>): void {
  flagNote(notes, { kind, tier: 'caution', text, ...extra });
}

/** The entries flagged against `notes` (a copy); empty when none were. */
export function noteFlags(notes: readonly string[]): ImportNote[] {
  return [...(flags.get(notes as string[]) ?? [])];
}

/** Carry `from`'s lines AND their flags onto `into` (a helper wrote into its own array). */
export function appendNotes(into: string[], from: readonly string[]): void {
  const fromFlags = noteFlags(from);
  into.push(...from);
  if (!fromFlags.length) return;
  const list = flags.get(into);
  if (list) list.push(...fromFlags); else flags.set(into, fromFlags);
}

/** Re-attach records to an array that replaced the one they were flagged on (a filter, a copy). */
export function carryFlags(into: string[], records: readonly ImportNote[]): string[] {
  if (!records.length) return into;
  const list = flags.get(into);
  if (list) list.push(...records); else flags.set(into, [...records]);
  return into;
}

/** An unflagged line: Information. */
export function infoLine(text: string, kind = 'note'): ImportNote {
  return { kind, tier: 'information', text };
}

/**
 * Each text line as an entry: the producer's record where one was flagged for
 * that exact line (each record used once), else Information.
 */
export function tierLines(texts: readonly string[], records: readonly ImportNote[] = []): ImportNote[] {
  const pool = [...records];
  return texts.map((text) => {
    const i = pool.findIndex((r) => r.text === text);
    if (i < 0) return infoLine(text);
    const [hit] = pool.splice(i, 1);
    return hit!;
  });
}

/** Legacy plain text (a stored or replayed note): every line Information. */
export function plainLines(text: string): ImportNote[] {
  return text.split('\n').filter((l) => l.length > 0).map((l) => infoLine(l));
}

export function tierRank(tier: NoteTier): number {
  return RANK[tier];
}

export function highestTier(lines: readonly Pick<ImportNote, 'tier'>[]): NoteTier {
  return lines.reduce<NoteTier>((acc, l) => (RANK[l.tier] > RANK[acc] ? l.tier : acc), 'information');
}

/** Danger, then Caution, then Information — stable within each tier. */
export function orderedLines<T extends Pick<ImportNote, 'tier'>>(lines: readonly T[]): T[] {
  return lines.map((l, i) => [l, i] as const)
    .sort(([a, i], [b, j]) => RANK[b.tier] - RANK[a.tier] || i - j)
    .map(([l]) => l);
}

/** "1 change" / "N changes". */
export function changesText(n: number): string {
  return `${n} change${n === 1 ? '' : 's'}`;
}

/**
 * A file-open/restore note as the notice bar draws it: an optional heading
 * ("Loaded “X”.") and the lines below it. `text` beside it (HeldNote, Notice)
 * stays the whole note, so everything that keys or names the note is as before.
 */
export interface NoteGroup {
  heading?: string;
  lines: ImportNote[];
}

/** The whole note's text: heading, then each line, as one string. */
export function groupText(group: NoteGroup): string {
  return [group.heading, ...group.lines.map((l) => l.text)].filter((t): t is string => !!t).join('\n');
}

/**
 * A held note's group, or — for a note written as plain text (an older
 * session's, a replayed one) — its lines as Information.
 */
export function groupOf(note: { text: string; group?: NoteGroup }): NoteGroup {
  return note.group ?? { lines: plainLines(note.text) };
}

/** The group without the lines whose text is in `drop` (identity of a line already shown). */
export function withoutLines(group: NoteGroup, drop: ReadonlySet<string>): NoteGroup {
  return { ...group, lines: group.lines.filter((l) => !drop.has(l.text)) };
}

/**
 * Rewrite one pushed line's text, keeping its record (and so its tier): the
 * open rewrites configuration labels once motors are known.
 */
export function renameNote(notes: string[], index: number, text: string): void {
  const before = notes[index];
  notes[index] = text;
  const hit = flags.get(notes)?.find((r) => r.text === before);
  if (hit) hit.text = text;
}
