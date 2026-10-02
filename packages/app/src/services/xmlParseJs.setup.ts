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
 */
import { setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

setXmlParser(jsXmlParser);
