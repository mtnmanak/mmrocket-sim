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
 *   npm run trf:bbcode -- "docs/TRF Blurbs/TRF Blurb - 2026-08-27 v0.072-v0.075.txt"
 *
 * Writes "<same name> BBCODE.txt" beside the input, checks tag balance, and checks the length.
 * On ANY failure nothing is written AND a stale BBCODE.txt from an earlier run is moved aside
 * to "<same name> BBCODE.OUTDATED.txt" — see quarantineStale() for why that matters.
 *
 * The CLI lives in main() behind an entry-point guard so the helpers above can be imported
 * and unit-tested; importing this module must never run the CLI or call process.exit.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * A section header is a bullet line that names a release: `- UI Changes (V0.074)`.
 * These read as headings, not list items — a one-item [LIST] renders wrong — so they
 * become bold lines, matching the `**Not fixed yet**` heading style Eric already uses.
 * Every OTHER `- ` line is a genuine list item.
 *
 * Case-insensitive on the `v`: CLAUDE.md and the blurbs write versions lowercase in prose
 * ("refresh until it reads v0.075"), so an uppercase-only match is one keystroke away from
 * silently rendering a header as a one-item list — the exact mis-render this rule exists to
 * prevent, and one checkTags cannot see because the output is well-formed either way.
 */
const isHeader = (l) => /^\s*- .+\(v0\.\d{3}\)\s*$/i.test(l);

/** A bullet line, at any indent: captures the indent and the text after `- `. */
const ITEM = /^(\s*)- (.*)$/;

/** `**bold**` is the only inline markup the blurbs use. */
const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '[B]$1[/B]');

export function toBBCode(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  /** Indent widths of the currently open [LIST]s, outermost first. */
  const open = [];
  const closeTo = (indent) => {
    while (open.length && (indent === null || indent < open[open.length - 1])) {
      out.push('[/LIST]');
      open.pop();
    }
  };
  for (const line of lines) {
    const m = ITEM.exec(line);
    if (m && !isHeader(line)) {
      // Contiguous `- ` lines become ONE list; a blank line or prose closes it. An
      // INDENTED bullet opens a nested list rather than being emitted as raw text
      // between two lists, which is what shattered the enclosing list before.
      const indent = m[1].length;
      closeTo(indent);
      if (!open.length || indent > open[open.length - 1]) { out.push('[LIST]'); open.push(indent); }
      out.push('[*]' + bold(m[2]));
      continue;
    }
    closeTo(null);
    if (isHeader(line)) { out.push('[B]' + bold(line.trim().slice(2)) + '[/B]'); continue; }
    // A line that is nothing but **…** is a heading in its own right.
    if (/^\*\*.+\*\*$/.test(line.trim())) { out.push(bold(line.trim())); continue; }
    if (/^https?:\/\/\S+$/.test(line.trim())) { out.push('[URL]' + line.trim() + '[/URL]'); continue; }
    out.push(bold(line));
  }
  closeTo(null);
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
  // Leading whitespace allowed deliberately: anchoring this at column 0 made it dead code,
  // because every column-0 `- ` line has already become [*] or [B] by the time we get here.
  // The lines it could ever catch are precisely the INDENTED ones.
  const stray = bb.split('\n').filter((l) => /^\s*- /.test(l)).length;
  if (stray) problems.push(`${stray} line(s) still start with "- " (not converted to [*])`);
  return problems;
}

/** XenForo's hard cap, counted in CHARACTERS of the BBCode. */
export const TRF_POST_LIMIT = 10000;

/** The generated file's path for a given source .txt. */
export const bbcodePathFor = (src) => src.replace(/\.txt$/i, '') + ' BBCODE.txt';

/**
 * Refuse to convert an already-converted file. Tab-completion on a blurb stem offers both
 * the .txt and its " BBCODE.txt", and re-converting the latter succeeds silently: no `**`
 * and no column-0 `- ` survive a first pass, so tag counts stay balanced and every check
 * reports success while writing a double-converted "<stem> BBCODE BBCODE.txt".
 */
export const looksAlreadyConverted = (src) => / BBCODE(\.OUTDATED)?\.txt$/i.test(src);

/**
 * Move a stale generated file aside when this run refuses to write a new one.
 *
 * Checking before writing stops a NEW unpostable file appearing, but it does nothing about
 * the one an EARLIER successful run left on disk: after an edit that pushes the draft over
 * the limit, that older file still sits beside the .txt, still fits the limit, and still
 * pastes cleanly — so the post that goes up is the previous draft. The .txt is the source of
 * truth, and a generated file that no longer matches it must not look postable.
 */
function quarantineStale(dst) {
  if (!existsSync(dst)) return null;
  const stale = dst.replace(/\.txt$/i, '') + '.OUTDATED.txt';
  if (existsSync(stale)) rmSync(stale);
  renameSync(dst, stale);
  return stale;
}

function fail(message, dst) {
  console.error(message);
  const stale = dst && quarantineStale(dst);
  if (stale) {
    console.error(
      `\nA BBCode file from an earlier run was beside it and would still have pasted cleanly.\n`
      + `Moved aside to: ${stale}\n`
      + `Fix the .txt and re-run — the .txt is the source of truth.`);
  }
  process.exit(1);
}

function main(argv) {
  const src = argv[2];
  if (!src) {
    console.error('usage: node scripts/bbcode-from-blurb.mjs "<path to the edited .txt>"');
    process.exit(1);
  }
  if (looksAlreadyConverted(src)) {
    console.error(
      `REFUSING: "${src}" is already BBCode — converting it again would double-convert it\n`
      + 'and every check would still pass. Pass the plain .txt instead (the source of truth).');
    process.exit(1);
  }
  if (!existsSync(src)) {
    console.error(`NOT FOUND: ${src}\nPass the path to the edited plain-text blurb.`);
    process.exit(1);
  }

  const dst = bbcodePathFor(src);
  const bb = toBBCode(readFileSync(src, 'utf8'));

  // Checked BEFORE writing, deliberately: an over-limit BBCode file left on disk looks
  // exactly like a postable one, and sooner or later somebody pastes it.
  if (bb.length > TRF_POST_LIMIT) {
    fail(
      `TOO LONG FOR TRF: ${bb.length} chars against a ${TRF_POST_LIMIT} limit `
      + `(over by ${bb.length - TRF_POST_LIMIT}). Nothing was written.\n`
      + 'Split it — see SPLITTING in this file\'s header: break on content, not release number,\n'
      + 'and put what the reader must not miss in the short first post.', dst);
  }

  const problems = checkTags(bb);
  if (problems.length) {
    fail('TAG PROBLEMS (nothing written):\n  ' + problems.join('\n  '), dst);
  }

  writeFileSync(dst, bb, 'utf8');
  console.log(`wrote ${dst} (${bb.length} chars, ${Buffer.byteLength(bb)} bytes)`);
  console.log(`tags balanced; fits TRF's ${TRF_POST_LIMIT}-char limit — ${TRF_POST_LIMIT - bb.length} to spare.`);
}

// Run the CLI only when invoked directly. Importing this module for its helpers must not
// execute any of the above — the top-level CLI body used to exit(1) on import, which is why
// the 10,000-character rule and the tag-balance check had no test at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
