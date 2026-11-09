import { afterEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import { TEST_KEY, testEnv } from './auth.testSupport.js';
import * as headless from '../../app/src/headless/index.js';
import * as body from './body.js';
import { kernelJob } from './admission.js';
import { bytesOf } from './fixtures.testSupport.js';

const ctx = { waitUntil() {} };
const post = (route: string, filename = '?filename=test.ork', data?: BodyInit) => new Request(
  `http://local${route}${filename}`, { method: 'POST', body: data,
    headers: { Authorization: `Bearer ${TEST_KEY}` }, duplex: 'half' } as RequestInit);
afterEach(() => { vi.restoreAllMocks(); expect(body.reservedBodyBytes()).toBe(0); });

it.each(['/describe', '/experimental/fly'])('reports limiter outages consistently on %s without reading the upload', async route => {
  const input = post(route, undefined, 'x');
  const read = vi.spyOn(input.body!, 'getReader');
  const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit: async () => { throw new Error('private binding detail'); } } }, ctx);
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR',
    message: 'The API request limit could not be checked. Retry in a few seconds.' } });
  expect(read).not.toHaveBeenCalled();
});

it.each(['/describe', '/experimental/fly'])('bounds cheap refusals separately from work tokens on %s', async route => {
  const counts = new Map<string, number>();
  const limit = vi.fn(async ({ key }: { key: string }) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { success: counts.get(key)! <= 20 };
  });
  const env = { ...testEnv, RATE_LIMITER: { limit } };
  for (let i = 0; i < 20; i++) {
    const response = await worker.fetch(post(route, i % 2 ? undefined : ''), env, ctx);
    expect(response.status).toBe(400);
  }
  expect(counts.get('test')).toBeUndefined();
  expect((await worker.fetch(post(route), env, ctx)).status).toBe(429);
  vi.spyOn(headless, 'describeFile').mockRejectedValue(new headless.SimulateDesignError('parse', 'test'));
  vi.spyOn(headless, 'simulateFile').mockRejectedValue(new headless.SimulateDesignError('parse', 'test'));
  expect((await worker.fetch(post(route, undefined, 'x'), env, ctx)).status).toBe(400);
  expect(counts.get('test')).toBe(1);
});

it.each(['/describe', '/experimental/fly'])('refuses a full kernel before upload and work-token spending on %s', async route => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jobs = Array.from({ length: 3 }, () => kernelJob(() => gate));
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const input = post(route, undefined, 'x');
  const read = vi.spyOn(input.body!, 'getReader');
  try {
    const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'KERNEL_BUSY' } });
    expect(read).not.toHaveBeenCalled();
    expect(limit.mock.calls).toEqual([[{ key: 'refused:test' }]]);
  } finally { release(); await Promise.all(jobs); }
});

it('distinguishes a declared body size from counted incoming bytes on both routes', async () => {
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  for (const route of ['/describe', '/experimental/fly']) {
    const input = post(route, undefined, 'x');
    input.headers.set('Content-Length', '100000000000000000000');
    const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
    expect(response.status).toBe(413);
    const out = await response.json() as { error: { message: string } };
    expect(out.error.message).toContain('declared');
    expect(out.error.message).not.toContain('received');
  }
  expect(limit.mock.calls).toEqual([[{ key: 'refused:test' }], [{ key: 'refused:test' }]]);
});

it('excludes authentication and rate-limiter time from parseMs while totalMs includes them', async () => {
  const out = await headless.simulateFile(bytesOf('reference.ork'), 'reference.ork', { reportSeries: 'summary' });
  vi.spyOn(headless, 'simulateFile').mockResolvedValue({ ...out, timing: { parseMs: 7, flyMs: 11, totalMs: 18 } });
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => { now += 100; return digest(...args); });
  vi.spyOn(body, 'readBody').mockImplementation(async () => { now += 30; return new ArrayBuffer(1); });
  const env = { ...testEnv, RATE_LIMITER: { limit: async () => { now += 200; return { success: true }; } } };
  const response = await worker.fetch(post('/experimental/fly', undefined, 'x'), env, ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ timing: { parseMs: 37, totalMs: 330 } });
});

it('logs a poisoned isolate once without private fields and makes no recovery-time promise', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(headless, 'describeFile').mockRejectedValue(new headless.KernelUnavailableError());
  vi.spyOn(headless, 'simulateFile').mockRejectedValue(new headless.KernelUnavailableError());
  for (const route of ['/describe', '/experimental/fly', '/describe']) {
    const response = await worker.fetch(post(route, '?filename=private-name.ork', 'private body'), testEnv, ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'KERNEL_UNAVAILABLE',
      message: expect.stringContaining('replaced') } });
  }
  expect(log.mock.calls).toEqual([['API kernel unavailable: isolate replacement required.']]);
});

it.each(['/describe', '/experimental/fly'])('refuses a poisoned kernel before body reservation or work tokens on %s', async route => {
  vi.spyOn(headless, 'kernelPoisoned').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const prepare = vi.spyOn(body.BodyReservation.prototype, 'prepare');
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const input = post(route, undefined, 'x');
  const read = vi.spyOn(input.body!, 'getReader');
  const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBeNull();
  expect(await response.json()).toMatchObject({ error: { code: 'KERNEL_UNAVAILABLE' } });
  expect(prepare).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(limit.mock.calls).toEqual([[{ key: 'refused:test' }]]);
});

it.each(['/describe', '/experimental/fly'])('refuses poison arising during upload before parsing on %s', async route => {
  const poison = vi.spyOn(headless, 'kernelPoisoned').mockReturnValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(body, 'readBody').mockImplementation(async () => {
    poison.mockReturnValue(true);
    return new ArrayBuffer(1);
  });
  const describe = vi.spyOn(headless, 'describeFile').mockRejectedValue(new Error('must not parse'));
  const simulate = vi.spyOn(headless, 'simulateFile').mockRejectedValue(new Error('must not parse'));
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const response = await worker.fetch(post(route, undefined, 'x'), { ...testEnv, RATE_LIMITER: { limit } }, ctx);
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBeNull();
  expect(await response.json()).toMatchObject({ error: { code: 'KERNEL_UNAVAILABLE' } });
  expect(describe).not.toHaveBeenCalled();
  expect(simulate).not.toHaveBeenCalled();
  // The upload was already admitted: its work token cannot be recovered.
  expect(limit.mock.calls).toEqual([[{ key: 'test' }]]);
});

it('allows four small unfinished uploads without an arbitrary count cap', async () => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const env = { ...testEnv, RATE_LIMITER: { limit } };
  const held = Array.from({ length: 3 }, () => worker.fetch(post('/describe', undefined,
    new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); c.enqueue(new Uint8Array(1)); } })), env, ctx));
  try {
    await vi.waitFor(() => expect(body.reservedBodyBytes()).toBe(3 * 64 * 1024));
    expect(limit.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ key: 'test' }]));
    limit.mockClear();
    const input = post('/experimental/fly', undefined, 'x');
    const read = vi.spyOn(input.body!, 'getReader');
    const second = await worker.fetch(input, env, ctx);
    expect(second.status).toBe(400);
    expect(read).toHaveBeenCalled();
    expect(limit.mock.calls).toEqual([[{ key: 'test' }]]);
    expect(body.reservedBodyBytes()).toBe(3 * 64 * 1024);
  } finally { for (const c of controllers) c.error(new Error('Lost client')); await Promise.all(held); }
  const after = await worker.fetch(post('/describe', undefined, 'x'), testEnv, ctx);
  expect(after.status).toBe(400);
});

it.each(['/describe', '/experimental/fly'])('charges full reader capacity refusals only to refused tokens on %s', async route => {
  const held = new body.BodyReservation();
  held.reserve(body.MAX_IN_FLIGHT_BODY_BYTES);
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const input = post(route, undefined, 'x');
  const read = vi.spyOn(input.body!, 'getReader');
  try {
    const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
    expect(await response.json()).toMatchObject({ error: { code: 'SERVER_BUSY' } });
    expect(read).not.toHaveBeenCalled();
    expect(limit.mock.calls).toEqual([[{ key: 'refused:test' }]]);
  } finally { held.release(); }
});

it.each(['/describe', '/experimental/fly'])('refuses declared empty before full kernel and reader budgets on %s', async route => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jobs = Array.from({ length: 3 }, () => kernelJob(() => gate));
  const held = new body.BodyReservation();
  held.reserve(body.MAX_IN_FLIGHT_BODY_BYTES);
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  try {
    for (const size of [0, body.MAX_API_BODY_BYTES + 1]) {
      const input = post(route, undefined, 'x');
      input.headers.set('Content-Length', String(size));
      const read = vi.spyOn(input.body!, 'getReader');
      const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
      expect(response.status).toBe(size === 0 ? 400 : 413);
      expect(await response.json()).toMatchObject({ error: { code: size === 0 ? 'EMPTY_FILE' : 'FILE_TOO_LARGE' } });
      expect(read).not.toHaveBeenCalled();
    }
    expect(limit.mock.calls).toEqual([[{ key: 'refused:test' }], [{ key: 'refused:test' }]]);
  } finally { held.release(); release(); await Promise.all(jobs); }
});

it.each(['/describe', '/experimental/fly'])('refuses declared oversize before a full kernel without reading or spending work on %s', async route => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const jobs = Array.from({ length: 3 }, () => kernelJob(() => gate));
  const limit = vi.fn(async (_input: { key: string }) => ({ success: true }));
  const input = post(route, undefined, 'x');
  input.headers.set('Content-Length', String(body.MAX_API_BODY_BYTES + 1));
  const read = vi.spyOn(input.body!, 'getReader');
  try {
    const response = await worker.fetch(input, { ...testEnv, RATE_LIMITER: { limit } }, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
    expect(read).not.toHaveBeenCalled();
    expect(limit.mock.calls).toEqual([[{ key: 'refused:test' }]]);
  } finally { release(); await Promise.all(jobs); }
});
