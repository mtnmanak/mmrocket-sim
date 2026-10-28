import { afterEach, describe, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import { MAX_API_BODY_BYTES, MAX_IN_FLIGHT_BODY_BYTES, reservedBodyBytes } from './body.js';
import { bytesOf, stampOf } from './fixtures.testSupport.js';
import * as headless from '../../app/src/headless/index.js';

/**
 * The body reader and the isolate-wide body budget (audit S1-2), in process:
 * each upload is a stream the test feeds by hand, so no timer or real network
 * decides when a byte arrives.
 */
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const STAMP = stampOf(await (await worker.fetch(new Request('http://local/health'), undefined, ctx)).json());
afterEach(() => {
  vi.restoreAllMocks();
  // Every exit gives its bytes back.
  expect(reservedBodyBytes()).toBe(0);
});

/** Let the Worker's reader take what was enqueued: microtasks only. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** An upload the test feeds: `send` enqueues, `end` closes, `fail` aborts as a lost client would. */
function upload(route = '/experimental/fly') {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { state.cancelled = true; },
  });
  const response = worker.fetch(new Request(`http://local${route}?filename=upload.ork`,
    { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' }), undefined, ctx);
  return {
    response, state,
    send: async (bytes: Uint8Array) => { controller.enqueue(bytes); await settle(); },
    /** Queue without waiting: the reader drains the queue in order. */
    push: (bytes: Uint8Array) => { controller.enqueue(bytes); },
    end: () => { controller.close(); },
    fail: () => { controller.error(new Error('Client went away.')); },
  };
}
const pattern = (size: number) => Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff);

describe('the isolate-wide body budget', () => {
  it('refuses the upload that would cross it with 503, Retry-After and the stamp, then serves again', async () => {
    expect(MAX_IN_FLIGHT_BODY_BYTES).toBe(3 * MAX_API_BODY_BYTES);
    const full = new Uint8Array(MAX_API_BODY_BYTES);
    const held = [upload(), upload(), upload()];
    for (const one of held) await one.send(full);
    expect(reservedBodyBytes()).toBe(MAX_IN_FLIGHT_BODY_BYTES);

    const busy = upload('/describe');
    await busy.send(new Uint8Array(1));
    const refused = await busy.response;
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(await refused.json()).toEqual({ error: { code: 'SERVER_BUSY',
      message: 'The API is busy with other uploads. Retry in a few seconds.' }, ...STAMP });
    expect(busy.state.cancelled).toBe(true);
    expect(reservedBodyBytes()).toBe(MAX_IN_FLIGHT_BODY_BYTES);

    // One client aborts, one goes past the cap, one finishes (eight MiB of zeros is no design).
    const [aborted, tooLarge, finished] = held;
    aborted!.fail();
    expect((await aborted!.response).status).toBe(500);
    await tooLarge!.send(new Uint8Array(1));
    expect((await tooLarge!.response).status).toBe(413);
    finished!.end();
    expect((await finished!.response).status).toBe(400);
    expect(reservedBodyBytes()).toBe(0);

    const after = await worker.fetch(new Request('http://local/describe?filename=reference.ork',
      { method: 'POST', body: bytesOf('reference.ork') }), undefined, ctx);
    expect(after.status, (await after.clone().text()).slice(0, 300)).toBe(200);
  }, 60_000);
});

describe('the body reader keeps exactly the bytes received', () => {
  /** What the Worker handed the service: the describe call is stubbed to capture it and refuse. */
  function capture() {
    const seen: Uint8Array[] & { held?: number } = [];
    vi.spyOn(headless, 'describeFile').mockImplementation(async data => {
      // What the request holds while the service runs: its body, not the buffer's last growth step.
      seen.held = reservedBodyBytes();
      seen.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)));
      throw new headless.SimulateDesignError('parse', 'Captured for the test.');
    });
    return seen;
  }

  it.each([
    ['1 byte', 1, 1],
    ['300 bytes in 1-byte chunks', 300, 1],
    ['65,537 bytes in 4,096-byte chunks (past the first step)', 65_537, 4_096],
    ['the cap in 65,537-byte chunks', MAX_API_BODY_BYTES, 65_537],
    ['the cap in one chunk', MAX_API_BODY_BYTES, MAX_API_BODY_BYTES],
  ])('%s', async (_label, size, chunk) => {
    const seen = capture();
    const bytes = pattern(size);
    const one = upload('/describe');
    for (let at = 0; at < size; at += chunk) one.push(bytes.subarray(at, at + chunk));
    one.end();
    const response = await one.response;
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.byteLength).toBe(size);
    expect(seen.held).toBe(size);
    expect(Buffer.from(seen[0]!).equals(Buffer.from(bytes))).toBe(true);
  }, 60_000);

  it('0 bytes: no body is EMPTY_FILE, and the service is never called', async () => {
    const seen = capture();
    const response = await worker.fetch(new Request('http://local/describe?filename=empty.ork', { method: 'POST' }), undefined, ctx);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('EMPTY_FILE');
    expect(seen).toHaveLength(0);
  });

  it('the cap plus one byte is refused with 413 and its exact count', async () => {
    const seen = capture();
    const one = upload('/describe');
    await one.send(pattern(MAX_API_BODY_BYTES));
    await one.send(new Uint8Array(1));
    const response = await one.response;
    expect(response.status).toBe(413);
    expect((await response.json() as { error: { message: string } }).error.message)
      .toBe('upload.ork: the API body limit is 8 MiB; received 8,388,609 bytes. Use https://mmrsim.mountainmanrockets.com for larger files.');
    expect(one.state.cancelled).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('a Content-Length that declares 8 MiB and sends 10 bytes keeps the 10', async () => {
    const seen = capture();
    const bytes = pattern(10);
    const response = await worker.fetch(new Request('http://local/describe?filename=short.ork',
      { method: 'POST', body: bytes, headers: { 'Content-Length': String(MAX_API_BODY_BYTES) } }), undefined, ctx);
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(1);
    expect(Buffer.from(seen[0]!).equals(Buffer.from(bytes))).toBe(true);
  });
});
