import { beforeEach, expect, it, vi } from 'vitest';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import {
  APP_VERSION, CURVES_GENERATED, KernelUnavailableError, MOTORS_GENERATED, SimulateDesignError, simulateFile,
} from '../../app/src/headless/index.js';
import { bytesOf, stampOf } from './fixtures.testSupport.js';
import { BodyReservation } from './body.js';

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

it('sizes the body buffer from received bytes, never a declared 8 MiB length, and hands off an exact-length buffer', async () => {
  // The API's body cap: a declared length AT the cap is read, so it must not size anything.
  async function trace(length: string | undefined) {
    const steps: unknown[] = [];
    const reserve = BodyReservation.prototype.reserve;
    const spy = vi.spyOn(BodyReservation.prototype, 'reserve').mockImplementation(function (this: BodyReservation, bytes) {
      steps.push(bytes);
      return reserve.call(this, bytes);
    });
    const request = new Request(url, { method: 'POST', body: new Uint8Array(10) });
    if (length !== undefined) request.headers.set('Content-Length', length);
    vi.mocked(simulateFile).mockReset().mockRejectedValue(new Error('test flight refusal'));
    try {
      await worker.fetch(request, undefined, { waitUntil: () => undefined });
    } finally { spy.mockRestore(); }
    const data = vi.mocked(simulateFile).mock.calls[0]![0] as ArrayBuffer;
    return { steps, received: data.byteLength, capacity: data.byteLength };
  }
  const declared = await trace(String(8 * 1024 * 1024));
  // Pins the initial backing allocation, before the exact-length shrink.
  expect(declared).toEqual({ steps: [64 * 1024], received: 10, capacity: 10 });
  expect(await trace(undefined)).toEqual(declared);
});

it('keeps waitUntil pending for the real flight and passes a timer-free yield', async () => {
  let rejectFlight!: (error: Error) => void;
  const flight = new Promise<never>((_, reject) => { rejectFlight = reject; });
  vi.mocked(simulateFile).mockReturnValue(flight);
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const delayedDigest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return digest(...args);
  });
  const pending: Promise<unknown>[] = [];
  const response = worker.fetch(new Request(url, { method: 'POST', body: 'x' }), undefined,
    { waitUntil(p) { pending.push(p); } });
  try {
    // Observe registration after authentication; missing waitUntil still fails within a bound.
    await vi.waitFor(() => { expect(pending).toHaveLength(1); }, { timeout: 2000, interval: 5 });
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
    delayedDigest.mockRestore();
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
  expect(response.headers.get('retry-after')).toBeNull();
  const body = await response.json() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(['error', 'appVersion', 'engine', 'catalogue']);
  expect(body['error']).toEqual({ code, message: expect.any(String),
    ...(refusal instanceof SimulateDesignError && refusal.importNote ? { importNote: refusal.importNote } : {}) });
  expect(stampOf(body)).toEqual(stampOf(health));
  expect({ appVersion: body['appVersion'], catalogue: body['catalogue'] })
    .toEqual({ appVersion: APP_VERSION, catalogue: { motorsGenerated: MOTORS_GENERATED, curvesGenerated: CURVES_GENERATED } });
});
