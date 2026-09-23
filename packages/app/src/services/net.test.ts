// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_MAX_JSON_BYTES, getJsonCapped, NetError, useOnline } from './net.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * services/net.ts — the capped, deadlined JSON GET every weather request goes
 * through. No test here touches the network: every answer is a fake
 * `fetchImpl`, which is also how the weather code is tested.
 */

const URL_ = 'https://api.open-meteo.com/v1/forecast?x=1';

/** A Response whose body arrives in the given chunks — a real stream, so the capped reader is exercised. */
function streamed(chunks: string[], init: ResponseInit = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(body, init);
}

/** A fetch that never answers until its signal aborts — a stalled socket. */
function stalled(): typeof fetch {
  return (_input, init) => new Promise<Response>((_resolve, reject) => {
    const sig = init?.signal;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (sig?.aborted) fail();
    sig?.addEventListener('abort', fail, { once: true });
  });
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof NetError ? err.kind : `other: ${String(err)}`;
  }
}

afterEach(() => { vi.useRealTimers(); });

describe('getJsonCapped', () => {
  it('reads a JSON answer, and hands the request options through to fetch', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_u, init) => {
      seen.push(init ?? {});
      return streamed(['{"a":', '1}'], { status: 200 });
    };
    const a = await getJsonCapped(URL_, {
      timeoutMs: 12_000, fetchImpl, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    expect(a).toEqual({ status: 200, json: { a: 1 } });
    expect(seen[0]).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a 400 answer with its body, so the service’s own reason can be quoted', async () => {
    const fetchImpl: typeof fetch = async () =>
      streamed(['{"error":true,"reason":"Invalid value"}'], { status: 400 });
    expect(await getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl }))
      .toEqual({ status: 400, json: { error: true, reason: 'Invalid value' } });
  });

  // A captive portal at a launch site answers 200 with its sign-in page.
  it('calls an HTML page at status 200 not-json, never "the service is broken"', async () => {
    const fetchImpl: typeof fetch = async () => streamed(['<!doctype html><title>Sign in</title>'], { status: 200 });
    expect(await kindOf(getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl }))).toBe('not-json');
  });

  it('stops reading a runaway answer at the cap — streamed, and by its stated length', async () => {
    const chunk = 'x'.repeat(64 * 1024);
    const runaway: typeof fetch = async () => streamed([chunk, chunk, chunk, chunk, chunk], { status: 200 });
    expect(await kindOf(getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl: runaway }))).toBe('too-large');
    expect(5 * chunk.length).toBeGreaterThan(DEFAULT_MAX_JSON_BYTES);

    const stated: typeof fetch = async () =>
      new Response('{}', { status: 200, headers: { 'content-length': String(300 * 1024) } });
    expect(await kindOf(getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl: stated }))).toBe('too-large');
  });

  it('calls a TypeError from fetch — no route, DNS, CORS — network', async () => {
    const fetchImpl: typeof fetch = async () => { throw new TypeError('Failed to fetch'); };
    expect(await kindOf(getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl }))).toBe('network');
  });

  it('calls the caller’s own cancel aborted, not a timeout', async () => {
    const ctrl = new AbortController();
    const p = getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl: stalled(), signal: ctrl.signal });
    ctrl.abort();
    expect(await kindOf(p)).toBe('aborted');
  });

  it('gives up on a stalled socket at its deadline and calls it a timeout', async () => {
    vi.useFakeTimers();
    const p = kindOf(getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl: stalled() }));
    await vi.advanceTimersByTimeAsync(11_999);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe('timeout');
  });

  it('times out a body that stalls after the headers — the read is inside the deadline', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async (_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"a":'));
          init?.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      });
      return new Response(body, { status: 200 });
    };
    const p = kindOf(getJsonCapped(URL_, { timeoutMs: 12_000, fetchImpl }));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await p).toBe('timeout');
  });
});

describe('useOnline', () => {
  it('follows the browser’s offline and online events', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useOnline());
      return null;
    }
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe(true);
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(seen.at(-1)).toBe(false);
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(seen.at(-1)).toBe(true);
    act(() => root.unmount());
    host.remove();
  });
});
