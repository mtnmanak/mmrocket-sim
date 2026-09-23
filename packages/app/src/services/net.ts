import { useEffect, useState } from 'react';

/**
 * THE APP'S NETWORK SURFACE, IN ONE PLACE (weather build, 2026-09-22).
 *
 * Every outside host the app ever asks for something, and the helpers a new
 * request should be built on: a deadline that tells a timeout from a caller's
 * cancel, and a JSON read that is capped by size and reports every way a
 * request can fail as one typed error.
 *
 * `networkSurface.test.ts` holds the host list against the source, so a new
 * outside host cannot be fetched without being listed here.
 */

/**
 * Every outside origin the app fetches from. The version badge's
 * `./version.json` is same-origin and is not listed. A CSP, if one is ever
 * added, needs exactly these in `connect-src` (there is none today: no meta
 * tag, no `_headers`).
 */
export const NETWORK_HOSTS: readonly string[] = [
  'https://www.thrustcurve.org',
  'https://www.mountainmanrockets.com',
  // The weather lookup (services/openMeteo.ts): forecasts and terrain height,
  // the ERA5 archive for dates more than 92 days back, and place search.
  'https://api.open-meteo.com',
  'https://archive-api.open-meteo.com',
  'https://geocoding-api.open-meteo.com',
];

/** A request's deadline, merged with the caller's own cancellation. */
export interface Deadline {
  /** undefined only where AbortController does not exist at all. */
  signal: AbortSignal | undefined;
  /** True when OUR timer fired, as opposed to the caller cancelling. */
  timedOut: () => boolean;
  /** Always call: clears the timer and unsubscribes from the caller's signal. */
  done: () => void;
}

/**
 * Combines the caller's cancellation with our own deadline.
 *
 * Hand-rolled rather than AbortSignal.any(), which is Chrome 116 / Safari 17.4
 * (2023-24) and would break an older iPad, and rather than a bare
 * AbortSignal.timeout(), whose abort is indistinguishable from the caller's
 * once the two are merged. Telling them apart is the point: a timeout has to
 * read as "the network stalled", a caller abort as "you pressed Stop".
 *
 * Moved here unchanged from thrustcurve.ts (weather build), which imports it,
 * so the thrust-curve download and the weather requests share one definition.
 */
export function deadline(caller: AbortSignal | undefined, ms: number): Deadline {
  if (typeof AbortController !== 'function') {
    return { signal: caller, timedOut: () => false, done: () => { /* nothing to undo */ } };
  }
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; ctrl.abort(); }, ms);
  const relay = (): void => ctrl.abort(caller?.reason);
  if (caller?.aborted) ctrl.abort(caller.reason);
  else caller?.addEventListener('abort', relay, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => expired,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', relay);
    },
  };
}

/** Every way a request can fail before there is an answer to read. */
export type NetErrorKind = 'timeout' | 'aborted' | 'network' | 'not-json' | 'too-large';

/** A failed request, by kind — the caller words the message for its reader. */
export class NetError extends Error {
  readonly kind: NetErrorKind;
  constructor(kind: NetErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetError';
    this.kind = kind;
  }
}

/** An answer that parsed as JSON — returned for a 4xx/5xx too, so its reason can be shown. */
export interface JsonAnswer {
  status: number;
  json: unknown;
}

/**
 * The most a JSON answer may be, by default. One weather request is about
 * 7 KB and a place search about 1 KB; 256 KB is far beyond any real answer
 * and still small enough that a runaway one costs nothing.
 */
export const DEFAULT_MAX_JSON_BYTES = 256 * 1024;

/**
 * GET a URL and read its body as JSON — within a deadline, and never more than
 * `maxBytes` of it. The only fetch a new feature should need.
 *
 * - An answer that is not JSON is `not-json`: a captive portal at a launch
 *   site answers 200 with its sign-in page, and "the service is broken" would
 *   be the wrong thing to tell someone standing in front of one.
 * - The body is read CAPPED, chunk by chunk (the `shareLink.ts` inflate
 *   pattern), so a runaway answer stops being read at the cap instead of being
 *   held whole first; a stated Content-Length over it is refused unread.
 * - Reading the body is inside the deadline: a connection that answers its
 *   headers and then stalls hangs in the read, not in fetch().
 * - A non-2xx status is NOT an error here: `{ status, json }` comes back so the
 *   caller can quote the service's own reason.
 *
 * Deliberately not `catalogueOverlay.ts`'s `getJson`, which has no timeout and
 * no cap.
 */
export async function getJsonCapped(url: string, opts: {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  cache?: RequestCache;
  credentials?: RequestCredentials;
  referrerPolicy?: ReferrerPolicy;
}): Promise<JsonAnswer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  // Called through a wrapper, never as a bare reference: an unbound
  // `window.fetch` throws "Illegal invocation" in some browsers.
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const limit = deadline(opts.signal, opts.timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: limit.signal,
      ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
      ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
      ...(opts.referrerPolicy !== undefined ? { referrerPolicy: opts.referrerPolicy } : {}),
    });
    const text = await readTextCapped(res, maxBytes);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new NetError('not-json', `The answer from ${hostOf(url)} was not JSON.`, { cause: err });
    }
    return { status: res.status, json };
  } catch (err) {
    if (err instanceof NetError) throw err;
    if (limit.timedOut()) {
      throw new NetError('timeout', `${hostOf(url)} did not answer within ${opts.timeoutMs / 1000} s.`, { cause: err });
    }
    if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new NetError('aborted', 'The request was cancelled.', { cause: err });
    }
    throw new NetError('network', `Could not reach ${hostOf(url)}.`, { cause: err });
  } finally {
    limit.done();
  }
}

/** A response body as text, refused past `maxBytes`. */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const tooBig = () => new NetError('too-large', `The answer ran past ${Math.round(maxBytes / 1024)} KB, so it was not read.`);
  if (Number(res.headers?.get('content-length')) > maxBytes) throw tooBig();
  if (!res.body) {
    const text = await res.text();
    if (text.length > maxBytes) throw tooBig();
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw tooBig();
      chunks.push(value);
    }
  } finally {
    // Stop the download the moment the loop exits early; on a finished stream
    // this is a resolved no-op.
    reader.cancel().catch(() => { /* already errored — nothing to release */ });
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(bytes);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the server';
  }
}

/**
 * Is the browser online, kept current by its `online`/`offline` events?
 *
 * `navigator.onLine` is a hint, not a promise — true can still mean a dead
 * hotspot — so a feature gates its BUTTON on this and still handles a failed
 * request. False, though, is reliable: nothing is going to answer.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
