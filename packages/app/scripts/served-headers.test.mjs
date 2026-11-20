import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NETWORK_HOSTS } from '../src/services/net.ts';
import { CHANGELOG, PRE_VERSIONING_NOTE } from '../src/changelog.ts';
import { renderReleaseNotes } from './release-notes.mjs';
import { checkDistHtml, checkServedHeaders, cspDirectives, inlineScriptHashes, parseHeaders } from './served-headers.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const headersText = read('../public/_headers');
const blocks = parseHeaders(headersText);
const headers = new Map(blocks['/*']);
const csp = cspDirectives(headers.get('Content-Security-Policy'));

describe('row 122: served headers match the app and its deployed scripts', () => {
  it('has one path rule, exactly four headers, and respects the Pages line limit', () => {
    expect(Object.keys(blocks)).toEqual(['/*']);
    expect(blocks['/*'].map(([name]) => name).sort()).toEqual([
      'Content-Security-Policy', 'Permissions-Policy', 'Referrer-Policy', 'X-Content-Type-Options',
    ]);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=(self)');
    expect(checkServedHeaders(html, headersText)).toEqual([]);
  });

  it('allows framing only by the same origin', () => {
    expect(csp.get('frame-ancestors')).toEqual(["'self'"]);
  });

  it('pins exactly the inline script hashes and allows only self and the beacon script origin', () => {
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(3);
    expect(new Set(csp.get('script-src'))).toEqual(new Set([
      "'self'", 'https://static.cloudflareinsights.com', ...hashes.map((hash) => `'${hash}'`),
    ]));
  });

  it('keeps connect-src equal to the app origins, inline example data and analytics', () => {
    expect(new Set(csp.get('connect-src'))).toEqual(new Set([
      "'self'", 'data:', ...NETWORK_HOSTS, 'https://cloudflareinsights.com',
    ]));
  });

  it('allows both analytics hosts named in the guide network paragraph', () => {
    const paragraph = read('../user-guide.md').split('\n').find((line) => line.startsWith('**What needs the network'));
    expect(paragraph).toBeTruthy();
    const hosts = [...paragraph.matchAll(/\b(?:static\.)?cloudflareinsights\.com\b/g)].map(([host]) => host);
    expect(new Set(hosts).size).toBe(2);
    for (const host of hosts) {
      expect([...csp.values()].flat()).toContain(`https://${host}`);
    }
  });

  it('keeps base, objects, workers, images, fonts and inline styles compatible', () => {
    for (const name of ['default-src', 'base-uri', 'worker-src', 'font-src']) {
      expect(csp.get(name)).toEqual(["'self'"]);
    }
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.has('form-action')).toBe(false);
  });

  it('reports added or changed inline scripts, removed scripts, and deleted hashes', () => {
    expect(checkServedHeaders(`${html}<script>newScript()</script>`, headersText)).toEqual([
      expect.stringContaining('Missing inline script hash'),
    ]);
    const changed = html.replace("var theme = 'dark'", "var theme = 'light'");
    expect(changed).not.toBe(html);
    expect(checkServedHeaders(changed, headersText)).toEqual([
      expect.stringContaining('Missing inline script hash'), expect.stringContaining('Stale inline script hash'),
    ]);
    const removed = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/i, '');
    expect(checkServedHeaders(removed, headersText)).toEqual([expect.stringContaining('Stale inline script hash')]);
    const hash = inlineScriptHashes(html)[0];
    expect(checkServedHeaders(html, headersText.replace(`'${hash}'`, '')))
      .toEqual([expect.stringContaining('Missing inline script hash')]);
  });

  it('rejects oversized lines, unsafe script sources and missing or malformed policies', () => {
    const boundary = `  Boundary: ${'x'.repeat(2_000 - '  Boundary: '.length)}`;
    expect(boundary).toHaveLength(2_000);
    expect(checkServedHeaders(html, `${headersText}\n${boundary}`)).toEqual([]);
    expect(checkServedHeaders(html, `${headersText}\n#${'x'.repeat(2_000)}`))
      .toEqual([expect.stringContaining('exceeds 2,000 characters')]);
    for (const source of ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'UNSAFE-INLINE'", "'UNSAFE-EVAL'", "'STRICT-DYNAMIC'"]) {
      expect(checkServedHeaders(html, headersText.replace("script-src 'self'", `script-src 'self' ${source}`)))
        .toEqual([expect.stringContaining(`Forbidden ${source}`)]);
    }
    expect(checkServedHeaders('', '/*\n  Referrer-Policy: no-referrer'))
      .toEqual(['Expected one Content-Security-Policy for /*']);
    expect(checkServedHeaders('', '  orphan: header')).toEqual([expect.stringContaining('Invalid header rule')]);
  });

  it('uses case-insensitive directive names and the first duplicate', () => {
    expect(checkServedHeaders(html, headersText.replace('script-src', 'Script-Src'))).toEqual([]);
    expect(cspDirectives("Script-Src 'self'; script-src 'unsafe-inline'").get('script-src')).toEqual(["'self'"]);
  });

  it('checks hashes and unsafe sources in script-src-elem and the default-src fallback', () => {
    const policy = (value) => `/*\n  Content-Security-Policy: ${value}\n`;
    const hash = inlineScriptHashes('<script>ok()</script>')[0];
    for (const directive of ['script-src-elem', 'default-src']) {
      const prefix = directive === 'script-src-elem' ? `script-src '${hash}'; ` : '';
      expect(checkServedHeaders('<script>ok()</script>', policy(`${prefix}${directive} '${hash}'`))).toEqual([]);
      expect(checkServedHeaders('<script>ok()</script>', policy(`${prefix}${directive} 'self'`)))
        .toContainEqual(expect.stringContaining(`in ${directive}`));
      expect(checkServedHeaders('', policy(`${prefix}${directive} '${hash}'`)))
        .toContainEqual(expect.stringContaining(`Stale inline script hash '${hash}' in ${directive}`));
      for (const source of ["'unsafe-inline'", "'UNSAFE-EVAL'", "'strict-dynamic'"]) {
        expect(checkServedHeaders('', policy(`${directive} ${source}`)))
          .toContain(`Forbidden ${source} in ${directive}`);
      }
    }
    expect(checkServedHeaders(html, headersText.replace("; style-src", "; script-src-elem 'unsafe-inline'; style-src")))
      .toContain("Forbidden 'unsafe-inline' in script-src-elem");
  });

  it('recognizes only real src attributes, respecting quoted values and tag delimiters', () => {
    const expected = inlineScriptHashes('<script>paint()</script>');
    expect(inlineScriptHashes('<script data-note="paint when module src fails">paint()</script>')).toEqual(expected);
    expect(inlineScriptHashes("<script data-note='> src = nope'>paint()</script>")).toEqual(expected);
    expect(inlineScriptHashes('<script data-note="src" SRC = "/app.js"></script><script src></script>')).toEqual([]);
  });

  it('ignores HTML comments outside scripts and preserves comments in script bodies', () => {
    expect(inlineScriptHashes('<!-- <script>old()</script> -->')).toEqual([]);
    const body = '<!-- old() -->\npaint()';
    expect(inlineScriptHashes(`<script>${body}</script>`)).toEqual([
      `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`,
    ]);
  });

  it('does not hash JSON-LD data, but still checks executable and unknown script types', () => {
    for (const attributes of ['type="application/ld+json"', "TYPE = 'APPLICATION/LD+JSON'", 'type=application/ld+json']) {
      expect(inlineScriptHashes(`<script ${attributes}>{"name":"MMRocket Sim"}</script>`)).toEqual([]);
      expect(checkServedHeaders(`${html}<script ${attributes}>{}</script>`, headersText)).toEqual([]);
    }
    for (const type of ['', 'module', 'text/javascript', 'unknown', 'application/ld+jsonx']) {
      expect(inlineScriptHashes(`<script type="${type}">paint()</script>`)).toHaveLength(1);
    }
    // HTML uses the first duplicate attribute: a later data type cannot hide code.
    expect(inlineScriptHashes('<script type="module" type="application/ld+json">paint()</script>')).toHaveLength(1);
  });

  it('normalizes CRLF and lone CR to LF before hashing script bodies', () => {
    const expected = inlineScriptHashes('<script>first()\nsecond()\nthird()</script>');
    expect(inlineScriptHashes('<script>first()\r\nsecond()\rthird()</script>')).toEqual(expected);
  });

  it('pins a non-ASCII UTF-8 hash against both crypto and a known vector', () => {
    const body = 'café µ 🚀';
    const vector = 'sha256-XKI7Xbcvmcq2qswQIF4OeoFUzWDlte7nB1uI4t94ZXA=';
    expect(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`).toBe(vector);
    expect(inlineScriptHashes(`<script>${body}</script>`)).toEqual([vector]);
  });

  it('checks every emitted HTML page against the combined policy hash inventory', () => {
    const dist = mkdtempSync(join(tmpdir(), 'served-headers-'));
    try {
      mkdirSync(join(dist, 'releases'));
      mkdirSync(join(dist, 'other', 'nested'), { recursive: true });
      writeFileSync(join(dist, 'index.html'), html);
      writeFileSync(join(dist, 'releases', 'index.html'), '<p>No script</p>');
      expect(checkDistHtml(dist, headersText)).toEqual([]);
      const release = '<script>releaseOnly()</script>';
      const hash = inlineScriptHashes(release)[0];
      writeFileSync(join(dist, 'releases', 'index.html'), release);
      expect(checkDistHtml(dist, headersText)).toEqual([expect.stringContaining(`Missing inline script hash '${hash}'`)]);
      const approved = headersText.replace("script-src 'self'", `script-src 'self' '${hash}'`);
      expect(checkDistHtml(dist, approved)).toEqual([]);
      writeFileSync(join(dist, 'other', 'nested', 'page.html'), '<script>anotherPage()</script>');
      expect(checkDistHtml(dist, approved)).toEqual([expect.stringContaining('Missing inline script hash')]);
      // A hash can be shared across pages; an inert non-HTML asset is not a page.
      writeFileSync(join(dist, 'other', 'nested', 'page.html'), release);
      writeFileSync(join(dist, 'other', 'text.txt'), '<script>notHtml()</script>');
      expect(checkDistHtml(dist, approved)).toEqual([]);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('hashes exact UTF-8 script text and ignores external scripts', () => {
    expect(inlineScriptHashes('<script src="/app.js"></script><script SRC ="/other.js"></script>')).toEqual([]);
    // SHA-256 of an empty UTF-8 body; whitespace is still part of a nonempty script.
    expect(inlineScriptHashes('<script></script>')).toEqual(['sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=']);
    expect(inlineScriptHashes('<script> </script>')).not.toEqual(inlineScriptHashes('<script></script>'));
    expect(cspDirectives("script-src 'self'; script-src 'unsafe-inline'").get('script-src')).toEqual(["'self'"]);
    expect(parseHeaders('# comment\n/*\n  Example: https://host/path\n')).toEqual({ '/*': [['Example', 'https://host/path']] });
  });

  it('renders the complete release notes without scripts, including hostile text', () => {
    expect(renderReleaseNotes(CHANGELOG, PRE_VERSIONING_NOTE)).not.toMatch(/<script\b/i);
    expect(renderReleaseNotes([{ version: '1.0', date: '', title: '<script>alert(1)</script>', items: ['<script>bad()</script>'] }], '<script>hostilePreNote()</script>'))
      .not.toMatch(/<script\b/i);
  });
});
