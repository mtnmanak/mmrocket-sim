import { MAX_DESIGN_PARTS, refusePartCount } from '../tree/sanitize.js';
import { MAX_NESTING, parseDecimal } from './xmlUtil.js';
import { declaresDoctype, XmlDoctypeRefused } from './xmlParse.js';

interface ElementCount {
  tag: string;
  text: string;
  children: ElementCount[];
}
const child = (el: ElementCount, tag: string) => el.children.find(c => c.tag === tag);

/**
 * Board Tier 2 part-cap early refusal: a cheap lexical pass, before either
 * DOM parser or component conversion. Only plain element syntax is proven.
 * Attributes, entities, CDATA, deep nesting and unmodelled retention rules
 * fall back to the existing checks, never to a guessed count. Scan to the end
 * for the exact refusal count, without a DOM or any design-part allocation.
 */
function plainElements(xml: string, documentTag: string): ElementCount | undefined {
  // Tier 2 early refusal must not replace the parser's malformed-XML refusal.
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(xml)) return;
  const holder: ElementCount = { tag: '', text: '', children: [] };
  const stack = [holder];
  const start = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let at = start;
  while (at < xml.length) {
    const open = xml.indexOf('<', at);
    const raw = xml.slice(at, open < 0 ? xml.length : open);
    if (raw.includes('&') || raw.includes(']]>') || (stack.length === 1 && /[^ \t\r\n]/.test(raw))) return;
    stack[stack.length - 1]!.text += raw;
    if (open < 0) break;
    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4);
      if (close < 0 || xml[close - 1] === '-' || xml.slice(open + 4, close).includes('--')) return;
      at = close + 3;
      continue;
    }
    if (xml.startsWith('<?xml ', open) && stack.length === 1 && !holder.children.length) {
      const close = xml.indexOf('?>', open + 6);
      if (close < 0 || open !== start) return;
      // Prove only XML 1.0 and its ordered, standard pseudo-attributes.
      if (!/^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(['"])1\.0\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(['"])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(['"])(?:yes|no)\3)?[ \t\r\n]*\?>$/.test(xml.slice(open, close + 2))) return;
      at = close + 2;
      continue;
    }
    const close = xml.indexOf('>', open + 1);
    if (close < 0) return;
    const match = /^<(\/?)([A-Za-z_][\w.-]*)[ \t\r\n]*(\/?)>$/.exec(xml.slice(open, close + 1));
    if (!match || match[2] === 'parsererror') return;
    if (match[1]) {
      if (match[3] || stack.length === 1 || stack.pop()!.tag !== match[2]) return;
    } else {
      // Tier 2: document-wide selectors may use a nested design or Recovery.
      // Leave that selection to the installed parser and the existing late cap.
      if (stack.length > 1 && match[2] === documentTag) return;
      const el: ElementCount = { tag: match[2]!, text: '', children: [] };
      stack[stack.length - 1]!.children.push(el);
      if (!match[3]) stack.push(el);
      if (stack.length > MAX_NESTING + 8) return;
    }
    at = close + 1;
  }
  if (stack.length !== 1 || holder.children.length !== 1) return;
  return holder.children[0];
}

function number(el: ElementCount, tag: string, fallback: number): number | undefined {
  const field = child(el, tag);
  if (!field) return fallback;
  if (field.children.length) return;
  const value = parseDecimal(field.text.trim());
  return Number.isFinite(value) ? value : fallback;
}

const INTERNAL = new Set(['BodyTube', 'Ring', 'MassObject', 'Parachute', 'Streamer']);
const FINS = new Set(['FinSet', 'CustomFinSet']);
const BODY = new Set(['NoseCone', 'Transition']);
const EXTERNAL = new Set(['TubeFinSet', 'LaunchLug', 'ExternalPod']);

/** Exact count at RockSim's first (pre-grouping) refusal, for proven cases. */
function rocksimCount(root: ElementCount): number | undefined {
  if (root.tag !== 'RockSimDocument') return;
  const info = child(root, 'DesignInformation');
  const design = info && child(info, 'RocketDesign');
  if (!design) return;
  const declared = number(design, 'StageCount', 1);
  if (declared === undefined) return;
  const stages = Math.floor(Math.max(1, Math.min(3, declared)));
  let count = stages;
  const visit = (el: ElementCount, parent: string, level: number): boolean => {
    const tag = el.tag;
    if (tag === 'SubAssembly') return false; // Flattening has its own independent depth cap.
    const body = BODY.has(tag) || (parent === 'stage' && tag === 'BodyTube');
    const internal = INTERNAL.has(tag) && !body;
    const fin = FINS.has(tag);
    const external = EXTERNAL.has(tag);
    if (!body && !internal && !fin && !external) return true; // Unsupported subtree is ignored.
    const holds = parent === 'stage' ? body : parent === 'bodytube' ? !body
      : parent === 'innertube' ? internal : internal || fin;
    if (!holds) return true;
    if (tag === 'ExternalPod') return false; // Direct and wrapped pod chains need the full importer.
    count++;
    if (tag !== 'BodyTube' && !BODY.has(tag)) return true; // Leaf handlers never visit AttachedParts.
    const inside = tag === 'BodyTube' ? number(el, 'IsInsideTube', 0) : 0;
    if (inside === undefined) return false;
    const type = tag === 'BodyTube' ? (parent !== 'stage' || inside === 1 ? 'innertube' : 'bodytube') : tag;
    const wrap = child(el, 'AttachedParts');
    if (level >= MAX_NESTING || !wrap) return true;
    return wrap.children.every(c => visit(c, type, level + 1));
  };
  for (const slot of ['Stage3Parts', 'Stage2Parts', 'Stage1Parts'].slice(0, stages)) {
    const wrap = child(design, slot);
    if (wrap && !wrap.children.every(c => visit(c, 'stage', 1))) return;
  }
  return count;
}

/** Flat RASAero chains with no conditional/synthesised extra parts. */
function rasaeroCount(root: ElementCount): number | undefined {
  if (root.tag !== 'RASAeroDocument') return;
  const design = child(root, 'RocketDesign');
  if (!design || child(root, 'Recovery')) return;
  let count = 1;
  for (const el of design.children) {
    if (['Booster', 'FinCan', 'BoatTail'].includes(el.tag)) return;
    if (!['NoseCone', 'BodyTube', 'Transition'].includes(el.tag)) continue;
    count++;
    if (el.tag === 'NoseCone') continue;
    if (child(el, 'Fin')) count++; // readFin takes only the FIRST direct child.
    if (el.tag === 'BodyTube' && el.children.some(c =>
      ['Protuberance', 'LaunchLugDiameter', 'LaunchLugLength'].includes(c.tag))) return;
  }
  return count;
}

export function refuseOversizedForeignXml(xml: string, format: 'rkt' | 'cdx1'): void {
  if (declaresDoctype(xml)) throw new XmlDoctypeRefused();
  const root = plainElements(xml, format === 'rkt' ? 'RockSimDocument' : 'RASAeroDocument');
  if (!root) return;
  const count = format === 'rkt' ? rocksimCount(root) : rasaeroCount(root);
  if (count !== undefined && count > MAX_DESIGN_PARTS) refusePartCount(count);
}
