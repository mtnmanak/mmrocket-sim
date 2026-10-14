import type { RocketTree } from '@online-openrocket/engine';
import type { DesignProvenance, DesignRevision, FlightTree } from '../model/design.js';
import type { XmlElement } from './xmlParse.js';

export const PROVENANCE_TAG = 'mmrsimprovenance';
export const PROVENANCE_FIELDS = {
  designer: 'Designer', kitName: 'Kit name', kitManufacturer: 'Kit manufacturer', kitPartNumber: 'Kit part number',
  comment: 'Design comments', revision: 'Revision',
} as const;
const NATIVE_FIELDS = { designer: 'designer', kitName: 'kitname', comment: 'comment', revision: 'revision', designType: 'designtype' } as const;
const DESIGN_TYPES = ['original', 'commercialkit', 'clonekit', 'upscalekit', 'downscalekit', 'modifiedkit', 'kitbash'];

/** Stored JSON key order is not evidence that a note was repaired. */
function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => sameData(value, b[i]));
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}

/** Calendar dates, not timestamps: a builder can record a change made on an earlier day. */
export function validRevisionDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function cleanDesignProvenance(value: unknown): DesignProvenance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: DesignProvenance = {};
  for (const key of Object.keys(PROVENANCE_FIELDS) as (keyof typeof PROVENANCE_FIELDS)[]) {
    if (typeof raw[key] === 'string' && raw[key]) out[key] = raw[key];
  }
  const designType = raw['designType'];
  if (typeof designType === 'string' && designType !== 'original' && DESIGN_TYPES.includes(designType)) out.designType = designType;
  if (Array.isArray(raw['revisions'])) {
    const entries: DesignRevision[] = [];
    for (const entry of raw['revisions']) {
      if (entry && typeof entry === 'object' && validRevisionDate(entry.date)
          && typeof entry.text === 'string' && entry.text.trim()) entries.push({ date: entry.date, text: entry.text });
    }
    if (entries.length) out.revisions = entries;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Load boundaries share the validator; valid metadata keeps tree/components identity. */
export function sanitizeDesignProvenance<T extends RocketTree>(tree: T, notes?: string[]): T {
  const raw = (tree as FlightTree).provenance;
  if (raw === undefined) return tree;
  const provenance = cleanDesignProvenance(raw);
  if (sameData(provenance, raw)) return tree;
  const next = { ...tree } as T & FlightTree;
  if (provenance) next.provenance = provenance;
  else delete next.provenance;
  // Information: unreadable notes are lost, but no flight input changes.
  notes?.push('Unreadable design notes were removed; readable notes were kept.');
  return next;
}

export function readDesignProvenance(rocket: XmlElement, notes: string[]): DesignProvenance | undefined {
  const raw: DesignProvenance = {};
  for (const [key, tag] of Object.entries(NATIVE_FIELDS)) {
    // XML line ends are LF; happy-dom keeps a raw CR that Chrome and the JS parser normalise.
    const value = rocket.querySelector(`:scope > ${tag}`)?.textContent?.replace(/\r\n?/g, '\n');
    if (value) Object.assign(raw, { [key]: value });
  }
  const extra = rocket.querySelector(`:scope > ${PROVENANCE_TAG}`);
  if (extra) {
    try {
      if (extra.getAttribute('version') !== '1') throw new Error('Unknown version');
      const value: unknown = JSON.parse(extra.textContent ?? '');
      const clean = cleanDesignProvenance(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unreadable record');
      const custom = value as Record<string, unknown>;
      if (clean?.kitManufacturer) raw.kitManufacturer = clean.kitManufacturer;
      if (clean?.kitPartNumber) raw.kitPartNumber = clean.kitPartNumber;
      if (clean?.revisions) raw.revisions = clean.revisions;
      const expected = { ...(raw.kitManufacturer ? { kitManufacturer: raw.kitManufacturer } : {}),
        ...(raw.kitPartNumber ? { kitPartNumber: raw.kitPartNumber } : {}), ...(raw.revisions ? { revisions: raw.revisions } : {}) };
      if (!sameData(custom, expected)) notes.push('Unreadable app-specific design notes were removed; desktop fields were kept.');
    } catch {
      notes.push('The app-specific design notes could not be read; desktop fields were kept.');
    }
  }
  return cleanDesignProvenance(raw);
}

export function writeDesignProvenance(tree: RocketTree, emit: (xml: string) => void, escape: (text: string) => string, notes?: string[]): void {
  const p = cleanDesignProvenance((tree as FlightTree).provenance);
  for (const [key, tag] of Object.entries(NATIVE_FIELDS)) {
    const value = p?.[key as keyof typeof NATIVE_FIELDS];
    if (tag === 'designtype') emit(`<designtype>${escape(value ?? 'original')}</designtype>`);
    else if (value) emit(`<${tag}>${escape(value)}</${tag}>`);
  }
  const extra = { ...(p?.kitManufacturer ? { kitManufacturer: p.kitManufacturer } : {}),
    ...(p?.kitPartNumber ? { kitPartNumber: p.kitPartNumber } : {}), ...(p?.revisions?.length ? { revisions: p.revisions } : {}) };
  if (Object.keys(extra).length) {
    emit(`<${PROVENANCE_TAG} version="1">${escape(JSON.stringify(extra))}</${PROVENANCE_TAG}>`);
    notes?.push('Kit manufacturer, kit part number and the dated revision log are saved for the app. Desktop OpenRocket ignores these app-specific fields and does not keep them when saving again.');
  }
}

export function designProvenanceLossNotes(tree: RocketTree, format: 'rkt' | 'cdx1'): string[] {
  const p = cleanDesignProvenance((tree as FlightTree).provenance);
  if (!p) return [];
  const labels: string[] = Object.entries(PROVENANCE_FIELDS).filter(([key]) => (format !== 'cdx1' || key !== 'comment')
    && Boolean(p[key as keyof typeof PROVENANCE_FIELDS])).map(([, label]) => label);
  if (p.designType) labels.push('Design type');
  if (p.revisions?.length) labels.push('Revision log');
  const notes = labels.length ? [`Design notes (${labels.join(', ')}) are not saved; use .ork to keep them.`] : [];
  const cdxName = p.comment?.trim().split('\n')[0]?.trim() || 'Imported RASAero rocket';
  if (format === 'cdx1' && p.comment && cdxName !== tree.name) {
    notes.push('Rocket name: .CDX1 keeps Design comments in its Comments field. The app uses the first line of comment text as the rocket name when reopening; save .ork to keep the name and comments separately.');
  }
  return notes;
}
