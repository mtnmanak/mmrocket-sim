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
 * to `fetch(` / `getJsonCapped(` / `getBytesCapped(` / `thrustcurveFetch(`, in any non-test
 * module that makes a request. A module counts as requesting when it calls one of
 * those, or catalogueClient.ts's readers built on getBytesCapped. Link hrefs (the feedback tracker, the source repository, the site
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

function originsInRequestingSource(text: string): string[] {
  if (!/\b(?:fetch|getJsonCapped|getBytesCapped|thrustcurveFetch)\(/.test(text)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(/\bconst\s+[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=\s*['"`](https:\/\/[^'"`/?]+)/g)) {
    found.push(origin(m[1]!));
  }
  for (const m of text.matchAll(/\b(?:fetch|getJsonCapped|getBytesCapped|thrustcurveFetch)\(\s*['"`](https:\/\/[^'"`/?]+)/g)) found.push(origin(m[1]!));
  return found;
}

/** Every outside origin a requesting module names, and where. */
function requestedOrigins(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (o: string, file: string) => found.set(o, [...(found.get(o) ?? []), relative(src, file)]);
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8');
    for (const o of originsInRequestingSource(text)) add(o, file);
  }
  return found;
}

describe('the network surface', () => {
  it('recognises the wrapped thrustcurve requester without a fetch comment', () => {
    expect(originsInRequestingSource("const API = 'https://www.thrustcurve.org/api/v1'; thrustcurveFetch()(`${API}/download.json`);"))
      .toEqual(['https://www.thrustcurve.org']);
  });
  it('recognises a requester built on getBytesCapped, the curated catalogue\'s reader (row 110)', () => {
    expect(originsInRequestingSource("export const CATALOGUE_BASE = 'https://catalogue.example/'; return getBytesCapped(href, opts);"))
      .toEqual(['https://catalogue.example']);
    expect(originsInRequestingSource("getBytesCapped('https://direct.example/x.json', opts)")).toEqual(['https://direct.example']);
    // A module that names an origin but requests nothing is still not a requester.
    expect(originsInRequestingSource("export const CATALOGUE_BASE = 'https://catalogue.example/';")).toEqual([]);
  });
  it('sees the catalogue client as a requester of the catalogue origin', () => {
    expect(requestedOrigins().get('https://catalogue.mountainmanrockets.com')).toContain(join('services', 'catalogueClient.ts'));
  });
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
