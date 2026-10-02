// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idFree } from './simulate.testSupport.js';
import { simulateFile } from './simulateFile.js';
import { setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

/**
 * STEPS 1 AND 2 TOGETHER (Tier 0 row 58, 2026-10-01): a design file flown in
 * plain Node, with NO browser stand-in at all — no DOMParser, no window, no
 * localStorage. simulateFile (step 1) is the Launch button's own path, held to
 * the mounted app by App.simulate.test.tsx; the JS XML parser (step 2) is held
 * to Chrome by xmlParse.golden.test.ts. This file is what neither proves alone:
 * that the two compose with nothing from a browser, which is what a server or
 * a command-line tool will have. One file per format.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CASES = ['reference.ork', 'TubeFins2.rkt', 'Show-off.CDX1'] as const;

describe('headless: a design file flown in plain Node', () => {
  beforeAll(() => setXmlParser(jsXmlParser));
  afterAll(() => setXmlParser(null));

  it('really is plain Node: no DOMParser, window or localStorage', () => {
    expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe('undefined');
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe('undefined');
  });

  it.each(CASES)('%s opens and flies, and flies the same twice', async (name) => {
    const first = await simulateFile(bytesOf(name), name);
    // Measured 2026-10-01: these three apogees are equal to the last digit to
    // the same simulateFile under happy-dom's DOMParser (280.38 m, 97.06 m, and
    // Show-off's 1.17 m on a 1/4A2). Not hard-coded here: the kernel's last bits
    // differ between Node 22 and 24 (CLAUDE.md), and the parser's equality is
    // xmlParse's job, against Chrome.
    expect(first.result.summary.maxAltitude).toBeGreaterThan(0);
    // Deterministic: a second open and flight of the same bytes is the same
    // flight. Component ids are NOT: they come from a module-level counter, so
    // a second open in the same process numbers the parts on from the first
    // (c5 -> c11), and the keys built from them move with it. idFree drops
    // exactly those; the flight itself must match to the last bit.
    const second = await simulateFile(bytesOf(name), name);
    expect(idFree(second.run)).toStrictEqual(idFree(first.run));
    expect(second.result.summary).toStrictEqual(first.result.summary);
    expect(second.result.series).toStrictEqual(first.result.series);
  }, 60_000);

  it('without the JS parser installed, an open refuses rather than crashing on a missing DOMParser', async () => {
    setXmlParser(null);
    try {
      await expect(simulateFile(bytesOf('reference.ork'), 'reference.ork')).rejects.toThrow(/No XML parser is installed/);
    } finally {
      setXmlParser(jsXmlParser);
    }
  });
});
