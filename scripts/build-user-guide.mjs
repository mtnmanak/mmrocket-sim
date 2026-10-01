/**
 * Generates packages/app/src/data/userGuide.ts from packages/app/user-guide.md, so the
 * markdown is the single source of truth for the guide. The old userGuide.ts
 * was a hand-maintained transcription that silently drifted from the markdown
 * every release (each mirror ended up with sentences the other lacked); this
 * script replaces that with a build step the app's `npm run build` runs, so
 * the guide a deploy SERVES cannot drift from the markdown.
 *
 * The COMMITTED userGuide.ts still could (audit 2026-09-22): the deploy runs the
 * tests before the build, so a test reading GUIDE_SECTIONS read whatever was
 * last committed, and the weekly motors refresh moved the catalogue figures the
 * guide quotes without recompiling it. `compileGuide()` is exported so
 * packages/app/scripts/user-guide-current.test.mjs can compile the guide and
 * require the committed file to match it byte for byte, and `npm run
 * motors:refresh` ends by running this script, so a refresh — the weekly
 * workflow's or a hand-run one — writes the guide beside the JSON it commits.
 *
 * Usage: node scripts/build-user-guide.mjs
 *
 * DELIBERATELY NOT A MARKDOWN LIBRARY. The guide uses a small, known set of
 * constructs (sections anchored by <a id>, ##/### headings, paragraphs,
 * bullet/numbered lists, pipe tables, fenced code blocks, bold/italic/code
 * spans, [text](url) links, bare URLs) and the emitted HTML is rendered via
 * dangerouslySetInnerHTML in GuideDialog — it MUST stay our own trusted
 * static markup. A general markdown parser would happily pass raw HTML and
 * every construct it knows straight through; this one refuses loudly
 * (exit 1, with the offending line) on anything outside the known set, so an
 * unsupported edit to the markdown breaks the build instead of the dialog.
 *
 * Output is a pure function of its inputs (the markdown, the three shipped data
 * files its {{TOKENS}} come from — motors.json, motorCurves.json and
 * nozzles.json — and the motor-catalogue corrections table) — byte-identical on
 * re-run — and
 * its data strings are pure ASCII (non-ASCII escaped as \uXXXX) so the
 * content survives any editor/codepage mishap on the way through a Windows
 * checkout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOTOR_CORRECTIONS } from '../packages/app/scripts/motor-corrections.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Lives beside the app that consumes it — the guide is a
// BUILD INPUT (CI runs this script on every deploy), so it must not sit in a
// directory the project may prune.
export const SRC = join(root, 'packages', 'app', 'user-guide.md');
export const OUT = join(root, 'packages', 'app', 'src', 'data', 'userGuide.ts');
export const DATA = join(root, 'packages', 'app', 'src', 'data');

/** A refusal. Thrown rather than exiting so a test can import the compiler;
 *  main() turns it back into the message on stderr and exit 1. */
export class GuideError extends Error {}

function fail(msg, line) {
  throw new GuideError(`build-user-guide: ${msg}${line !== undefined ? `\n  at packages/app/user-guide.md:${line + 1}` : ''}`);
}

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

/** External links open a new tab: the guide lives in a dialog inside a PWA,
 *  and navigating the app away to a reference would lose the user's design view. */
function anchor(url, innerHtml, ln) {
  if (/^https?:\/\//.test(url)) {
    return `<a href="${escAttr(url)}" target="_blank" rel="noopener">${innerHtml}</a>`;
  }
  if (/^mailto:/.test(url)) return `<a href="${escAttr(url)}">${innerHtml}</a>`;
  // #fragment links can't work across the dialog's per-section rendering, and
  // anything else (relative paths, javascript:) has no business in the guide.
  fail(`unsupported link target "${url}" (only https://, http://, mailto:)`, ln);
}

/**
 * Inline markdown -> HTML: code spans, links, bare URLs, **bold**, *italic*.
 * Anything half-formed (odd backticks, unmatched asterisks, a leftover
 * [text]( ...) is a refusal, not a guess.
 */
function inline(text, ln) {
  const ticks = text.split('`');
  if (ticks.length % 2 === 0) fail('unmatched backtick', ln);
  return ticks.map((piece, i) => {
    if (i % 2 === 1) return `<code>${escText(piece)}</code>`;
    if (/[<>]/.test(piece)) fail(`raw HTML outside a code span: "${piece.trim()}"`, ln);
    let s = piece.replace(/&/g, '&amp;');

    // Links come out first, as placeholders, so that **bold around a link**
    // still pairs up and the bare-URL pass can't re-match a generated href.
    const stash = [];
    const put = (html) => `\u0000${stash.push(html) - 1}\u0001`;
    s = s.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_, label, url) => {
      if (/[[\]*`\u0000]/.test(label)) fail(`unsupported markup inside link text "${label}"`, ln);
      // `s` is already &-escaped: the label passes through as-is (it may
      // carry &amp;), the URL is un-escaped so escAttr() in anchor() does not
      // double it.
      return put(anchor(url.replace(/&amp;/g, '&'), label, ln));
    });
    if (/\[[^\]]*\]\(/.test(s)) fail('malformed [text](url) link', ln);
    s = s.replace(/https?:\/\/[^\s\u0000\u0001]+/g, (url) => {
      const trimmed = url.replace(/[.,;:)\]]+$/, ''); // "…openrocket." links the URL, keeps the period
      return put(anchor(trimmed.replace(/&amp;/g, '&'), trimmed, ln)) + url.slice(trimmed.length);
    });

    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    if (s.includes('*')) fail(`unmatched asterisk in: "${piece.trim()}"`, ln);

    return s.replace(/\u0000(\d+)\u0001/g, (_, n) => stash[Number(n)]);
  }).join('');
}

/** One section's markdown lines -> HTML blocks, joined by newlines. */
function renderBlocks(lines, base, glossary = false) {
  const out = [];
  const entries = new Set();
  const letters = new Map();
  let i = 0;
  const isBlockStart = (t) => /^(#{1,6} |```|\||- |\d+\. |> |---$)/.test(t) || /^</.test(t);

  while (i < lines.length) {
    const line = lines[i];
    const ln = base + i;
    if (line.trim() === '' || line.trim() === '---') { i++; continue; }

    if (/^## Contents\s*$/.test(line)) {
      // The dialog has its own table of contents; the markdown's list of
      // #fragment links would be dead weight (and dead links) inside it.
      i++;
      while (i < lines.length && (lines[i].trim() === '' || /^\s*(\d+\.|-) /.test(lines[i]))) i++;
      continue;
    }

    let m;
    if ((m = line.match(/^(##|###) (.*)$/))) {
      const tag = m[1] === '##' ? 'h2' : 'h3';
      out.push(`<${tag}>${inline(m[2].trim(), ln)}</${tag}>`);
      i++;
      continue;
    }
    if (/^#/.test(line)) fail(`unsupported heading level: "${line}"`, ln);

    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) fail('unclosed code fence', ln);
      i++;
      out.push(`<pre><code>${escText(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push([lines[i++], base + i - 1]);
      if (rows.length < 3 || !/^\|[\s:|-]+\|$/.test(rows[1][0])) fail('malformed table', ln);
      const cells = ([t, n]) => {
        const parts = t.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim(), n));
        return parts;
      };
      const head = cells(rows[0]);
      const body = rows.slice(2).map((r) => {
        const c = cells(r);
        if (c.length !== head.length) fail(`table row has ${c.length} cells, header has ${head.length}`, r[1]);
        return c;
      });
      out.push(
        '<div>\n<table>\n'
        + `<thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>\n<tbody>\n`
        + body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')
        + '\n</tbody>\n</table>\n</div>',
      );
      continue;
    }

    if ((m = line.match(/^(- |\d+\. )/))) {
      const ordered = m[1] !== '- ';
      const items = [];
      while (i < lines.length && (m = lines[i].match(ordered ? /^\d+\. (.*)$/ : /^- (.*)$/))) {
        let item = m[1];
        i++;
        // Lazy continuation: a wrapped item keeps going until a blank line or
        // the start of any other block.
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
          item += ' ' + lines[i++].trim();
        }
        items.push(inline(item, base + i - 1));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>\n${items.map((t) => `<li>${t}</li>`).join('\n')}\n</${tag}>`);
      continue;
    }

    if (/^[<>]/.test(line)) fail(`unsupported construct: "${line.slice(0, 60)}"`, ln);

    // Paragraph: hard-wrapped source lines join into one.
    let para = line.trim();
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      para += ' ' + lines[i++].trim();
    }
    let attributes = '';
    const entry = glossary && para.match(/^\*\*([^*]+)\*\* — /);
    if (entry) {
      const title = entry[1];
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug || entries.has(slug)) fail(`empty or duplicate glossary anchor: "${title}"`, ln);
      entries.add(slug);
      const id = `glossary-${slug}`;
      attributes = ` id="${id}" tabindex="-1"`;
      const letter = title[0].toUpperCase();
      if (!letters.has(letter)) letters.set(letter, id);
    }
    out.push(`<p${attributes}>${inline(para, ln)}</p>`);
  }
  if (glossary && out.length) {
    const links = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => letters.has(letter)
      ? `<a href="#${letters.get(letter)}" aria-label="Glossary: ${letter}">${letter}</a>`
      : `<span aria-disabled="true">${letter}</span>`);
    out.unshift(`<nav class="guide-letters" aria-label="Glossary letters">${links.join(' ')}</nav>`);
  }
  return out.join('\n');
}

// ---- split the document into anchored sections --------------------------------

/**
 * NUMBERS THE GUIDE MUST NOT HARD-CODE.
 *
 * The motor counts were typed into the prose by hand and went stale every time
 * the catalogue was refreshed — which is now a weekly cron. Eric asked for an
 * as-of date beside them (2026-09-18: "if Thrustcurve adds, deletes or changes
 * motors in between builds, this number will not be correct"). The better
 * answer is that the guide should not hold the number at all: these tokens are
 * substituted from the SHIPPED data files at build time, so the sentence is
 * true of the build it ships in, by construction. Within one session of writing
 * this, a refresh had already made three hand-typed figures wrong.
 *
 * An unknown {{TOKEN}} is a hard failure, not a silent pass-through — a typo
 * would otherwise reach a reader as literal braces.
 *
 * Audit 2026-09-22 added the breakdown of the motors with no curve (by maker,
 * and how many are out of production) and the curve files' source shares:
 * both were hand-typed, and the maker list was already wrong — it named
 * Gorilla and Jambol for a set that is half Kosdon.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** What each token holds, for the bare-figure check below. */
const TOKEN_KIND = {
  MOTOR_COUNT: 'count',
  CURVE_MOTORS: 'count',
  CURVE_FILES: 'count',
  CURVE_MISSING: 'count',
  CURVE_MISSING_OOP: 'count',
  CURVE_MISSING_MAKERS: 'text',
  MOTOR_DB_DATE: 'date',
  CURVE_SHARE_CERT: 'percent',
  CURVE_SHARE_USER: 'percent',
  CURVE_SHARE_MFR: 'percent',
  // Not 'count': small figures like these recur in honest prose (a bare 54 is also a
  // casing size, "54, 75/76, 98 mm"), so a rule on the value would refuse it. The
  // coverage PHRASE is refused instead, whatever its numbers (see checkBareFigures).
  NOZZLE_LOKI_WITH_EXIT: 'coverage',
  NOZZLE_LOKI_IN_PRODUCTION: 'coverage',
  MOTOR_CORRECTIONS: 'text',
};

/**
 * THE CATALOGUE ROWS THE APP CORRECTS, as one clause each (board Tier 1 row 6,
 * 2026-10-01). The guide says the bundled motors are thrustcurve.org's "as
 * pulled", and the rows packages/app/scripts/motor-corrections.mjs corrects are
 * not, so the guide says which and how — phrased from that table, the same one
 * the refresh applies, so retiring an entry there retires its words here. A
 * field with no wording below stops the build: a correction must not go
 * unmentioned just because nobody wrote a phrase for it.
 */
export function motorCorrectionsSentence(corrections, motors) {
  const n = (v) => Number(v).toLocaleString('en-US');
  const byId = new Map(motors.map((m) => [m.motorId, m]));
  const clauses = corrections.flatMap((c) => Object.entries(c.fields).map(([field, { bad, good }]) => {
    const name = `the ${c.manufacturer} ${c.designation}`;
    if (field === 'length') return `${name} is ${n(good)} mm long, where thrustcurve.org lists ${n(bad)} mm`;
    if (field === 'propWeightG') {
      const loaded = byId.get(c.motorId)?.totalWeightG;
      return `${name} carries ${n(good)} g of propellant, where thrustcurve.org lists ${n(bad)} g`
        + (Number.isFinite(loaded) ? ` in a ${n(loaded)} g motor` : '');
    }
    return fail(`motor-corrections.mjs corrects ${c.designation} ${field}, and the guide has no wording for ${field} — add one in motorCorrectionsSentence()`);
  }));
  return clauses.length > 1 ? `${clauses.slice(0, -1).join('; ')}; and ${clauses.at(-1)}` : (clauses[0] ?? '');
}

function guideTokens(data, corrections) {
  const motors = JSON.parse(readFileSync(join(data, 'motors.json'), 'utf8'));
  const curves = JSON.parse(readFileSync(join(data, 'motorCurves.json'), 'utf8'));
  const total = motors.count ?? motors.motors.length;
  const n = (v) => Number(v).toLocaleString('en-US');
  // "19 September 2026" — the guide writes dates in prose, and an ISO string
  // in the middle of a sentence reads like a version number.
  const [y, m, d] = String(motors.generated).split('-').map(Number);
  if (!y || !m || !d || !MONTHS[m - 1]) fail(`motors.json has an unreadable generated date: ${motors.generated}`);

  // The catalogued motors with no bundled curve, counted from the rows rather
  // than by subtraction, and held to the subtraction so the two cannot part.
  const withCurve = new Set(Object.keys(curves.curves ?? {}));
  const missing = motors.motors.filter((x) => !withCurve.has(x.motorId));
  if (missing.length !== total - curves.motors) {
    fail(`motorCurves.json covers ${curves.motors} motors, but ${missing.length} of the ${total} catalogued `
      + 'motors have no curve in it — the two files were not built against one catalogue');
  }
  if (missing.length === 0) {
    fail('every catalogued motor has a bundled curve — the guide\'s sentences about the ones without need rewriting');
  }
  // "39 Kosdon, 13 Jambol, 13 Ultra, 11 Gorilla and 4 more from 3 other
  // makers": every maker with five or more, largest first, the rest lumped.
  const byMaker = new Map();
  for (const x of missing) byMaker.set(x.manufacturerAbbrev, (byMaker.get(x.manufacturerAbbrev) ?? 0) + 1);
  const ranked = [...byMaker].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const named = ranked.filter(([, c]) => c >= 5);
  const rest = ranked.filter(([, c]) => c < 5);
  const parts = named.map(([mfr, c]) => `${n(c)} ${mfr}`);
  if (rest.length === 1) parts.push(`${n(rest[0][1])} ${rest[0][0]}`);
  else if (rest.length > 1) {
    parts.push(`${n(rest.reduce((s, [, c]) => s + c, 0))} more from ${rest.length} other makers`);
  }
  const makers = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];

  // Where the bundled files came from. The guide's sentence names exactly
  // three sources, so a fourth tag is a failure, not a silent 99 %.
  const bySource = { cert: 0, user: 0, mfr: 0 };
  let files = 0;
  for (const list of Object.values(curves.curves ?? {})) {
    for (const f of list) {
      if (!(f.source in bySource)) fail(`motorCurves.json has a file with source "${f.source}" — the guide names only cert, user and mfr`);
      bySource[f.source] += 1;
      files += 1;
    }
  }
  if (files !== curves.files) fail(`motorCurves.json says ${curves.files} files and holds ${files}`);
  const share = (k) => (100 * bySource[k] / files).toFixed(1);

  return {
    MOTOR_COUNT: n(total),
    MOTOR_DB_DATE: `${d} ${MONTHS[m - 1]} ${y}`,
    CURVE_MOTORS: n(curves.motors),
    CURVE_FILES: n(curves.files),
    CURVE_MISSING: n(total - curves.motors),
    CURVE_MISSING_OOP: n(missing.filter((x) => x.availability === 'OOP').length),
    CURVE_MISSING_MAKERS: makers,
    CURVE_SHARE_CERT: share('cert'),
    CURVE_SHARE_USER: share('user'),
    CURVE_SHARE_MFR: share('mfr'),
    MOTOR_CORRECTIONS: motorCorrectionsSentence(corrections, motors.motors),
  };
}

/**
 * THE NOZZLE DATABASE'S FIGURES (board Tier 1 row 17, 2026-10-01). The nozzle
 * section quoted counts out of nozzles.json by hand, and they drifted the way the
 * motor counts had: v0.133 corrected "278 motors you can load" to 279 and left
 * "221 of AeroTech's 272" standing one clause away, so the paragraph's own parts
 * summed to 275 — and its changelog said the count "cannot drift again" while
 * nothing read it. The figures are of two kinds, so there are two mechanisms:
 *
 *  - COVERAGE ("54 of their 58 in production") is a pair of numbers and nothing
 *    else, so it is a token, summed per casing diameter from the file's own
 *    `coverage` block — `withExitDiameter`, never `withNozzleRow`: a row is not
 *    a number.
 *  - The counts the prose writes IN WORDS come with names and reasons no token
 *    can carry ("four Loki motors are short: ... N3800 and N5500 ... L2050,
 *    M1378"). Measure two of those tomorrow and a token would print "two" in
 *    front of four names. So those are CHECKED: wherever the guide states one,
 *    it must be the file's figure, or the build stops until the sentence is
 *    rewritten. user-guide-current.test.mjs holds the shipped guide to stating
 *    every one of them, so no check here can go quietly vacuous. That includes
 *    the motors the guide NAMES for a reason (the J615ST's aerospike, the
 *    I40N-P's machined nozzle) and the sentence listing every row with no
 *    number on purpose: a row with no exit for a reason it does not give stops
 *    the build too (2026-10-01 — resolving the K76WN-P's cut-down exit
 *    compiled byte for byte, with the guide still describing its nozzle).
 *
 * All of it reads nozzles.json alone, never motors.json: the weekly catalogue
 * refresh runs this script, and nozzles.json can only be rebuilt on the one
 * machine that holds its source documents, so a check joining the two would
 * fail a workflow nobody on CI can clear (nozzle-db.test.mjs says the same).
 */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/** A count as the guide writes it: a numeral, or a word up to twenty. */
const SAID_COUNT = String.raw`(\d[\d,]*|${NUMBER_WORDS.join('|')})`;
const inWords = (n) => (n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : n.toLocaleString('en-US'));
const asCount = (said) => (/^\d/.test(said) ? Number(said.replace(/,/g, '')) : NUMBER_WORDS.indexOf(said.toLowerCase()));

function nozzleFacts(data) {
  const db = JSON.parse(readFileSync(join(data, 'nozzles.json'), 'utf8'));
  const rows = db.motors ?? [];
  const loki = Object.values(db.coverage?.byManufacturer?.Loki?.byCasingDiameterMm ?? {});
  if (loki.length === 0) fail('nozzles.json states no coverage for Loki, and the guide quotes it');
  const total = (key) => loki.reduce((s, e) => s + e[key], 0);
  const lokiExit = total('withExitDiameter');
  const lokiInProduction = total('inProduction');
  // The in-production Loki motors the app has no exit for: those with no row at
  // all, which each casing names, and those whose row carries none.
  const lokiShort = [
    ...loki.flatMap((e) => e.missing ?? []),
    ...rows.filter((m) => m.manufacturer === 'Loki' && m.motorId && m.exitDiameterM === undefined)
      .map((m) => m.designation),
  ].sort();
  if (lokiShort.length !== lokiInProduction - lokiExit) {
    fail(`nozzles.json counts ${lokiInProduction - lokiExit} in-production Loki motors with no exit, but names `
      + `${lokiShort.length} (${lokiShort.join(', ')}) — is a row with no exit out of production? nozzleFacts() `
      + 'has to say which motors are short before the guide can name them');
  }
  // Every other loadable row with no exit carries none ON PURPOSE, for the reason
  // its sheet's line of material gives, and the guide's sentence on those rows
  // names each reason: an aerospike, a nozzle machined and drawn by its outside
  // diameter, one cut shorter than its mould, and the moulded 29 mm cases.
  const onPurpose = rows.filter((m) => m.manufacturer !== 'Loki' && m.motorId && m.exitDiameterM === undefined);
  const sheet = (m) => m.provenance?.lomDescription ?? '';
  return {
    tokens: {
      NOZZLE_LOKI_WITH_EXIT: lokiExit.toLocaleString('en-US'),
      NOZZLE_LOKI_IN_PRODUCTION: lokiInProduction.toLocaleString('en-US'),
    },
    rows,
    lokiShort,
    twoNozzles: rows.filter((m) => m.exitAmbiguous),
    onPurpose,
    // The loadable 29 mm DMS rows with no exit: the moulded case, part 01912.
    moulded29: rows.filter((m) => m.motorId && m.exitDiameterM === undefined
      && m.docFamily === 'dms' && m.casingDiameterMm === 29),
    aerospike: onPurpose.filter((m) => /\bAEROSPIKE\b/i.test(sheet(m))),
    machinedOD: onPurpose.filter((m) => /\bMACHINED\b/i.test(sheet(m)) && /\bO\.D\./i.test(sheet(m))),
    cutShort: onPurpose.filter((m) => /\bCUT TO\b/i.test(sheet(m))),
  };
}

/** Wherever the guide states one of nozzleFacts()'s figures in words, it must be the file's. */
function checkNozzleClaims(raw, facts) {
  const lines = raw.split('\n');
  const find = (re) => {
    for (let ln = 0; ln < lines.length; ln++) {
      const m = lines[ln].match(re);
      if (m) return { m, ln, line: lines[ln] };
    }
    return null;
  };
  const named = (rows) => rows.map((m) => m.designation).join(', ');

  let at = find(new RegExp(String.raw`\b${SAID_COUNT} (\w+) motors have two published nozzles\b`, 'i'));
  if (at) {
    const [said, count, maker] = at.m;
    const two = facts.twoNozzles;
    if (asCount(count) !== two.length || two.some((m) => m.manufacturer !== maker)) {
      fail(`user-guide.md says "${said}"; nozzles.json has ${inWords(two.length)} motors with two published `
        + `nozzles (${named(two)}) — rewrite the sentence`, at.ln);
    }
  }

  at = find(new RegExp(String.raw`\b${SAID_COUNT} Loki motors are short\b`, 'i'));
  if (at) {
    const short = facts.lokiShort;
    if (asCount(at.m[1]) !== short.length) {
      fail(`user-guide.md says ${at.m[1]} Loki motors are short; nozzles.json has ${inWords(short.length)} in `
        + `production with no exit (${short.join(', ')}) — rewrite that sentence and the motors it names`, at.ln);
    }
    for (const designation of short) {
      const name = designation.match(/^[A-Z]\d+/)?.[0] ?? designation;
      if (!at.line.includes(name)) {
        fail(`user-guide.md's sentence on the Loki motors that are short does not name ${name} (${designation}), `
          + 'which nozzles.json counts among them', at.ln);
      }
    }
  }

  at = find(new RegExp(String.raw`\b${SAID_COUNT} 29 mm DMS motors have the nozzle moulded into the case\b`, 'i'));
  if (at && asCount(at.m[1]) !== facts.moulded29.length) {
    fail(`user-guide.md says ${at.m[1]} 29 mm DMS motors have the nozzle moulded into the case; nozzles.json has `
      + `${inWords(facts.moulded29.length)} loadable 29 mm DMS rows with no exit (${named(facts.moulded29)})`, at.ln);
  }

  // The rest of the rows with no number on purpose. The sentence names one motor
  // for two of its reasons and counts the other two, and it reads as the whole
  // list, so a row with no exit for a reason it does not give is a sentence to
  // write, not a row to leave out.
  const notTheFiles = (hit, what, rows) => fail(`user-guide.md says "${hit.m[0]}"; in nozzles.json the loadable `
    + `rows with no exit ${what} are ${rows.length ? `${inWords(rows.length)}: ${named(rows)}` : 'none'}`, hit.ln);
  const theOne = (re, what, rows) => {
    const hit = find(re);
    if (hit && !(rows.length === 1 && rows[0].designation.startsWith(hit.m[1]))) notTheFiles(hit, what, rows);
  };
  theOne(/\bthe ([A-Z]\d+[A-Z]*) is an aerospike\b/, 'and an aerospike on the sheet', facts.aerospike);
  theOne(/\bthe ([A-Z]\d+[A-Z]*(?:-[A-Z]+)?)'s machined nozzle is drawn with its outside diameter and no exit\b/,
    'and a nozzle the sheet gives machined to an outside diameter', facts.machinedOD);
  at = find(new RegExp(String.raw`\b${SAID_COUNT} has a nozzle the sheet says was cut shorter than the mould\b`, 'i'));
  if (at && asCount(at.m[1]) !== facts.cutShort.length) {
    notTheFiles(at, 'and a nozzle the sheet says was "CUT TO" a length', facts.cutShort);
  }
  at = find(/\bcarry a row with no number on purpose\b/);
  if (at) {
    const given = [facts.aerospike, facts.moulded29, facts.machinedOD, facts.cutShort];
    const unexplained = facts.onPurpose.filter((m) => !given.some((rows) => rows.includes(m)));
    if (unexplained.length) {
      fail(`nozzles.json has ${inWords(unexplained.length)} loadable row(s) with no exit that user-guide.md's sentence `
        + 'on the rows with no number on purpose does not account for: '
        + `${unexplained.map((m) => `${m.designation} ("${m.provenance?.lomDescription ?? 'no sheet line'}")`).join(', ')}`
        + ' — say why in that sentence, and check it in checkNozzleClaims()', at.ln);
    }
  }

  // An AREA, from two diameters — the comparison this project has got wrong most often.
  at = find(/\b([A-Z]\d+[A-Z]*)'s two options differ by (\d+) % in area\b/);
  if (at) {
    const [, name, said] = at.m;
    const row = facts.rows.find((m) => m.designation.startsWith(name) && m.alternatives?.length);
    if (!row) fail(`user-guide.md compares the ${name}'s two nozzles; nozzles.json has no ${name} row with two`, at.ln);
    const exits = [row.exitDiameterIn, ...row.alternatives.map((a) => a.exitDiameterIn)];
    const pct = Math.round(100 * ((Math.max(...exits) / Math.min(...exits)) ** 2 - 1));
    if (Number(said) !== pct) {
      fail(`user-guide.md says the ${name}'s two options differ by ${said} % in area; nozzles.json's exits `
        + `(${exits.join(' in and ')} in) give ${pct} %`, at.ln);
    }
  }
}

/**
 * NO BARE CATALOGUE FIGURES (audit 2026-09-22). The tokens only help if they
 * are used: the offline section went on hand-typing "80" and "(5 September
 * 2026)" two lines below a sentence that used the tokens, and the date was
 * already a fortnight stale when it was found. So the build refuses the raw
 * markdown when it carries, outside a {{TOKEN}}:
 *
 *  - a token's CURRENT value as a bare figure: a count (thousands only in the
 *    guide's own comma form, so a year such as 1949 in a reference is never
 *    read as one) that is not part of a larger number and not followed by a
 *    unit; a share followed by %; the catalogue date, in prose or ISO form;
 *  - a count of catalogued, bundled or thrustcurve.org motors or curves, or
 *    any count of three digits or more of motors or curves, whatever the
 *    number — that is a catalogue figure however stale it is;
 *  - a date within a sentence's reach of "catalogue", "pulled" or
 *    "thrustcurve";
 *  - a nozzle coverage figure, "N of their M in production", whatever the
 *    numbers (2026-10-01: that is the shape "221 of AeroTech's 272" shipped in).
 *
 * The two PHRASE rules (catalogue count, coverage) read the line with its
 * **emphasis** taken out, since a bold figure is how the guide has written both.
 *
 * Designed against the guide as it stands: "0.80 (auto)", "above 80 N
 * average thrust" and "29 mm DMS motors" all pass. If a figure is refused that
 * genuinely counts something else, give it its unit or write it in words.
 */
const UNIT_AFTER = String.raw`(?!\s*(?:N·s|Ns|N|mm|cm|km|ms|m|s|kg|g|lb|oz|ft|in|K|Pa|hPa|kPa|percent|degrees?|cal|calibers?|px|x)(?![A-Za-z]))(?!\s*[%°″′×·/])`;
const CATALOGUE_NOUN = String.raw`(?:motors?|simulator files?|thrust curves?|curve files?|curves?)\b`;
const PROSE_DATE = new RegExp(String.raw`\b\d{1,2} (?:${MONTHS.join('|')}) \d{4}\b`, 'g');
// "54 of their 58 in production", and the shapes it has been or could be written
// in: "of AeroTech's 272", "out of", no "their" at all, up to three words before
// "in production" ("272 AeroTech motors in production"), or "in-production
// motors". Matched on the line with its emphasis taken out (see checkBareFigures).
const COVERAGE_PHRASE = /(?<![\d.,])\d[\d,]*\s+(?:out\s+)?of\s+(?:(?:their|its|the|all|[A-Za-z]+(?:\s+Research)?['’]s)\s+)?\d[\d,]*\s+(?:[A-Za-z]+\s+){0,3}?in[\s-]+production\b/i;

function checkBareFigures(raw, tokens) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  for (const [key, value] of Object.entries(tokens)) {
    const kind = TOKEN_KIND[key];
    if (kind === 'count') {
      // Not after a letter: a figure glued to one is a designation (a G80), not a count.
      rules.push({ key, re: new RegExp(String.raw`(?<![\d.,A-Za-z])${esc(value)}(?![\d]|[.,]\d)${UNIT_AFTER}`, 'g') });
    } else if (kind === 'percent') {
      rules.push({ key, re: new RegExp(String.raw`(?<![\d.,])${esc(value)}\s*%`, 'g') });
    } else if (kind === 'date') {
      const [d, month, y] = value.split(' ');
      const iso = `${y}-${String(MONTHS.indexOf(month) + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
      rules.push({ key, re: new RegExp(`\\b(?:${esc(value)}|${iso})\\b`, 'g') });
    }
  }
  const phrase = new RegExp(String.raw`(?<![\d.,])(?:\d[\d,]*\s+(?:(?:catalogued|catalogue|catalog|bundled|thrustcurve\.org)\s+)+|(?:\d{1,3}(?:,\d{3})+|\d{3,})\s+)${CATALOGUE_NOUN}`, 'gi');
  raw.split('\n').forEach((line, ln) => {
    // A token is the one sanctioned way to write these figures; blank it out
    // (same length, so a reported column stays honest) before looking.
    const text = line.replace(/\{\{[A-Z_]+\}\}/g, (t) => ' '.repeat(t.length));
    for (const { key, re } of rules) {
      re.lastIndex = 0;
      const hit = re.exec(text);
      if (hit) {
        fail(`bare "${hit[0].trim()}" is the shipped data's {{${key}}} (${TOKEN_KIND[key]}), typed by hand — write {{${key}}} so it follows the data`, ln);
      }
    }
    // The two phrase rules read the line with its emphasis taken out: they need
    // the figure and its noun side by side, and "**221** of AeroTech's 272" or
    // "**1,129** motors" — the bold the guide uses for exactly these figures —
    // put markup between them (2026-10-01: both compiled).
    const plain = text.replace(/\*/g, '');
    // Before the catalogue-count phrase, which would also catch "272 motors" and
    // send the writer to the wrong tokens.
    const coverage = plain.match(COVERAGE_PHRASE);
    if (coverage) {
      fail(`"${coverage[0]}" is a hand-typed nozzle coverage figure — use {{NOZZLE_LOKI_WITH_EXIT}} of their `
        + '{{NOZZLE_LOKI_IN_PRODUCTION}}, or add a token for that maker in nozzleFacts(), so it follows nozzles.json', ln);
    }
    phrase.lastIndex = 0;
    const counted = phrase.exec(plain);
    if (counted) {
      fail(`"${counted[0]}" is a hand-typed catalogue count — use {{MOTOR_COUNT}}, {{CURVE_MOTORS}}, {{CURVE_FILES}} or {{CURVE_MISSING}}`, ln);
    }
    PROSE_DATE.lastIndex = 0;
    for (let m; (m = PROSE_DATE.exec(text));) {
      const near = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
      if (/catalog|thrustcurve|pulled/i.test(near)) {
        fail(`"${m[0]}" is a hand-typed catalogue date — use {{MOTOR_DB_DATE}}`, ln);
      }
    }
  });
}

// ---- compile and emit ---------------------------------------------------------

// \uXXXX-escape everything outside printable ASCII (per UTF-16 unit, so
// emoji surrogate pairs stay valid JS).
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const field = (k, v) => `    ${JSON.stringify(k)}: ${ascii(JSON.stringify(v))}`;

/**
 * Compile the guide: markdown in, the text of userGuide.ts out. Pure — it
 * writes nothing — so user-guide-current.test.mjs can hold the committed file
 * to it. `dataDir` is where motors.json, motorCurves.json and nozzles.json are
 * read from; `corrections` is the motor-catalogue corrections table.
 */
export function compileGuide({
  markdown = readFileSync(SRC, 'utf8'), dataDir = DATA, corrections = MOTOR_CORRECTIONS,
} = {}) {
  const nozzles = nozzleFacts(dataDir);
  const TOKENS = { ...guideTokens(dataDir, corrections), ...nozzles.tokens };
  for (const key of Object.keys(TOKENS)) {
    if (!(key in TOKEN_KIND)) fail(`guide token {{${key}}} has no entry in TOKEN_KIND`);
  }

  const rawGuide = markdown.replace(/\r\n/g, '\n');
  checkBareFigures(rawGuide, TOKENS);
  checkNozzleClaims(rawGuide, nozzles);

  const lines = rawGuide
    .replace(/\{\{([A-Z_]+)\}\}/g, (_m, key) => {
      if (!(key in TOKENS)) {
        fail(`unknown guide token {{${key}}} — known: ${Object.keys(TOKENS).join(', ')}`);
      }
      // A sentence built round a token must not print with a hole in it — the
      // corrections sentence once the last correction is retired, say.
      if (TOKENS[key] === '') fail(`{{${key}}} renders nothing from the data it is built on — remove or reword the sentence that uses it`);
      return TOKENS[key];
    })
    .split('\n');
  const anchors = [];
  lines.forEach((l, n) => {
    const m = l.match(/^<a id="([a-z0-9-]+)"><\/a>\s*$/);
    if (m) anchors.push({ id: m[1], line: n });
    else if (/<a id/.test(l)) fail(`malformed section anchor: "${l}"`, n);
  });
  if (anchors.length === 0) fail('no <a id="…"></a> section anchors found');

  const sections = anchors.map(({ id, line }, k) => {
    let t = line + 1;
    while (t < lines.length && lines[t].trim() === '') t++;
    const m = lines[t]?.match(/^## (.+)$/);
    if (!m) fail(`anchor "${id}" is not followed by a "## Title" heading`, line);
    const title = m[1].trim();
    if (/[*`[\]<>]/.test(title)) fail(`markup in section title "${title}"`, t);
    const end = k + 1 < anchors.length ? anchors[k + 1].line : lines.length;
    const html = renderBlocks(lines.slice(t + 1, end), t + 1, id === 'glossary');
    if (!html) fail(`section "${id}" has no content`, line);
    return { id, title, html };
  });

  const ids = new Set(sections.map((s) => s.id));
  if (ids.size !== sections.length) fail('duplicate section ids');
  for (const s of sections) {
    // Belt and braces on the trust contract, over and above the whitelist.
    if (/<\s*(script|style|iframe)\b|javascript:|\bon[a-z]+=/i.test(s.html)) {
      fail(`unsafe markup slipped into section "${s.id}"`);
    }
  }

  const ts = `/**
 * MMRocket Sim user guide content — the in-app rendered version of
 * packages/app/user-guide.md.
 *
 * GENERATED from packages/app/user-guide.md by scripts/build-user-guide.mjs — do NOT
 * edit this file by hand; edit the markdown and re-run
 * \`node scripts/build-user-guide.mjs\` (the app's build script runs it
 * automatically). Each section's \`html\` is our own trusted, static markup
 * (never user input; semantic tags only, no scripts/styles), rendered via
 * dangerouslySetInnerHTML in GuideDialog.
 */

export interface GuideSection {
  id: string;
  title: string;
  /** Trusted static HTML (semantic tags only, no scripts/styles). */
  html: string;
}

export const GUIDE_SECTIONS: GuideSection[] = [
${sections.map((s) => `  {\n${field('id', s.id)},\n${field('title', s.title)},\n${field('html', s.html)}\n  }`).join(',\n')}
];
`;
  return { ts, sections: sections.length };
}

function main() {
  let out;
  try {
    out = compileGuide();
  } catch (err) {
    if (!(err instanceof GuideError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
  writeFileSync(OUT, out.ts);
  console.log(`build-user-guide: wrote ${out.sections} sections to packages/app/src/data/userGuide.ts`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
