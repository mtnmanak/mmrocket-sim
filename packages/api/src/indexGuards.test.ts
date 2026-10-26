import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync, zipSync } from 'fflate';
import { worker } from './index.js';
import { bytesOf, secondaryBody, timeStepBody } from './fixtures.testSupport.js';
import { simulateFile } from '../../app/src/headless/index.js';
import { resetKernelForTests, withKernel } from '../../app/src/services/simulateDesign.js';
import { DOMParser } from '@xmldom/xmldom';
import * as foreignParts from '../../app/src/services/foreignPartPrecount.js';
import * as extensions from '../../app/src/services/orkExtensions.js';

afterEach(() => { vi.useRealTimers(); resetKernelForTests(); });

const request = (body: Uint8Array | string, filename = 'test.ork', headers?: HeadersInit) =>
  new Request('http://local/experimental/fly?filename=' + filename, { method: 'POST', body: typeof body === 'string' ? body : new Uint8Array(body).buffer, headers });
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };

it('reports an out-of-motor EX snapshot as an import refusal before installation', async () => {
  const body = secondaryBody('refused');
  const node = await simulateFile(body, 'refused.ork', { network: 'forbid', reportSeries: 'summary' });
  expect(node.importNote.text).toContain('Embedded EX motor Bad-C6 was not loaded');
  expect(node.build.motorFailures).toEqual([]);
  const response = await worker.fetch(request(body, 'refused.ork'), undefined, ctx);
  expect(response.status).toBe(200);
  const result = await response.json() as { motorFailures: unknown[]; motors: { mount: string }[];
    notes: { import: { text: string } } };
  expect(result.notes.import.text).toContain('Embedded EX motor Bad-C6 was not loaded');
  expect(result.motorFailures).toEqual([]);
  expect(result.motors).toHaveLength(1);
  expect(result.motors.some(m => m.mount === 'Secondary mount')).toBe(false);
});

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

it.each([['ork', 'zip'], ['ork', 'gzip'], ['rkt', 'zip'], ['rkt', 'gzip'], ['CDX1', 'zip'], ['CDX1', 'gzip']] as const)(
  'classifies oversized inflated %s in %s as 413 rather than a parse failure', async (ext, compression) => {
    const xml = new Uint8Array(16 * 1024 * 1024 + 1);
    const body = compression === 'zip' ? zipSync({ ['rocket.' + ext]: xml }) : gzipSync(xml);
    const response = await worker.fetch(request(body, 'large.' + ext), undefined, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: expect.stringMatching(/16 MiB.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
  });

it.each([
  ['elements', '<x/>'.repeat(50_000)],
  ['depth', '<x>'.repeat(63) + '</x>'.repeat(63)],
  ['comments', '<!---->'.repeat(200_000)],
  ['processing instructions', '<?a?>'.repeat(200_000)],
  ['text siblings', 'x<!---->'.repeat(100_000)],
  ['CDATA siblings', '<![CDATA[x]]>'.repeat(200_000)],
  ['attributes', '<x ' + Array.from({ length: 200_000 }, (_, i) => `a${i}=""`).join(' ') + '/>'],
])('refuses excessive XML %s before constructing any DOM', async (_kind, payload) => {
  const dom = vi.spyOn(DOMParser.prototype, 'parseFromString');
  try {
    const response = await worker.fetch(request(`<openrocket><rocket>${payload}</rocket></openrocket>`), undefined, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: expect.stringMatching(/XML.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
    expect(dom).not.toHaveBeenCalled();
  } finally { dom.mockRestore(); }
});

it.each([
  ['rkt', '<RockSimDocument><DesignInformation><RocketDesign>', '</RocketDesign></DesignInformation></RockSimDocument>', '<x/>'.repeat(50_000)],
  ['CDX1', '<RASAeroDocument><RocketDesign>', '</RocketDesign></RASAeroDocument>', '<x/>'.repeat(50_000)],
  ['rkt', '<RockSimDocument><DesignInformation><RocketDesign>', '</RocketDesign></DesignInformation></RockSimDocument>', '<x>'.repeat(64) + '</x>'.repeat(64)],
  ['CDX1', '<RASAeroDocument><RocketDesign>', '</RocketDesign></RASAeroDocument>', '<x>'.repeat(64) + '</x>'.repeat(64)],
  ['ork', '<openrocket><simulations>', '</simulations></openrocket>', '<simulation/>'.repeat(50_000)],
  ['ork', '<openrocket>', '</openrocket>', '<x>'.repeat(64) + '</x>'.repeat(64)],
].flatMap(([ext, open, close, payload]) => ['plain', 'zip', 'gzip'].map(compression => ({
  ext: ext!, compression, xml: open! + payload! + close!,
}))))('refuses excessive $ext XML ($compression) before importer pre-passes', async ({ ext, compression, xml }) => {
  const parts = vi.spyOn(foreignParts, 'refuseOversizedForeignXml');
  const slices = vi.spyOn(extensions, 'extensionXmlBySimulation');
  const dom = vi.spyOn(DOMParser.prototype, 'parseFromString');
  try {
    const bytes = new TextEncoder().encode(xml);
    const body = compression === 'plain' ? bytes
      : compression === 'zip' ? zipSync({ ['rocket.' + ext]: bytes }) : gzipSync(bytes);
    const response = await worker.fetch(request(body, 'flood.' + ext), undefined, ctx);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: 'FILE_TOO_LARGE',
      message: expect.stringMatching(/XML.*https:\/\/mmrsim\.mountainmanrockets\.com/) } });
    expect(parts.mock.calls.length).toBe(0);
    expect(slices.mock.calls.length).toBe(0);
    expect(dom).not.toHaveBeenCalled();
  } finally { parts.mockRestore(); slices.mockRestore(); dom.mockRestore(); }
});

it.each([
  ['ork', '<openrocket><rocket><x></rocket></openrocket>', 'Not a valid .ork file (XML parse error)'],
  ['rkt', '<RockSimDocument><x></RockSimDocument>', 'Not a valid RockSim file (XML parse error)'],
  ['CDX1', '<RASAeroDocument><x></RASAeroDocument>', 'Not a valid RASAero file (XML parse error)'],
])('keeps the %s malformed-XML message while refusing before pre-passes', async (ext, xml, message) => {
  const parts = vi.spyOn(foreignParts, 'refuseOversizedForeignXml');
  const slices = vi.spyOn(extensions, 'extensionXmlBySimulation');
  try {
    const response = await worker.fetch(request(xml!, 'broken.' + ext), undefined, ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_FILE', message: expect.stringContaining(message!) } });
    expect(parts.mock.calls.length).toBe(0);
    expect(slices.mock.calls.length).toBe(0);
  } finally { parts.mockRestore(); slices.mockRestore(); }
});

it('keeps the binary RockSim refusal before XML parsing', async () => {
  const response = await worker.fetch(request('[[RS001024RS]]', 'old.rkt'), undefined, ctx);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'INVALID_FILE', message: expect.stringContaining('older BINARY RockSim file') } });
});

it('keeps the extension-byte refusal for XML within the structural budgets', async () => {
  const xml = '<openrocket><simulations><simulation><extension>' + 'x'.repeat(1024 * 1024)
    + '</extension></simulation></simulations></openrocket>';
  const response = await worker.fetch(request(gzipSync(new TextEncoder().encode(xml))), undefined, ctx);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'INVALID_FILE',
    message: expect.stringContaining('Simulation extension XML exceeds the limit of 1,048,576 bytes total.') } });
});

it('discloses a floor above the default when the file omits its time step', async () => {
  const out = await simulateFile(bytesOf('reference.ork'), 'reference.ork', { minTimeStepS: 0.1, reportSeries: 'summary' });
  expect(out.timeStepFloor).toEqual({ appStepS: 0.05, flownStepS: 0.1 });
  expect(out.plan.snapshot.launch.timeStepS).toBe(0.1);
  expect(out.run.timeStepS).toBe(0.1);
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
