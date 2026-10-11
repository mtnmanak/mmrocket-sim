// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { checkFormatLoss, checkFormatLossOf, checkFormatLossSafely, type FormatLossInput } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const input = (): FormatLossInput => ({
  tree: { name: 'Safety', components: [{ type: 'stage', name: 'Sustainer', children: [
    { type: 'nosecone', length: 0.1, aftRadius: 0.02 },
    { type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
  ] }] },
  motors: {}, launch: { ...DEFAULT_CONDITIONS }, configs: [], activeConfigId: null,
  measured: { massKg: null, cgM: null }, flightData: {},
});

describe('loss check safety and effective rod aim', () => {
  it.each(['rkt', 'cdx1'] as const)('%s does not warn about the aim of a vertical rod', format => {
    const data = input();
    data.launch = { ...data.launch, launchRodAngleDeg: 0, launchRodAimDeg: 90 };
    expect(checkFormatLoss(format, data).losses.join('\n')).not.toContain('Rod aim');
  });

  it.each(['rkt', 'cdx1'] as const)('%s reports an effective aim once', format => {
    const data = input();
    data.launch = { ...data.launch, launchRodAngleDeg: 5, launchRodAimDeg: 90 };
    const losses = checkFormatLoss(format, data).losses;
    expect(losses.filter(line => line.includes('Rod aim'))).toHaveLength(1);
    expect(losses.find(line => line.startsWith('Launch settings'))?.includes('Rod aim') ?? false).toBe(format === 'rkt');
    if (format === 'cdx1') expect(losses.join('\n')).toContain('RASAero has no rod direction');
  });

  it.each(['rkt', 'cdx1'] as const)('%s keeps normal reports, including writer refusals', format => {
    const data = input();
    expect(checkFormatLossSafely(format, data)).toEqual(checkFormatLoss(format, data));
    expect(checkFormatLossSafely(format, data).incomplete).toBeUndefined();
    expect(checkFormatLossOf(format, () => data)).toEqual(checkFormatLoss(format, data));
    data.tree.components = Array.from({ length: 4 }, () => ({ type: 'stage', children: [] }));
    expect(checkFormatLossSafely(format, data)).toEqual(checkFormatLoss(format, data));
    expect(checkFormatLossSafely(format, data).refused).toContain('at most 3 stages');
  });

  it.each(['rkt', 'cdx1'] as const)('%s turns detector exceptions into a choice to save', format => {
    const data = input();
    // Configurations are read after the writer dry run, outside its catch.
    Object.defineProperty(data, 'configs', { get: () => { throw new Error('broken detector'); } });
    expect(() => checkFormatLoss(format, data)).toThrow('broken detector');
    const report = checkFormatLossSafely(format, data);
    expect(report.format).toBe(format);
    expect(report.refused).toBeNull();
    // Not a count: the one line says the check stopped, so callers must not show “1 not kept”.
    expect(report.incomplete).toBe(true);
    expect(report.losses).toHaveLength(1);
    expect(report.losses[0]).toContain(format === 'rkt' ? '.rkt' : '.CDX1');
    expect(report.losses[0]).toContain('could not finish checking');
    expect(report.losses[0]).toContain('broken detector');
    expect(report.losses[0]).toContain('Save .ork keeps everything');
    expect(report.losses[0]).toContain('parts of the design this check could not list');
    expect(report.losses[0]).not.toContain('more than this list shows');
  });

  it.each(['rkt', 'cdx1'] as const)('%s reports an input that cannot be built as an unfinished check', format => {
    const report = checkFormatLossOf(format, () => { throw new Error('motor set failed'); });
    expect(report).toMatchObject({ format, refused: null, incomplete: true });
    expect(report.losses).toHaveLength(1);
    expect(report.losses[0]).toContain('could not finish checking');
    expect(report.losses[0]).toContain('motor set failed');
  });
});
