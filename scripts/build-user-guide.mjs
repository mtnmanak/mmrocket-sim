/**
 * Generates packages/app/src/data/userGuide.ts from docs/user-guide.md, so the
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
const SRC = join(root, 'docs', 'user-guide.md');
const OUT = join(root, 'packages', 'app', 'src', 'data', 'userGuide.ts');

function fail(msg, line) {
  console.error(`build-user-guide: ${msg}${line !== undefined ? `\n  at docs/user-guide.md:${line + 1}` : ''}`);
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

const lines = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n').split('\n');
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
 * docs/user-guide.md.
 *
 * GENERATED from docs/user-guide.md by scripts/build-user-guide.mjs — do NOT
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
