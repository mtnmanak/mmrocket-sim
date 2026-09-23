/**
 * Generates packages/app/src/data/userGuide.ts from packages/app/user-guide.md, so the
 * markdown is the single source of truth for the guide. The old userGuide.ts
 * was a hand-maintained transcription that silently drifted from the markdown
 * every release (each mirror ended up with sentences the other lacked); this
 * script replaces that with a build step the app's `npm run build` runs, so
 * drift is structurally impossible.
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
 * Output is a pure function of the input file — byte-identical on re-run —
 * and its data strings are pure ASCII (non-ASCII escaped as \uXXXX) so the
 * content survives any editor/codepage mishap on the way through a Windows
 * checkout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Lives beside the app that consumes it — the guide is a
// BUILD INPUT (CI runs this script on every deploy), so it must not sit in a
// directory the project may prune.
const SRC = join(root, 'packages', 'app', 'user-guide.md');
const OUT = join(root, 'packages', 'app', 'src', 'data', 'userGuide.ts');

function fail(msg, line) {
  console.error(`build-user-guide: ${msg}${line !== undefined ? `\n  at packages/app/user-guide.md:${line + 1}` : ''}`);
  process.exit(1);
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
function renderBlocks(lines, base) {
  const out = [];
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
    out.push(`<p>${inline(para, ln)}</p>`);
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
};

function guideTokens() {
  const data = join(root, 'packages', 'app', 'src', 'data');
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
  };
}

const TOKENS = guideTokens();
for (const key of Object.keys(TOKENS)) {
  if (!(key in TOKEN_KIND)) fail(`guide token {{${key}}} has no entry in TOKEN_KIND`);
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
 *    "thrustcurve".
 *
 * Designed against the guide as it stands: "0.80 (auto)", "above 80 N
 * average thrust" and "29 mm DMS motors" all pass. If a figure is refused that
 * genuinely counts something else, give it its unit or write it in words.
 */
const UNIT_AFTER = String.raw`(?!\s*(?:N·s|Ns|N|mm|cm|km|ms|m|s|kg|g|lb|oz|ft|in|K|Pa|hPa|kPa|percent|degrees?|cal|calibers?|px|x)(?![A-Za-z]))(?!\s*[%°″′×·/])`;
const CATALOGUE_NOUN = String.raw`(?:motors?|simulator files?|thrust curves?|curve files?|curves?)\b`;
const PROSE_DATE = new RegExp(String.raw`\b\d{1,2} (?:${MONTHS.join('|')}) \d{4}\b`, 'g');

function checkBareFigures(raw, tokens) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  for (const [key, value] of Object.entries(tokens)) {
    const kind = TOKEN_KIND[key];
    if (kind === 'count') {
      rules.push({ key, re: new RegExp(String.raw`(?<![\d.,])${esc(value)}(?![\d]|[.,]\d)${UNIT_AFTER}`, 'g') });
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
    phrase.lastIndex = 0;
    const counted = phrase.exec(text);
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

const rawGuide = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
checkBareFigures(rawGuide, TOKENS);

const lines = rawGuide
  .replace(/\{\{([A-Z_]+)\}\}/g, (_m, key) => {
    if (!(key in TOKENS)) {
      fail(`unknown guide token {{${key}}} — known: ${Object.keys(TOKENS).join(', ')}`);
    }
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
  const html = renderBlocks(lines.slice(t + 1, end), t + 1);
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

// ---- emit ---------------------------------------------------------------------

// \uXXXX-escape everything outside printable ASCII (per UTF-16 unit, so
// emoji surrogate pairs stay valid JS).
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const field = (k, v) => `    ${JSON.stringify(k)}: ${ascii(JSON.stringify(v))}`;

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

writeFileSync(OUT, ts);
console.log(`build-user-guide: wrote ${sections.length} sections to packages/app/src/data/userGuide.ts`);
