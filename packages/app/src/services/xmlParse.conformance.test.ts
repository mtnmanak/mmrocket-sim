import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jsXmlParser } from './xmlParseJs.js';
import { CONFORMANCE_QUERIES, runConformance } from './xmlParseParity.js';

/**
 * The DOM members the importers read (xmlParse.ts XmlElement), exercised on
 * documents built to break a careless implementation, and held to what REAL
 * CHROME answered (critique F1 fix 2). Headless step 2, 2026-10-01.
 *
 * What it catches that the corpus cannot: a querySelector that returns the
 * LAST match, a getElementsByTagName that stops one level down, comma lists
 * returned in group order, dropped empty elements, mangled non-ASCII,
 * case-insensitive tag matching (happy-dom's habit), and css-select's
 * "relative" reading of `el.querySelectorAll('A > B')` — where the DOM lets A
 * be el itself or an ancestor of it, and css-select by default does not.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SERVICES = here;
const golden = JSON.parse(readFileSync(join(here, '__fixtures__/xml-parity/chrome-golden.json'), 'utf8')) as {
  chrome: string; conformance: Record<string, unknown>;
};

describe(`DOM-surface conformance of the JS parser, against Chrome ${golden.chrome}`, () => {
  it('the golden has an answer for every probe, and for no probe that is gone', () => {
    expect(Object.keys(runConformance(jsXmlParser)).sort()).toEqual(Object.keys(golden.conformance).sort());
  });

  it('every probe answers as Chrome did', () => {
    const got = runConformance(jsXmlParser);
    const wrong = Object.keys(golden.conformance)
      .filter((k) => JSON.stringify(got[k]) !== JSON.stringify(golden.conformance[k]))
      .map((k) => `${k}\n    Chrome ${JSON.stringify(golden.conformance[k])}\n    JS     ${JSON.stringify(got[k])}`);
    expect(wrong).toEqual([]);
  });
});

/**
 * Every selector the importers use has a SHAPE these probes cover. The shape
 * is the selector with each tag name replaced by T: `:scope > subcomponents >
 * stage` is `:scope > T > T`. A selector written in a new shape — an
 * attribute selector, a sibling combinator, a pseudo-class — fails here until
 * a probe of that shape is added and the golden regenerated, because the JS
 * adapter has never been checked against Chrome on it.
 *
 * Read by grep, so it sees what is written literally: the first argument of
 * querySelector / querySelectorAll / closest / getElementsByTagName and of
 * the xmlText helper (imported as `text` in two readers), with `${…}` read as
 * a tag name. A selector built elsewhere and passed in a variable is not
 * seen — none is today: the variable call sites are the helpers themselves.
 */
const IMPORTERS = ['orkFile.ts', 'rocksimFile.ts', 'rasaeroFile.ts', 'exMotors.ts', 'xmlUtil.ts', 'rocksimMotorEvidence.ts'];
const shapeOf = (selector: string): string => selector
  .replace(/\$\{[^}]*\}/g, 'T')
  .replace(/[A-Za-z_À-￿][\w\-.·À-￿]*/g, (m, offset: number, s: string) => (s[offset - 1] === ':' ? m : 'T'))
  .replace(/\s+/g, ' ')
  .trim();

describe('selector shapes', () => {
  const covered = new Set(CONFORMANCE_QUERIES
    .filter((q) => q.op === 'qs' || q.op === 'qsa' || q.op === 'closest' || q.op === 'gebtn')
    .map((q) => shapeOf(q.arg!)));

  const used = new Map<string, string>();
  for (const file of IMPORTERS) {
    const src = readFileSync(join(SERVICES, file), 'utf8');
    const call = /\b(?:querySelector|querySelectorAll|closest|getElementsByTagName|xmlText|text)\(\s*(?:[A-Za-z_$][\w$.!?]*\s*,\s*)?(['`])((?:(?!\1).)*)\1/g;
    for (const m of src.matchAll(call)) {
      // text(el, 'Tag') and xmlText(el, 'Tag') take the element first; the
      // DOM methods take the selector first. The optional group takes both.
      used.set(m[2]!, file);
    }
  }

  it('finds the importers\' selectors at all (a regex that matches nothing passes everything)', () => {
    expect(used.size).toBeGreaterThan(40);
    expect([...used.keys()]).toContain(':scope > subcomponents > stage');
    expect([...used.keys()]).toContain('parallelstage, podset, boosterset');
    expect([...used.keys()]).toContain('SimulationResults');
  });

  it('every one has a shape the conformance probes cover', () => {
    const uncovered = [...used].filter(([sel]) => !covered.has(shapeOf(sel))).map(([sel, f]) => `${f}: '${sel}' (${shapeOf(sel)})`);
    expect(uncovered).toEqual([]);
  });

  it('reads shapes as intended', () => {
    expect(shapeOf(':scope > ${tag}')).toBe(':scope > T');
    expect(shapeOf('RockSimDocument > DesignInformation > RocketDesign')).toBe('T > T > T');
    expect(shapeOf(':scope > SimulationEventList > SimulationEvent, :scope > SimulationEvents > SimulationEvent'))
      .toBe(':scope > T > T, :scope > T > T');
    expect(shapeOf('data > eng-data')).toBe('T > T');
    expect(shapeOf('a[x="1"]')).not.toBe('T');
  });
});
