import { afterEach, expect, it, vi } from 'vitest';
import { worker } from './index.js';
import { autoBody, bytesOf } from './fixtures.testSupport.js';
import { resetKernelForTests } from '../../app/src/services/simulateDesign.js';

/** The watchdog the wrappers below install in place of the Worker's 10 s. */
const DEAD_HOLDER_MS = 1;
const seen = vi.hoisted(() => ({ flights: 0, describes: 0 }));

// The Worker's own options, with the dead-holder watchdog shortened so a short
// healthy flight outlasts it. Every other option is the one index.ts passes.
vi.mock('../../app/src/headless/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../app/src/headless/index.js')>();
  return { ...real,
    simulateFile: (...[data, name, opts]: Parameters<typeof real.simulateFile>) => {
      expect(opts?.kernelDeadHolderMs).toBe(10_000);
      seen.flights++;
      return real.simulateFile(data, name, { ...opts, kernelDeadHolderMs: DEAD_HOLDER_MS });
    },
    describeFile: (...[data, name, opts]: Parameters<typeof real.describeFile>) => {
      expect(opts?.kernelDeadHolderMs).toBe(10_000);
      seen.describes++;
      return real.describeFile(data, name, { ...opts, kernelDeadHolderMs: DEAD_HOLDER_MS });
    } };
});
afterEach(() => { vi.restoreAllMocks(); resetKernelForTests(); });

const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const post = (route: string, filename: string, body: Uint8Array) => worker.fetch(new Request(
  `http://local${route}?filename=${filename}`, { method: 'POST', body: new Uint8Array(body).buffer }), undefined, ctx);

it('never poisons a request queued behind a real, healthy flight, even at a 1 ms watchdog', async () => {
  const auto = await autoBody();
  const reference = bytesOf('reference.ork');
  // Warm the lazy bundled loaders (presets, catalogue, curves) so each request's
  // pre-lock work settles in the same turn and the requests below really queue.
  for (const response of [await post('/experimental/fly', 'auto.rkt', auto), await post('/describe', 'reference.ork', reference)]) {
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const timers = vi.spyOn(globalThis, 'setTimeout');
  Object.assign(seen, { flights: 0, describes: 0 });
  const responses = await Promise.all([
    post('/experimental/fly', 'auto.rkt', auto),
    post('/experimental/fly', 'reference.ork', reference),
    post('/describe', 'reference.ork', reference),
  ]);
  const armed = timers.mock.calls.filter(([, delay]) => delay === DEAD_HOLDER_MS).length;
  timers.mockRestore();
  expect({ flights: seen.flights, describes: seen.describes }).toEqual({ flights: 2, describes: 1 });
  // A watchdog is armed only for a caller that found the lock held: proof a request queued behind a holder.
  expect(armed).toBeGreaterThanOrEqual(1);
  for (const response of responses) expect(response.status, await response.clone().text()).toBe(200);
  // Not poisoned: the next request is served too.
  const after = await post('/experimental/fly', 'reference.ork', reference);
  expect(after.status, await after.clone().text()).toBe(200);
});
