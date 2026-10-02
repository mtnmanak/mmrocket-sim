/**
 * The pure-JavaScript XML parser for environments with NO DOMParser — Node,
 * Cloudflare Workers — behind the seam in xmlParse.ts (headless step 2,
 * 2026-10-01). A non-browser entry installs it ONCE at load:
 *
 *     import { setXmlParser } from './xmlParse.js';
 *     import { jsXmlParser } from './xmlParseJs.js';
 *     setXmlParser(jsXmlParser);
 *
 * NEVER IMPORT THIS FROM BROWSER CODE. The browser keeps the native DOMParser
 * (orchestrator's ruling (a), 2026-10-01: no change to what ships, no new
 * bundle weight — this module and its three packages are ~53 KB gzip). The
 * three packages are devDependencies of the app for now, used by the tests;
 * they become dependencies of the server package when there is one. An ESLint
 * no-restricted-imports block and xmlParse.guard.test.ts both refuse an import
 * of this file, saxes, @xmldom/xmldom or css-select from shipped source.
 *
 * THREE PIECES, each for a measured reason (scratchpad spec-step2.md §4 and
 * its critique; Chrome 154 is the reference throughout):
 *
 *  1. saxes as a strict XML 1.0 WELL-FORMEDNESS GATE, run first. xmldom alone
 *     silently accepts a bare `&` (`R & D`) and a raw control character
 *     (U+0002), both of which Chrome refuses: on the corpus, a bare `&` in the
 *     first <name> is refused by Chrome on 56 of 136 files and would have been
 *     imported by xmldom on all 136. saxes is spec-exact about CDATA and
 *     comments, which a regex pre-scan is not. The gate also refuses:
 *       - ANY DOCTYPE, from saxes's own `doctype` event — structural, so a
 *         5 KB comment before it or a `>` inside a quoted SYSTEM id cannot
 *         hide it (both bypassed the 4 KiB regex the spec first proposed;
 *         critique F5). Chrome EXPANDS internal entities, no JS parser does;
 *         refusing is the only answer that is never silently different. The
 *         browser path keeps Chrome's behaviour (ruling (b)), and the hostile
 *         table names these rows as the expected difference.
 *       - an XML declaration whose version is not 1.0. saxes implements XML
 *         1.1, under which `&#1;` is legal; Chrome's libxml2 does not
 *         (critique F4).
 *  2. @xmldom/xmldom 0.9 builds the DOM, in strict mode (every report above a
 *     warning stops the parse), with XML 1.0 line-ending normalisation: CRLF and
 *     CR become LF. Its default follows XML 1.1 and ALSO turns U+0085, U+2028 and
 *     U+2029 into LF, which Chrome keeps — a silent text change (critique F4).
 *     xmldom wraps whatever onError throws in its own ParseError, so the whole
 *     call is caught and EVERY throw becomes the one XmlParseError: otherwise
 *     an unbound prefix (`<x:a/>`, which saxes passes and xmldom refuses)
 *     reached the user as xmldom's raw text instead of the importer's message
 *     (critique F3, measured 7 of 7).
 *  3. css-select supplies `querySelector`, `querySelectorAll` and `closest`,
 *     which xmldom lacks, with the DOM's semantics (below).
 *
 * One leading U+FEFF is stripped first. Node's readFileSync(p, 'utf8') keeps a
 * BOM where the browser's Blob.text() and TextDecoder drop it, and saxes
 * refuses one: a server reading a .rse from disk would refuse a file the
 * browser opens (critique F4).
 *
 * LICENCES (critique F11): saxes and boolbase ISC; @xmldom/xmldom, xmlchars and
 * dom-serializer MIT; css-select, css-what, domhandler, domutils, entities and
 * nth-check BSD-2-Clause — all GPL-3.0-compatible. As devDependencies they
 * are distributed with nothing. Once they ship in a served bundle (the server
 * step), MIT and BSD-2 require their notices to travel with it, and the repo
 * has no third-party-notices mechanism yet: that lands with the bundle. The
 * ranges are `^`, as the rest of package.json's are, not pinned exact.
 *
 * NO SIZE, ELEMENT OR DEPTH CAPS HERE (ruling (c), critique F6). Chrome refuses
 * nesting somewhere between 4,000 and 5,000 levels; this parser accepts far
 * deeper (20,000 measured), and xmldom costs ~1.3–1.5 KB of heap per element.
 * Those limits belong to the future server package, applied BEFORE this parser
 * runs — with their own message, not "XML parse error", and with <datapoint>
 * runs (95 % of the largest corpus file's elements, read by no importer)
 * stripped or not counted, or an ordinary desktop .ork with stored flights
 * would be refused on a server that the browser opens.
 */
import { SaxesParser } from 'saxes';
import * as CSSselect from 'css-select';
import { DOMParser, Document as XDocument, Element as XElement } from '@xmldom/xmldom';
import type { Document as XmldomDocument, Element as XmldomElement, Node as XmldomNode } from '@xmldom/xmldom';
import { XmlParseError, type XmlDocument, type XmlElement, type XmlParser } from './xmlParse.js';

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

const isTag = (n: XmldomNode): n is XmldomElement => n.nodeType === ELEMENT_NODE;
const childNodes = (n: XmldomNode): XmldomNode[] => Array.from(n.childNodes);

/** css-select's view of an xmldom tree. Tag and attribute names are matched
 *  exactly as written (`xmlMode: true` below): an XML document is
 *  case-sensitive, as Chrome is — and as happy-dom, the test stand-in, is NOT
 *  (it matches `bodytube` against <BodyTube>; spec §1.4). */
const adapter: CSSselect.Options<XmldomNode, XmldomElement>['adapter'] = {
  isTag,
  getChildren: childNodes,
  // The Document is no element: a chain stops at the root, so
  // `openrocket > rocket` matches from the document as it does in a browser.
  getParent: (e) => {
    const p = e.parentNode;
    return p && p.nodeType === ELEMENT_NODE ? p : null;
  },
  getName: (e) => e.tagName,
  getAttributeValue: (e, name) => (e.hasAttribute(name) ? e.getAttribute(name) ?? undefined : undefined),
  hasAttrib: (e, name) => e.hasAttribute(name),
  getText: (n) => n.textContent ?? '',
  getSiblings: (n) => (n.parentNode ? childNodes(n.parentNode) : [n]),
  // Only reached for an ARRAY of roots, which nothing below passes; written
  // linear anyway (a Set, not Array.includes per ancestor), because the
  // prototype's quadratic version would take minutes on an element with
  // tens of thousands of children.
  removeSubsets: (nodes) => {
    const all = new Set(nodes);
    const out: XmldomNode[] = [];
    const seen = new Set<XmldomNode>();
    for (const n of nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      let inside = false;
      for (let a = n.parentNode; a; a = a.parentNode) if (all.has(a)) { inside = true; break; }
      if (!inside) out.push(n);
    }
    return out;
  },
};

/**
 * Selector options for a query run FROM `scope`, with the DOM's semantics —
 * which differ from css-select's defaults in a way no corpus file exercises:
 *
 *  - `relativeSelector: false`. css-select by default "absolutizes" a selector
 *    run from an element, so `el.querySelectorAll('A > B')` means
 *    `:scope A > B`: A must be INSIDE el. The DOM matches the whole selector
 *    against the whole document and keeps the matches that are descendants of
 *    el — A may be el itself or any ancestor. orkFile's
 *    `rocketEl.querySelectorAll('motormount > motor')` agrees either way today
 *    (every motormount is inside <rocket>); the conformance test pins the
 *    DOM's answer for the case where they differ.
 *  - `:scope` is the element queried from, and for a query on the Document it
 *    is the root element, as the DOM defines it.
 */
const optionsFor = (scope: XmldomNode): CSSselect.Options<XmldomNode, XmldomElement> => ({
  adapter,
  xmlMode: true,
  relativeSelector: false,
  // Queries run against a tree that never changes after the parse; caching
  // inside one compiled query is safe. Off anyway: each call compiles afresh,
  // so there is nothing to share, and a cache keyed on nodes is one more thing
  // that could outlive its document.
  cacheResults: false,
  context: scope.nodeType === DOCUMENT_NODE ? (scope as unknown as { documentElement: XmldomNode }).documentElement : scope,
});

// Installed on THIS xmldom module instance's prototypes, not on any global
// DOM: a browser's Element is untouched (and the browser never loads this
// file). A non-array root makes css-select search that node's CHILDREN and
// their descendants — never the node itself, as querySelector requires.
type Queryable = { querySelector(s: string): unknown; querySelectorAll(s: string): unknown };
function querySelectorAll(this: XmldomNode, selectors: string): XmldomElement[] {
  return CSSselect.selectAll(selectors, this, optionsFor(this));
}
function querySelector(this: XmldomNode, selectors: string): XmldomElement | null {
  return CSSselect.selectOne(selectors, this, optionsFor(this));
}
for (const proto of [XElement.prototype, XDocument.prototype] as unknown as Queryable[]) {
  proto.querySelectorAll = querySelectorAll;
  proto.querySelector = querySelector;
}
/** The element itself first, then each ancestor element: the first that
 *  matches. */
const closestMatch = (start: XmldomElement, query: (e: XmldomElement) => boolean): XmldomElement | null => {
  for (let e: XmldomNode | null = start; e && isTag(e); e = e.parentNode) if (query(e)) return e;
  return null;
};
(XElement.prototype as unknown as { closest(s: string): unknown }).closest = function closest(
  this: XmldomElement, selectors: string,
): XmldomElement | null {
  // `:scope` means the element `closest` was called on, as the DOM defines it.
  return closestMatch(this, CSSselect.compile(selectors, optionsFor(this)));
};

/** XML 1.0 §2.11: CRLF and a lone CR become LF — and nothing else does. */
const normalizeLineEndingsXml10 = (s: string): string => s.replace(/\r\n?/g, '\n');

/**
 * The well-formedness gate (piece 1 above). Throws XmlParseError; never
 * builds anything. Its own throws from inside an event handler propagate out
 * of `write()` untouched, and are caught with the rest below. `xmlns: true`
 * makes it apply the Namespaces constraints too, as Chrome does: an unbound
 * prefix, and `xmlns:xml` bound to anything but its own URI, are refused here
 * (the second one xmldom ACCEPTS — critique F4).
 */
export function xmlGate(text: string): void {
  const sax = new SaxesParser({ xmlns: true });
  sax.on('doctype', () => {
    throw new XmlParseError('A DOCTYPE is not accepted: no supported file format uses one, '
      + 'and entities declared in one cannot be read the way a browser reads them.');
  });
  sax.on('xmldecl', (decl) => {
    if (decl.version !== '1.0') {
      throw new XmlParseError(`XML version ${decl.version ?? '(none)'} is not accepted: only XML 1.0 is.`);
    }
  });
  try {
    sax.write(text).close();
  } catch (e) {
    if (e instanceof XmlParseError) throw e;
    throw new XmlParseError(`XML parse error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/**
 * xmldom's half (piece 2 above): build the DOM from text the gate passed.
 * Exported apart from the gate so a test can reach it with input the gate
 * would have refused first — with the gate in front, no input is known that
 * saxes passes and xmldom refuses, so the conversion below is otherwise
 * untestable, and it is the one critique F3 found missing.
 */
export function xmlDom(text: string): XmlDocument {
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({
      normalizeLineEndings: normalizeLineEndingsXml10,
      onError: (level, message) => {
        if (level !== 'warning') throw new XmlParseError(message);
      },
    }).parseFromString(text, 'text/xml');
  } catch (e) {
    // xmldom re-wraps an onError throw in its own ParseError, and its
    // DOM-construction errors (a NamespaceError) arrive the same way: convert
    // EVERYTHING, so the importer shows its own message (critique F3).
    throw new XmlParseError(`XML parse error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (!doc.documentElement) throw new XmlParseError('XML parse error: no root element');
  return doc as unknown as XmlDocument;
}

/** The Node/Workers parser: one leading BOM off, the gate, then the DOM.
 *  Throws XmlParseError for anything Chrome reports as a parse error, and for
 *  the refusals listed in the header. */
export const jsXmlParser: XmlParser = (input) => {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  xmlGate(text);
  return xmlDom(text);
};

// What the prototypes above add, told to the compiler (module augmentation:
// it describes this module instance's xmldom, which is the only one the
// patched prototypes belong to).
declare module '@xmldom/xmldom' {
  interface Element {
    querySelector(selectors: string): Element | null;
    querySelectorAll(selectors: string): Element[];
    closest(selectors: string): Element | null;
  }
  interface Document {
    querySelector(selectors: string): Element | null;
    querySelectorAll(selectors: string): Element[];
  }
}

// Compile-time proof that an xmldom element and document, with the methods
// added above, offer the narrow surface the importers are typed against. If
// xmldom drops a member xmlParse.ts's XmlElement names (or XmlElement grows one
// xmldom lacks), this stops compiling.
type Assert<T extends true> = T;
export type JsXmlConforms = Assert<XmldomElement extends XmlElement
  ? XmldomDocument extends Omit<XmlDocument, 'documentElement'> ? true : false : false>;
