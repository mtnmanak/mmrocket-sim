import { beforeEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import {
  APP_VERSION, CURVES_GENERATED, KernelUnavailableError, MOTORS_GENERATED, SimulateDesignError, simulateFile,
} from '../../app/src/headless/index.js';
import { bytesOf, stampOf } from './fixtures.testSupport.js';

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

it('sizes the body buffer from received bytes, never a declared 8 MiB length, and takes no slice', async () => {
  // The API's body cap: a declared length AT the cap is read, so it must not size anything.
  type Traced = ArrayBuffer & { resize(n: number): void; readonly maxByteLength: number };
  const proto = ArrayBuffer.prototype as Traced;
  const originalSlice = proto.slice;
  const originalResize = proto.resize;
  /** The reader's own buffer steps (each resize, with the buffer's maxByteLength) and any slice, for one request. */
  async function trace(length: string | undefined) {
    const steps: unknown[] = [];
    const inReader = () => new Error().stack?.includes('readBody') ?? false;
    const sliceSpy = vi.spyOn(proto, 'slice').mockImplementation(function (this: ArrayBuffer, ...args) {
      if (inReader()) steps.push(['slice', ...args]);
      return originalSlice.apply(this, args);
    });
    const resizeSpy = vi.spyOn(proto, 'resize').mockImplementation(function (this: Traced, n: number) {
      if (inReader()) steps.push(['resize', n, this.maxByteLength]);
      originalResize.call(this, n);
    });
    const request = new Request(url, { method: 'POST', body: new Uint8Array(10) });
    if (length !== undefined) request.headers.set('Content-Length', length);
    vi.mocked(simulateFile).mockReset().mockRejectedValue(new Error('test flight refusal'));
    try {
      await worker.fetch(request, undefined, { waitUntil: () => undefined });
    } finally { sliceSpy.mockRestore(); resizeSpy.mockRestore(); }
    return { steps, received: vi.mocked(simulateFile).mock.calls[0]![0].byteLength };
  }
  const declared = await trace(String(8 * 1024 * 1024));
  // One buffer that may grow to the cap: a first step for the bytes, then exactly them.
  const cap = 8 * 1024 * 1024;
  expect(declared).toEqual({ steps: [['resize', 65_536, cap], ['resize', 10, cap]], received: 10 });
  expect(await trace(undefined)).toEqual(declared);
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

it('skips a flown mount with no motor entry instead of turning a finished flight into a 500', async () => {
  const actual = await vi.importActual<typeof import('../../app/src/headless/index.js')>('../../app/src/headless/index.js');
  const out = await actual.simulateFile(bytesOf('reference.ork'), 'reference.ork', { reportSeries: 'summary' });
  const id = out.flight.delayResolution.mounts[0]!.mountId;
  const name = out.flight.delayResolution.mounts[0]!.mountName;
  // No real input is known to reach this: the flight's mounts come from these same entries.
  delete out.state.mountMotors[id];
  vi.mocked(simulateFile).mockResolvedValue(out);
  const response = await worker.fetch(new Request(url, { method: 'POST', body: 'x' }), undefined,
    { waitUntil: () => undefined });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as { motors: { mount: string }[]; apogeeM: number; maxVelocityMs: number;
    maxMach: number; flightTimeS: number };
  expect(result.motors.some(motor => motor.mount === name)).toBe(false);
  const { maxAltitude, maxVelocity, maxMachNumber, flightTime } = out.result.summary;
  expect({ apogeeM: result.apogeeM, maxVelocityMs: result.maxVelocityMs, maxMach: result.maxMach, flightTimeS: result.flightTimeS })
    .toEqual({ apogeeM: maxAltitude, maxVelocityMs: maxVelocity, maxMach: maxMachNumber, flightTimeS: flightTime });
});

// Fly-route refusals no committed fixture reaches over HTTP (a 'file' refusal sits behind the 8 MiB body cap).
it.each([
  [new SimulateDesignError('file', 'Too large.'), 413, 'FILE_TOO_LARGE'],
  [new SimulateDesignError('parse', 'Unreadable.'), 400, 'INVALID_FILE'],
  [new SimulateDesignError('build', 'Refused.', { importNote: { text: 'Imported.', severity: 'info' } }), 422, 'DESIGN_BUILD_FAILED'],
  [new SimulateDesignError('no-motor', 'No motor.'), 422, 'NO_MOTOR'],
  [new SimulateDesignError('flight', 'Failed.'), 422, 'FLIGHT_FAILED'],
  [new KernelUnavailableError(), 503, 'KERNEL_UNAVAILABLE'],
  [new Error('test flight refusal'), 500, 'INTERNAL_ERROR'],
] as const)('stamps the fly refusal %s beside an unchanged error', async (refusal, status, code) => {
  vi.mocked(simulateFile).mockRejectedValue(refusal);
  const health = await (await worker.fetch(new Request('http://local/health'), undefined, { waitUntil: () => undefined })).json();
  const response = await worker.fetch(new Request(url, { method: 'POST', body: 'x' }), undefined, { waitUntil: () => undefined });
  expect(response.status).toBe(status);
  expect(response.headers.get('retry-after')).toBe(code === 'KERNEL_UNAVAILABLE' ? '5' : null);
  const body = await response.json() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(['error', 'appVersion', 'engine', 'catalogue']);
  expect(body['error']).toEqual({ code, message: expect.any(String),
    ...(refusal instanceof SimulateDesignError && refusal.importNote ? { importNote: refusal.importNote } : {}) });
  expect(stampOf(body)).toEqual(stampOf(health));
  expect({ appVersion: body['appVersion'], catalogue: body['catalogue'] })
    .toEqual({ appVersion: APP_VERSION, catalogue: { motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED } });
});
