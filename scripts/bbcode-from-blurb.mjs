#!/usr/bin/env node
/**
 * Convert an EDITED plain-text TRF blurb into BBCode for pasting into XenForo.
 *
 * The publishing loop (Eric, 2026-08-27):
 *
 *     Claude drafts plain .txt  →  Eric edits the .txt in place  →  hands it back
 *       →  this script produces the BBCode  →  Eric posts it.
 *
 * BBCode is painful to edit, so it is only ever generated from finished copy, and it
 * is generated rather than hand-written so the two files cannot drift. **The .txt is
 * the source of truth.** If anything needs changing after the BBCode exists, change
 * the .txt and re-run this — never edit the BBCode directly.
 *
 * The conversion is MARKUP ONLY. It never touches wording, spelling or punctuation:
 * Eric's edited text is the posted text. (When he explicitly asks for a typo fix, fix
 * it in the .txt and re-run, so both files carry it.)
 *
 * TRF (XenForo) REFUSES A POST OVER 10,000 CHARACTERS. The count that matters is the BBCode,
 * which runs ~1.2 % longer than the plain text, so the practical ceiling on a draft is about
 * 9,800 plain characters. This script fails rather than writing something unpostable.
 *
 * SPLITTING, when a post does not fit: break on CONTENT, not on release number. Releases do
 * not group meaningfully — v0.073 and v0.075 both moved users' numbers, v0.072 and v0.074 were
 * both fixes — so a release split scatters the urgent warnings across two posts. Put whatever
 * the reader must not miss in the SHORT first post: a 3.5k post is read to the end, a 7.8k one
 * is skimmed. Name the parts "<stem> (1 of 2).txt" and "(2 of 2).txt", add a one-line pointer
 * at the foot of the first and a one-line "Continued from the post above" at the head of the
 * second, and change NOTHING else — the parts must rejoin to Eric's edited text word for word.
 *
 * Usage:
 *   node scripts/bbcode-from-blurb.mjs "docs/TRF Blurbs/TRF Blurb - 2026-08-27 v0.072-v0.075.txt"
 *
 * Writes "<same name> BBCODE.txt" beside the input, checks tag balance, and checks the length.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A section header is a bullet line that names a release: `- UI Changes (V0.074)`.
 * These read as headings, not list items — a one-item [LIST] renders wrong — so they
 * become bold lines, matching the `**Not fixed yet**` heading style Eric already uses.
 * Every OTHER `- ` line is a genuine list item.
 */
const isHeader = (l) => /^- .+\(V0\.\d{3}\)\s*$/.test(l);

/** `**bold**` is the only inline markup the blurbs use. */
const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '[B]$1[/B]');

export function toBBCode(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const isItem = line.startsWith('- ') && !isHeader(line);
    if (isItem) {
      // Contiguous `- ` lines become ONE list; a blank line or prose closes it.
      if (!inList) { out.push('[LIST]'); inList = true; }
      out.push('[*]' + bold(line.slice(2)));
      continue;
    }
    if (inList) { out.push('[/LIST]'); inList = false; }
    if (isHeader(line)) { out.push('[B]' + bold(line.slice(2)) + '[/B]'); continue; }
    // A line that is nothing but **…** is a heading in its own right.
    if (/^\*\*.+\*\*$/.test(line.trim())) { out.push(bold(line.trim())); continue; }
    if (/^https?:\/\/\S+$/.test(line.trim())) { out.push('[URL]' + line.trim() + '[/URL]'); continue; }
    out.push(bold(line));
  }
  if (inList) out.push('[/LIST]');
  return out.join('\n');
}

/** Unbalanced tags are the one failure mode that silently ruins a post. */
export function checkTags(bb) {
  const n = (re) => (bb.match(re) || []).length;
  const problems = [];
  for (const [open, close, o, c] of [
    [/\[LIST\]/g, /\[\/LIST\]/g, 'LIST', '/LIST'],
    [/\[B\]/g, /\[\/B\]/g, 'B', '/B'],
    [/\[URL\]/g, /\[\/URL\]/g, 'URL', '/URL'],
  ]) {
    if (n(open) !== n(close)) problems.push(`[${o}] ${n(open)} vs [${c}] ${n(close)}`);
  }
  if (/\*\*/.test(bb)) problems.push('leftover ** (markdown bold that did not convert)');
  const stray = bb.split('\n').filter((l) => l.startsWith('- ')).length;
  if (stray) problems.push(`${stray} line(s) still start with "- " (not converted to [*])`);
  return problems;
}

/** XenForo's hard cap, counted in CHARACTERS of the BBCode. */
export const TRF_POST_LIMIT = 10000;

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/bbcode-from-blurb.mjs "<path to the edited .txt>"');
  process.exit(1);
}
const dst = src.replace(/\.txt$/i, '') + ' BBCODE.txt';
const bb = toBBCode(readFileSync(src, 'utf8'));
// Checked BEFORE writing, deliberately: an over-limit BBCode file left on disk looks
// exactly like a postable one, and sooner or later somebody pastes it.
if (bb.length > TRF_POST_LIMIT) {
  console.error(
    `TOO LONG FOR TRF: ${bb.length} chars against a ${TRF_POST_LIMIT} limit `
    + `(over by ${bb.length - TRF_POST_LIMIT}). Nothing was written.\n`
    + 'Split it — see SPLITTING in this file\'s header: break on content, not release number,\n'
    + 'and put what the reader must not miss in the short first post.');
  process.exit(1);
}

const problems = checkTags(bb);
if (problems.length) {
  console.error('TAG PROBLEMS (nothing written):\n  ' + problems.join('\n  '));
  process.exit(1);
}

writeFileSync(dst, bb, 'utf8');
console.log(`wrote ${dst} (${bb.length} chars, ${Buffer.byteLength(bb)} bytes)`);
console.log(`tags balanced; fits TRF's ${TRF_POST_LIMIT}-char limit — ${TRF_POST_LIMIT - bb.length} to spare.`);
