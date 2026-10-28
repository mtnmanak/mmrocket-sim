import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOGUE_BASE, CatalogueError, MOTORS_MAX_BYTES, catalogueFileUrl, fetchCatalogueFile, fetchCatalogueManifest,
  readCatalogueBytes, validSnapshotRef, validateCatalogueManifest,
} from './catalogueClient.js';
import { NetError } from './net.js';
import { MOTOR_DB, MOTOR_DB_DATE } from './motorDb.js';
import { catalogueFetch, daysAfter, manifestOf, publication, type Publication } from './catalogueFixture.testSupport.js';
import { validatePreviousManifest } from '../../scripts/catalogue-publish.mjs';

/**
 * The curated catalogue's client (row 110): the manifest held to the
 * publisher's own rules, every path pinned to the catalogue's origin, and
 * every snapshot file read capped, held to its declared size and sha, and only
 * then parsed. A node-environment file, so the publisher's validator can be
 * imported beside the app's.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ID = daysAfter(MOTOR_DB_DATE, 14);
const OLD_ID = daysAfter(MOTOR_DB_DATE, 7);
const pick = MOTOR_DB.slice(0, 3);
let pub: Publication;
let old: Publication;
const valid = async () => {
  pub = await publication(ID, pick);
  old = await publication(OLD_ID, pick);
  return manifestOf(pub, [old]);
};
const clone = <T>(v: T): T => structuredClone(v);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the malformation fixtures reach into arbitrary JSON
type Manifest = Record<string, any>;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('the base constant is the publisher\'s PUBLIC_BASE, read from the script\'s own text', () => {
  const script = readFileSync(join(here, '..', '..', 'scripts', 'catalogue-publish.mjs'), 'utf8');
  const base = /const PUBLIC_BASE = '([^']+)'/.exec(script)?.[1];
  expect(base).toBeDefined();
  expect(CATALOGUE_BASE).toBe(base);
});

/** Each malformation, applied to a valid manifest; `entry` is the snapshot it lands in. */
const malformations: [string, (m: Manifest) => void][] = [
  ['schema 2', m => { m['schema'] = 2; }],
  ['no current', m => { delete m['current']; }],
  ['a current not in snapshots', m => { m['current'] = daysAfter(ID, 1); }],
  ['empty snapshots', m => { m['snapshots'] = []; }],
  ['a repeated id', m => { m['snapshots'][0].id = ID; }],
  ...(['current', 'older'] as const).flatMap(which => {
    const at = (m: Manifest) => m['snapshots'][which === 'current' ? 1 : 0];
    const id = () => (which === 'current' ? ID : OLD_ID);
    return [
      [`${which}: an absolute path`, m => { at(m).motors.path = `https://evil.example/v1/${id()}/motors.json`; }],
      [`${which}: a protocol-relative path`, m => { at(m).motors.path = `//evil.example/v1/${id()}/motors.json`; }],
      [`${which}: another snapshot's path`, m => { at(m).curves.path = `v1/${which === 'current' ? OLD_ID : ID}/motorCurves.json`; }],
      [`${which}: a .. path`, m => { at(m).motors.path = `v1/${id()}/../motors.json`; }],
      [`${which}: a query path`, m => { at(m).motors.path = `v1/${id()}/motors.json?x=1`; }],
      [`${which}: a backslash path`, m => { at(m).motors.path = `v1\\${id()}\\motors.json`; }],
      [`${which}: a short sha`, m => { at(m).motors.sha256 = at(m).motors.sha256.slice(1); }],
      [`${which}: an uppercase sha`, m => { at(m).curves.sha256 = at(m).curves.sha256.toUpperCase(); }],
      [`${which}: an uppercase contentSha256`, m => { at(m).curves.contentSha256 = 'A'.repeat(64); }],
      [`${which}: a non-integer bytes`, m => { at(m).motors.bytes = 1.5; }],
      [`${which}: a negative bytes`, m => { at(m).curves.bytes = -1; }],
      [`${which}: an invalid generated`, m => { at(m).motors.generated = '2026-02-31'; }],
      [`${which}: a non-integer count`, m => { at(m).motors.count = '3'; }],
      [`${which}: a curves date that is not the motors date`, m => { at(m).curves.catalogueGenerated = daysAfter(ID, 3); }],
      [`${which}: malformed fetchedAt`, m => { at(m).fetchedAt = 'yesterday'; }],
      [`${which}: malformed sourceRunId`, m => { at(m).sourceRunId = '0'; }],
      [`${which}: malformed snapshot id`, m => { at(m).id = '26-10-2026'; }],
    ] as [string, (m: Manifest) => void][];
  }),
  ['not an object', () => { /* replaced below */ }],
];

describe('the manifest check', () => {
  it('accepts a valid manifest and returns its current snapshot', async () => {
    const m = await valid();
    const current = validateCatalogueManifest(m);
    expect(current.id).toBe(ID);
    expect(current.motors.sha256).toBe(pub.entry.motors.sha256);
    expect(current.curves.path).toBe(`v1/${ID}/motorCurves.json`);
    expect(() => validatePreviousManifest(m)).not.toThrow();
  });

  it.each(malformations)('refuses %s, and agrees with the publisher\'s validatePreviousManifest', async (name, mutate) => {
    let m: unknown = clone(await valid());
    if (name === 'not an object') m = [m];
    else mutate(m as Manifest);
    expect(() => validateCatalogueManifest(m)).toThrow(CatalogueError);
    expect(() => validatePreviousManifest(m)).toThrow();
  });

  it('refuses a missing manifest, which the publisher deliberately accepts (the one place the app is stricter)', () => {
    expect(() => validateCatalogueManifest(undefined)).toThrow(CatalogueError);
    expect(() => validateCatalogueManifest(null)).toThrow(CatalogueError);
    expect(() => validatePreviousManifest(undefined)).not.toThrow();
  });

  it('a malformed OLD entry blocks the update, as it blocks the publisher', async () => {
    const m = clone(await valid()) as Manifest;
    m['snapshots'][0].motors.sha256 = 'nope';
    expect(() => validateCatalogueManifest(m)).toThrow(/snapshot .* motors metadata/);
  });

  it('looks snapshots up by id, never through a prototype key', async () => {
    const m = clone(await valid()) as Manifest;
    m['current'] = 'constructor';
    expect(() => validateCatalogueManifest(m)).toThrow(CatalogueError);
  });
});

describe('paths and the origin', () => {
  it('resolves a checked path on the catalogue origin', () => {
    expect(catalogueFileUrl(`v1/${ID}/motors.json`)).toBe(`${CATALOGUE_BASE}v1/${ID}/motors.json`);
  });
  it.each([
    'https://evil.example/x.json', '//evil.example/x.json', 'v1/x.json?y=1', 'v1/x.json#y',
  ])('refuses a path that leaves the catalogue: %s', path => {
    expect(() => catalogueFileUrl(path)).toThrow(CatalogueError);
  });
  it('the byte reader re-checks the origin of every URL it is given, before any request', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await expect(readCatalogueBytes('https://evil.example/v1/x/motors.json', { maxBytes: 10, timeoutMs: 1000, fetchImpl }))
      .rejects.toThrow(CatalogueError);
    await expect(readCatalogueBytes(`${CATALOGUE_BASE.replace('https', 'http')}manifest.json`, { maxBytes: 10, timeoutMs: 1000, fetchImpl }))
      .rejects.toThrow(CatalogueError);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Positive control: the catalogue's own origin is read.
    await readCatalogueBytes(`${CATALOGUE_BASE}manifest.json`, { maxBytes: 10, timeoutMs: 1000, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('validSnapshotRef holds a stored record to the manifest\'s rules', () => {
    const ok = { id: ID, generated: ID, motorsSha256: 'a'.repeat(64), curves: { path: `v1/${ID}/motorCurves.json`, bytes: 10, sha256: 'b'.repeat(64) } };
    expect(validSnapshotRef(ok)).toBe(true);
    for (const broken of [
      { ...ok, id: 'constructor' }, { ...ok, generated: 'x' }, { ...ok, motorsSha256: 'A'.repeat(64) },
      { ...ok, curves: { ...ok.curves, path: 'https://evil.example/c.json' } },
      { ...ok, curves: { ...ok.curves, path: `v1/${OLD_ID}/motorCurves.json` } },
      { ...ok, curves: { ...ok.curves, bytes: 1.5 } }, { ...ok, curves: null }, null, [],
    ]) expect(validSnapshotRef(broken), JSON.stringify(broken)).toBe(false);
  });
});

describe('reading a file: bytes, then size, then sha, then parse', () => {
  const stream = (bytes: Uint8Array, extra = 0) => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); if (extra) c.enqueue(new Uint8Array(extra)); c.close(); },
  }));

  it('reads the current motors file when everything matches', async () => {
    const manifest = await valid();
    const fetchImpl = catalogueFetch(manifest, [pub]);
    const current = await fetchCatalogueManifest({ fetchImpl });
    const doc = await fetchCatalogueFile(current.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl }) as { motors: unknown[] };
    expect(doc.motors).toHaveLength(pick.length);
    expect(fetchImpl.seen.map(r => r.url)).toEqual([`${CATALOGUE_BASE}manifest.json`, `${CATALOGUE_BASE}${current.motors.path}`]);
  });

  it('sends simple requests: no credentials, no redirects, no custom headers; the manifest past any cache', async () => {
    const manifest = await valid();
    const fetchImpl = catalogueFetch(manifest, [pub]);
    const current = await fetchCatalogueManifest({ fetchImpl });
    await fetchCatalogueFile(current.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl });
    for (const { init } of fetchImpl.seen) {
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      expect(init).not.toHaveProperty('headers');
      expect(init?.method ?? 'GET').toBe('GET');
    }
    expect(fetchImpl.seen[0]!.init?.cache).toBe('no-cache');
  });

  it('refuses a declared size over the cap before any request', async () => {
    await valid();
    const fetchImpl = vi.fn(async () => new Response(pub.motorsBytes as Uint8Array<ArrayBuffer>));
    await expect(fetchCatalogueFile({ ...pub.entry.motors, bytes: MOTORS_MAX_BYTES + 1 }, MOTORS_MAX_BYTES, 'motors file', { fetchImpl }))
      .rejects.toThrow(/larger than the app accepts/);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Positive control: the same file at its declared size is read.
    await fetchCatalogueFile(pub.entry.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('stops reading an overlong file as soon as it passes its declared size', async () => {
    await valid();
    let pulled = 0;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(pulled === 1 ? pub.motorsBytes : new Uint8Array(1024)); if (pulled > 50) c.close(); },
    })));
    await expect(fetchCatalogueFile(pub.entry.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl }))
      .rejects.toMatchObject({ kind: 'too-large' });
    expect(pulled).toBeLessThan(5);
  });

  it.each([
    ['a short file', (b: Uint8Array) => b.slice(0, -1), /not the size/],
    ['a flipped byte', (b: Uint8Array) => { const c = b.slice(); c[10] = c[10]! ^ 1; return c; }, /does not match/],
  ])('refuses %s', async (_name, change, message) => {
    await valid();
    const fetchImpl = vi.fn(async () => stream(change(pub.motorsBytes)));
    await expect(fetchCatalogueFile(pub.entry.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl })).rejects.toThrow(message);
  });

  it('refuses a stated Content-Length over the declared size unread', async () => {
    await valid();
    const fetchImpl = vi.fn(async () => new Response(pub.motorsBytes as Uint8Array<ArrayBuffer>,
      { headers: { 'content-length': String(pub.motorsBytes.length + 1) } }));
    await expect(fetchCatalogueFile(pub.entry.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl })).rejects.toMatchObject({ kind: 'too-large' });
  });

  it.each([404, 503, 301])('refuses an HTTP %s answer itself', async status => {
    await valid();
    const fetchImpl = vi.fn(async () => new Response(status === 301 ? null : pub.motorsBytes as Uint8Array<ArrayBuffer>, { status }));
    const err = await fetchCatalogueFile(pub.entry.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetError);
    expect((err as NetError).kind).toBe('http');
    expect((err as Error).message).toContain(`HTTP ${status}`);
  });

  it.each([
    ['says it was redirected', { redirected: true, url: `${CATALOGUE_BASE}manifest.json` }],
    ['came from another origin', { redirected: false, url: 'https://evil.example/manifest.json' }],
  ])('refuses a manifest answer that %s', async (_name, props) => {
    const manifest = await valid();
    const fetchImpl = vi.fn(async () => {
      const res = new Response(JSON.stringify(manifest));
      Object.defineProperties(res, { redirected: { value: props.redirected }, url: { value: props.url } });
      return res;
    });
    await expect(fetchCatalogueManifest({ fetchImpl })).rejects.toMatchObject({ kind: 'redirected' });
  });

  it('fails closed with no crypto.subtle', async () => {
    await valid();
    const fetchImpl = vi.fn(async () => new Response(pub.motorsBytes as Uint8Array<ArrayBuffer>));
    vi.stubGlobal('crypto', {});
    await expect(fetchCatalogueFile(pub.entry.motors, MOTORS_MAX_BYTES, 'motors file', { fetchImpl })).rejects.toThrow(/cannot check/);
  });

  it('refuses a manifest that is not JSON, or over 256 KB', async () => {
    await expect(fetchCatalogueManifest({ fetchImpl: vi.fn(async () => new Response('<html>')) })).rejects.toThrow(/not JSON/);
    await expect(fetchCatalogueManifest({ fetchImpl: vi.fn(async () => new Response('x'.repeat(256 * 1024 + 1))) }))
      .rejects.toMatchObject({ kind: 'too-large' });
  });
});
