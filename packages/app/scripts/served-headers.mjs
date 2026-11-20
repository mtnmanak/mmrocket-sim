/** Cloudflare Pages headers are reviewed source; check the exact deployed HTML. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const asciiLower = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Path rules and their ordered header pairs; comments and blank lines are ignored. */
export function parseHeaders(text) {
  const blocks = Object.create(null);
  let headers;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      headers = blocks[line.trim()] ??= [];
    } else {
      const match = line.trim().match(/^([^:]+):\s*(.*)$/);
      if (!headers || !match) throw new Error(`Invalid header rule: ${line}`);
      headers.push([match[1], match[2]]);
    }
  }
  return blocks;
}

/** Browsers use the first occurrence of a duplicate CSP directive. */
export function cspDirectives(value) {
  const directives = new Map();
  for (const part of value.split(';')) {
    const [rawName, ...sources] = part.trim().split(/\s+/);
    const name = asciiLower(rawName);
    if (name && !directives.has(name)) directives.set(name, sources);
  }
  return directives;
}

/** Hash UTF-8 script text after the browser's HTML newline preprocessing. */
export function inlineScriptHashes(html) {
  // Consume whole scripts before looking for another comment: comment markers
  // inside a script are body bytes, while commented-out script tags are inert.
  const tags = /<!--[\s\S]*?(?:-->|$)|<script(?=[\t\n\f />])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi;
  const attributes = /([^\t\n\f "'<>/=]+)(?:[\t\n\f ]*=[\t\n\f ]*(?:"[^"]*"|'[^']*'|[^\t\n\f >]*))?/g;
  return [...html.replace(/\r\n?/g, '\n').matchAll(tags)]
    .filter((match) => {
      if (match[1] === undefined) return false;
      const attrs = [...match[1].matchAll(attributes)];
      if (attrs.some(attribute => asciiLower(attribute[1]) === 'src')) return false;
      // JSON-LD is an inert data block. Keep hashing every other type, and
      // respect HTML's first-duplicate-attribute rule rather than hiding code.
      const type = attrs.find(attribute => asciiLower(attribute[1]) === 'type');
      const value = type?.[0].match(/=\s*(?:"([^"]*)"|'([^']*)'|([^\t\n\f >]*))/);
      return asciiLower(value?.[1] ?? value?.[2] ?? value?.[3] ?? '') !== 'application/ld+json';
    })
    .map((match) => `sha256-${createHash('sha256').update(match[2], 'utf8').digest('base64')}`);
}

/** Problems that must stop a build, rather than silently allowing new scripts. */
export function checkServedHeaders(html, headersText) {
  const problems = [];
  for (const [index, line] of headersText.split(/\r?\n/).entries()) {
    if (line.length > 2_000) problems.push(`_headers line ${index + 1} exceeds 2,000 characters`);
  }
  let blocks;
  try {
    blocks = parseHeaders(headersText);
  } catch (error) {
    return [...problems, error.message];
  }
  const policies = (blocks['/*'] ?? []).filter(([name]) => name.toLowerCase() === 'content-security-policy');
  if (policies.length !== 1) problems.push('Expected one Content-Security-Policy for /*');
  const directives = cspDirectives(policies[0]?.[1] ?? '');
  const expected = new Set((Array.isArray(html) ? html : [html]).flatMap(inlineScriptHashes));
  const names = [directives.has('script-src') ? 'script-src' : 'default-src'];
  if (directives.has('script-src-elem')) names.push('script-src-elem');
  for (const name of names) {
    const scripts = directives.get(name) ?? [];
    const listed = new Set(scripts.filter((source) => /^'sha256-.*'$/.test(source)).map((source) => source.slice(1, -1)));
    for (const hash of expected) {
      if (!listed.has(hash)) problems.push(`Missing inline script hash '${hash}' in ${name}`);
    }
    for (const hash of listed) {
      if (!expected.has(hash)) problems.push(`Stale inline script hash '${hash}' in ${name}`);
    }
    for (const source of scripts) {
      if (["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'"].includes(asciiLower(source))) {
        problems.push(`Forbidden ${source} in ${name}`);
      }
    }
  }
  return problems;
}

/** All emitted HTML shares the /* policy, so compare its combined hash set. */
export function checkDistHtml(distDir, headersText) {
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) pages.push(readFileSync(path, 'utf8'));
    }
  };
  walk(distDir);
  if (pages.length === 0) throw new Error(`No HTML files in ${distDir}`);
  return checkServedHeaders(pages, headersText);
}
