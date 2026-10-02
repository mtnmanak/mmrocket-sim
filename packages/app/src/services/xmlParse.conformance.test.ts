import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { jsXmlParser } from './xmlParseJs.js';
import { COVERED_SELECTOR_SHAPES, runConformance, selectorShape } from './xmlParseParity.js';

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
 * stage` is `:scope > T > T` (xmlParseParity.ts selectorShape). A selector
 * written in a new shape — an attribute selector, a sibling combinator, a
 * pseudo-class — fails here until a probe of that shape is added and the
 * golden regenerated, because the JS adapter has never been checked against
 * Chrome on it.
 *
 * Read by grep, so it sees what is written literally: the first argument of
 * querySelector / querySelectorAll / closest / getElementsByTagName and of
 * the xmlText helper (imported as `text` in two readers), in any of the three
 * quotes, with `${…}` read as a tag name. What grep cannot see — a selector in
 * a variable, a tag literal handed to a helper that builds `:scope > ${tag}`
 * — the RUNTIME check sees: in the `jsxml` project, xmlParseJs.setup.ts
 * records every selector run on a JS-parser document and fails the file if
 * one has an uncovered shape (verify-step2 finding 3, 2026-10-01).
 */
const IMPORTERS = ['orkFile.ts', 'rocksimFile.ts', 'rasaeroFile.ts', 'exMotors.ts', 'xmlUtil.ts', 'rocksimMotorEvidence.ts'];
// text(el, 'Tag') and xmlText(el, 'Tag') take the element first; the DOM
// methods take the selector first. The optional group takes both.
const SELECTOR_CALL = /\b(?:querySelector|querySelectorAll|closest|getElementsByTagName|xmlText|text)\(\s*(?:[A-Za-z_$][\w$.!?]*\s*,\s*)?(['"`])((?:(?!\1).)*)\1/g;
const selectorsIn = (src: string): string[] => [...src.matchAll(SELECTOR_CALL)].map((m) => m[2]!);

describe('selector shapes', () => {
  const used = new Map<string, string>();
  for (const file of IMPORTERS) {
    for (const s of selectorsIn(readFileSync(join(SERVICES, file), 'utf8'))) used.set(s, file);
  }

  it('finds the importers\' selectors at all (a regex that matches nothing passes everything)', () => {
    expect(used.size).toBeGreaterThan(40);
    expect([...used.keys()]).toContain(':scope > subcomponents > stage');
    expect([...used.keys()]).toContain('parallelstage, podset, boosterset');
    expect([...used.keys()]).toContain('SimulationResults');
  });

  it('reads a selector in any quote (verify-step2 finding 3: a double-quoted one was invisible)', () => {
    expect(selectorsIn('void doc.querySelector("RocketDesign[x]");')).toEqual(['RocketDesign[x]']);
    expect(selectorsIn("el.closest('a > b'); text(el, `:scope > ${tag}`);")).toEqual(['a > b', ':scope > ${tag}']);
    expect(selectorsIn('el.querySelectorAll(\'a[x="1"]\')')).toEqual(['a[x="1"]']);
  });

  it('every one has a shape the conformance probes cover', () => {
    const uncovered = [...used].filter(([sel]) => !COVERED_SELECTOR_SHAPES.has(selectorShape(sel)))
      .map(([sel, f]) => `${f}: '${sel}' (${selectorShape(sel)})`);
    expect(uncovered).toEqual([]);
  });

  it('reads shapes as intended', () => {
    expect(selectorShape(':scope > ${tag}')).toBe(':scope > T');
    expect(selectorShape('RockSimDocument > DesignInformation > RocketDesign')).toBe('T > T > T');
    expect(selectorShape(':scope > SimulationEventList > SimulationEvent, :scope > SimulationEvents > SimulationEvent'))
      .toBe(':scope > T > T, :scope > T > T');
    expect(selectorShape('data > eng-data')).toBe('T > T');
    expect(selectorShape('a[x="1"]')).not.toBe('T');
    expect(COVERED_SELECTOR_SHAPES.has(selectorShape('RocketDesign[x]'))).toBe(false);
  });
});
