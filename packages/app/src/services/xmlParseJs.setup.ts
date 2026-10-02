/**
 * Vitest setup for the `jsxml` project (vite.config.ts): installs the JS XML
 * parser before each test file in scripts/xml-js-suites.mjs runs, so the
 * importers inside it parse through saxes + xmldom + css-select instead of
 * happy-dom's DOMParser. Setup files share the test file's module graph, so
 * this is the same xmlParse.ts instance the importers call.
 *
 * Only the IMPORTERS change parser. The global DOMParser is untouched, so a
 * test that builds or edits XML with it (rocksimRecovery.test.ts edits
 * fixtures with DOMParser and XMLSerializer; motorMatch.policy.test.ts and
 * xmlUtil.test.ts parse their own) still gets happy-dom's. The spec's first
 * run REPLACED the global and failed 14 rocksimRecovery tests for that
 * reason alone; this one does not.
 *
 * IT ALSO RECORDS EVERY SELECTOR (verify-step2 finding 3, 2026-10-01). The
 * conformance test greps the importers for selector literals and requires
 * each one's SHAPE to be among the probes held to Chrome; grep cannot see a
 * selector in a variable, or a tag literal handed to a helper that builds
 * `:scope > ${tag}`. So querySelector, querySelectorAll and closest on this
 * xmldom instance are wrapped to record their argument, and after the file's
 * last test any selector of an uncovered shape FAILS the file — naming it, so
 * the fix (add a probe of that shape to xmlParseParity.ts CONFORMANCE_QUERIES
 * and regenerate the Chrome golden) is obvious.
 */
import { afterAll } from 'vitest';
import { Document as XDocument, Element as XElement } from '@xmldom/xmldom';
import { setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';
import { COVERED_SELECTOR_SHAPES, SELECTORS_SEEN, selectorShape } from './xmlParseParity.js';

setXmlParser(jsXmlParser);

type Methods = Record<string, (this: unknown, selectors: string) => unknown>;
for (const proto of [XElement.prototype, XDocument.prototype] as unknown as Methods[]) {
  for (const name of ['querySelector', 'querySelectorAll', 'closest']) {
    const original = proto[name];
    if (typeof original !== 'function') continue; // a Document has no closest()
    proto[name] = function recorded(this: unknown, selectors: string) {
      SELECTORS_SEEN.add(selectors);
      return original.call(this, selectors);
    };
  }
}

afterAll(() => {
  const uncovered = [...SELECTORS_SEEN].filter((s) => !COVERED_SELECTOR_SHAPES.has(selectorShape(s)));
  if (uncovered.length) {
    throw new Error(`A selector of a shape no conformance probe covers ran on a JS-parser document: ${
      uncovered.map((s) => `'${s}' (${selectorShape(s)})`).join(', ')}. Add a probe of that shape to `
      + 'xmlParseParity.ts CONFORMANCE_QUERIES and regenerate the Chrome golden (scripts/xml-chrome-golden.mjs).');
  }
});
