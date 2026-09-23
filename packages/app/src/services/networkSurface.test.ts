import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NETWORK_FEATURES, NETWORK_HOSTS } from './net.js';

/**
 * THE APP'S NETWORK SURFACE, HELD AGAINST THE SOURCE (weather build,
 * 2026-09-22). `NETWORK_HOSTS` is the list a CSP's `connect-src` would need and
 * the list the user guide's "What needs the network" paragraph answers for. A
 * list someone has to remember to update drifts, so this test reads it off the
 * code instead: every outside origin a requesting module names must be listed,
 * and every listed origin must still be requested somewhere.
 *
 * What counts as "named": a SCREAMING_CASE constant assigned an https URL
 * (`API`, `CONTRACT`, `FORECAST_API` …), or an https literal handed straight
 * to `fetch(` / `getJsonCapped(`, in any non-test module that makes a
 * request. Link hrefs (the feedback tracker, the source repository, the site
 * band's fallback menu) are not requests and are not listed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // data/ holds generated catalogues and the compiled guide, not code that fetches.
      if (name !== 'data' && name !== '__fixtures__') out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

const origin = (u: string) => new URL(u).origin;

/** Every outside origin a requesting module names, and where. */
function requestedOrigins(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (o: string, file: string) => found.set(o, [...(found.get(o) ?? []), relative(src, file)]);
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    if (!/\b(?:fetch|getJsonCapped)\(/.test(text)) continue;
    for (const m of text.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*['"`](https:\/\/[^'"`/?]+)/g)) {
      add(origin(m[1]!), file);
    }
    for (const m of text.matchAll(/\b(?:fetch|getJsonCapped)\(\s*['"`](https:\/\/[^'"`/?]+)/g)) add(origin(m[1]!), file);
  }
  return found;
}

describe('the network surface', () => {
  it('lists every outside origin the source requests from', () => {
    const requested = requestedOrigins();
    const unlisted = [...requested.entries()]
      .filter(([o]) => !NETWORK_HOSTS.includes(o))
      .map(([o, files]) => `${o} (${files.join(', ')})`);
    expect(unlisted, 'requested but not in NETWORK_HOSTS').toEqual([]);
  });

  it('lists nothing the source no longer requests from', () => {
    const requested = requestedOrigins();
    expect(NETWORK_HOSTS.filter((h) => !requested.has(h)), 'in NETWORK_HOSTS but requested nowhere').toEqual([]);
  });

  it('lists bare https origins only', () => {
    for (const h of NETWORK_HOSTS) expect(origin(h)).toBe(h);
  });
});

/**
 * The user guide's "What needs the network" paragraph is the promise the app
 * makes about what leaves the browser. It must name every host, and its count
 * ("Five things …") must be the number of features that reach out.
 */
describe('the guide’s network paragraph', () => {
  const guide = readFileSync(join(here, '..', '..', 'user-guide.md'), 'utf8');
  const paragraph = guide.split('\n').find((l) => l.startsWith('**What needs the network')) ?? '';
  const COUNT = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

  it('exists', () => {
    expect(paragraph).not.toBe('');
  });

  it('names every host the app reaches out to', () => {
    for (const h of NETWORK_HOSTS) {
      const host = new URL(h).host.replace(/^www\./, '');
      expect(paragraph, host).toContain(host);
    }
  });

  it('counts the features that reach out', () => {
    const word = COUNT[NETWORK_FEATURES.length];
    expect(paragraph).toContain(`${word} things in the app itself ever reach out`);
  });
});
