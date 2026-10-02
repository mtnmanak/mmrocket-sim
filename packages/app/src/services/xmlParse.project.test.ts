import { describe, expect, it } from 'vitest';
import { browserXmlParser, currentXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';
import { SELECTORS_SEEN } from './xmlParseParity.js';

/**
 * Runs in BOTH vitest projects (vite.config.ts): in `jsxml` the importers must
 * be parsing through the JS parser, in `app` through the browser's. Without
 * this, a setup file that stopped installing the parser would leave every
 * importer suite passing under happy-dom twice while claiming a second parser.
 */
const wantJs = process.env['VITEST_XML_PARSER'] === 'js';

describe('the vitest project installs the parser it claims', () => {
  it(`parses with the ${wantJs ? 'JS' : 'browser'} parser`, () => {
    expect(currentXmlParser()).toBe(wantJs ? jsXmlParser : browserXmlParser);
  });

  it(`${wantJs ? 'records' : 'does not record'} the selectors run on a JS-parser document (verify-step2 finding 3)`, () => {
    // In `jsxml`, xmlParseJs.setup.ts records every selector so that it can
    // fail a file that ran one of a shape the conformance probes do not cover.
    // A recorder that stopped recording would pass every file.
    const doc = jsXmlParser('<a><b><c/></b></a>');
    doc.querySelector(':scope > b');
    doc.documentElement.querySelectorAll('b > c');
    doc.documentElement.children[0]!.closest('a');
    expect([':scope > b', 'b > c', 'a'].every((s) => SELECTORS_SEEN.has(s))).toBe(wantJs);
  });
});
