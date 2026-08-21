import { describe, expect, it } from 'vitest';
import type { FlightResult, FlightSeries, FlightSummary } from '@online-openrocket/engine';
import { flightDataCsv, seriesColumns } from './flightDataCsv.js';

const summary: FlightSummary = {
  maxAltitude: 100, maxVelocity: 50, maxAcceleration: 100, maxMachNumber: 0.2,
  timeToApogee: 4, flightTime: 20, groundHitVelocity: 4, launchRodVelocity: 15,
  deploymentVelocity: 5, optimumDelay: 4,
};

/** 3-sample series: the friendly dozen + symbol extras + duplicate symbols. */
function fakeSeries(): FlightSeries {
  const s: FlightSeries = {
    time: [0, 0.05, 0.1],
    altitude: [0, 1, 3],
    velocity: [0, 10, 20],
    acceleration: [0, 100, 90],
    mass: [0.05, 0.049, 0.048],
    thrust: [0, 10, 9],
    drag: [0, 0.1, 0.2],
    mach: [0, 0.03, 0.06],
    stability: [1.3, 1.3, 1.4],
    cpLocation: [0.29, 0.29, 0.29],
    cgLocation: [0.26, 0.26, 0.26],
    aoa: [0, 0, 0],
  };
  // Wire duplicates of friendly arrays — must be SKIPPED.
  s['t'] = [0, 0.05, 0.1];
  s['h'] = [0, 1, 3];
  s['Vt'] = [0, 10, 20];
  // Real extras (one with a null = kernel NaN), plus an unknown future symbol.
  s['Vz'] = [0, 9.8, 19.5];
  s['dΦ'] = [0, null, 0.2];
  s['ρ'] = [1.225, 1.225, 1.224];
  s['zz'] = [1, 2, 3];
  return s;
}

describe('seriesColumns', () => {
  it('keeps the friendly dozen (time first) plus non-duplicate extras', () => {
    const cols = seriesColumns(fakeSeries());
    // 12 friendly + Vz, dΦ, ρ, zz — the t/h/Vt duplicates are dropped.
    expect(cols.length).toBe(16);
    expect(cols[0]!.header).toBe('Time (s)');
    const headers = cols.map((c) => c.header);
    expect(headers).toContain('Vz — Vertical velocity (m/s)');
    expect(headers).toContain('dΦ — Roll rate (rad/s)');
    expect(headers).toContain('ρ — Air density (kg/m³)');
    // Unknown symbol still exports, header = symbol alone.
    expect(headers).toContain('zz');
    expect(headers.filter((h) => h === 'Time (s)' || h === 't')).toEqual(['Time (s)']);
  });

  it('tolerates an old-engine series with no symbol keys at all', () => {
    const s = fakeSeries();
    for (const k of ['t', 'h', 'Vt', 'Vz', 'dΦ', 'ρ', 'zz']) delete s[k];
    expect(seriesColumns(s).length).toBe(12);
  });
});

describe('flightDataCsv', () => {
  it('header count matches every data row; null becomes an empty cell', () => {
    const csv = flightDataCsv({ summary, events: [], series: fakeSeries() });
    const lines = csv.split('\n');
    expect(lines.length).toBe(1 + 3); // header + 3 samples
    const headerCount = lines[0]!.split(',').length;
    expect(headerCount).toBe(16);
    for (const line of lines.slice(1)) {
      expect(line.split(',').length).toBe(headerCount);
    }
    // dΦ sample 1 is null (kernel NaN) → empty cell, not "null"/"NaN".
    expect(lines[2]!).not.toContain('null');
    expect(lines[2]!).not.toContain('NaN');
    const dPhiIdx = lines[0]!.split(',').findIndex((h) => h.startsWith('dΦ'));
    expect(lines[2]!.split(',')[dPhiIdx]).toBe('');
  });

  it('appends booster branches as name-prefixed column groups with their own time', () => {
    const boosterSeries = fakeSeries();
    boosterSeries.time = [0, 0.05, 0.1, 0.15]; // longer than the sustainer
    boosterSeries.altitude = [0, 1, 2, 1];
    const result: FlightResult = {
      summary,
      events: [],
      series: fakeSeries(),
      branches: [
        { name: 'Sustainer', events: [], series: fakeSeries() }, // branch 0 = top-level, skipped
        { name: 'Booster', events: [], series: boosterSeries },
      ],
    };
    const csv = flightDataCsv(result);
    const lines = csv.split('\n');
    const headers = lines[0]!.split(',');
    // Sustainer columns unprefixed, booster group prefixed, own time column.
    expect(headers[0]).toBe('Time (s)');
    expect(headers).toContain('Booster — Time (s)');
    expect(headers).toContain('Booster — Altitude (m)');
    expect(headers.filter((h) => h.startsWith('Booster — ')).length).toBe(16);
    // Rows run to the LONGEST branch; the shorter sustainer trails empty.
    expect(lines.length).toBe(1 + 4);
    const last = lines[4]!.split(',');
    expect(last[0]).toBe(''); // sustainer has no 4th sample
    expect(last[headers.indexOf('Booster — Time (s)')]).toBe('0.15');
  });
});
