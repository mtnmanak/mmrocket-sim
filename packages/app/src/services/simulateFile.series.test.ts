// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { commentsOf, jsXmlParser, setXmlParser, simulateFile } from '../headless/index.js';

// No module mocks: exercise the public barrel, both import layers and the kernel.
const data = new Uint8Array(readFileSync(new URL('./__fixtures__/reference.ork', import.meta.url)));
beforeAll(() => { setXmlParser(jsXmlParser); });
afterAll(() => { setXmlParser(null); });

describe('simulateFile reported series at the real kernel', () => {
  it('keeps full by default and omits Vs for summary without an airspeed limit', async () => {
    const full = await simulateFile(data, 'reference.ork');
    const summary = await simulateFile(data, 'reference.ork', { reportSeries: 'summary' });
    expect(full.result.series['Vs']?.length).toBeGreaterThan(0);
    expect(summary.result.series['Vs']).toBeUndefined();
  }, 60_000);

  it('overrides summary for an active airspeed limit and evaluates the caution', async () => {
    const out = await simulateFile(data, 'reference.ork', {
      reportSeries: 'summary', advisoryLimits: { maxAirspeedMs: 1 },
    });
    expect.soft(out.result.series['Vs']?.length).toBeGreaterThan(0);
    expect.soft(out.run.maxAirspeedMs).toBeGreaterThan(1);
    expect.soft(commentsOf(out.run)).toContainEqual({
      text: expect.stringMatching(/recorded airspeed .* exceeded your maximum of 1\.0 m\/s/),
      level: 'caution',
    });
    expect.soft(out.run.comments).not.toContain('airspeed telemetry is incomplete');
  }, 60_000);

  it.each([0, -1, NaN, Infinity])('keeps summary for the inactive airspeed limit %s', async (limit) => {
    const out = await simulateFile(data, 'reference.ork', {
      reportSeries: 'summary', advisoryLimits: { maxAirspeedMs: limit },
    });
    expect(out.result.series['Vs']).toBeUndefined();
  }, 60_000);
});
