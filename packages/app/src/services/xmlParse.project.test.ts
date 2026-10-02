import { describe, expect, it } from 'vitest';
import { browserXmlParser, currentXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

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
});
