import { afterEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import * as headless from '../../app/src/headless/index.js';
import { TEST_KEY, TEST_KEYS, testEnv } from './auth.testSupport.js';
import { reservedBodyBytes } from './body.js';

const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const request = (route = '/describe', auth: string | null = `Bearer ${TEST_KEY}`) => {
  const headers = new Headers();
  if (auth !== null) headers.set('Authorization', auth);
  return new Request(`http://local${route}?filename=test.ork`, { method: 'POST', body: 'x', headers });
};
afterEach(() => { vi.restoreAllMocks(); expect(reservedBodyBytes()).toBe(0); });

it('checks path then method before configuration or credentials', async () => {
  expect((await worker.fetch(request('/missing', null), undefined, ctx)).status).toBe(404);
  expect((await worker.fetch(new Request('http://local/describe'), undefined, ctx)).status).toBe(405);
  expect((await worker.fetch(new Request('http://local/health'), undefined, ctx)).status).toBe(200);
  expect((await worker.fetch(request('/health', null), undefined, ctx)).status).toBe(405);
});
it.each([undefined, '', 'bad', `UPPER:${'a'.repeat(64)}`, `test:${'A'.repeat(64)}`])(
  'fails closed for unusable API_KEYS %s', async API_KEYS => {
    const response = await worker.fetch(request(), { ...testEnv, API_KEYS }, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_CONFIGURED' } });
  });
it.each([null, 'Basic x', 'Bearers x', 'Bearer', 'Bearer unknown'])('refuses credentials %s before reading a byte', async header => {
  const input = request('/describe', header);
  const read = vi.spyOn(input.body!, 'getReader');
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const response = await worker.fetch(input, { API_KEYS: TEST_KEYS, RATE_LIMITER: { limit } }, ctx);
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer realm="mmrsim-api"');
  expect(await response.json()).toMatchObject({ error: { code: header === 'Bearer' || header === 'Bearer unknown'
    ? 'API_KEY_INVALID' : 'API_KEY_REQUIRED', message: expect.stringContaining('https://mmrsim.mountainmanrockets.com') } });
  expect(read).not.toHaveBeenCalled();
  expect(limit).not.toHaveBeenCalled();
});
it('accepts mixed-case Bearer, skips malformed lines, and rotates the secret cache', async () => {
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  for (const API_KEYS of [`bad\n\n${TEST_KEYS},later:${'0'.repeat(64)}`, `other:${'0'.repeat(64)}`, TEST_KEYS]) {
    const response = await worker.fetch(request('/describe', `bEaReR ${TEST_KEY}`), { API_KEYS, RATE_LIMITER: { limit } }, ctx);
    expect(response.status).toBe(API_KEYS.startsWith('other') ? 401 : 400);
  }
  expect(limit.mock.calls).toEqual([[{ key: 'test' }], [{ key: 'test' }]]);
});
it.each([undefined, { limit: async () => ({ success: false }) }])('refuses a missing or exhausted limiter before body and filename', async RATE_LIMITER => {
  const input = new Request('http://local/experimental/fly', request());
  const read = vi.spyOn(input.body!, 'getReader');
  const response = await worker.fetch(input, { API_KEYS: TEST_KEYS, RATE_LIMITER }, ctx);
  expect(response.status).toBe(RATE_LIMITER ? 429 : 503);
  expect(response.headers.get('retry-after')).toBe(RATE_LIMITER ? '60' : null);
  expect(await response.json()).toMatchObject({ error: { code: RATE_LIMITER ? 'RATE_LIMITED' : 'NOT_CONFIGURED' } });
  expect(read).not.toHaveBeenCalled();
});
it('shares three admission slots across routes and retains them after abort until work settles', async () => {
  // Authentication may take longer than the former admission polling window.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 2000));
    return digest(...args);
  });
  const reject: ((e: Error) => void)[] = [];
  let cleaning = false;
  const work = () => new Promise<never>((_, no) => {
    if (cleaning) no(new Error('Test cleanup.'));
    else reject.push(no);
  });
  vi.spyOn(headless, 'describeFile').mockImplementation(work);
  vi.spyOn(headless, 'simulateFile').mockImplementation(work);
  const pending: Promise<unknown>[] = [];
  const runtime = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  const controller = new AbortController();
  const active = [worker.fetch(new Request(request(), { signal: controller.signal }), testEnv, runtime),
    worker.fetch(request('/experimental/fly'), testEnv, runtime), worker.fetch(request(), testEnv, runtime)];
  try {
    await vi.waitFor(() => { expect(pending, 'Three requests must reach admission.').toHaveLength(3); }, { timeout: 10000, interval: 5 });
    controller.abort();
    const fourth = worker.fetch(request('/experimental/fly'), testEnv, runtime);
    active.push(fourth);
    let refused: Response | undefined;
    void fourth.then(response => { refused = response; });
    await vi.waitFor(() => { expect(refused, 'Fourth request must refuse without waiting for a slot.').toBeDefined(); }, { timeout: 10000, interval: 5 });
    expect(refused!.status).toBe(503);
    expect(refused!.headers.get('retry-after')).toBe('5');
    expect(await refused!.json()).toMatchObject({ error: { code: 'KERNEL_BUSY' } });
    expect(reject).toHaveLength(3);
    reject[0]!(new Error('Finished after client disconnect.'));
    expect((await active[0]!).status).toBe(500);
    const later = worker.fetch(request(), testEnv, runtime);
    active.push(later);
    await vi.waitFor(() => { expect(reject, 'A settled slot must admit the later request.').toHaveLength(4); }, { timeout: 10000, interval: 5 });
  } finally {
    cleaning = true;
    for (const no of reject) no(new Error('Test cleanup.'));
    await Promise.all(active);
    await Promise.all(pending);
  }
});

it('compares every configured entry even after matching, and rejects a digest differing only in the final byte', async () => {
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const digest = TEST_KEYS.split(':')[1]!;
  const API_KEYS = 'first:' + digest + ',last:' + digest;
  expect((await worker.fetch(request(), { API_KEYS, RATE_LIMITER: { limit } }, ctx)).status).toBe(400);
  expect(limit.mock.calls).toEqual([[{ key: 'last' }]]);
  const wrong = digest.slice(0, -2) + (digest.endsWith('00') ? '01' : '00');
  expect((await worker.fetch(request(), { API_KEYS: 'test:' + wrong, RATE_LIMITER: { limit } }, ctx)).status).toBe(401);
});
