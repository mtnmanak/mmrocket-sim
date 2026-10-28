import { CATALOGUE_BASE } from './catalogueClient.js';

/**
 * A curated-catalogue publication built at run time, for the tests that stub
 * the catalogue: real rows in, shas computed here, dates derived by the
 * caller from MOTOR_DB_DATE. Nothing in it is pinned.
 */

export const daysAfter = (date: string, days: number): string =>
  new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);

export const jsonBytes = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return [...hash].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The seven fields fetch-motor-db.mjs's FULL_FIELDS adds to the app's eighteen. */
export const withFullFields = <T extends object>(m: T): T & Record<string, unknown> => ({
  ...m, manufacturer: 'Full name', certOrg: 'NAR', dataFiles: 1, infoUrl: 'https://example.invalid/motor',
  delayAdjustable: false, sparky: false, updatedOn: '2026-01-01',
});

export interface Publication {
  id: string;
  generated: string;
  motorsDoc: unknown;
  curvesDoc: unknown;
  motorsBytes: Uint8Array;
  curvesBytes: Uint8Array;
  /** The manifest entry, with shas and sizes of the bytes above. */
  entry: Record<string, unknown> & {
    id: string;
    motors: Record<string, unknown> & { path: string; bytes: number; sha256: string; count: number; generated: string };
    curves: Record<string, unknown> & { path: string; bytes: number; sha256: string; motors: number; files: number;
      generated: string; catalogueGenerated: string };
  };
}

/** A snapshot of `motors` (and `curves`, motorId → files) as the publisher writes it. */
export async function publication(id: string, motors: readonly object[], curves: Record<string, unknown[]> = {},
  over: { motorsDoc?: unknown; curvesDoc?: unknown; generated?: string } = {}): Promise<Publication> {
  const generated = over.generated ?? id.slice(0, 10);
  const motorsDoc = over.motorsDoc ?? { generated, source: 'test', count: motors.length, fields: [], motors: motors.map(withFullFields) };
  const curvesDoc = over.curvesDoc ?? {
    generated, source: 'test', catalogueGenerated: generated, complete: true,
    motors: Object.keys(curves).length, files: Object.values(curves).reduce((n, f) => n + f.length, 0), curves,
  };
  const motorsBytes = jsonBytes(motorsDoc);
  const curvesBytes = jsonBytes(curvesDoc);
  return {
    id, generated, motorsDoc, curvesDoc, motorsBytes, curvesBytes,
    entry: {
      id, commit: '0'.repeat(40), sourceRunId: '1', fetchedAt: `${generated}T00:00:00Z`, sourceAttempt: '1',
      motors: { path: `v1/${id}/motors.json`, bytes: motorsBytes.length, sha256: await sha256(motorsBytes),
        contentSha256: '0'.repeat(64), count: motors.length, generated },
      curves: { path: `v1/${id}/motorCurves.json`, bytes: curvesBytes.length, sha256: await sha256(curvesBytes),
        contentSha256: '0'.repeat(64), motors: Object.keys(curves).length,
        files: Object.values(curves).reduce((n, f) => n + f.length, 0), generated, catalogueGenerated: generated },
      publishedAt: `${generated}T01:00:00.000Z`,
    },
  };
}

export const manifestOf = (current: Publication, older: Publication[] = []): Record<string, unknown> => ({
  schema: 1, current: current.id, publishedAt: current.entry['publishedAt'], commit: '0'.repeat(40), source: 'test',
  snapshots: [...older.map(p => p.entry), current.entry],
});

/** Every request a stub saw, with its init, so a test can read the options it was sent with. */
export interface SeenRequest { url: string; init: RequestInit | undefined }

/**
 * A fetch serving the catalogue: the manifest, and each publication's two
 * files at their paths. `override` answers a path itself (a 503, a swapped
 * file). Anything else is a 404, and a request to another host is a test
 * failure the caller can see in `seen`.
 */
export function catalogueFetch(manifest: unknown, pubs: Publication[],
  override: Record<string, () => Response | Promise<Response>> = {}): typeof fetch & { seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const files = new Map<string, Uint8Array>();
  for (const p of pubs) {
    files.set(p.entry.motors.path, p.motorsBytes);
    files.set(p.entry.curves.path, p.curvesBytes);
  }
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, init });
    if (!url.startsWith(CATALOGUE_BASE)) return new Response('not the catalogue', { status: 599 });
    const path = url.slice(CATALOGUE_BASE.length);
    if (Object.hasOwn(override, path)) return override[path]!();
    if (path === 'manifest.json') return new Response(JSON.stringify(manifest), { status: 200 });
    const body = files.get(path);
    return body ? new Response(body as Uint8Array<ArrayBuffer>, { status: 200 }) : new Response('missing', { status: 404 });
  }) as typeof fetch & { seen: SeenRequest[] };
  impl.seen = seen;
  return impl;
}
