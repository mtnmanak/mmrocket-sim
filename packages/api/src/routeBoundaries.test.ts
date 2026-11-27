import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedWorker, TEST_KEY, testEnv } from './auth.testSupport.js';
import { worker } from './index.js';
import { BodyReservation, readBody, reservedBodyBytes } from './body.js';
import { bytesOf } from './fixtures.testSupport.js';

const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
afterEach(() => { vi.restoreAllMocks(); expect(reservedBodyBytes()).toBe(0); });

it('returns prepared empty-body capacity before handoff to the caller', async () => {
  const reservation = new BodyReservation();
  reservation.setKey('empty-reader');
  reservation.prepare();
  try {
    expect(reservedBodyBytes()).toBe(64 * 1024);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const data = await readBody(new Request('http://local', { method: 'POST', body, duplex: 'half' } as RequestInit), reservation);
    expect(data.byteLength).toBe(0);
    // Check before finally/release: final cleanup alone must not satisfy this guard.
    expect(reservedBodyBytes()).toBe(0);
  } finally { reservation.release(); }
});

it.each(['/describe', '/experimental/fly'])('%s: streamed empty uploads spend a work token and return prepared capacity', async route => {
  const returned = vi.spyOn(BodyReservation.prototype, 'return');
  const limit = vi.fn(async () => ({ success: true }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  const request = new Request(`http://local${route}?filename=empty.ork`, {
    method: 'POST', headers: { Authorization: `Bearer ${TEST_KEY}` }, body: stream, duplex: 'half',
  } as RequestInit);
  expect(request.headers.has('Content-Length')).toBe(false);
  const response = await worker.fetch(request, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'EMPTY_FILE' } });
  expect(limit.mock.calls).toEqual([[{ key: 'test' }]]);
  expect(returned).toHaveBeenCalledWith(64 * 1024);
  expect(reservedBodyBytes()).toBe(0);
});

it.each(['/health', '/describe', '/experimental/fly'].flatMap(route => ['HEAD', 'OPTIONS'].map(method => [route, method])))(
  '%s: refuses %s with Allow and no CORS', async (route, method) => {
    const response = await authenticatedWorker.fetch(new Request(`http://local${route}`, { method }), undefined, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(route === '/health' ? 'GET' : 'POST');
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    expect(await response.json()).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
  });

it.each(['/describe', '/experimental/fly'].flatMap(route => [['reference.ork', 'ork'], ['Show-off.CDX1', 'cdx1']].map(
  ([fixture, format]) => [route, fixture!, format!])))(
  '%s: opens mislabelled %s and discloses its actual format', async (route, fixture, format) => {
    const response = await authenticatedWorker.fetch(new Request(`http://local${route}?filename=renamed.rkt`, {
      method: 'POST', body: bytesOf(fixture),
    }), undefined, ctx);
    const json = await response.json() as { sourceFormat?: string; notes: { import: { text: string } } };
    expect(response.status, JSON.stringify(json)).toBe(200);
    if (route === '/describe') expect(json.sourceFormat).toBe(format);
    expect(json.notes.import.text).toContain('despite its extension');
  }, 30_000);
