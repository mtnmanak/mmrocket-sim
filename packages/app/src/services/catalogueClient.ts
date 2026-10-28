import { DEFAULT_MAX_JSON_BYTES, getBytesCapped } from './net.js';

/**
 * THE CURATED MOTOR CATALOGUE, READ (row 110, owner 2026-10-27).
 *
 * thrustcurve.org answers the app's anonymous requests with 503 after about
 * three in a second, so the old per-maker pull could not finish, and it put
 * load on a volunteer-run service. The owner publishes a curated, hash-pinned
 * copy instead (scripts/catalogue-publish.mjs): a small `manifest.json` naming
 * the current snapshot, and under `v1/<id>/` that snapshot's motors file and
 * curves file, each with its byte size and sha256.
 *
 * WHAT THE SHA IS, AND IS NOT. The manifest's `sha256` binds each snapshot
 * file to the manifest that names it: it catches a corrupt, truncated, swapped
 * or stale-cached file. It does not protect against a compromised catalogue
 * origin, which serves the manifest too. What stands between a hostile
 * publication and the user is the overlay's screen (screenEntry), its field
 * projection, the rule that a shipped curve is never replaced, and the
 * curve-shape checks in thrustcurve.ts. `contentSha256` is the publisher's own
 * change detector, not an integrity check, and is never read here.
 *
 * React-free, and it does nothing at import time: the API Worker bundles
 * thrustcurve.ts, which imports this module. It imports neither thrustcurve.ts
 * nor catalogueOverlay.ts, which both import it. It never goes through
 * thrustcurveTraffic.ts: that is thrustcurve.org's own back-off, and a
 * catalogue failure says nothing about thrustcurve.org.
 */

/** The catalogue's public root. catalogue-publish.mjs's PUBLIC_BASE; catalogueClient.test.ts holds the two equal. */
export const CATALOGUE_BASE = 'https://catalogue.mountainmanrockets.com/';

/**
 * Caps and deadlines. The manifest is about 0.8 KB per publication and has no
 * declared size, so it gets net.ts's 256 KB default. The 26 Oct 2026 files are
 * 614,581 bytes (motors) and 982,033 bytes (curves); each cap is several times
 * that. 120 s brings a 1 MB file in on a link of about 70 kbit/s.
 */
const MANIFEST_MAX_BYTES = DEFAULT_MAX_JSON_BYTES;
const MANIFEST_TIMEOUT_MS = 30_000;
export const MOTORS_MAX_BYTES = 4 * 1024 * 1024;
export const CURVES_MAX_BYTES = 8 * 1024 * 1024;
const FILE_TIMEOUT_MS = 120_000;

/** One snapshot file as the manifest names it. */
export interface CatalogueFileRef {
  path: string;
  bytes: number;
  sha256: string;
}

/** The current snapshot, after the whole manifest has passed validateCatalogueManifest. */
export interface ManifestSnapshot {
  id: string;
  motors: CatalogueFileRef & { count: number; generated: string };
  curves: CatalogueFileRef & { motors: number; files: number; generated: string; catalogueGenerated: string };
}

/**
 * What an overlay keeps of the snapshot it was diffed against: enough to skip
 * the download when the snapshot has not moved, and to find the curves file
 * after a reload. Read back from localStorage, so validSnapshotRef checks it
 * again before anything uses it.
 */
export interface CatalogueSnapshotRef {
  id: string;
  /** The snapshot's motors.generated. */
  generated: string;
  motorsSha256: string;
  curves: CatalogueFileRef;
}

export type CatalogueErrorKind = 'manifest' | 'integrity' | 'shape';

/** A catalogue answer that arrived but cannot be used: a bad manifest, a file that is not the one it names, or a file of the wrong shape. */
export class CatalogueError extends Error {
  readonly kind: CatalogueErrorKind;
  constructor(kind: CatalogueErrorKind, message: string) {
    super(message);
    this.name = 'CatalogueError';
    this.kind = kind;
  }
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const snapshotId = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d{2}-\d{2}(?:\.[2-9]|\.[1-9]\d+)?$/.test(v) && date(v.slice(0, 10));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)
  && date(v.slice(0, 10)) && Number.isFinite(Date.parse(v));
const runId = (v: unknown): boolean => typeof v === 'string' && /^[1-9]\d*$/.test(v);
const FILE_NAMES = { motors: 'motors.json', curves: 'motorCurves.json' } as const;

const bad = (why: string): never => { throw new CatalogueError('manifest', `The catalogue's manifest is not usable: ${why}.`); };

/**
 * catalogue-publish.mjs's validatePreviousManifest, rule for rule, over EVERY
 * snapshot entry, not just the current one — so one malformed old entry blocks
 * every update, as it blocks the publisher. Stricter in one place: a missing
 * manifest (`undefined`), which the publisher accepts as "first publication",
 * is refused. Returns the current snapshot.
 */
export function validateCatalogueManifest(manifest: unknown): ManifestSnapshot {
  if (!object(manifest)) return bad('not an object');
  if (manifest['schema'] !== 1) return bad(`unknown schema ${String(manifest['schema'])}`);
  const snapshots = manifest['snapshots'];
  if (!Array.isArray(snapshots) || !snapshots.length || !snapshotId(manifest['current'])) return bad('no history, or no current snapshot');
  const byId = new Map<string, ManifestSnapshot>();
  for (const entry of snapshots as unknown[]) {
    if (!object(entry) || !snapshotId(entry['id']) || byId.has(entry['id'])) return bad('a snapshot id is invalid or repeated');
    const id = entry['id'];
    if ((entry['fetchedAt'] !== undefined && !timestamp(entry['fetchedAt']))
      || (entry['sourceAttempt'] !== undefined && !runId(entry['sourceAttempt']))
      || (entry['sourceRunId'] !== undefined && !runId(entry['sourceRunId']))) return bad(`snapshot ${id} has invalid provenance`);
    for (const kind of ['motors', 'curves'] as const) {
      const meta = entry[kind];
      if (!object(meta) || meta['path'] !== `v1/${id}/${FILE_NAMES[kind]}` || !integer(meta['bytes'])
        || !digest(meta['sha256']) || (meta['contentSha256'] !== undefined && !digest(meta['contentSha256']))
        || !date(meta['generated'])) return bad(`snapshot ${id} has invalid ${kind} metadata`);
    }
    const motors = entry['motors'] as Record<string, unknown>;
    const curves = entry['curves'] as Record<string, unknown>;
    // A count of at least one: planPublication refuses a motors file with no
    // rows, so a 0 is never published (validatePreviousManifest accepts it).
    if (!integer(motors['count']) || (motors['count'] as number) < 1 || !integer(curves['motors']) || !integer(curves['files'])
      || curves['catalogueGenerated'] !== motors['generated']) return bad(`snapshot ${id} has invalid counts or dates`);
    byId.set(id, {
      id,
      motors: { path: motors['path'] as string, bytes: motors['bytes'] as number, sha256: motors['sha256'] as string,
        count: motors['count'] as number, generated: motors['generated'] as string },
      curves: { path: curves['path'] as string, bytes: curves['bytes'] as number, sha256: curves['sha256'] as string,
        motors: curves['motors'] as number, files: curves['files'] as number, generated: curves['generated'] as string,
        catalogueGenerated: curves['catalogueGenerated'] as string },
    });
  }
  const current = byId.get(manifest['current']);
  if (!current) return bad('the current snapshot is not in its history');
  return current;
}

/**
 * The first day a build could write a curated overlay (row 110: the first
 * commit that did, 71fe22a, is 2026-10-28T01:52Z). Before it, overlays came
 * from a thrustcurve.org pull and carried no `snapshot`; since it, a curated
 * check that finds only a snapshot older than the build writes none either
 * (catalogueOverlay.ts, 2026-10-28 C). The check date tells the two apart.
 */
const CURATED_CHECK_SINCE = '2026-10-28';

/**
 * Was this overlay written by a thrustcurve.org pull (before row 110)? Only
 * those key the no-curve memory on their check date (thrustcurve.ts
 * catalogueDate); a curated check rewrites that date every six hours. Read
 * from what the overlay already stores, so its format does not change: no
 * `snapshot` field at all, and a valid check date before CURATED_CHECK_SINCE.
 * A pull written later by a tab left open on an old build reads as curated,
 * the side that asks thrustcurve.org less.
 */
export function isThrustcurvePull(o: { fetchedAt?: unknown } | null | undefined): boolean {
  if (!o || Object.hasOwn(o, 'snapshot') || typeof o.fetchedAt !== 'string') return false;
  return Date.parse(o.fetchedAt) < Date.parse(CURATED_CHECK_SINCE);
}

/** A stored overlay's snapshot record, held to the same rules as the manifest it came from. */
export function validSnapshotRef(v: unknown): v is CatalogueSnapshotRef {
  if (!object(v) || !snapshotId(v['id']) || !date(v['generated']) || !digest(v['motorsSha256'])) return false;
  const curves = v['curves'];
  return object(curves) && curves['path'] === `v1/${v['id']}/${FILE_NAMES.curves}`
    && integer(curves['bytes']) && digest(curves['sha256']);
}

/**
 * A snapshot path as a URL on the catalogue's origin, or a throw. The path
 * has already been held to `v1/<id>/<file>` by the manifest check; resolving
 * it against the base and asserting the origin is the second lock.
 */
export function catalogueFileUrl(path: string): string {
  const url = new URL(path, CATALOGUE_BASE);
  assertCatalogueUrl(url.href);
  return url.href;
}

function assertCatalogueUrl(href: string): void {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new CatalogueError('manifest', 'The catalogue named a file the app cannot read.');
  }
  const base = new URL(CATALOGUE_BASE);
  if (url.origin !== base.origin || url.search || url.hash || url.username || url.password) {
    throw new CatalogueError('manifest', 'The catalogue named a file outside the catalogue, so it was not read.');
  }
}

/** The request options a test reads; never credentials, never a redirect, never a header. */
interface ReadOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Bytes from the catalogue's origin — and only from it: the origin is checked
 * here on every URL, whoever builds it, because thrustcurve.ts reads a curves
 * file named by an overlay out of localStorage, not by a freshly checked
 * manifest.
 */
export async function readCatalogueBytes(href: string, opts: ReadOptions & {
  maxBytes: number; timeoutMs: number; cache?: RequestCache;
}): Promise<Uint8Array> {
  assertCatalogueUrl(href);
  return getBytesCapped(href, opts);
}

/** Why a browser with no `crypto.subtle` reads no catalogue file. */
export const NO_HASH_MESSAGE = 'This browser cannot check the catalogue\'s files, so none were read.';

/**
 * Can this browser check a catalogue file's sha256? Only in a secure context
 * (https, or localhost). Asked before a file is downloaded, so a browser that
 * cannot is not sent the file only to fail at the hash (2026-10-28, E).
 */
export const canCheckCatalogueFiles = (): boolean => !!globalThis.crypto?.subtle;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Only in a secure context (https, or localhost). Fail closed without it.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new CatalogueError('integrity', NO_HASH_MESSAGE);
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...hash].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The manifest, read fresh past any cache, checked whole; the current snapshot comes back. */
export async function fetchCatalogueManifest(opts: ReadOptions = {}): Promise<ManifestSnapshot> {
  const bytes = await readCatalogueBytes(new URL('manifest.json', CATALOGUE_BASE).href, {
    ...opts, maxBytes: MANIFEST_MAX_BYTES, timeoutMs: MANIFEST_TIMEOUT_MS, cache: 'no-cache',
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CatalogueError('manifest', 'The catalogue\'s manifest is not JSON.');
  }
  return validateCatalogueManifest(parsed);
}

/**
 * One snapshot file: its declared size held to the cap before any request,
 * read no further than that size, held to it exactly, hashed, and only then
 * parsed. `what` names it in the message ("motors file").
 */
export async function fetchCatalogueFile(file: CatalogueFileRef, maxBytes: number, what: string,
  opts: ReadOptions = {}): Promise<unknown> {
  if (!integer(file.bytes) || file.bytes > maxBytes) {
    throw new CatalogueError('integrity', `The catalogue's ${what} is larger than the app accepts (${Math.round(maxBytes / 1024 / 1024)} MB), so it was not read.`);
  }
  if (!digest(file.sha256)) throw new CatalogueError('manifest', `The catalogue's ${what} has no usable sha256.`);
  if (!canCheckCatalogueFiles()) throw new CatalogueError('integrity', NO_HASH_MESSAGE);
  const bytes = await readCatalogueBytes(catalogueFileUrl(file.path), {
    ...opts, maxBytes: file.bytes, timeoutMs: FILE_TIMEOUT_MS,
  });
  if (bytes.length !== file.bytes) {
    throw new CatalogueError('integrity', `The catalogue's ${what} is not the size its manifest states, so it was not used.`);
  }
  if (await sha256Hex(bytes) !== file.sha256) {
    throw new CatalogueError('integrity', `The catalogue's ${what} does not match its manifest, so it was not used.`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CatalogueError('shape', `The catalogue's ${what} is not JSON.`);
  }
}
