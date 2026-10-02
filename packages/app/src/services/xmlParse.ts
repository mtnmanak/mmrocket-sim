/**
 * The ONE place a design or motor file's XML is parsed (headless step 2,
 * 2026-10-01).
 *
 * WHY A SEAM. The four importers (orkFile.ts importOrk, rocksimFile.ts
 * importRkt, rasaeroFile.ts importCdx1, exMotors.ts parseRse) each called
 * `new DOMParser()` themselves. Node and Cloudflare Workers have no DOMParser
 * (workerd: `typeof DOMParser === 'undefined'`, measured), so none of them could
 * run outside a browser — and the tests only ran them because happy-dom
 * stands one in. They now call `parseXml`, which uses whichever parser is
 * installed:
 *
 *  - in the BROWSER, the native DOMParser, exactly as before. Same call, same
 *    `querySelector('parsererror')` check, same message per importer: nothing a
 *    user sees changes, and nothing is added to what ships (orchestrator's
 *    ruling (a) and (b), 2026-10-01). This module has no dependencies.
 *  - where there is no DOMParser, a pure-JS parser that a non-browser entry
 *    installs with `setXmlParser(jsXmlParser)` (xmlParseJs.ts: a saxes
 *    well-formedness gate, @xmldom/xmldom for the DOM, css-select for the
 *    queries). The browser never imports it: an ESLint block and
 *    xmlParse.guard.test.ts both refuse that import from shipped source.
 *
 * The two paths are held to the same answers by the xmlParse.*.test.ts files:
 * golden outputs recorded in real Chrome for the committed fixtures, the
 * hostile-input table and a DOM-surface conformance set, plus the importer and
 * hardening suites run a second time under the JS parser (the `jsxml` vitest
 * project in vite.config.ts).
 *
 * KNOWN, NAMED DIFFERENCES — three classes, each row listed by name in
 * xmlParse.hostile.test.ts JS_DIFFERS_FROM_CHROME (verify-step2 finding 8):
 *  1. A DOCTYPE. The JS parser refuses ANY, where Chrome accepts one and
 *     EXPANDS internal entities from it (`<!ENTITY e "X">` then `&e;` reads
 *     "X"). No JavaScript parser expands entities, so refusing is the only
 *     answer the JS path can give that is never silently different; 0 of the
 *     136 inputs measured (the corpus with the committed fixtures) carry a
 *     DOCTYPE, and none of OpenRocket, RockSim or RASAero writes one.
 *  2. An XML declaration of any version but 1.0. Chrome reads `version="1.1"`
 *     (and, measured, `"1.9"`) as 1.0; the JS parser refuses it, because saxes
 *     would apply XML 1.1's rules (`&#1;` legal). No supported format writes one.
 *  3. Nesting deeper than Chrome's limit, somewhere between 4,000 and 5,000
 *     levels. Chrome refuses; the JS parser has no depth cap here — that
 *     belongs to the future server package (xmlParseJs.ts header).
 * The browser keeps Chrome's behaviour in all three — no new refusal there.
 */

/** A list the importers may index, count and spread. Iterable as well as
 *  array-like: rocksimMotorEvidence.ts spreads `querySelectorAll`, and every
 *  parser here returns one that is (a NodeList / HTMLCollection in the browser,
 *  an array or xmldom's iterable live list in xmlParseJs.ts). */
export type XmlList = ArrayLike<XmlElement> & Iterable<XmlElement>;

/**
 * The DOM surface the importers may use on parsed XML — deliberately narrow, so
 * that TypeScript refuses an API the JS parser does not supply (xmldom has no
 * `firstElementChild` or `nextElementSibling`, for two). Measured over the
 * importers on 2026-10-01: these ten members are all they read. A browser
 * `Element` satisfies it structurally, so tests that hand the readers a DOM
 * element of their own still type-check.
 */
export interface XmlElement {
  readonly tagName: string;
  readonly children: XmlList;
  readonly parentElement: XmlElement | null;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selectors: string): XmlElement | null;
  querySelectorAll(selectors: string): XmlList;
  closest(selectors: string): XmlElement | null;
  getElementsByTagName(name: string): XmlList;
}

/** The parsed document. `documentElement` is never null here: a parse that
 *  produced no root element is a refusal (XmlParseError), on both paths. */
export interface XmlDocument {
  readonly documentElement: XmlElement;
  querySelector(selectors: string): XmlElement | null;
  querySelectorAll(selectors: string): XmlList;
}

/** The one error a parser throws for input that is not well-formed XML (or
 *  that the JS path refuses: a DOCTYPE, an XML version other than 1.0). The
 *  importers turn it into their own user-facing message through `parseXml`. */
export class XmlParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'XmlParseError';
  }
}

/** A parser: text in, document out, or THROW XmlParseError. It must never
 *  return a document that carries a parse error. */
export type XmlParser = (text: string) => XmlDocument;

/**
 * The platform DOMParser — the browser path, unchanged from what each importer
 * did inline before this seam: `parseFromString(text, 'text/xml')`, then
 * refuse when `querySelector('parsererror')` finds the error element (Chrome
 * nests it in the XHTML namespace, Firefox makes it the root; this query finds
 * both, as it always has). Where there is no DOMParser at all it says so,
 * rather than failing with a ReferenceError a server log would misread.
 */
export const browserXmlParser: XmlParser = (text) => {
  if (typeof DOMParser === 'undefined') {
    throw new Error('No XML parser is installed: this environment has no DOMParser. '
      + 'A Node or Workers entry must call setXmlParser(jsXmlParser) from services/xmlParseJs.ts first.');
  }
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new XmlParseError('XML parse error');
  return doc;
};

let current: XmlParser = browserXmlParser;

/**
 * Install the parser `parseXml` uses; `null` restores the browser's.
 *
 * A module-level setting, meant to be set ONCE when a non-browser entry loads
 * (a CLI, a test setup file, a Worker module). That is safe because a parse is
 * synchronous and the setting never changes afterwards — NOT because a Worker
 * isolate serves one request at a time, which it does not (one isolate can
 * serve several concurrently; critique F8). Do not switch parsers per request.
 */
export function setXmlParser(parser: XmlParser | null): void {
  current = parser ?? browserXmlParser;
}

/** The parser `parseXml` would use now. For tests that must restore it. */
export function currentXmlParser(): XmlParser {
  return current;
}

/**
 * Parse `text` with the installed parser. Malformed XML (an XmlParseError)
 * becomes `new Error(refusal)` — the importer's own message, word for word
 * what it threw before the seam ('Not a valid .ork file (XML parse error)'
 * and its siblings). Anything else is rethrown untouched: a bug is not a bad
 * file.
 *
 * `cause` ONLY OFF THE BROWSER PATH (verify-step2 finding 7, 2026-10-01).
 * Elsewhere the parser's own report rides along as `cause`, which no user sees
 * and a server log can use. In the browser the error is exactly the
 * `new Error(message)` each importer threw before the seam — ruling (b) says
 * byte for byte, and the browser's report would only ever say "XML parse
 * error", so it would give a log nothing.
 */
export function parseXml(text: string, refusal: string): XmlDocument {
  try {
    return current(text);
  } catch (e) {
    if (!(e instanceof XmlParseError)) throw e;
    // eslint-disable-next-line preserve-caught-error -- the browser path keeps the pre-seam error exactly (ruling (b)); its report says only "XML parse error"
    if (current === browserXmlParser) throw new Error(refusal);
    throw new Error(refusal, { cause: e });
  }
}
