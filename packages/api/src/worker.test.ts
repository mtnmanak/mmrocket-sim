import { beforeEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import { simulateFile } from '../../app/src/headless/index.js';
import { bytesOf } from './fixtures.testSupport.js';

vi.mock('../../app/src/headless/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../app/src/headless/index.js')>();
  return { ...actual, simulateFile: vi.fn() };
});
beforeEach(() => { vi.mocked(simulateFile).mockReset(); });
const url = 'http://local/experimental/fly?filename=test.rkt';

it.each([undefined, '3', '1', '10'])('assembles received bytes with Content-Length %s', async length => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    const chunk = chunks.shift();
    if (chunk) c.enqueue(chunk); else c.close();
  } });
  const request = new Request(url, { method: 'POST', body, duplex: 'half' } as RequestInit);
  if (length !== undefined) request.headers.set('Content-Length', length);
  vi.mocked(simulateFile).mockRejectedValue(new Error('test flight refusal'));
  const response = await worker.fetch(request, undefined, { waitUntil: () => undefined });
  expect(response.status).toBe(500);
  const data = vi.mocked(simulateFile).mock.calls[0]![0];
  expect(data).toBeInstanceOf(ArrayBuffer);
  expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([1, 2, 3]);
});

it('assembles only received bytes with no ArrayBuffer reservation or slice despite a declared 8 MiB length', async () => {
  const request = new Request(url, { method: 'POST', body: new Uint8Array(10) });
  // The API's body cap: a declared length AT the cap is read, so only received bytes may be allocated.
  request.headers.set('Content-Length', String(8 * 1024 * 1024));
  const sizes: number[] = [];
  const reservations: number[] = [];
  const slices: unknown[][] = [];
  const original = globalThis.Uint8Array;
  const originalBuffer = globalThis.ArrayBuffer;
  const originalSlice = originalBuffer.prototype.slice;
  const sliceSpy = vi.spyOn(originalBuffer.prototype, 'slice').mockImplementation(function (this: ArrayBuffer, ...args) {
    if (new Error().stack?.includes('readDesign')) slices.push(args);
    return originalSlice.apply(this, args);
  });
  vi.stubGlobal('Uint8Array', new Proxy(original, { construct(target, args) {
    // Observe the reader's allocation path, excluding Response.json/runtime allocations.
    if (typeof args[0] === 'number' && Number.isFinite(args[0]) && new Error().stack?.includes('readDesign')) sizes.push(args[0]);
    return Reflect.construct(target, args);
  } }));
  vi.stubGlobal('ArrayBuffer', new Proxy(originalBuffer, { construct(target, args) {
    if (typeof args[0] === 'number' && Number.isFinite(args[0]) && new Error().stack?.includes('readDesign')) reservations.push(args[0]);
    return Reflect.construct(target, args);
  } }));
  vi.mocked(simulateFile).mockRejectedValue(new Error('test flight refusal'));
  try {
    await worker.fetch(request, undefined, { waitUntil: () => undefined });
    expect(sizes).toEqual([10]);
    expect(reservations).toEqual([]);
    expect(slices).toEqual([]);
    expect(vi.mocked(simulateFile).mock.calls[0]![0].byteLength).toBe(10);
  } finally { sliceSpy.mockRestore(); vi.unstubAllGlobals(); }
});

it('keeps waitUntil pending for the real flight and passes a timer-free yield', async () => {
  let rejectFlight!: (error: Error) => void;
  const flight = new Promise<never>((_, reject) => { rejectFlight = reject; });
  vi.mocked(simulateFile).mockReturnValue(flight);
  let register!: () => void;
  const registered = new Promise<void>(resolve => { register = resolve; });
  const pending: Promise<unknown>[] = [];
  const response = worker.fetch(new Request(url, { method: 'POST', body: 'x' }), undefined,
    { waitUntil(p) { pending.push(p); register(); } });
  try {
    // Also reaches the assertion if registration is removed (rather than hanging).
    await Promise.race([registered, new Promise(resolve => setTimeout(resolve, 20))]);
    expect(pending).toHaveLength(1);
    let settled = false;
    void pending[0]!.then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    const options = vi.mocked(simulateFile).mock.calls[0]![2]!;
    expect(options.network).toBe('forbid');
    expect(options.reportSeries).toBe('summary');
    let macrotaskRan = false;
    const timeout = setTimeout(() => { macrotaskRan = true; }, 0);
    const immediate = setImmediate(() => { macrotaskRan = true; });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await options.yieldToUi!();
      expect(macrotaskRan, 'the yield must resolve before an already queued macrotask').toBe(false);
      expect(timers).not.toHaveBeenCalled();
    } finally { timers.mockRestore(); clearTimeout(timeout); clearImmediate(immediate); }
  } finally {
    rejectFlight(new Error('test flight refusal'));
    expect((await response).status).toBe(500);
    await Promise.all(pending);
  }
});

it('filters the motor list using projected ignition, including tree defaults', async () => {
  const actual = await vi.importActual<typeof import('../../app/src/headless/index.js')>('../../app/src/headless/index.js');
  const out = await actual.simulateFile(bytesOf('reference.ork'), 'reference.ork', { reportSeries: 'summary' });
  const id = out.flight.delayResolution.mounts[0]!.mountId;
  // Simulate the editor state returned alongside a flight whose tree default is never.
  out.state.tree.ignitionDefaults = { [id]: { event: 'never', delay: 0 } };
  expect(out.state.mountMotors[id]!.ignition?.event).not.toBe('never');
  vi.mocked(simulateFile).mockResolvedValue(out);
  const response = await worker.fetch(new Request(url, { method: 'POST', body: 'x' }), undefined,
    { waitUntil: () => undefined });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ motors: [] });
});
