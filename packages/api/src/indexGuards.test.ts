import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync, zipSync } from 'fflate';
import { worker } from './index.js';
import { bytesOf, timeStepBody } from './fixtures.testSupport.js';
import { simulateFile } from '../../app/src/headless/index.js';
import { resetKernelForTests, withKernel } from '../../app/src/services/simulateDesign.js';

afterEach(() => { vi.useRealTimers(); resetKernelForTests(); });

const request = (body: Uint8Array | string, filename = 'test.ork', headers?: HeadersInit) =>
  new Request('http://local/experimental/fly?filename=' + filename, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body).buffer, headers });
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };

it('refuses 9 MiB bodies and declared sizes above 8 MiB with app guidance', async () => {
  for (const input of [request(new Uint8Array(9 * 1024 * 1024)),
    request('x', 'test.ork', { 'Content-Length': String(8 * 1024 * 1024 + 1) })]) {
    const response = await worker.fetch(input, undefined, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: expect.stringMatching(/8 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
  }
});

it('accepts exactly 8 MiB and parses it, ignoring an in-limit declared size', async () => {
  const body = new Uint8Array(8 * 1024 * 1024);
  body.fill(32);
  const response = await worker.fetch(request(body, 'test.ork', { 'Content-Length': '1' }), undefined, ctx);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'INVALID_FILE' } });
});

it('cancels streaming input on the first byte above 8 MiB, even if cancellation fails', async () => {
  let sent = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const bytes = Math.min(chunk.length, 8 * 1024 * 1024 + 1 - sent);
      if (!bytes) throw new Error('Read past the limit.');
      controller.enqueue(chunk.subarray(0, bytes));
      sent += bytes;
    },
    cancel() { cancelled = true; throw new Error('Cancellation failed.'); },
  }, { highWaterMark: 0 });
  const input = new Request('http://local/experimental/fly?filename=stream.ork',
    { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const response = await worker.fetch(input, undefined, ctx);
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(sent).toBe(8 * 1024 * 1024 + 1);
});

it.each([['ork', 'zip'], ['ork', 'gzip'], ['rkt', 'zip'], ['rkt', 'gzip']] as const)(
  'classifies oversized inflated %s in %s as 413 rather than a parse failure', async (ext, compression) => {
    const xml = new Uint8Array(16 * 1024 * 1024 + 1);
    const body = compression === 'zip' ? zipSync({ ['rocket.' + ext]: xml }) : gzipSync(xml);
    const response = await worker.fetch(request(body, 'large.' + ext), undefined, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: expect.stringMatching(/16 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
  });

it.each([0.005, 0.01, 0.05, 0.1])('flies at the API floor for an own-file step of %s s and reports changes', async step => {
  const body = timeStepBody(step);
  const node = await simulateFile(body, 'step.ork', { reportSeries: 'summary', minTimeStepS: 0.05 });
  expect(node.plan.snapshot.launch.timeStepS).toBe(Math.max(step, 0.05));
  expect(node.timeStepFloor).toEqual(step < 0.05 ? { appStepS: 0.01, flownStepS: 0.05 } : undefined);
  expect(node.run.timeStepS).toBe(Math.max(step, 0.05));
  const response = await worker.fetch(request(body), undefined, ctx);
  expect(response.status).toBe(200);
  const out = await response.json() as { apogeeM: number; flightTimeS: number; notes: { api: string[]; import: { text: string; group: { lines: { text: string }[] } } } };
  expect(out.apogeeM).toBeCloseTo(node.result.summary.maxAltitude, 8);
  expect(out.flightTimeS).toBeCloseTo(node.result.summary.flightTime, 8);
  expect(out.notes.api).toEqual(step < 0.05
    ? ['This API flies at a time step of at least 0.05 s; in the app this design flies at 0.01 s.'] : []);
  for (const text of [out.notes.import.text, ...out.notes.import.group.lines.map(line => line.text)]) {
    expect(text).not.toContain('Flights here now use a 0.01 s');
  }
  if (step === 0.005) expect(out.notes.import.text).toMatch(/0\.005 s[\s\S]*0\.01 s/);
}, 60_000);

it('passes the ten-second watchdog through simulateFile and returns unwrapped 503 with Retry-After', async () => {
  const body = bytesOf('reference.ork');
  // Load the lazy bundled inputs before advancing the host's fake clock.
  await simulateFile(body, 'reference.ork', { reportSeries: 'summary' });
  vi.useFakeTimers();
  void withKernel(() => new Promise(() => {}));
  let settled = false;
  const flight = worker.fetch(request(body), undefined, ctx);
  void flight.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(9999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const response = await flight;
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('5');
  expect(await response.json()).toEqual({ error: { code: 'KERNEL_UNAVAILABLE',
    message: expect.stringMatching(/previous flight.*stopped part-way.*retry/i) } });
  const later = await worker.fetch(request(body), undefined, ctx);
  expect(later.status).toBe(503);
}, 60_000);
