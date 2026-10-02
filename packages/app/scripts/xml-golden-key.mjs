/**
 * The KEY of the Chrome golden's importer half (headless step 2, repair of
 * verify-step2 finding 1, 2026-10-01).
 *
 * WHY. xmlParse.golden.test.ts holds each committed fixture's IMPORT RESULT to
 * what Chrome made of it. That result depends on far more than the XML
 * parser: rasaeroFile.ts and rocksimFile.ts look motors up in
 * src/data/motors.json, orkFile.ts and rocksimFile.ts link presets from
 * presets.json, and every helper the importers call shapes it too. Held as a
 * bare hash, it turned CI red on a data change that has nothing to do with
 * parsing — measured: +0.1 g on every motor in motors.json failed 7 fixtures —
 * and the weekly motors-refresh workflow (.github/workflows/motors-refresh.yml)
 * runs `npm test` as its gate, where the golden cannot be regenerated (that
 * needs a system Chrome and playwright-core). So the automated refresh PR
 * would have sat red every time a refreshed motor was one a fixture matches.
 *
 * WHAT. The key is a SHA-256 over every file the import results are computed
 * from: the static and dynamic RELATIVE imports reachable from
 * src/services/xmlParseParity.ts (the four importers, their helpers, and the
 * JSON catalogues they read), minus the XML parser itself. xml-chrome-golden.mjs
 * records it beside the hashes; the golden test compares the import hashes only
 * while the key still matches, and otherwise SKIPS them with a printed warning
 * naming the regeneration script. What stays a hard CI assertion, key or no
 * key: the DOM each parser builds (which depends on the parser and the fixture
 * bytes alone), the hostile table, the conformance probes, and the exact
 * JS-parser-against-happy-dom comparison of every import.
 *
 * WHAT IT DOES NOT SEE. A package import (`@online-openrocket/engine`, `fflate`)
 * is not followed: a change there that moves an import result still fails the
 * import check with "golden is stale". `import type` lines are not followed
 * either, as they emit nothing.
 *
 * Line ends are normalised to LF before hashing, so a checkout with
 * core.autocrlf=true keys the same as CI's.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Where the walk starts: the module the golden script bundles and runs. */
export const KEY_ROOT = 'src/services/xmlParseParity.ts';

/** Left out of the key ON PURPOSE: the parser. A change to it must still fail
 *  the import check hard, not skip it — it is what the golden exists to watch.
 *  (xmlParseJs.ts is not reachable from the root at all; named for the reader.) */
export const KEY_EXCLUDED = ['src/services/xmlParse.ts', 'src/services/xmlParseJs.ts'];

// `import x from './y.js'`, `export * from './y.js'`, `import './y.js'` and
// `import('./y.js')`; group 1 marks `import type` / `export type`.
const IMPORT = /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

const toRel = (app, p) => relative(app, p).split(sep).join('/');

function resolveSpec(from, spec) {
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''));
  for (const c of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** The files the key covers, relative to the app folder, sorted. Throws on a
 *  relative import it cannot resolve: a key that silently covers less than the
 *  import reads is the failure this module exists to prevent. */
export function importerKeyFiles(app) {
  const seen = new Set();
  const excluded = new Set(KEY_EXCLUDED.map((p) => resolve(app, p)));
  const walk = (file) => {
    if (seen.has(file) || excluded.has(file)) return;
    seen.add(file);
    if (!/\.(ts|tsx|mjs|js)$/.test(file)) return;
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[2] ?? m[3];
      if (m[1] || !spec.startsWith('.')) continue;
      const target = resolveSpec(file, spec);
      if (!target) throw new Error(`xml-golden-key: cannot resolve '${spec}' from ${toRel(app, file)}`);
      walk(target);
    }
  };
  walk(resolve(app, KEY_ROOT));
  return [...seen].map((p) => toRel(app, p)).sort();
}

/**
 * The key: SHA-256 over each covered file's path and LF-normalised content.
 * `overrides` replaces a covered file's content by its relative path — how
 * the test simulates a catalogue refresh without touching the real file.
 */
export function importerKey(app, overrides = {}) {
  const h = createHash('sha256');
  for (const rel of importerKeyFiles(app)) {
    const text = overrides[rel] ?? readFileSync(join(app, rel), 'utf8');
    h.update(rel).update('\0').update(text.replace(/\r\n?/g, '\n')).update('\0');
  }
  return h.digest('hex');
}

/**
 * What the golden test does with one fixture's import hash: `unchecked` when
 * the key moved since the golden was recorded (skip, and warn), otherwise
 * `same` or `different` (a hard failure).
 */
export function importVerdict({ key, goldenKey, got, want }) {
  if (key !== goldenKey) return 'unchecked';
  return got === want ? 'same' : 'different';
}
