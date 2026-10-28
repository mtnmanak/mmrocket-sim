import { INITIAL_UNITS, noticeChange, noticeEqual, noticeNumber, noticeComparison, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import {
  MOTOR_DB, MOTOR_DB_DATE, motorLabel, setCatalogueOverlay, type CatalogueChange, type CatalogueOverlay,
  type MotorDbEntry,
} from './motorDb.js';
import { baseDesignation } from './motorMatch.js';
import { NetError } from './net.js';
import { validCatalogueDate } from './thrustcurve.js';
import {
  CatalogueError, MOTORS_MAX_BYTES, fetchCatalogueFile, fetchCatalogueManifest, validSnapshotRef,
  type CatalogueSnapshotRef, type ManifestSnapshot,
} from './catalogueClient.js';
import { correctMotorRow } from '../../scripts/motor-corrections.mjs';

/**
 * "Check for newer motors" — the user's way round a stale shipped catalogue,
 * without anyone touching motors.json.
 *
 * The shipped catalogue is refreshed by `npm run motors:refresh` at release
 * time and flagged by check-upstream.mjs when it is over 30 days old; but it
 * sat 63 days unrefreshed before 2026-09-05 and a user with a motor certified
 * last week had no recourse. This module reads the curated catalogue's current
 * snapshot (catalogueClient.ts; row 110, 2026-10-27 — it pulled thrustcurve.org
 * per maker until thrustcurve.org began refusing the pull), diffs it against
 * the shipped one, SCREENS every row the diff would ADD or CHANGE for
 * plausibility (a row identical to its shipped counterpart already had a human
 * look at it — refusing it would wrongly read as "removed"), persists the
 * delta in this browser, and installs it as an overlay every lookup in
 * motorDb.ts sees (getCatalogue). See CatalogueOverlay's docblock in motorDb.ts
 * for why an overlay, why persisted, why screened. It runs by itself on load
 * (catalogueAutoCheck.ts) and on the motor browser's button.
 *
 * WHAT IT DOES NOT DO: replace a bundled curve. A NEW motor's curve comes from
 * the snapshot's curves file on first use (thrustcurve.ts); an existing motor
 * whose curve file changed upstream keeps flying the bundled curve until the
 * next release (row 101).
 */

export const OVERLAY_KEY = 'online-openrocket.motor-catalogue-overlay.v1';

/**
 * How soon a repeat check is refused unless forced. A check is one small
 * manifest request when the snapshot has not moved, and a ~600 KB motors file
 * when it has. Six hours is short enough that "check again after lunch" works
 * and long enough that a page reloaded ten times does not ask ten times.
 */
export const RECHECK_MIN_MS = 6 * 60 * 60 * 1000;

/**
 * Was this overlay checked inside RECHECK_MIN_MS of `now`? A `fetchedAt` in
 * the FUTURE counts as expired: validCatalogueDate accepts one, and a clock
 * set ahead and then corrected would otherwise hold every check off until
 * that date.
 */
export function checkedRecently(o: Pick<CatalogueOverlay, 'fetchedAt'> | null, now: number): boolean {
  if (!o?.fetchedAt) return false;
  const at = Date.parse(o.fetchedAt);
  return Number.isFinite(at) && at <= now && now - at < RECHECK_MIN_MS;
}

/** The same 18 fields fetch-motor-db.mjs's FIELDS projects — keep the two lists identical. */
const CATALOGUE_FIELDS = [
  'motorId', 'manufacturerAbbrev', 'designation', 'commonName', 'impulseClass',
  'diameter', 'length', 'type', 'avgThrustN', 'maxThrustN', 'totImpulseNs',
  'burnTimeS', 'totalWeightG', 'propWeightG', 'delays', 'availability',
  'propInfo', 'caseInfo',
] as const;

const CATALOGUE_FIELD_SET: ReadonlySet<string> = new Set(CATALOGUE_FIELDS);

/** A catalogue row's field by name — the diff and the copy iterate CATALOGUE_FIELDS. */
const field = (m: MotorDbEntry, f: string): unknown => (m as unknown as Record<string, unknown>)[f];

const NUMERIC_FIELDS = new Set([
  'diameter', 'length', 'avgThrustN', 'maxThrustN', 'totImpulseNs', 'burnTimeS', 'totalWeightG', 'propWeightG',
]);
/** Numbers whose own check in screenEntry quotes a text token it cannot read ('diameter "oops" is not a motor'). */
const QUOTED_NUMERIC_FIELDS = new Set(['diameter', 'length', 'totalWeightG', 'propWeightG']);

// ------------------------------------------------------------------ screening

/**
 * Reasons a live row is refused. The shipped catalogue is looked at by a human
 * when it is refreshed; a live row is not, and the parts catalogue has already
 * shown that upstream data arrives with impossible numbers in it. Mirrors the
 * checks samplesToMotorSpec and motorDbIntegrity.test.ts apply to shipped rows.
 */
export function screenEntry(m: Partial<MotorDbEntry>, units: UnitSelection = INITIAL_UNITS): string | null {
  for (const key of CATALOGUE_FIELDS) {
    // A text token in a field whose own check below quotes it is left to that
    // check, so the refusal names what the row said; anything else of the
    // wrong type (an object's own toString can throw) is refused here.
    if (typeof m[key] === 'string' && QUOTED_NUMERIC_FIELDS.has(key)) continue;
    if (m[key] != null && typeof m[key] !== (NUMERIC_FIELDS.has(key) ? 'number' : 'string')) {
      return `${key} is not ${NUMERIC_FIELDS.has(key) ? 'a number' : 'text'}`;
    }
  }
  if (typeof m.motorId !== 'string' || !m.motorId) return 'no motorId';
  if (typeof m.designation !== 'string' || !m.designation.trim()) return 'no designation';
  if (typeof m.manufacturerAbbrev !== 'string' || !m.manufacturerAbbrev.trim()) return 'no manufacturer';
  // Required, not just checked when present (audit 2026-09-22): the motor
  // browser dereferences it on every row — its search and its load label call
  // string methods on it — so one live row without it threw inside the render.
  if (typeof m.commonName !== 'string' || !m.commonName.trim()) return 'no common name';
  for (const field of ['impulseClass', 'propInfo', 'caseInfo', 'delays', 'type'] as const) {
    if (m[field] != null && typeof m[field] !== 'string') return `${field} is not text`;
  }
  // A required number the row lacks, or carries as JSON's null, is named as
  // missing: describeOverlay shows the reason, and it read "diameter undefined
  // mm is not a motor" (audit 2026-09-30).
  if (!(Number.isFinite(m.diameter) && m.diameter! > 0 && m.diameter! <= 300)) {
    return m.diameter == null ? 'no diameter' : `diameter ${Number.isFinite(m.diameter) ? noticeQuantity('motorDimensions', m.diameter! / 1000, units) : `"${String(m.diameter)}"`} is not a motor`;
  }
  if (!(Number.isFinite(m.length) && m.length! > 0 && m.length! <= 3000)) {
    return m.length == null ? 'no length' : `length ${Number.isFinite(m.length) ? noticeQuantity('motorDimensions', m.length! / 1000, units) : `"${String(m.length)}"`} is not a motor`;
  }
  const tw = m.totalWeightG; const pw = m.propWeightG;
  if (tw !== undefined && tw !== null && !(Number.isFinite(tw) && tw > 0)) return `loaded weight ${Number.isFinite(tw) ? noticeQuantity('mass', tw / 1000, units) : `"${String(tw)}"`}`;
  if (pw !== undefined && pw !== null && !(Number.isFinite(pw) && pw >= 0)) return `propellant weight ${Number.isFinite(pw) ? noticeQuantity('mass', pw / 1000, units) : `"${String(pw)}"`}`;
  if (Number.isFinite(tw) && Number.isFinite(pw) && (pw as number) > (tw as number) && !noticeEqual((pw as number) / 1000, (tw as number) / 1000)) {
    const [propellant, loaded] = noticeComparison('mass', (pw as number) / 1000, (tw as number) / 1000, units, { parenthesized: true });
    return propellant.startsWith('just ') ? `slightly more propellant than loaded mass (${loaded})` : `more propellant (${propellant}) than loaded mass (${loaded})`;
  }
  if (m.totImpulseNs !== undefined && m.totImpulseNs !== null && !(Number.isFinite(m.totImpulseNs) && m.totImpulseNs > 0)) {
    return `total impulse ${m.totImpulseNs} Ns`;
  }
  // Required too, for the same reason: the table draws `burnTimeS.toFixed(1)`.
  // Every one of the 1,156 shipped rows carries it; the weights, which 156 of
  // them lack one or both of, stay optional above.
  if (!(Number.isFinite(m.burnTimeS) && m.burnTimeS! > 0)) {
    return m.burnTimeS == null ? 'no burn time' : `burn time ${m.burnTimeS} s`;
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
 * A stored overlay's rows through TODAY's screen. The screen runs when a check
 * writes the overlay, so an overlay written before a rule existed carries rows
 * that rule refuses — and one written before the screen required burnTimeS and
 * commonName (audit 2026-09-22) can hold a row the motor browser throws on
 * while drawing its table. The Check-again and Discard buttons that would
 * replace it live inside that browser, so the bad row stuck until a release
 * changed the shipped catalogue's date. Refused rows move to `rejected` the way
 * a check refuses them, and a refused change keeps the shipped row.
 */
function rescreen(o: CatalogueOverlay): CatalogueOverlay {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  let repaired = false;
  const rejected: CatalogueOverlay['rejected'] = o.rejected.map(r => {
    if (object(r) && object(r.entry) && typeof r.reason === 'string') return r;
    repaired = true;
    return { entry: {}, reason: 'unreadable stored refusal record discarded' };
  });
  const passes = (entry: unknown): boolean => {
    const reason = object(entry)
      ? screenEntry(entry as Partial<MotorDbEntry>) : 'not a motor row';
    if (reason) rejected.push({ entry: object(entry) ? entry : {}, reason });
    return !reason;
  };
  // Only the catalogue fields, as fetchLiveCatalogue writes them (closure
  // audit of v0.194, row D): screenEntry checks just those, and a hand-edited
  // row that also carried realManufacturer: 7 was installed whole and threw in
  // displayMotorManufacturer. Projected rather than refused, because the
  // fields the app reads are sound; the extra ones are never read from a row.
  let projected = false;
  const project = <T extends MotorDbEntry>(entry: T): T => {
    if (Object.keys(entry).every(key => CATALOGUE_FIELD_SET.has(key))) return entry;
    projected = true;
    return Object.fromEntries(CATALOGUE_FIELDS.filter(f => Object.hasOwn(entry, f)).map(f => [f, entry[f]])) as unknown as T;
  };
  const added = o.added.filter(passes).map(project);
  const changed = o.changed.filter(c => {
    if (!passes((c as CatalogueChange | null)?.after)) return false;
    if (object(c) && object(c.before) && screenEntry(c.before) === null
      && c.motorId === c.after.motorId && c.motorId === c.before.motorId
      && Array.isArray(c.fields) && c.fields.length > 0
      && c.fields.every(f => typeof f === 'string' && CATALOGUE_FIELD_SET.has(f))) return true;
    rejected.push({ entry: c.after, reason: 'unreadable stored change metadata discarded; the shipped motor was kept' });
    return false;
  }).map(c => {
    const before = project(c.before), after = project(c.after);
    return before === c.before && after === c.after ? c : { ...c, before, after };
  });
  const removed = o.removed.filter(id => typeof id === 'string' && id.length > 0);
  if (removed.length !== o.removed.length) {
    repaired = true;
    rejected.push({ entry: {}, reason: 'unreadable stored removed motor IDs discarded' });
  }
  const fetchedAt = validCatalogueDate(o.fetchedAt) ? o.fetchedAt : '';
  if (fetchedAt !== o.fetchedAt) {
    repaired = true;
    rejected.push({ entry: {}, reason: 'unreadable stored check date reset; check the catalogue again' });
  }
  // The snapshot record names the curves file thrustcurve.ts will read, so it
  // is held to the manifest's own rules (catalogueClient.ts) on every restore.
  // A bad one is dropped, never repaired: the next check writes a fresh one.
  const badSnapshot = Object.hasOwn(o, 'snapshot') && !validSnapshotRef(o.snapshot);
  if (badSnapshot) {
    repaired = true;
    rejected.push({ entry: {}, reason: 'unreadable stored catalogue snapshot discarded; check the catalogue again' });
  }
  if (!repaired && !projected && added.length === o.added.length && changed.length === o.changed.length) return o;
  const { snapshot, ...rest } = o;
  // An overlay with no snapshot field must not gain `snapshot: undefined`.
  return { ...rest, ...(snapshot !== undefined && !badSnapshot ? { snapshot } : {}), fetchedAt, added, changed, removed, rejected };
}

/**
 * The persisted overlay, or null — and null when the shipped catalogue has
 * moved on from the base it was diffed against, in which case it is also
 * deleted: a release supersedes the overlay, and the next check starts clean.
 * What it returns has been through today's screen (rescreen, above).
 */
export function loadStoredOverlay(): CatalogueOverlay | null {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isOverlay(parsed)) { localStorage.removeItem(OVERLAY_KEY); return null; }
    if (parsed.baseGenerated !== MOTOR_DB_DATE) { localStorage.removeItem(OVERLAY_KEY); return null; }
    return rescreen(parsed);
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

/** Discard: stops any check still running, so its result cannot land afterwards and undo this. */
export function discardCatalogueOverlay(): void {
  supersedeRunningCheck();
  try { localStorage.removeItem(OVERLAY_KEY); } catch { /* nothing to remove */ }
  setCatalogueOverlay(null);
}

// ------------------------------------------------------------------- fetch

export interface CheckOptions {
  /** Check again even inside RECHECK_MIN_MS. */
  force?: boolean;
  signal?: AbortSignal;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * ONE CHECK AT A TIME IN THIS PAGE. Each check takes the next generation and
 * aborts the one before it; Discard takes one too. A check whose generation is
 * no longer the latest installs and stores nothing — so an automatic check's
 * result cannot land after the user pressed Discard and silently undo it, and
 * the button's own check supersedes an automatic one still running. Two tabs
 * are not coordinated: each may download once, and the last write wins.
 */
let generation = 0;
let running: AbortController | null = null;

function supersedeRunningCheck(): number {
  generation++;
  running?.abort();
  running = null;
  return generation;
}

const stopped = (cause?: unknown) =>
  Object.assign(new Error('The catalogue check was stopped.', { cause }), { name: 'AbortError' });

/** Present a catalogue failure in one sentence, and a Stop as the AbortError the motor browser tells a Stop by. */
function checkFailure(err: unknown, signal: AbortSignal): Error {
  if (signal.aborted || (err instanceof NetError && err.kind === 'aborted')) return stopped(err);
  if (err instanceof NetError || err instanceof CatalogueError) return err;
  return err instanceof Error ? err : new Error(String(err));
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The snapshot's motors file, refused whole unless it is the catalogue it says
 * it is, then projected to the same 18 fields the shipped catalogue carries
 * and corrected the way the shipped catalogue is, so the diff compares like
 * with like.
 */
async function readSnapshotMotors(current: ManifestSnapshot, opts: { signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<MotorDbEntry[]> {
  const doc = await fetchCatalogueFile(current.motors, MOTORS_MAX_BYTES, 'motors file', opts);
  const unreadable = (why: string): never => { throw new CatalogueError('shape', `The catalogue's motors file ${why}, so it was not used.`); };
  if (!object(doc) || !Array.isArray(doc['motors'])) return unreadable('has no motor list');
  const rows = doc['motors'] as unknown[];
  if (rows.length !== doc['count'] || rows.length !== current.motors.count) return unreadable('does not hold the number of motors it states');
  const ids = new Set<string>();
  for (const m of rows) {
    if (!object(m) || typeof m['motorId'] !== 'string' || !m['motorId'] || ids.has(m['motorId'])) {
      return unreadable('has a row that is not a motor, or a repeated motor id');
    }
    ids.add(m['motorId']);
  }
  // Projected, not screened: screening belongs to the rows the diff would
  // apply (checkForCatalogueUpdates), so a shipped row the catalogue still
  // lists unchanged is neither "refused" nor mistaken for "removed". The file
  // carries seven fields more than the app's 18 (fetch-motor-db.mjs
  // FULL_FIELDS); only own catalogue fields are copied, so neither those nor a
  // `__proto__` or `constructor` key reaches the screen, the overlay, or
  // displayMotorManufacturer (rescreen's row-D note).
  //
  // And CORRECTED the way the shipped catalogue is (board Tier 1 rows 6 and
  // 37): the refresh writes motor-corrections.mjs's sourced figures over rows
  // thrustcurve.org still serves wrong (a 9,122 mm Contrail J234-BG, a Cesaroni
  // 25E75-17A with 104 g of propellant in 52 g, a 274 mm AeroTech K62N whose
  // case alone is 358 mm). The snapshot's rows are corrected already, and
  // correctMotorRow replaces only a known-bad figure, so a second pass is a
  // no-op there — and it keeps a snapshot published without them from reading
  // as a change on every check, or undoing a correction. Any other value the
  // catalogue moves to still arrives as a change, screened like every other.
  return (rows as Record<string, unknown>[]).map((raw) => correctMotorRow(Object.fromEntries(
    CATALOGUE_FIELDS.filter(f => Object.hasOwn(raw, f)).map((f) => [f, raw[f]])) as unknown as MotorDbEntry));
}

/**
 * The check. Reads the manifest, then — only when the snapshot has moved —
 * its motors file; screens, diffs against the SHIPPED catalogue, persists,
 * installs. Returns the overlay it installed (or the one it kept, when the
 * last check was recent and `force` is not set — `skipped` says so).
 * A failed check installs nothing and leaves storage as it was.
 */
export async function checkForCatalogueUpdates(
  opts: CheckOptions = {},
): Promise<{
  overlay: CatalogueOverlay; skipped: 'recent' | null; stored: boolean;
  /** Manufacturers the snapshot carries NO rows for, whose motors were therefore not marked removed. */
  silent: string[];
}> {
  const now = opts.now ?? Date.now;
  const recent = loadStoredOverlay();
  if (recent && !opts.force && checkedRecently(recent, now())) {
    setCatalogueOverlay(recent);
    return { overlay: recent, skipped: 'recent', stored: true, silent: [] };
  }
  const mine = supersedeRunningCheck();
  const ctrl = new AbortController();
  running = ctrl;
  const relay = () => ctrl.abort(opts.signal?.reason);
  if (opts.signal?.aborted) relay();
  else opts.signal?.addEventListener('abort', relay, { once: true });
  const io = { signal: ctrl.signal, fetchImpl: opts.fetchImpl };
  /** Nothing is installed or stored once a newer check or a Discard has started. */
  const current = (): void => { if (mine !== generation) throw stopped(); };
  try {
    let manifest: ManifestSnapshot;
    try {
      manifest = await fetchCatalogueManifest(io);
    } catch (err) { throw checkFailure(err, ctrl.signal); }
    current();
    // Read storage again: the overlay may have changed while the manifest was in flight.
    const previous = loadStoredOverlay();
    const snapshot: CatalogueSnapshotRef = {
      id: manifest.id, generated: manifest.motors.generated, motorsSha256: manifest.motors.sha256,
      curves: { path: manifest.curves.path, bytes: manifest.curves.bytes, sha256: manifest.curves.sha256 },
    };
    const install = (overlay: CatalogueOverlay, silent: string[] = []) => {
      current();
      const stored = storeOverlay(overlay);
      setCatalogueOverlay(overlay);
      return { overlay, skipped: null, stored, silent };
    };
    const checkedAt = new Date(now()).toISOString();
    // The same snapshot as last time: nothing to download, and nothing changes
    // but the date the throttle runs from.
    if (previous?.snapshot?.id === snapshot.id && previous.snapshot.motorsSha256 === snapshot.motorsSha256) {
      return install({ ...previous, fetchedAt: checkedAt, snapshot });
    }
    // A snapshot OLDER than the shipped catalogue (a release built from a
    // refresh that was never published): this build already knows better.
    // Download nothing and remove nothing; record the check, so the throttle
    // holds and the next check costs one request.
    if (manifest.motors.generated < MOTOR_DB_DATE) {
      return install({
        ...(previous ?? { baseGenerated: MOTOR_DB_DATE, added: [], changed: [], removed: [], rejected: [] }),
        fetchedAt: checkedAt, liveCount: manifest.motors.count, snapshot,
      });
    }
    let live: MotorDbEntry[];
    try {
      live = await readSnapshotMotors(manifest, io);
    } catch (err) { throw checkFailure(err, ctrl.signal); }
    current();
    return install(...overlayFrom(live, previous, checkedAt, snapshot));
  } finally {
    opts.signal?.removeEventListener('abort', relay);
    if (running === ctrl) running = null;
  }
}

/** The diff of `live` against the shipped catalogue, screened, with what a previous check learned carried forward. */
function overlayFrom(live: MotorDbEntry[], previous: CatalogueOverlay | null, fetchedAt: string,
  snapshot: CatalogueSnapshotRef): [CatalogueOverlay, string[]] {
  const d = diffCatalogue(MOTOR_DB, live);
  // Screen only what would be APPLIED: a shipped row was looked at when it
  // shipped. The shipped catalogue carried two rows that fail this same screen
  // (measured 2026-09-05) until 2026-10-01, when both were corrected from
  // their makers' published data (scripts/motor-corrections.mjs);
  // motor-catalogue-screen.test.mjs now keeps any other from shipping.
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
  // "No longer listed" is believed motor by motor, never for a whole maker at
  // once (audit 2026-09-22). A manufacturer whose pull came back with no rows
  // at all — a failed page, an API hiccup, a maker missing from metadata.json —
  // marked its entire shipped line out of production, and that stuck until the
  // next check. Under the curated snapshot (row 110) "silent" means a maker the
  // snapshot carries no rows for; the rule is unchanged. A maker with rows is
  // trusted about the rest; one with none keeps its previous effective rows,
  // and is named.
  const answered = new Set(live.map((m) => m.manufacturerAbbrev));
  const shippedMaker = new Map(MOTOR_DB.map((m) => [m.motorId, m.manufacturerAbbrev]));
  const silent = new Set<string>();
  const removed = d.removed.filter((id) => {
    const maker = shippedMaker.get(id) ?? '';
    if (answered.has(maker)) return true;
    silent.add(maker);
    return previous?.removed.includes(id) ?? false;
  });
  const resolved = new Set([...live.map(m => m.motorId), ...removed]);
  // An empty maker response also keeps motors learned by an earlier check.
  const acceptedNewIds = new Set(added.map(m => m.motorId));
  const listedIds = new Set(live.map(m => m.motorId));
  for (const m of previous?.added ?? []) if (!acceptedNewIds.has(m.motorId)) {
    if (answered.has(m.manufacturerAbbrev)) {
      if (!listedIds.has(m.motorId)) removed.push(m.motorId);
    } else {
      silent.add(m.manufacturerAbbrev);
      if (previous?.removed.includes(m.motorId)) removed.push(m.motorId);
    }
    added.push(m);
  }
  for (const c of previous?.changed ?? []) if (!resolved.has(c.motorId) && !answered.has(c.after.manufacturerAbbrev)) {
    silent.add(c.after.manufacturerAbbrev);
    changed.push(c);
  }
  const overlay: CatalogueOverlay = {
    baseGenerated: MOTOR_DB_DATE,
    fetchedAt,
    liveCount: live.length,
    added,
    changed,
    removed,
    rejected,
    snapshot,
  };
  return [overlay, [...silent]];
}

// ------------------------------------------------------------------- copy

/** "12 new, 3 changed, 0 removed" and the per-field detail, for the browser's note. */
export function describeOverlay(o: CatalogueOverlay, units: UnitSelection = INITIAL_UNITS): string[] {
  const scalar = (v: unknown): string => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '?';
  const lines: string[] = [];
  lines.push(`${o.added.length} new, ${o.changed.length} changed, ${o.removed.length} no longer listed`
    + (o.rejected.length ? `, ${o.rejected.length} refused as implausible` : '')
    + ` — ${o.snapshot ? `curated catalogue ${o.snapshot.id}` : 'thrustcurve.org'} checked ${o.fetchedAt ? o.fetchedAt.slice(0, 10) : "on an unknown date"} against the catalogue of ${o.baseGenerated}.`);
  for (const c of o.changed.slice(0, 12)) {
    const parts = c.fields.map((f) => {
      const a = field(c.before, f); const b = field(c.after, f);
      const quantity = f === 'diameter' || f === 'length' ? 'motorDimensions'
        : f === 'totalWeightG' || f === 'propWeightG' ? 'mass' : null;
      if (quantity && typeof a === 'number' && typeof b === 'number') {
        const [before, after] = noticeComparison(quantity, a / 1000, b / 1000, units);
        return `${f} ${noticeChange(before, after, before.startsWith('just ') || noticeEqual(a / 1000, b / 1000))}`;
      }
      const show = (v: unknown) => typeof v === 'number' ? noticeNumber(v, 6) : scalar(v);
      return `${f} ${noticeChange(show(a), show(b))}`;
    });
    lines.push(`${c.after.manufacturerAbbrev} ${c.after.designation}: ${parts.join(', ')}`);
  }
  if (o.changed.length > 12) lines.push(`…and ${o.changed.length - 12} more changed.`);
  for (const r of o.rejected.slice(0, 5)) {
    const reason = screenEntry(r.entry, units);
    lines.push(`Refused ${scalar(r.entry.manufacturerAbbrev)} ${scalar(r.entry.designation)}: ${reason && !reason.startsWith('no ') ? reason : r.reason}.`);
  }
  return lines;
}

/**
 * The one line that matters most after a check: a changed certified figure on
 * a motor that is IN THE DESIGN. The motor browser leads its result with it;
 * App's message strip shows it for an automatic check (catalogueAutoCheck.ts).
 */
export function designChangeLine(mine: readonly CatalogueChange[]): string {
  return `In this design: ${mine.map((c) => `${c.after.manufacturerAbbrev} ${c.after.designation} (${c.fields.join(', ')})`).join('; ')} — re-run the flight.`;
}

/** Prefer catalogue identity; older records without ids can match either side of a rename. */
export function changedMotorsInDesign(
  o: CatalogueOverlay,
  loaded: readonly { label: string; manufacturer?: string; motorId?: string }[],
): CatalogueChange[] {
  // motorMatch's one delay-strip rule, so a picker label on auto delay
  // ("C6 (auto delay)") is known as the C6 it is.
  const base = baseDesignation;
  return o.changed.filter((c) => loaded.some((l) => {
    if (l.motorId) return l.motorId === c.motorId;
    return [c.before, c.after].some(entry =>
      (l.manufacturer === undefined || l.manufacturer === entry.manufacturerAbbrev)
      && (base(l.label) === base(motorLabel(entry, 0))
        || base(l.label) === base(entry.designation) || base(l.label) === base(entry.commonName ?? '')));
  }));
}
