import { afterEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import * as body from './body.js';
import { TEST_KEY, testEnv } from './auth.testSupport.js';

afterEach(() => { vi.restoreAllMocks(); expect(body.reservedBodyBytes()).toBe(0); });
it('times out a trickled upload, cancels its reader, maps 408 and returns every reserved byte', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; c.enqueue(new Uint8Array([1])); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const original = body.readBody;
  vi.spyOn(body, 'readBody').mockImplementation((request, reservation) => original(request, reservation, performance.now() + 30));
  const input = new Request('http://local/describe?filename=slow.ork', {
    method: 'POST', headers: { Authorization: `Bearer ${TEST_KEY}` }, body: stream, duplex: 'half',
  } as RequestInit);
  const timer = setInterval(() => { if (!cancelled) controller.enqueue(new Uint8Array([2])); }, 5);
  try {
    const response = await worker.fetch(input, testEnv, { waitUntil() {} });
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: 'BODY_TIMEOUT', message: 'The upload did not finish within 30 seconds.' } });
    expect(cancelled).toBe(true);
  } finally { clearInterval(timer); }
});
it('uses an absolute request deadline and never waits for a hanging cancel', async () => {
  const reservation = new body.BodyReservation();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const input = new Request('http://local', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  try {
    await expect(body.readBody(input, reservation, performance.now() - 1)).rejects.toMatchObject({ name: 'Error' });
    expect(cancelled).toBe(true);
  } finally { reservation.release(); }
});
it('clears the upload timer after success and reader failure', async () => {
  const clear = vi.spyOn(globalThis, 'clearTimeout');
  for (const failure of [false, true]) {
    const reservation = new body.BodyReservation();
    const stream = new ReadableStream<Uint8Array>({ start(c) { if (failure) c.error(new Error('Lost client.')); else c.close(); } });
    try {
      const read = body.readBody(new Request('http://local', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), reservation, performance.now() + 30);
      if (failure) await expect(read).rejects.toThrow('Lost client.');
      else await read;
    } finally { reservation.release(); }
  }
  expect(clear).toHaveBeenCalledTimes(2);
});

it('refuses an expired absolute deadline even when the whole body is buffered', async () => {
  const reservation = new body.BodyReservation();
  try {
    await expect(body.readBody(new Request('http://local', { method: 'POST', body: 'buffered' }), reservation,
      performance.now() - 1)).rejects.toBeInstanceOf(body.BodyTimeout);
  } finally { reservation.release(); }
});
it.each(['cap', 'budget'])('does not let hanging cancellation strand bytes on a %s refusal', async kind => {
  const reservation = new body.BodyReservation();
  const other = new body.BodyReservation();
  if (kind === 'budget') other.reserve(body.MAX_IN_FLIGHT_BODY_BYTES);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(kind === 'cap' ? body.MAX_API_BODY_BYTES + 1 : 1)); },
    cancel() { return new Promise(() => {}); },
  });
  try {
    const result = body.readBody(new Request('http://local', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
      reservation, performance.now() + 20);
    await expect(Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error('Refusal hung.')), 80))]))
      .rejects.toBeInstanceOf(kind === 'cap' ? body.BodyTooLarge : body.ServerBusy);
  } finally { reservation.release(); other.release(); }
});

it('times out a stalled reader even when no further bytes arrive', async () => {
  const reservation = new body.BodyReservation();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancelled = true; } });
  try {
    const read = body.readBody(new Request('http://local', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
      reservation, performance.now() + 20);
    await expect(Promise.race([read, new Promise((_, reject) => setTimeout(() => reject(new Error('Deadline did not fire.')), 100))]))
      .rejects.toBeInstanceOf(body.BodyTimeout);
    expect(cancelled).toBe(true);
  } finally {
    if (!cancelled) controller.error(new Error('Test cleanup.'));
    reservation.release();
  }
});

it('preserves the timeout when an internal reader refuses release with a pending read', async () => {
  const reservation = new body.BodyReservation();
  const reader = { read: () => new Promise(() => {}), cancel: () => new Promise(() => {}),
    releaseLock() { throw new TypeError('Cannot call releaseLock() on a reader with outstanding read promises.'); } };
  const request = { headers: new Headers(), body: { getReader: () => reader } } as unknown as Request;
  try {
    await expect(body.readBody(request, reservation, performance.now() + 10)).rejects.toBeInstanceOf(body.BodyTimeout);
  } finally { reservation.release(); }
});
it('uses one timeout race for a many-chunk upload', async () => {
  const reservation = new body.BodyReservation();
  const stream = new ReadableStream<Uint8Array>({ start(c) {
    for (let i = 0; i < 1000; i++) c.enqueue(new Uint8Array([1]));
    c.close();
  } });
  const race = vi.spyOn(Promise, 'race');
  try {
    const result = await body.readBody(new Request('http://local', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), reservation);
    expect(result.byteLength).toBe(1000);
    // A race per chunk retains timeout reactions until the whole upload settles.
    expect(race).toHaveBeenCalledTimes(1);
  } finally { reservation.release(); }
});
