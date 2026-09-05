import {
  MOTOR_DB, MOTOR_DB_DATE, setCatalogueOverlay, type CatalogueChange, type CatalogueOverlay,
  type MotorDbEntry,
} from './motorDb.js';
import { API } from './thrustcurve.js';

/**
 * "Check thrustcurve.org for newer motors" — the user's way round a stale
 * shipped catalogue, without anyone touching motors.json.
 *
 * The shipped catalogue is refreshed by `npm run motors:refresh` at release
 * time and flagged by check-upstream.mjs when it is over 30 days old; but it
 * sat 63 days unrefreshed before 2026-09-05 and a user with a motor certified
 * last week had no recourse. This module pulls the live catalogue on request,
 * diffs it against the shipped one, SCREENS every row the diff would ADD or
 * CHANGE for plausibility (a row identical to its shipped counterpart already
 * had a human look at it — refusing it would wrongly read as "removed"),
 * persists the delta in this browser, and installs it as an overlay every
 * lookup in motorDb.ts sees (getCatalogue). See CatalogueOverlay's docblock in
 * motorDb.ts for why an overlay, why persisted, why screened.
 *
 * WHAT IT DOES NOT DO: refresh the curve bundle. A NEW motor's curve downloads
 * on first use through the ordinary path (bundle miss → network); an existing
 * motor whose curve file changed upstream keeps flying the bundled curve until
 * the next release. Curves change rarely; the copy says "catalogue".
 */

export const OVERLAY_KEY = 'online-openrocket.motor-catalogue-overlay.v1';

/**
 * How soon a repeat check is refused unless forced. A full pull is one
 * search.json request per manufacturer — 26 on 2026-09-05 — against a
 * volunteer-run service. Six hours is short enough that "check again after
 * lunch" works and long enough that a page reloaded ten times does not hit
 * them ten times.
 */
export const RECHECK_MIN_MS = 6 * 60 * 60 * 1000;

/** thrustcurve.org caps a search at this many results; the refresh script pages past it by impulse class. */
const SEARCH_CAP = 500;

/** The same 18 fields fetch-motor-db.mjs projects — keep the two lists identical. */
export const CATALOGUE_FIELDS = [
  'motorId', 'manufacturerAbbrev', 'designation', 'commonName', 'impulseClass',
  'diameter', 'length', 'type', 'avgThrustN', 'maxThrustN', 'totImpulseNs',
  'burnTimeS', 'totalWeightG', 'propWeightG', 'delays', 'availability',
  'propInfo', 'caseInfo',
] as const;

/** A catalogue row's field by name — the diff and the copy iterate CATALOGUE_FIELDS. */
const field = (m: MotorDbEntry, f: string): unknown => (m as unknown as Record<string, unknown>)[f];

const NUMERIC_FIELDS = new Set([
  'diameter', 'length', 'avgThrustN', 'maxThrustN', 'totImpulseNs', 'burnTimeS', 'totalWeightG', 'propWeightG',
]);

// ------------------------------------------------------------------ screening

/**
 * Reasons a live row is refused. The shipped catalogue is looked at by a human
 * when it is refreshed; a live row is not, and the parts catalogue has already
 * shown that upstream data arrives with impossible numbers in it. Mirrors the
 * checks samplesToMotorSpec and motorDbIntegrity.test.ts apply to shipped rows.
 */
export function screenEntry(m: Partial<MotorDbEntry>): string | null {
  if (typeof m.motorId !== 'string' || !m.motorId) return 'no motorId';
  if (typeof m.designation !== 'string' || !m.designation.trim()) return 'no designation';
  if (typeof m.manufacturerAbbrev !== 'string' || !m.manufacturerAbbrev.trim()) return 'no manufacturer';
  if (!(Number.isFinite(m.diameter) && m.diameter! > 0 && m.diameter! <= 300)) return `diameter ${m.diameter} mm is not a motor`;
  if (!(Number.isFinite(m.length) && m.length! > 0 && m.length! <= 3000)) return `length ${m.length} mm is not a motor`;
  const tw = m.totalWeightG; const pw = m.propWeightG;
  if (tw !== undefined && tw !== null && !(Number.isFinite(tw) && tw > 0)) return `loaded weight ${tw} g`;
  if (pw !== undefined && pw !== null && !(Number.isFinite(pw) && pw >= 0)) return `propellant weight ${pw} g`;
  if (Number.isFinite(tw) && Number.isFinite(pw) && (pw as number) > (tw as number)) {
    return `more propellant (${pw} g) than loaded mass (${tw} g)`;
  }
  if (m.totImpulseNs !== undefined && m.totImpulseNs !== null && !(Number.isFinite(m.totImpulseNs) && m.totImpulseNs > 0)) {
    return `total impulse ${m.totImpulseNs} Ns`;
  }
  if (m.burnTimeS !== undefined && m.burnTimeS !== null && !(Number.isFinite(m.burnTimeS) && m.burnTimeS > 0)) {
    return `burn time ${m.burnTimeS} s`;
  }
  if (m.availability !== undefined && !['regular', 'occasional', 'OOP'].includes(String(m.availability))) {
    return `unknown availability "${m.availability}"`;
  }
  return null;
}

// --------------------------------------------------------------------- diff

const same = (field: string, a: unknown, b: unknown): boolean => {
  if (NUMERIC_FIELDS.has(field) && typeof a === 'number' && typeof b === 'number') {
    // 13668.3 vs 13668.300000000001 is a serialisation, not a certification change.
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

/** Added / changed (with the differing fields) / removed, by motorId. */
export function diffCatalogue(
  base: readonly MotorDbEntry[],
  live: readonly MotorDbEntry[],
): { added: MotorDbEntry[]; changed: CatalogueChange[]; removed: string[] } {
  const baseById = new Map(base.map((m) => [m.motorId, m]));
  const liveById = new Map(live.map((m) => [m.motorId, m]));
  const added: MotorDbEntry[] = [];
  const changed: CatalogueChange[] = [];
  for (const m of live) {
    const b = baseById.get(m.motorId);
    if (!b) { added.push(m); continue; }
    const fields = CATALOGUE_FIELDS.filter((f) => !same(f, field(b, f), field(m, f)));
    if (fields.length) changed.push({ motorId: m.motorId, before: b, after: m, fields: [...fields] });
  }
  const removed = base.filter((m) => !liveById.has(m.motorId)).map((m) => m.motorId);
  return { added, changed, removed };
}

// -------------------------------------------------------------- persistence

const isOverlay = (v: unknown): v is CatalogueOverlay => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['baseGenerated'] === 'string' && typeof o['fetchedAt'] === 'string'
    && Array.isArray(o['added']) && Array.isArray(o['changed']) && Array.isArray(o['removed'])
    && Array.isArray(o['rejected']);
};

/**
 * The persisted overlay, or null — and null when the shipped catalogue has
 * moved on from the base it was diffed against, in which case it is also
 * deleted: a release supersedes the overlay, and the next check starts clean.
 */
export function loadStoredOverlay(): CatalogueOverlay | null {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isOverlay(parsed)) { localStorage.removeItem(OVERLAY_KEY); return null; }
    if (parsed.baseGenerated !== MOTOR_DB_DATE) { localStorage.removeItem(OVERLAY_KEY); return null; }
    return parsed;
  } catch {
    return null;
  }
}

function storeOverlay(o: CatalogueOverlay): boolean {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(o));
    return true;
  } catch {
    // Quota, or no storage: the overlay still applies for this session.
    return false;
  }
}

/** Startup: install whatever a previous check left, if it still applies. */
export function restoreCatalogueOverlay(): CatalogueOverlay | null {
  const o = loadStoredOverlay();
  setCatalogueOverlay(o);
  return o;
}

export function discardCatalogueOverlay(): void {
  try { localStorage.removeItem(OVERLAY_KEY); } catch { /* nothing to remove */ }
  setCatalogueOverlay(null);
}

// ------------------------------------------------------------------- fetch

export interface CheckOptions {
  /** Check again even inside RECHECK_MIN_MS. */
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, manufacturer: string) => void;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function getJson(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`thrustcurve.org answered HTTP ${res.status} for ${url.replace(API, '')}`);
  return res.json();
}

/**
 * The live catalogue, pulled the way scripts/fetch-motor-db.mjs pulls it: the
 * manufacturer list from metadata.json, then one search per manufacturer,
 * subdivided by impulse class when a manufacturer hits the 500-result cap.
 * Projected to the same 18 fields so the diff compares like with like.
 */
export async function fetchLiveCatalogue(opts: CheckOptions = {}): Promise<MotorDbEntry[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const meta = await getJson(`${API}/metadata.json?availability=all`, fetchImpl, opts.signal) as {
    manufacturers?: { abbrev: string }[]; impulseClasses?: string[];
  };
  const manufacturers = (meta.manufacturers ?? []).map((m) => m.abbrev).filter(Boolean);
  const classes = meta.impulseClasses ?? [];
  if (!manufacturers.length) throw new Error('thrustcurve.org returned no manufacturers — the API shape may have changed.');

  const search = async (params: Record<string, string>): Promise<Record<string, unknown>[]> => {
    const qs = new URLSearchParams({ ...params, maxResults: String(SEARCH_CAP) });
    const body = await getJson(`${API}/search.json?${qs}`, fetchImpl, opts.signal) as { results?: Record<string, unknown>[] };
    return Array.isArray(body.results) ? body.results : [];
  };

  const byId = new Map<string, Record<string, unknown>>();
  let done = 0;
  for (const mfr of manufacturers) {
    opts.onProgress?.(done, manufacturers.length, mfr);
    let results = await search({ manufacturer: mfr, availability: 'all' });
    if (results.length >= SEARCH_CAP) {
      results = [];
      for (const ic of classes) results.push(...await search({ manufacturer: mfr, impulseClass: ic, availability: 'all' }));
    }
    for (const m of results) if (typeof m['motorId'] === 'string') byId.set(m['motorId'], m);
    done++;
  }
  opts.onProgress?.(done, manufacturers.length, '');

  // Projected, not screened: screening belongs to the rows the diff would
  // apply (checkForCatalogueUpdates), so a shipped row thrustcurve.org still
  // lists unchanged — even an implausible one the runtime already refuses at
  // fly time — is neither "refused" nor mistaken for "removed".
  return [...byId.values()]
    .map((raw) => Object.fromEntries(CATALOGUE_FIELDS.map((f) => [f, raw[f]])) as unknown as MotorDbEntry);
}

/**
 * The button. Pulls, screens, diffs against the SHIPPED catalogue, persists,
 * installs. Returns the overlay it installed (or the one it kept, when the
 * last check was recent and `force` is not set — `skipped` says so).
 */
export async function checkForCatalogueUpdates(
  opts: CheckOptions = {},
): Promise<{ overlay: CatalogueOverlay; skipped: 'recent' | null; stored: boolean }> {
  const now = opts.now ?? Date.now;
  const previous = loadStoredOverlay();
  if (previous && !opts.force && now() - Date.parse(previous.fetchedAt) < RECHECK_MIN_MS) {
    setCatalogueOverlay(previous);
    return { overlay: previous, skipped: 'recent', stored: true };
  }
  const live = await fetchLiveCatalogue(opts);
  const d = diffCatalogue(MOTOR_DB, live);
  // Screen only what would be APPLIED. The shipped catalogue carries two rows
  // (measured 2026-09-05) that fail this same screen and that the runtime
  // refuses at fly time with a message; a live pull returning them unchanged
  // must leave them exactly as they are.
  const rejected: { entry: Partial<MotorDbEntry>; reason: string }[] = [];
  const added = d.added.filter((m) => {
    const reason = screenEntry(m);
    if (reason) rejected.push({ entry: m, reason });
    return !reason;
  });
  const changed = d.changed.filter((c) => {
    const reason = screenEntry(c.after);
    if (reason) rejected.push({ entry: c.after, reason });
    return !reason; // a refused change keeps the shipped row as it was
  });
  const removed = d.removed;
  const overlay: CatalogueOverlay = {
    baseGenerated: MOTOR_DB_DATE,
    fetchedAt: new Date(now()).toISOString(),
    liveCount: live.length,
    added,
    changed,
    removed,
    rejected,
  };
  const stored = storeOverlay(overlay);
  setCatalogueOverlay(overlay);
  return { overlay, skipped: null, stored };
}

// ------------------------------------------------------------------- copy

/** "12 new, 3 changed, 0 removed" and the per-field detail, for the browser's note. */
export function describeOverlay(o: CatalogueOverlay): string[] {
  const lines: string[] = [];
  lines.push(`${o.added.length} new, ${o.changed.length} changed, ${o.removed.length} no longer listed`
    + (o.rejected.length ? `, ${o.rejected.length} refused as implausible` : '')
    + ` — thrustcurve.org checked ${o.fetchedAt.slice(0, 10)} against the catalogue of ${o.baseGenerated}.`);
  for (const c of o.changed.slice(0, 12)) {
    const parts = c.fields.map((f) => {
      const a = field(c.before, f); const b = field(c.after, f);
      return `${f} ${String(a)} → ${String(b)}`;
    });
    lines.push(`${c.after.manufacturerAbbrev} ${c.after.designation}: ${parts.join(', ')}`);
  }
  if (o.changed.length > 12) lines.push(`…and ${o.changed.length - 12} more changed.`);
  for (const r of o.rejected.slice(0, 5)) {
    lines.push(`Refused ${r.entry.manufacturerAbbrev ?? '?'} ${r.entry.designation ?? '?'}: ${r.reason}.`);
  }
  return lines;
}

/** Which of the CHANGED motors is loaded in the design right now, by maker + designation base. */
export function changedMotorsInDesign(
  o: CatalogueOverlay,
  loaded: readonly { label: string; manufacturer?: string }[],
): CatalogueChange[] {
  const base = (s: string) => s.trim().replace(/-(\d+(?:\.\d+)?|P)$/i, '').toLowerCase();
  return o.changed.filter((c) => loaded.some((l) =>
    (l.manufacturer === undefined || l.manufacturer === c.after.manufacturerAbbrev)
    && (base(l.label) === base(c.after.designation) || base(l.label) === base(c.after.commonName ?? ''))));
}
