/**
 * Regenerates src/services/__fixtures__/xml-parity/chrome-golden.json — what
 * REAL CHROME's native DOMParser makes of the XML-parity cases, the answers the
 * JS parser (src/services/xmlParseJs.ts) is held to in CI by
 * src/services/xmlParse.golden.test.ts.
 *
 * Usage (from the repo root):
 *   node packages/app/scripts/xml-chrome-golden.mjs [--check]
 *
 * --check writes nothing: it reports which recorded entries Chrome now answers
 * differently, and exits 1 if any do.
 *
 * WHEN TO RUN IT. When the golden test fails with "golden is stale", or warns
 * that its import hashes were SKIPPED because the importers or the catalogues
 * they read changed (the `importKey` below, scripts/xml-golden-key.mjs — a
 * motors refresh does that, and must not turn CI red: verify-step2 finding 1);
 * or when a fixture, a case in xmlParseParity.ts, or a parser package is added
 * or bumped. Read the diff of the JSON before committing it: an entry that moved
 * is a statement about what users' browsers now do.
 *
 * WHAT IT NEEDS, neither of which CI has (so the JSON is a committed artifact,
 * the arrangement build-nozzle-db.mjs and the TeaVM kernel already use):
 *  - a system Chrome (Playwright's `channel: 'chrome'`);
 *  - playwright-core, which is NOT a dependency of this repo. Either
 *    `npm i --no-save playwright-core` at the root first, or point
 *    PLAYWRIGHT_CORE at an installed copy's package folder.
 *
 * HOW. Vite bundles src/services/xmlParseParity.ts — the four importers, the
 * seam, the cases — for the browser, exactly as the app bundles them. The page
 * runs goldenRun() with the seam's default parser, which in a browser is the
 * native DOMParser. Node then hashes the long strings (each fixture's DOM dump
 * and import result, as SHA-256; the hostile and conformance answers are
 * stored whole) and writes the JSON. Numbers in import results are rounded to
 * 14 significant digits in the page, as the test rounds its own.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importerKey } from './xml-golden-key.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(APP, 'src/services/__fixtures__');
const OUT = join(FIXTURES, 'xml-parity/chrome-golden.json');
const check = process.argv.includes('--check');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The committed fixtures the golden covers: every design or motor file at
 *  the top of __fixtures__, by the extensions xmlParseParity.formatOf reads. */
export function goldenFixtureNames() {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ork|rkt|cdx1|rse)$/i.test(d.name))
    .map((d) => d.name)
    .sort();
}

async function main() {
  const pwSpec = process.env.PLAYWRIGHT_CORE
    ? pathToFileURL(join(resolve(process.env.PLAYWRIGHT_CORE), 'index.mjs')).href
    : 'playwright-core';
  let chromium;
  try {
    ({ chromium } = await import(pwSpec));
  } catch {
    console.error('playwright-core is not installed: `npm i --no-save playwright-core`, or set PLAYWRIGHT_CORE.');
    process.exit(2);
  }
  const { build } = await import('vite');

  const outDir = mkdtempSync(join(tmpdir(), 'xml-golden-'));
  try {
    await build({
      configFile: false,
      logLevel: 'warn',
      root: APP,
      build: {
        lib: { entry: join(APP, 'src/services/xmlParseParity.ts'), formats: ['es'], fileName: 'parity' },
        outDir,
        emptyOutDir: true,
        minify: false,
        target: 'es2022',
      },
    });
    const bundle = readFileSync(join(outDir, 'parity.js'), 'utf8');
    const names = goldenFixtureNames();
    const fixtures = names.map((name) => ({ name, b64: readFileSync(join(FIXTURES, name)).toString('base64') }));

    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    let raw;
    let chromeVersion;
    try {
      chromeVersion = browser.version();
      const page = await browser.newPage();
      await page.route('http://local/**', (route) => (route.request().url().endsWith('.mjs')
        ? route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle })
        : route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>golden</title>' })));
      await page.goto('http://local/');
      raw = await page.evaluate(async (inputs) => {
        const m = await import('http://local/parity.mjs');
        const decoded = inputs.map(({ name, b64 }) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return { name, bytes };
        });
        return m.goldenRun(decoded);
      }, fixtures);
    } finally {
      await browser.close();
    }

    const golden = {
      note: 'Generated by packages/app/scripts/xml-chrome-golden.mjs in real Chrome (native DOMParser). '
        + 'Do not edit by hand: regenerate. Hashes are SHA-256 of the UTF-8 JSON strings.',
      chrome: chromeVersion,
      generated: new Date().toISOString().slice(0, 10),
      // What the import hashes were computed from (xml-golden-key.mjs): the
      // golden test checks them only while this still matches.
      importKey: importerKey(APP),
      hostile: raw.hostile,
      conformance: raw.conformance,
      fixtures: Object.fromEntries(Object.entries(raw.fixtures).map(([name, f]) => [name, {
        elements: f.elements,
        dom: f.dom.startsWith('THROW') ? f.dom : sha(f.dom),
        importer: f.importer.startsWith('THROW') ? f.importer : sha(f.importer),
        importerLength: f.importer.length,
      }])),
    };

    if (check) {
      const old = JSON.parse(readFileSync(OUT, 'utf8'));
      const moved = [];
      if (old.importKey !== golden.importKey) moved.push('importKey: the importers or their catalogues changed');
      for (const part of ['hostile', 'conformance', 'fixtures']) {
        const keys = new Set([...Object.keys(old[part] ?? {}), ...Object.keys(golden[part])]);
        for (const k of keys) {
          if (JSON.stringify(old[part]?.[k]) !== JSON.stringify(golden[part][k])) moved.push(`${part}: ${k}`);
        }
      }
      console.log(moved.length ? `Chrome ${chromeVersion} now differs on:\n  ${moved.join('\n  ')}` : `Chrome ${chromeVersion}: golden is current.`);
      process.exitCode = moved.length ? 1 : 0;
      return;
    }
    writeFileSync(OUT, `${JSON.stringify(golden, null, 1)}\n`);
    console.log(`Wrote ${OUT}: Chrome ${chromeVersion}, ${names.length} fixtures, `
      + `${Object.keys(golden.hostile).length} hostile rows, ${Object.keys(golden.conformance).length} conformance probes.`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
