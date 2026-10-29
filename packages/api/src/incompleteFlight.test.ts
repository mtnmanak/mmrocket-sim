import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { bytesOf } from './fixtures.testSupport.js';
import { authenticatedWorker as worker } from './auth.testSupport.js';

const injection = vi.hoisted(() => ({ enabled: true, boosterOnly: false, mainLanded: false,
  summary: { maxAltitude: 0, maxVelocity: 0, maxMachNumber: 0, flightTime: 0 } }));
afterEach(() => { injection.enabled = true; injection.boosterOnly = false; });
const INCOMPLETE_FILE = new URL('../../../docs/User files/TRF RASAero Files/SS Wild Bash 20260623v0.rkt', import.meta.url);

// Keep the real import/build/flight response shape; isolate the summary's
// warning contract from kernel timing and local-only corpus availability.
vi.mock('../../app/src/headless/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../app/src/headless/index.js')>();
  return { ...real, simulateFile: async (...args: Parameters<typeof real.simulateFile>) => {
    const out = await real.simulateFile(...args);
    injection.mainLanded = out.result.events.some(e => e.type === 'GROUND_HIT');
    injection.summary = out.result.summary;
    if (injection.enabled) out.run = { ...out.run, simWarnings: [{ key: 'INCOMPLETE_FLIGHT', priority: 'HIGH',
      message: injection.boosterOnly ? 'The booster stage\'s flight is incomplete; its landing rate is unavailable.'
        : 'The flight is incomplete; landing rate and landing drift are unavailable.' }] };
    return out;
  } };
});

it('preserves the completed main flight numbers when only a booster warning makes the run incomplete', async () => {
  injection.boosterOnly = true;
  const response = await worker.fetch(new Request('http://local/experimental/fly?filename=booster-warning.ork',
    { method: 'POST', body: bytesOf('reference.ork') }), {}, { waitUntil() {} });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(injection.mainLanded).toBe(true);
  expect(result).toMatchObject({ outcome: 'incomplete', partial: true, aborts: [],
    apogeeM: injection.summary.maxAltitude, maxVelocityMs: injection.summary.maxVelocity,
    maxMach: injection.summary.maxMachNumber, flightTimeS: injection.summary.flightTime });
  expect(result.warnings[0].message).toContain('booster');
});

it.each([
  ['reference.ork', 'completed', false],
  ['TubeFins2.rkt', 'completed', false],
  ['Show-off.CDX1', 'aborted', true],
] as const)('reports the independent expected outcome for %s', async (name, outcome, partial) => {
  injection.enabled = false;
  const response = await worker.fetch(new Request(`http://local/experimental/fly?filename=${name}`,
    { method: 'POST', body: bytesOf(name) }), {}, { waitUntil() {} });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ outcome, partial });
});

it('honors incomplete-flight warnings without inventing an abort event', async () => {
  const response = await worker.fetch(new Request('http://local/experimental/fly?filename=slow-descent.ork',
    { method: 'POST', body: bytesOf('reference.ork') }), {}, { waitUntil() {} });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as {
    warnings: { key: string }[]; aborts: unknown[]; outcome: string; partial: boolean;
  };
  expect(result.warnings.some(w => w.key === 'INCOMPLETE_FLIGHT'), JSON.stringify(result)).toBe(true);
  expect(result.aborts).toEqual([]);
  expect(result.outcome).toBe('incomplete');
  expect(result.partial).toBe(true);
});

it.skipIf(!existsSync(INCOMPLETE_FILE))('reports the real time-capped tester flight as incomplete at its last sample', async () => {
  injection.enabled = false;
  const response = await worker.fetch(new Request('http://local/experimental/fly?filename=slow-descent.rkt',
    { method: 'POST', body: new Uint8Array(readFileSync(INCOMPLETE_FILE)) }), {}, { waitUntil() {} });
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json() as {
    warnings: { key: string; message: string }[]; aborts: unknown[]; outcome: string; partial: boolean; flightTimeS: number;
  };
  expect(result.aborts).toEqual([]);
  expect(result.outcome).toBe('incomplete');
  expect(result.partial).toBe(true);
  const warning = result.warnings.find(w => w.key === 'INCOMPLETE_FLIGHT')!;
  const quotedTime = Number(/T\+(\d+\.\d+) s/.exec(warning.message)![1]);
  // The note rounds the same last sample to hundredths; no fixed kernel float.
  expect(Math.abs(quotedTime - result.flightTimeS)).toBeLessThanOrEqual(0.005);
}, 60_000);
