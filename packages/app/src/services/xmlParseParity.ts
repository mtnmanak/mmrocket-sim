/**
 * The shared cases and comparators of the XML-parser parity tests (headless
 * step 2, 2026-10-01; see xmlParse.ts). TEST-ONLY: nothing that ships imports
 * this (xmlParse.guard.test.ts checks), and it has no Node dependency, because
 * packages/app/scripts/xml-chrome-golden.mjs bundles it — importers and all —
 * and runs it in real Chrome to record the golden answers the JS parser is held
 * to in CI (`__fixtures__/xml-parity/chrome-golden.json`).
 *
 * WHY CHROME AND NOT happy-dom (critique F2). The tests run under happy-dom,
 * and happy-dom is a poor stand-in for a browser's XML parser: measured, it
 * disagrees with Chrome on 10 of the 29 original hostile cases, matches type
 * selectors case-INsensitively, refuses CDATA and a single-quoted XML
 * declaration, and keeps CR/CRLF in text. A JS-path-versus-happy-dom check
 * cannot see a drift TOWARD happy-dom, and raises false alarms where happy-dom
 * is the one that is wrong. So the reference is Chrome, recorded once.
 *
 * WHY THREE KINDS OF CASE (critique F1). The corpus alone is weak evidence:
 * of 25 deliberate defects in a JS DOM, 10 changed no corpus file and 12 no
 * committed fixture — `querySelector` returning the LAST match, dropped empty
 * elements, non-ASCII text mangled, `getElementsByTagName` going one level
 * deep. Only 2 querySelector calls on the whole corpus ever had more than one
 * match. So beside the fixtures there is a hostile-input table (what is
 * refused, what is read), and a DOM-surface conformance set built to have
 * repeated matches, empty elements, entities, non-ASCII and mixed content.
 */
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { parseRse } from './exMotors.js';
import { decodeXml } from './xmlUtil.js';
import { gunzipCapped, unzipMember } from './zipMember.js';
import {
  currentXmlParser, setXmlParser, XmlParseError, type XmlDocument, type XmlElement, type XmlParser,
} from './xmlParse.js';

// ─────────────────────────────── hostile table ───────────────────────────────

const LOL = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
  + Array.from({ length: 8 }, (_, i) => `<!ENTITY lol${i + 2} "${`&lol${i + 1};`.repeat(10)}">`).join('')
  + ']><a>&lol9;</a>';
const nest = (n: number): string => `<a>${'<b>'.repeat(n)}${'</b>'.repeat(n)}</a>`;

/**
 * Malformed, hostile and edge-case documents, by name. The first 29 are the
 * spec's table (§4), then the five its seam probe added, then the critique's
 * thirty (crit-edge.mjs, F4/F5), then rows added here: POSITIVE entity and
 * non-ASCII rows (F1 fix 3 — a parser that left `&amp;` undecoded, or mangled
 * `é`, refused nothing and would pass every refusal row), the XML-version rows
 * and a nesting depth Chrome refuses.
 */
export const HOSTILE: Readonly<Record<string, string>> = {
  ok: '<a><b x="1">t</b></a>',
  mismatched: '<a><b></a>',
  unclosedRoot: '<a><b></b>',
  garbage: 'not xml at all',
  empty: '',
  twoRoots: '<a/><b/>',
  undefinedEntity: '<a>&foo;</a>',
  bareAmp: '<a>R & D</a>',
  ltInAttr: '<a x="<"/>',
  dupAttr: '<a x="1" x="2"/>',
  unboundPrefix: '<x:a/>',
  rawCtrlChar: '<a>\u0002</a>',
  textAfterRoot: '<a/>junk',
  cdata: '<a>p<![CDATA[ x<y ]]>q</a>',
  crlfText: '<a>l1\r\nl2\rl3</a>',
  newlineAttr: '<a x="1\n2\t3"/>',
  charRefCR: '<a x="&#13;&#10;">&#13;</a>',
  doctypeInternalEntity: '<!DOCTYPE a [<!ENTITY e "EXPANDED">]><a>&e;</a>',
  externalEntity: '<!DOCTYPE a [<!ENTITY e SYSTEM "file:///C:/Windows/win.ini">]><a>&e;</a>',
  billionLaughs: LOL,
  singleQuotedDecl: "<?xml version='1.0' encoding='utf-8'?><a/>",
  leadingWhitespaceDecl: "  <?xml version='1.0'?><a/>",
  piAndComment: '<?pi x?><!-- c --><a><!-- c2 -->t</a>',
  nsDefault: '<a xmlns="urn:x"><b/></a>',
  // (the spec's table also counted these five under "agrees")
  cdataWithAmp: '<a><![CDATA[R & D]]></a>',
  commentWithAmp: '<a><!-- R & D -->t</a>',
  bareDoctype: '<!DOCTYPE a><a>t</a>',
  publicDoctypeNoSubset: '<!DOCTYPE a SYSTEM "http://example.invalid/x.dtd"><a>t</a>',
  deep3000: nest(3000),
  // the critique's thirty
  bomString: '\uFEFF<a>t</a>',
  bomThenDecl: '\uFEFF<?xml version="1.0"?><a>t</a>',
  declUtf16InString: '<?xml version="1.0" encoding="UTF-16"?><a>t</a>',
  declWin1252: '<?xml version="1.0" encoding="windows-1252"?><a>t\u00e9</a>',
  xml11CtrlRef: '<?xml version="1.1"?><a>&#1;</a>',
  nulRef: '<a>&#0;</a>',
  surrogateRef: '<a>&#xD800;</a>',
  loneSurrogate: '<a>\uD800</a>',
  uFFFE: '<a>\uFFFE</a>',
  nel: '<a>\u0085</a>',
  unquotedAttr: '<a x=1/>',
  cdataEndInText: '<a>]]></a>',
  doubleHyphenComment: '<a><!-- a -- b --></a>',
  digitName: '<1a/>',
  missingGt: '<a></a',
  xmlLang: '<a xml:lang="en" x="1"/>',
  prefixedBound: '<p:a xmlns:p="u" x="1">t</p:a>',
  xmlnsRebindXml: '<a xmlns:xml="urn:bad"/>',
  dtdAfter4k: `<!--${'x'.repeat(5000)}--><!DOCTYPE a [<!ENTITY e "EXPANDED">]><a>&e;</a>`,
  dtdGtInSystemId: '<!DOCTYPE a SYSTEM "x>y" [<!ENTITY e "EXPANDED">]><a>&e;</a>',
  dtdLowercase: '<!doctype a [<!ENTITY e "X">]><a>&e;</a>',
  attrLtEscaped: '<a x="&lt;b&gt;"/>',
  tabInAttrRef: '<a x="1&#9;2"/>',
  trailingWsComment: '<a/>\n<!-- c -->\n',
  emptyNsDefault: '<a xmlns=""/>',
  pIxml: '<a><?xml-stylesheet x?></a>',
  pIreservedName: '<a><?xml x?></a>',
  hugeNameChars: '<a\u00B7b/>',
  colonStartName: '<:a/>',
  entityInAttr: '<a x="&amp;&quot;&apos;"/>',
  // added here: what MUST be read, not only what must be refused
  entitiesInText: '<a>&amp;&lt;&gt;&quot;&apos;</a>',
  entitiesInAttr: '<a x="&amp;&lt;&gt;&quot;&apos;"/>',
  numericRefsText: '<a>&#xE9;&#233;&#x1F680;</a>',
  numericRefsAttr: '<a x="&#xE9;&#233;&#x1F680;"/>',
  nonAsciiName: '<Größe x="1">t</Größe>',
  nonAsciiTextAndAttr: '<a x="ü ñ 中文">é — 🚀</a>',
  u2028Text: '<a>x\u2028y\u2029z</a>',
  // U+FFFD, the trace of a file decoded with the wrong encoding: legal XML,
  // and something xmldom WARNS about \u2014 a warning must not refuse it
  // (verify-step2 finding 6).
  replacementChar: '<a x="\ufffd">t\ufffd</a>',
  version11Plain: '<?xml version="1.1"?><a>t</a>',
  version20: '<?xml version="2.0"?><a>t</a>',
  deep5000: nest(5000),
};

/** What a parser made of one hostile row: refused, or the root's tag, the
 *  first 40 characters of its text, and its attribute `x`. */
export type HostileOutcome = 'REFUSED' | { root: string; txt: string; x: string | null } | `THREW ${string}`;

export function hostileOutcome(parse: XmlParser, text: string): HostileOutcome {
  let doc: XmlDocument;
  try {
    doc = parse(text);
  } catch (e) {
    return e instanceof XmlParseError ? 'REFUSED' : `THREW ${e instanceof Error ? e.message : String(e)}`;
  }
  const root = doc.documentElement;
  return { root: root.tagName, txt: (root.textContent ?? '').slice(0, 40), x: root.getAttribute('x') };
}

export function runHostile(parse: XmlParser): Record<string, HostileOutcome> {
  return Object.fromEntries(Object.entries(HOSTILE).map(([k, t]) => [k, hostileOutcome(parse, t)]));
}

// ───────────────────────────── DOM-surface conformance ─────────────────────────────

/**
 * Small documents built for the DOM members the importers read (xmlParse.ts's
 * XmlElement): repeated matches, empty elements, entities, non-ASCII, mixed
 * content, letter case, comma lists, and a chain whose first compound is the
 * element queried from — the case where css-select's default "relative"
 * reading and the DOM's differ.
 */
export const CONFORMANCE_DOCS: Readonly<Record<string, string>> = {
  repeated: '<root><item id="1"><name>first</name></item><item id="2"><name>second</name></item>'
    + '<group><item id="3"><name>third</name><item id="4"><name>nested</name></item></item></group>'
    + '<Item id="5"><name>case</name></Item><ITEM id="6"/></root>',
  empty: '<a><b/><b></b><b> </b><c x=""/><c/><d><e/></d></a>',
  entities: '<a x="&amp;&lt;&gt;&quot;&apos;" y="&#xE9;&#233;&#x1F680;">&amp;&lt;&gt;&quot;&apos; &#xE9;&#x1F680; '
    + '<![CDATA[<raw> & stuff]]><n>R &amp; D</n></a>',
  nonAscii: '<Ruta é="ü"><Ñame>Größe 中文 🚀</Ñame><Ñame>ñ</Ñame></Ruta>',
  mixed: '<a>pre<b>in</b>post<!-- c -->tail<?pi x?><c>  spaced  </c></a>',
  lineEnds: '<a x="1\n2\t3\r\n4"><l>l1\r\nl2\rl3</l><u>x\u0085y\u2028z\u2029w</u></a>',
  commaOrder: '<rocket><stage><podset n="1"/><parallelstage n="2"/></stage><boosterset n="3"/><podset n="4"/></rocket>',
  eventPair: '<d><SimulationEvents><SimulationEvent n="1"/></SimulationEvents><SimulationEventList><SimulationEvent n="2"/>'
    + '</SimulationEventList><SimulationEvents><SimulationEvent n="3"/></SimulationEvents><x><SimulationEvents>'
    + '<SimulationEvent n="deep"/></SimulationEvents></x></d>',
  docChains: '<openrocket version="1.10"><rocket><subcomponents><stage n="1"/><stage n="2"/></subcomponents></rocket>'
    + '<simulations><simulation n="a"/><simulation n="b"/></simulations></openrocket>',
  wind: '<conditions><windlevel altitude="0" speed="1" standarddeviation="0.5"/><windlevel altitude="100" speed="2"/>'
    + '<windlevel altitude="200" speed="3" standarddeviation=""/></conditions>',
  motors: '<rocket><motormount><motor configid="a"/></motormount><stage><motormount><motor configid="b"/>'
    + '<motor configid="c"/></motormount></stage><motor configid="stray"/></rocket>',
  nsDefault: '<a xmlns="urn:x"><b k="1"/><c><b k="2"/></c></a>',
  rocksim: '<RockSimDocument><DesignInformation><RocketDesign><Name>R</Name><SerialNo>7</SerialNo>'
    + '<Stage3Parts><BodyTube><SerialNo>1</SerialNo><ID>48</ID></BodyTube></Stage3Parts></RocketDesign>'
    + '</DesignInformation><SimulationList><SimulationResults><Stage3Engines><EngineSet><MountSerialNo>1</MountSerialNo>'
    + '</EngineSet><EngineSet><MountSerialNo>1</MountSerialNo></EngineSet></Stage3Engines></SimulationResults>'
    + '</SimulationList><EngineSet><MountSerialNo>9</MountSerialNo></EngineSet></RockSimDocument>',
};

/** One probe: from the document (`from: null`) or from the element at a
 *  child-index path under the root (`[]` is the root itself). */
export interface ConformanceQuery {
  doc: string;
  from: number[] | null;
  op: 'qs' | 'qsa' | 'closest' | 'gebtn' | 'children' | 'parent' | 'text' | 'attr' | 'hasAttr' | 'tag';
  arg?: string;
}

const q = (doc: string, from: number[] | null, op: ConformanceQuery['op'], arg?: string): ConformanceQuery =>
  ({ doc, from, op, ...(arg === undefined ? {} : { arg }) });

export const CONFORMANCE_QUERIES: readonly ConformanceQuery[] = [
  // repeated: first match is the FIRST in document order; letter case is exact
  q('repeated', null, 'qs', 'item'), q('repeated', null, 'qsa', 'item'), q('repeated', null, 'qs', 'name'),
  q('repeated', null, 'qsa', 'Item'), q('repeated', null, 'qsa', 'ITEM'), q('repeated', null, 'qsa', 'item, Item'),
  q('repeated', [], 'qsa', ':scope > item'), q('repeated', [], 'qs', ':scope > group > item'),
  q('repeated', [], 'qsa', 'item > name'), q('repeated', [], 'qsa', ':scope > item > name'),
  q('repeated', [2, 0], 'qsa', 'item > name'), // first compound = the element itself
  q('repeated', [2, 0], 'qsa', 'group > item > name'), // first compound = an ANCESTOR
  q('repeated', [2, 0], 'qsa', 'root item'), q('repeated', [2, 0], 'qsa', ':scope > name'),
  q('repeated', [2, 0], 'qs', ':scope > item > name'), q('repeated', [2, 0], 'qsa', 'item'),
  q('repeated', [2, 0, 1], 'closest', 'group'), q('repeated', [2, 0, 1], 'closest', 'item'),
  q('repeated', [2, 0, 1], 'closest', ':scope'), q('repeated', [2, 0, 1], 'closest', 'root > group'),
  q('repeated', [2, 0, 1], 'closest', 'missing'), q('repeated', [2, 0, 1], 'closest', 'Group'),
  q('repeated', [], 'gebtn', 'item'), q('repeated', [], 'gebtn', 'name'), q('repeated', [2], 'gebtn', 'item'),
  q('repeated', [], 'gebtn', 'Item'), q('repeated', [], 'children'), q('repeated', [2, 0], 'children'),
  q('repeated', [2, 0, 1], 'parent'), q('repeated', [], 'parent'), q('repeated', [3], 'tag'),
  q('repeated', [0], 'attr', 'id'), q('repeated', [0], 'attr', 'missing'), q('repeated', [0], 'hasAttr', 'id'),
  q('repeated', [0], 'hasAttr', 'ID'),
  // empty elements are elements; " " is text; x="" is present
  q('empty', [], 'qsa', 'b'), q('empty', [], 'children'), q('empty', [0], 'text'), q('empty', [2], 'text'),
  q('empty', [3], 'attr', 'x'), q('empty', [3], 'hasAttr', 'x'), q('empty', [4], 'attr', 'x'),
  q('empty', [4], 'hasAttr', 'x'), q('empty', [], 'qsa', ':scope > c'), q('empty', [], 'qsa', 'e'),
  q('empty', [], 'qs', ':scope > d > e'), q('empty', [5], 'children'), q('empty', [], 'text'),
  // entities decode in text and attributes; CDATA is text
  q('entities', [], 'text'), q('entities', [], 'attr', 'x'), q('entities', [], 'attr', 'y'),
  q('entities', [], 'qs', 'n'), q('entities', [0], 'text'),
  // non-ASCII names, text and attributes
  q('nonAscii', [], 'qsa', 'Ñame'), q('nonAscii', [], 'text'), q('nonAscii', [], 'attr', 'é'),
  q('nonAscii', [], 'tag'), q('nonAscii', [0], 'text'), q('nonAscii', [], 'qs', ':scope > Ñame'),
  // mixed content: textContent joins every text node, comments and PIs excluded
  q('mixed', [], 'text'), q('mixed', [], 'children'), q('mixed', [1], 'text'),
  // line endings and attribute-value normalisation
  q('lineEnds', [], 'attr', 'x'), q('lineEnds', [0], 'text'), q('lineEnds', [1], 'text'),
  // comma lists come back in DOCUMENT order, not group order
  q('commaOrder', [], 'qsa', 'parallelstage, podset, boosterset'),
  q('commaOrder', null, 'qsa', 'boosterset, podset'),
  q('eventPair', [], 'qsa', ':scope > SimulationEventList > SimulationEvent, :scope > SimulationEvents > SimulationEvent'),
  q('eventPair', [], 'qsa', 'SimulationEvent'),
  // document-level chains; `:scope` from the document is the root element
  q('docChains', null, 'qs', 'openrocket > rocket'), q('docChains', null, 'qsa', 'openrocket > simulations > simulation'),
  q('docChains', null, 'qsa', 'rocket > subcomponents > stage'), q('docChains', null, 'qs', ':scope > rocket'),
  q('docChains', null, 'qs', 'rocket'), q('docChains', [0], 'qsa', ':scope > subcomponents > stage'),
  q('docChains', [0], 'qs', ':scope > subcomponents'), q('docChains', [], 'attr', 'version'),
  q('docChains', null, 'qs', 'missing'), q('docChains', null, 'qsa', 'missing'),
  // windlevel: present, missing and empty attributes
  q('wind', [], 'qsa', ':scope > windlevel'), q('wind', [0], 'hasAttr', 'standarddeviation'),
  q('wind', [1], 'hasAttr', 'standarddeviation'), q('wind', [2], 'hasAttr', 'standarddeviation'),
  q('wind', [1], 'attr', 'standarddeviation'), q('wind', [2], 'attr', 'standarddeviation'),
  // getElementsByTagName reaches every depth, in document order
  q('motors', [], 'gebtn', 'motor'), q('motors', [], 'qsa', 'motormount > motor'),
  q('motors', [1, 0], 'qsa', 'motormount > motor'), q('motors', [1, 0], 'qsa', 'stage motor'),
  q('motors', [1], 'gebtn', 'motor'),
  // a default namespace does not stop a type selector
  q('nsDefault', [], 'qsa', 'b'), q('nsDefault', [], 'qsa', ':scope > b'), q('nsDefault', [], 'tag'),
  q('nsDefault', [1], 'closest', 'a'),
  // the RockSim shapes: closest() across levels, bare descendants, spread
  q('rocksim', null, 'qsa', 'EngineSet'), q('rocksim', null, 'qs', 'RockSimDocument > DesignInformation > RocketDesign'),
  q('rocksim', null, 'qsa', 'SerialNo'), q('rocksim', [1, 0, 0, 0], 'closest', 'SimulationResults'),
  q('rocksim', [2], 'closest', 'SimulationResults'), q('rocksim', [0, 0], 'qs', 'RocketDesign'),
  q('rocksim', [0, 0], 'qs', ':scope > Stage3Parts > BodyTube'), q('rocksim', [0, 0, 2, 0, 0], 'parent'),
  q('rocksim', null, 'qsa', 'SimulationList > SimulationResults'),
];

/**
 * A selector's SHAPE: each tag name replaced by T, pseudo-class names kept,
 * whitespace collapsed — `:scope > subcomponents > stage` is `:scope > T > T`,
 * and a `${…}` in a template is read as a tag name. Two selectors of one shape
 * exercise the same paths of the css-select adapter in xmlParseJs.ts.
 */
export const selectorShape = (selector: string): string => selector
  .replace(/\$\{[^}]*\}/g, 'T')
  .replace(/[A-Za-z_À-￿][\w\-.·À-￿]*/g, (m, offset: number, s: string) => (s[offset - 1] === ':' ? m : 'T'))
  .replace(/\s+/g, ' ')
  .trim();

/** The selector shapes the conformance probes above hold to Chrome. An
 *  importer selector of any other shape has never been checked against a
 *  browser: xmlParse.conformance.test.ts (by grep) and xmlParseJs.setup.ts (at
 *  run time, in the `jsxml` project) both fail on one. */
export const COVERED_SELECTOR_SHAPES: ReadonlySet<string> = new Set(CONFORMANCE_QUERIES
  .filter((query) => query.op === 'qs' || query.op === 'qsa' || query.op === 'closest' || query.op === 'gebtn')
  .map((query) => selectorShape(query.arg!)));

/** Every selector run on a JS-parser document while a `jsxml` test file runs,
 *  recorded by xmlParseJs.setup.ts (verify-step2 finding 3, 2026-10-01). */
export const SELECTORS_SEEN = new Set<string>();

/** An element as a path of child indexes under the root, then its tag and
 *  the first 30 characters of its text: enough to tell two matches apart. */
function describe(el: XmlElement | null): string | null {
  if (!el) return null;
  const path: number[] = [];
  for (let e: XmlElement = el; e.parentElement; e = e.parentElement) {
    path.unshift(Array.prototype.indexOf.call(e.parentElement.children, e));
  }
  return `/${path.join('/')} ${el.tagName} ${JSON.stringify((el.textContent ?? '').slice(0, 30))}`;
}

export function runConformance(parse: XmlParser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const query of CONFORMANCE_QUERIES) {
    const key = `${query.doc} ${query.from === null ? 'doc' : `/${query.from.join('/')}`} ${query.op}${query.arg === undefined ? '' : ` ${query.arg}`}`;
    let result: unknown;
    try {
      const doc = parse(CONFORMANCE_DOCS[query.doc]!);
      let at: XmlElement | null = query.from === null ? null : doc.documentElement;
      for (const i of query.from ?? []) at = at!.children[i] ?? null;
      const arg = query.arg ?? '';
      const list = (l: ArrayLike<XmlElement>) => Array.from(l, (e) => describe(e));
      switch (query.op) {
        case 'qs': result = describe((at ?? doc).querySelector(arg)); break;
        case 'qsa': result = list((at ?? doc).querySelectorAll(arg)); break;
        case 'closest': result = describe(at!.closest(arg)); break;
        case 'gebtn': result = list(at!.getElementsByTagName(arg)); break;
        case 'children': result = list(at!.children); break;
        case 'parent': result = describe(at!.parentElement); break;
        case 'text': result = at!.textContent; break;
        case 'attr': result = at!.getAttribute(arg); break;
        case 'hasAttr': result = at!.hasAttribute(arg); break;
        case 'tag': result = at!.tagName; break;
      }
    } catch (e) {
      result = `THREW ${e instanceof Error ? e.name : 'value'}`;
    }
    if (key in out) throw new Error(`duplicate conformance query: ${key}`);
    out[key] = result;
  }
  return out;
}

// ─────────────────────────────── fixtures ───────────────────────────────

/** The importer a fixture goes through, by extension; null if none does. */
export function formatOf(name: string): 'ork' | 'rkt' | 'cdx1' | 'rse' | null {
  const m = /\.(ork|rkt|cdx1|rse)$/i.exec(name);
  return m ? (m[1]!.toLowerCase() as 'ork' | 'rkt' | 'cdx1' | 'rse') : null;
}

/**
 * Stable JSON of an import result: Maps and Sets spelled out, freshId's `c<N>`
 * ids renumbered by first appearance (the counter is per page load), and —
 * with `round` — every number cut to 14 significant digits, because Node 24
 * and Chrome 154 differ in the last bit of one `clusterRotation` (V8's Math,
 * not the parser: happy-dom, linkedom and xmldom all give Node's value).
 */
export function stableJson(value: unknown, round: boolean): string {
  const s = JSON.stringify(value, (_k, x: unknown) => {
    if (x instanceof Map) return { __map: [...x] };
    if (x instanceof Set) return { __set: [...x] };
    if (round && typeof x === 'number' && Number.isFinite(x)) return Number(x.toPrecision(14));
    return x;
  });
  const ids = new Map<string, string>();
  return s.replace(/"c(\d+)"/g, (m) => {
    if (!ids.has(m)) ids.set(m, `"#${ids.size}"`);
    return ids.get(m)!;
  });
}

/** Run a fixture through its importer with the parser installed now. */
export function importFixture(name: string, bytes: Uint8Array, round: boolean): string {
  const ab = bytes.slice().buffer;
  try {
    switch (formatOf(name)) {
      case 'ork': return stableJson(importOrk(ab), round);
      case 'rkt': return stableJson(importRkt(ab), round);
      case 'cdx1': return stableJson(importCdx1(ab), round);
      // addedAt is the wall clock at import (Date.now()), not file content.
      case 'rse': return stableJson(parseRse(new TextDecoder().decode(bytes), []).map((m) => ({ ...m, addedAt: 0 })), round);
      case null: return 'NOT A DESIGN FILE';
    }
  } catch (e) {
    return `THROW: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A fixture's XML text before any importer touches it: unzipped or
 *  gunzipped as importOrk does, then decoded as every importer does. */
export function fixtureXml(name: string, bytes: Uint8Array): string {
  let b = bytes;
  if (formatOf(name) === 'ork' && b[0] === 0x50 && b[1] === 0x4b) b = unzipMember(b, '.ork', '.ork');
  else if (formatOf(name) === 'ork' && b[0] === 0x1f && b[1] === 0x8b) b = gunzipCapped(b, '.ork');
  return decodeXml(b).xml;
}

/** The DOM a parser built, as canonical JSON: every element's tag, its
 *  attributes in document order, and its children, with adjacent text and
 *  CDATA joined (what textContent sees) and comments and PIs left out (no
 *  importer reads one). Uses the node API both parsers share, beyond the
 *  importers' narrow one. */
interface DumpNode {
  nodeType: number;
  nodeValue: string | null;
  tagName?: string;
  childNodes: ArrayLike<DumpNode>;
  attributes?: ArrayLike<{ name: string; value: string }>;
}
export function domDump(doc: XmlDocument): { json: string; elements: number } {
  let elements = 0;
  const walk = (n: DumpNode): unknown => {
    elements++;
    const attrs = Array.from(n.attributes ?? [], (a) => [a.name, a.value]);
    const kids: unknown[] = [];
    let text: string | null = null;
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 3 || c.nodeType === 4) { text = (text ?? '') + (c.nodeValue ?? ''); continue; }
      if (text !== null) { kids.push(text); text = null; }
      if (c.nodeType === 1) kids.push(walk(c));
    }
    if (text !== null) kids.push(text);
    return [n.tagName, attrs, kids];
  };
  const json = JSON.stringify(walk(doc.documentElement as unknown as DumpNode));
  return { json, elements };
}

/** Everything the Chrome golden records, computed with the parser installed
 *  now. The generator calls this in Chrome; the golden test calls it in Node
 *  under the JS parser and compares. */
export function goldenRun(fixtures: readonly { name: string; bytes: Uint8Array }[], parse: XmlParser = currentXmlParser()): {
  hostile: Record<string, HostileOutcome>;
  conformance: Record<string, unknown>;
  fixtures: Record<string, { dom: string; elements: number; importer: string }>;
} {
  const previous = currentXmlParser();
  setXmlParser(parse);
  try {
    const out: Record<string, { dom: string; elements: number; importer: string }> = {};
    for (const f of fixtures) {
      let dom: string;
      let elements = 0;
      try {
        ({ json: dom, elements } = domDump(parse(fixtureXml(f.name, f.bytes))));
      } catch (e) {
        dom = `THROW: ${e instanceof Error ? e.message : String(e)}`;
      }
      out[f.name] = { dom, elements, importer: importFixture(f.name, f.bytes, true) };
    }
    return { hostile: runHostile(parse), conformance: runConformance(parse), fixtures: out };
  } finally {
    setXmlParser(previous);
  }
}
