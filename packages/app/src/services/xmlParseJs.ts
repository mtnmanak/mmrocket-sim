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
 *         refusing is the only answer that is never silently different. Since
 *         v0.150 the browser path refuses one too, and parseXml refuses it
 *         before either parser runs (Tier 0 row 59); this is the backstop for
 *         a direct call, with the same XmlDoctypeRefused. The hostile
 *         table pins both parsers to the same refusal on these rows.
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
 * dom-serializer MIT; css-select, css-what, domelementtype, domhandler,
 * domutils, entities and nth-check BSD-2-Clause — all GPL-3.0-compatible
 * (twelve packages, read from package-lock.json's dependency closure of the
 * three, 2026-10-01). As devDependencies they
 * are distributed with nothing. Once they ship in a served bundle (the server
 * step), MIT and BSD-2 require their notices to travel with it, and the repo
 * has no third-party-notices mechanism yet: that lands with the bundle. The
 * ranges are `^`, as the rest of package.json's are, not pinned exact.
 *
 * No structural caps by default, for browser parity. Server hosts can install
 * createJsXmlParser(limits): its SAX gate applies element, node and depth
 * budgets before DOM construction, with a distinct size-refusal error. With
 * `omitOrkSamples` the gate still validates every byte, but stored .ork sample
 * branch content never reaches xmldom: the element and node budgets then count
 * the elements the DOM gets, depth counts the source, and the omitted content
 * has its own element and node budgets and messages.
 */
import { SaxesParser } from 'saxes';
import * as CSSselect from 'css-select';
import { DOMParser, Document as XDocument, Element as XElement } from '@xmldom/xmldom';
import type { Document as XmldomDocument, Element as XmldomElement, Node as XmldomNode } from '@xmldom/xmldom';
import { XmlBudgetExceededError, XmlDoctypeRefused, XmlParseError, type XmlDocument, type XmlElement, type XmlParser } from './xmlParse.js';

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

const isTag = (n: XmldomNode): n is XmldomElement => n.nodeType === ELEMENT_NODE;
const childNodes = (n: XmldomNode): XmldomNode[] => Array.from(n.childNodes);

/** css-select's view of an xmldom tree. Local tag names and attribute names
 *  are matched exactly as written (`xmlMode: true` below): an XML document is
 *  case-sensitive, as Chrome is — and as happy-dom, the test stand-in, is NOT
 *  (it matches `bodytube` against <BodyTube>; spec §1.4). */
export const xmlSelectAdapter: NonNullable<CSSselect.Options<XmldomNode, XmldomElement>['adapter']> = {
  isTag,
  getChildren: childNodes,
  // The Document is no element: a chain stops at the root, so
  // `openrocket > rocket` matches from the document as it does in a browser.
  getParent: (e) => {
    const p = e.parentNode;
    return p && p.nodeType === ELEMENT_NODE ? p : null;
  },
  // A type selector with no default namespace matches the LOCAL name in
  // any namespace: `engine` finds <p:engine>, as it does in Chrome.
  getName: (e) => e.localName ?? e.tagName,
  getAttributeValue: (e, name) => (e.hasAttribute(name) ? e.getAttribute(name) ?? undefined : undefined),
  hasAttrib: (e, name) => e.hasAttribute(name),
  getText: (n) => n.textContent ?? '',
  getSiblings: (n) => (n.parentNode ? childNodes(n.parentNode) : [n]),
  // Only reached for an ARRAY of roots (or a sibling combinator after
  // :scope), which no importer query produces — xmlParse.test.ts calls it
  // directly, as css-select would. Written linear (a Set, not Array.includes
  // per ancestor), because the prototype's quadratic version would take
  // minutes on an element with tens of thousands of children.
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
  adapter: xmlSelectAdapter,
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

export interface XmlLimits {
  /** Elements, and nodes (default maxElements × 4), that reach the DOM. */
  maxElements: number; maxDepth: number; maxNodes?: number;
  /**
   * Host opt-in, never a default: the children of each stored .ork sample
   * branch (ORK_SAMPLE_PATH) are validated by the gate but never reach xmldom.
   * Their elements and nodes count against this budget instead of the DOM's.
   */
  omitOrkSamples?: { maxElements: number; maxNodes?: number };
}

/**
 * The .ork stored-flight sample branch: desktop OpenRocket's per-step series
 * (`<event>` and `<datapoint>` children), almost all of a long stored flight's
 * XML. No importer reads below `<flightdata>`: orkFile reads its attributes
 * only (stored summary, provenance, configurations with results). Qualified
 * names match exactly, so a prefixed lookalike, or the same name anywhere
 * else, stays. The branch element itself stays, with its attributes, so
 * `flightdata > databranch` still exists; only its content goes.
 */
const ORK_SAMPLE_PATH = ['openrocket', 'simulations', 'simulation', 'flightdata'];
const ORK_SAMPLE_TAG = 'databranch';
/**
 * Local names that a document-wide query still reads below a sample branch:
 * orkExtensions counts nested `extension`s for its loss note, and xmlDom
 * refuses a literal `parsererror` (css-select matches local names in any
 * namespace). A branch holding either is kept whole.
 */
const ORK_SAMPLE_READ = new Set(['extension', 'parsererror']);

/**
 * The well-formedness gate (piece 1 above). Never builds a DOM. Throws
 * XmlParseError, XmlDoctypeRefused, or the host's XmlBudgetExceededError.
 * Its own throws from inside an event handler propagate out
 * of `write()` untouched, and are caught with the rest below. `xmlns: true`
 * makes it apply the Namespaces constraints too, as Chrome does: an unbound
 * prefix, and `xmlns:xml` bound to anything but its own URI, are refused here
 * (the second one xmldom ACCEPTS — critique F4).
 */
export function xmlGate(text: string, limits?: XmlLimits): void {
  gate(text, limits);
}

/**
 * The gate itself. Returns the text for xmldom: `text` unchanged (the same
 * string) unless `limits.omitOrkSamples` cut a sample branch's content. A cut
 * branch becomes self-closing, so its content is never handed to xmldom, from
 * source offsets saxes reported after validating the WHOLE original text.
 */
function gate(text: string, limits?: XmlLimits): string {
  const sax = new SaxesParser({ xmlns: true });
  const cuts: [number, number][] = [];
  if (limits) {
    let elements = 0;
    let depth = 0;
    let nodes = 0;
    const maxNodes = limits.maxNodes ?? limits.maxElements * 4;
    const omit = limits.omitOrkSamples;
    const maxSkippedNodes = omit ? omit.maxNodes ?? omit.maxElements * 4 : 0;
    let skippedElements = 0;
    let skippedNodes = 0;
    // The open sample branch: the offset just past its start tag, and what
    // its content has counted so far (moved back to the DOM's count if kept).
    let branch: { from: number; elements: number; nodes: number } | null = null;
    const stack: string[] = [];
    const refuseElements = () => {
      if (elements > limits.maxElements) throw new XmlBudgetExceededError(`XML element limit is ${limits.maxElements.toLocaleString('en-US')}.`);
    };
    const refuseNodes = () => {
      if (nodes > maxNodes) throw new XmlBudgetExceededError(`XML node limit is ${maxNodes.toLocaleString('en-US')}.`);
    };
    const countNode = () => {
      if (branch) {
        branch.nodes++;
        if (++skippedNodes > maxSkippedNodes) {
          throw new XmlBudgetExceededError(`Stored flight data node limit is ${maxSkippedNodes.toLocaleString('en-US')}.`);
        }
      } else {
        nodes++;
        refuseNodes();
      }
    };
    /** Keep the open branch whole, under the DOM's budgets. */
    const keepBranch = () => {
      elements += branch!.elements;
      nodes += branch!.nodes;
      skippedElements -= branch!.elements;
      skippedNodes -= branch!.nodes;
      branch = null;
      refuseElements();
      refuseNodes();
    };
    for (const event of ['attribute', 'comment', 'processinginstruction', 'text', 'cdata'] as const) sax.on(event, countNode);
    sax.on('opentag', (tag) => {
      if (branch) {
        branch.elements++;
        if (++skippedElements > omit!.maxElements) {
          throw new XmlBudgetExceededError(`Stored flight data element limit is ${omit!.maxElements.toLocaleString('en-US')}.`);
        }
      } else {
        elements++;
        refuseElements();
      }
      if (++depth > limits.maxDepth) throw new XmlBudgetExceededError(`XML nesting limit is ${limits.maxDepth}.`);
      countNode();
      if (branch && ORK_SAMPLE_READ.has(tag.local)) {
        // What the branch counted so far, this element included, moves to
        // the DOM's budgets, and so does the rest of it.
        keepBranch();
      } else if (omit && !branch && !tag.isSelfClosing && tag.name === ORK_SAMPLE_TAG
        && stack.length === ORK_SAMPLE_PATH.length && stack.every((name, i) => name === ORK_SAMPLE_PATH[i])
        && text.charCodeAt(sax.position - 1) === 0x3e /* > */) {
        branch = { from: sax.position, elements: 0, nodes: 0 };
      }
      if (omit) stack.push(tag.name);
    });
    sax.on('closetag', () => {
      depth--;
      if (!omit) return;
      stack.pop();
      if (branch && stack.length === ORK_SAMPLE_PATH.length) {
        // Never cut on an offset that is not where saxes says the tags end.
        if (text.charCodeAt(sax.position - 1) === 0x3e) {
          cuts.push([branch.from, sax.position]);
          branch = null;
        } else keepBranch();
      }
    });
  }
  // The same refusal, and the same message, as the browser parser's backstop
  // and parseXml's pre-parse scan (Tier 0 row 59, 2026-10-01), so the two
  // parsers give one answer for a DOCTYPE even when called directly.
  sax.on('doctype', () => {
    throw new XmlDoctypeRefused();
  });
  sax.on('xmldecl', (decl) => {
    if (decl.version !== '1.0') {
      throw new XmlParseError(`XML version ${decl.version ?? '(none)'} is not accepted: only XML 1.0 is.`);
    }
  });
  try {
    sax.write(text).close();
  } catch (e) {
    if (e instanceof XmlParseError || e instanceof XmlDoctypeRefused || e instanceof XmlBudgetExceededError) throw e;
    throw new XmlParseError(`XML parse error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (!cuts.length) return text;
  // `from` is just past the branch's start tag `>`: rewrite that `>` as `/>`
  // and resume after the branch's end tag.
  const parts: string[] = [];
  let at = 0;
  for (const [from, to] of cuts) {
    parts.push(text.slice(at, from - 1), '/>');
    at = to;
  }
  parts.push(text.slice(at));
  return parts.join('');
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
        // A warning is not a refusal: xmldom warns on a U+FFFD in text (the
        // trace of a file decoded with the wrong encoding), which Chrome opens.
        if (level !== 'warning') throw new XmlParseError(message);
      },
    }).parseFromString(text, 'text/xml');
  } catch (e) {
    // xmldom re-wraps an onError throw in its own ParseError, and its
    // DOM-construction errors (a NamespaceError) arrive the same way: convert
    // EVERYTHING, so the importer shows its own message (critique F3).
    throw new XmlParseError(`XML parse error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  // No `documentElement` null check: xmldom 0.9 itself throws on every
  // rootless input (empty, whitespace, only a comment, PI or declaration), so
  // one here was unreachable (verify-step2 finding 6). xmlParse.test.ts pins
  // that xmldom behaviour; if a bump changes it, the check comes back.
  // The browser's error-element check also refuses a literal <parsererror/>
  // in well-formed XML. Keep that refusal on this path too.
  if (doc.querySelector('parsererror')) throw new XmlParseError('XML parse error');
  return doc as unknown as XmlDocument;
}

/** The Node/Workers parser: one leading BOM off, the gate, then the DOM.
 *  Throws XmlParseError for anything Chrome reports as a parse error, and for
 *  the refusals listed in the header. */
export function createJsXmlParser(limits?: XmlLimits): XmlParser {
  const parser: XmlParser = (input) => {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    return xmlDom(gate(text, limits));
  };
  // One shared gate/host budget, also available before importer lexical scans.
  // The parser still validates its own input: callers may use it directly or
  // normalize text after preflight. No request-scoped validation cache is kept.
  if (limits) parser.preflight = (text) => xmlGate(text, limits);
  return parser;
}

export const jsXmlParser: XmlParser = createJsXmlParser();

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
