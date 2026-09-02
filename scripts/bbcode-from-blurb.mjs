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
 * TRF (XenForo) REFUSES A POST OVER 10,000 CHARACTERS, counted on the BBCode. Since Eric's
 * 2026-08-30 ruling the draft is ONE .txt of any length and this script SPLITS it rather than
 * refusing it, writing "<stem> BBCODE (n of N).txt" and adding the joining lines itself.
 * See postLength() for what TRF really counts — it is not String.length — and splitBBCode()
 * for where the cuts may fall.
 *
 * The draft still governs the reading ORDER. The splitter cuts where it must; only the .txt
 * decides what a reader meets first. Releases do not group meaningfully — v0.073 and v0.075
 * both moved users' numbers, v0.072 and v0.074 were both fixes — so never organise a draft by
 * release number, and put whatever the reader must not miss near the top. The parts must
 * rejoin to Eric's edited text word for word; nothing here changes his wording.
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
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  // `\r\n?` and not `\r\n`: a LONE carriage return survives the narrower form, and then no
  // split('\n') ever breaks on it — the paragraphs collapse into one unbreakable "line".
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
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

/**
 * The length TRF will actually count — NOT `String.length`, and NOT the CRLF count that
 * used to stand here.
 *
 * Three things in XenForo's own source decide it. Read from 2.1.4 and 2.3.4:
 *
 *  1. **Line endings never arrive as CRLF.** `XF\InputFilterer::cleanInternal()`'s `str`
 *     case runs `str_replace("\r\n", "\n", strval($value))`, and `cleanString()` then
 *     strips `"\x0D"` outright — its own comment says *"carriage returns, because jQuery
 *     does so in .val()"*. The receiver counts LF. The note that used to sit here claimed
 *     a 9,998-character post "would have counted 10,104 and been REFUSED"; it would have
 *     been accepted, and that whole mechanism was wrong.
 *  2. **The count is in CODE POINTS**, not UTF-16 units: `utf8_strlen($message)` (2.3:
 *     `Str::strlen`). An astral character — an emoji — is ONE there and two to JS `.length`.
 *  3. **The message is REWRITTEN before it is measured.**
 *     `XF\Service\Message\Preparer::prepare()` calls `processMessage()` first and hands the
 *     rewritten string to `checkValidity()`. So growth nobody typed is counted:
 *       - every resolvable `@handle` becomes `[USER=<id>]@Name[/USER]`
 *         (`MentionFormatter`: `'[USER=' . $user['user_id'] . ']' . $prefix . $user['username'] . '[/USER]'`)
 *         — 14 characters plus the id's digits;
 *       - a bare URL still sitting in prose is autolinked to `[URL]…[/URL]` — 11 characters.
 *
 * Points 2 and 3 both grow the count in the DANGEROUS direction, so they are counted rather
 * than hoped over. Over-counting only splits a post earlier than it strictly had to; the
 * blurbs credit reporters inline by handle, so a long one carries a dozen mentions.
 *
 * ASSUMES the BBCode is pasted with the editor's BB-code toggle ON. Pasted into the rich
 * editor instead, XenForo receives `message_html` and measures its own HTML→BBCode
 * conversion of it, which can differ. Unverified — worth checking the first time a post
 * lands within a hundred characters of the limit.
 */

/** `[USER=<id>]` + `[/USER]` wrapped around the `@Name` already in the text. */
export const MENTION_GROWTH = 14 + 6; // TRF's user ids run to six digits; budget the longest.

/** `[URL]` + `[/URL]` wrapped around a bare link XenForo autolinks for you. */
export const AUTOLINK_GROWTH = 11;

/**
 * Mentions, counted generously: `@` followed by anything that is not a space. A handle that
 * does not resolve to a real member is NOT expanded by XenForo, and a stray `@` in an email
 * address is not either, so this over-counts — which is the safe direction.
 */
export const countMentions = (s) => (s.match(/@[^\s@]/g) || []).length;

/** Links XenForo will autolink: the ones NOT already inside an [URL] tag this script wrote. */
export const countBareUrls = (s) =>
  (s.replace(/\[URL\][\s\S]*?\[\/URL\]/gi, '').match(/\bhttps?:\/\//gi) || []).length;

export const postLength = (s) =>
  [...s].length + countMentions(s) * MENTION_GROWTH + countBareUrls(s) * AUTOLINK_GROWTH;

/** The generated file's path for a given source .txt. */
export const bbcodePathFor = (src) => src.replace(/\.txt$/i, '') + ' BBCODE.txt';

/** Part n of N, when one post will not hold it. */
export const bbcodePartPathFor = (src, n, total) =>
  src.replace(/\.txt$/i, '') + ` BBCODE (${n} of ${total}).txt`;

/** Added at the foot of every part but the last, and the head of every part but the first. */
export const CONTINUES = 'Continued in the post below.';
export const CONTINUED = 'Continued from the post above.';

/**
 * A line that reads as a HEADING, so the splitter can refuse to cut just after one.
 *
 * The blurbs write headings two ways: a bold-only line (`[B]…[/B]`, from a `**…**` line or
 * a `- Title (v0.0NN)` release header), and a bare ALL-CAPS line, which is what Eric's own
 * section headings are — "PARTS DATABASE", "NOT FIXED YET".
 *
 * The `^\[` bail-out is load-bearing: `[/LIST]` and `[*]ITEM` are uppercase and full of
 * letters, and without it every list would look like a heading.
 */
export const isHeadingLine = (l) => {
  const t = l.trim();
  if (!t) return false;
  if (/^\[B\].+\[\/B\]$/.test(t)) return true;
  if (t.startsWith('[')) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
};

/**
 * Split finished BBCode into postable parts.
 *
 * The convention changed on 2026-08-30 (Eric): he wants ONE consolidated .txt to edit,
 * however long it runs, and the split done HERE, from his edited text. So this no longer
 * refuses an over-length draft - it cuts it.
 *
 * Where it cuts: only at a BLANK LINE that is not inside a [LIST]. That keeps every list,
 * and therefore every tag pair, whole inside one part - the alternative is a part that opens
 * a [LIST] it never closes, which pastes as visible junk. If a single unsplittable run is
 * itself over the limit the caller is told rather than handed a bad cut.
 *
 * And it will not cut immediately after a HEADING, which strands the heading at the foot of
 * one post with its body at the head of the next. That is not hypothetical: it is what
 * happened to the real v0.088-v0.091 blurb, whose part 1 ended on the bare line "OPENING A
 * DESIGN FILE NOW ASKS BEFORE THROWING YOUR WORK AWAY" - and the generated file was then
 * repaired BY HAND, which is exactly the drift the .txt-is-the-source-of-truth rule exists
 * to prevent.
 *
 * The joining lines are budgeted PER POSITION. A middle part of a three-or-more-part split
 * carries BOTH of them, and reserving room for only one is how a middle part came out at
 * 10,032 characters while the docstring here claimed it could not happen.
 */
export function splitBBCode(bb, limit = TRF_POST_LIMIT) {
  const HEAD = CONTINUED + '\n\n';
  const FOOT = '\n\n' + CONTINUES;
  const headCost = postLength(HEAD);
  const footCost = postLength(FOOT);

  // A document that fits in ONE post carries no joining lines at all, so it must be measured
  // against the WHOLE limit - reserving the join is what split a 9,980-character blurb in two
  // for no reason, and refused one outright when it had no blank line to cut at. That check
  // is the loop's own first iteration, where parts.length is 0 and so `head` is 0; an explicit
  // early return here as well was unreachable, and a guard no mutation can break is a guard
  // that is not guarding anything.
  const lines = bb.split('\n');
  const cuts = [];
  let depth = 0;
  let lastSolid = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('[LIST]')) depth++;
    if (l.includes('[/LIST]')) depth--;
    if (l.trim() === '') {
      if (depth === 0) {
        cuts.push({ at: i, orphansHeading: lastSolid >= 0 && isHeadingLine(lines[lastSolid]) });
      }
    } else {
      lastSolid = i;
    }
  }

  const parts = [];
  let start = 0;
  for (;;) {
    // Step over blank lines rather than measuring them: a trailing newline (every editor
    // saves one) used to register as a cut and produce a final "post" that was nothing but
    // the "Continued from the post above." line.
    while (start < lines.length && lines[start].trim() === '') start++;
    if (start >= lines.length) break;

    const head = parts.length === 0 ? 0 : headCost;
    const rest = lines.slice(start).join('\n').trimEnd();
    if (head + postLength(rest) <= limit) { parts.push(rest); break; }

    const allowance = limit - head - footCost;
    let best = -1;      // the last cut that fits AND does not strand a heading
    let bestAny = -1;   // the last cut that fits, heading or not
    for (const c of cuts) {
      if (c.at <= start) continue;
      const candidate = lines.slice(start, c.at).join('\n').trimEnd();
      if (!candidate) continue;
      if (postLength(candidate) > allowance) break;
      bestAny = c.at;
      if (!c.orphansHeading) best = c.at;
    }
    // Falling back to bestAny matters: a stranded heading is ugly, an unpostable file is
    // useless, and refusing a blurb that CAN be cut would send Eric back to hand-splitting.
    const at = best >= 0 ? best : bestAny;
    if (at < 0) {
      throw new Error(
        'the next unbreakable run is longer than a post. Add a blank line between '
        + 'paragraphs, or shorten the longest list.');
    }
    parts.push(lines.slice(start, at).join('\n').trimEnd());
    start = at + 1;
  }

  if (parts.length === 1) return parts;
  return parts.map((part, i) => {
    const head = i === 0 ? '' : HEAD;
    const foot = i === parts.length - 1 ? '' : FOOT;
    return head + part + foot;
  });
}

/**
 * The parts of a split that TRF would refuse. An empty array is the only acceptable answer,
 * and until this existed nothing checked: main() printed "each inside TRF's 10000-char
 * limit" as a fixed string whatever splitBBCode had returned.
 */
export const partsOverLimit = (parts, limit = TRF_POST_LIMIT) =>
  parts.map((part, i) => ({ n: i + 1, len: postLength(part) })).filter((p) => p.len > limit);

/**
 * Refuse to convert an already-converted file. Tab-completion on a blurb stem offers both
 * the .txt and its " BBCODE.txt", and re-converting the latter succeeds silently: no `**`
 * and no column-0 `- ` survive a first pass, so tag counts stay balanced and every check
 * reports success while writing a double-converted "<stem> BBCODE BBCODE.txt".
 */
export const looksAlreadyConverted = (src) =>
  / BBCODE( \(\d+ of \d+\))?(\.OUTDATED)?\.txt$/i.test(src);

/**
 * Move a stale generated file aside when this run refuses to write a new one.
 *
 * Checking before writing stops a NEW unpostable file appearing, but it does nothing about
 * the one an EARLIER successful run left on disk: after an edit that pushes the draft over
 * the limit, that older file still sits beside the .txt, still fits the limit, and still
 * pastes cleanly — so the post that goes up is the previous draft. The .txt is the source of
 * truth, and a generated file that no longer matches it must not look postable.
 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every "<stem> BBCODE (n of N).txt" that is REALLY on disk beside the source.
 *
 * The sweep used to guess instead, asking for "(1 of 9)" … "(9 of 9)" — names no run has
 * ever written — so a genuine "(1 of 4)" set survived every later run untouched, sitting
 * beside the new output looking perfectly postable. Any change to how a blurb splits is
 * exactly when that happens, and this commit changes how every blurb splits.
 */
export function existingPartPaths(src) {
  const stem = basename(src).replace(/\.txt$/i, '');
  const dir = dirname(src) || '.';
  const re = new RegExp('^' + escapeRe(stem) + ' BBCODE \\(\\d+ of \\d+\\)\\.txt$', 'i');
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((f) => re.test(f)).map((f) => join(dir, f));
}

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

  // Tags first: a split of malformed BBCode is malformed twice over.
  const problems = checkTags(bb);
  if (problems.length) {
    fail('TAG PROBLEMS (nothing written):\n  ' + problems.join('\n  '), dst);
  }

  let parts;
  try {
    parts = splitBBCode(bb);
  } catch (e) {
    fail(`TOO LONG AND CANNOT BE SPLIT: ${e.message}\nNothing was written.`, dst);
    return;
  }

  // The one job this script has is never to write a file TRF will refuse, and until now
  // nothing checked: the summary printed "each inside TRF's 10000-char limit" as a constant
  // string, so a splitter bug shipped with exit code 0 and a reassuring message.
  const over = partsOverLimit(parts);
  if (over.length) {
    fail(
      'SPLIT PRODUCED AN UNPOSTABLE PART (nothing written):\n  '
      + over.map((p) => `part ${p.n} of ${parts.length}: ${p.len} characters, `
        + `${p.len - TRF_POST_LIMIT} over the limit`).join('\n  ')
      + '\nThat is a bug in splitBBCode, not in the draft — the draft did not do anything '
      + 'wrong.', dst);
    return;
  }

  if (parts.length === 1) {
    // A multi-part set from an earlier, longer draft must not survive beside it.
    for (const stale of existingPartPaths(src)) quarantineStale(stale);
    writeFileSync(dst, bb, 'utf8');
    console.log(`wrote ${dst} (${postLength(bb)} chars as TRF counts them, ${Buffer.byteLength(bb)} bytes)`);
    console.log(`tags balanced; fits TRF's ${TRF_POST_LIMIT}-char limit - ${TRF_POST_LIMIT - postLength(bb)} to spare.`);
    return;
  }

  // Likewise a single-file BBCode from an earlier, shorter draft, and any part file from an
  // earlier split that this one will NOT overwrite (a 4-part set becoming a 2-part set).
  quarantineStale(dst);
  const willWrite = new Set(
    parts.map((_, i) => basename(bbcodePartPathFor(src, i + 1, parts.length))));
  for (const stale of existingPartPaths(src)) {
    if (!willWrite.has(basename(stale))) quarantineStale(stale);
  }
  parts.forEach((part, i) => {
    const path = bbcodePartPathFor(src, i + 1, parts.length);
    writeFileSync(path, part, 'utf8');
    console.log(`wrote ${path} (${postLength(part)} chars as TRF counts them, `
      + `${Buffer.byteLength(part)} bytes)`);
  });
  // One measure for every number printed in a run. This total used to be `bb.length`, so it
  // was smaller than the sum of the parts printed two lines above it.
  const total = parts.reduce((n, part) => n + postLength(part), 0);
  console.log(
    `tags balanced; ${total} chars as TRF counts them, split into ${parts.length} posts, `
    + `each verified inside TRF's ${TRF_POST_LIMIT}-char limit. Post them in order - the `
    + 'joining lines are already in.');
}

// Run the CLI only when invoked directly. Importing this module for its helpers must not
// execute any of the above — the top-level CLI body used to exit(1) on import, which is why
// the 10,000-character rule and the tag-balance check had no test at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
