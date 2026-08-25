import { describe, expect, it } from 'vitest';
import type { FlightResult, FlightSeries, FlightSummary } from '@online-openrocket/engine';
import { IMPERIAL_UNITS } from '../prefs/units.js';
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

describe('unit-preference export', () => {
  it('converts headers and values to the selection; force and roll rate stay SI', () => {
    const s = fakeSeries();
    s['T'] = [288.15, 287, 286];
    const cols = seriesColumns(s, '', IMPERIAL_UNITS);
    const byHeader = new Map(cols.map((c) => [c.header, c]));
    const alt = byHeader.get('Altitude (ft)');
    expect(alt).toBeDefined();
    expect(alt!.values[1]).toBeCloseTo(1 / 0.3048, 10); // 1 m
    expect(alt!.values[2]).toBeCloseTo(3 / 0.3048, 10); // 3 m
    // K → °F goes through the offset, not a bare scale: 288.15 K = 59 °F.
    expect(byHeader.get('T — Air temperature (°F)')!.values[0]).toBeCloseTo(59, 6);
    // No FORCE preference group — desktop's imperial force default is N.
    expect(byHeader.get('Thrust (N)')!.values).toEqual(s.thrust);
    // Roll rate has no preference group either: stays rad/s, null passes through.
    expect(byHeader.get('dΦ — Roll rate (rad/s)')!.values).toEqual(s['dΦ']);
    // Angles convert rad → °.
    expect(byHeader.get('Angle of attack (°)')).toBeDefined();
  });

  it('keeps column order identical with and without a selection', () => {
    const strip = (h: string) => h.replace(/ \([^)]*\)$/, '');
    const si = seriesColumns(fakeSeries()).map((c) => strip(c.header));
    const imp = seriesColumns(fakeSeries(), '', IMPERIAL_UNITS).map((c) => strip(c.header));
    expect(imp).toEqual(si);
  });

  it('booster-prefixed headers carry the selected unit symbols', () => {
    const result: FlightResult = {
      summary,
      events: [],
      series: fakeSeries(),
      branches: [
        { name: 'Sustainer', events: [], series: fakeSeries() },
        { name: 'Booster', events: [], series: fakeSeries() },
      ],
    };
    const headers = flightDataCsv(result, IMPERIAL_UNITS).split('\n')[0]!.split(',');
    expect(headers).toContain('Booster — Altitude (ft)');
    expect(headers).toContain('Booster — Vz — Vertical velocity (ft/s)');
  });

  it('without a selection the output is the SI export, byte for byte', () => {
    const s: FlightSeries = {
      time: [0, 0.05], altitude: [0, 1], velocity: [0, 10], acceleration: [0, 100],
      mass: [0.05, 0.049], thrust: [0, 10], drag: [0, 0.1], mach: [0, 0.03],
      stability: [1.3, 1.3], cpLocation: [0.29, 0.29], cgLocation: [0.26, 0.26], aoa: [0, 0],
    };
    s['T'] = [288.15, 287.5];
    const csv = flightDataCsv({ summary, events: [], series: s });
    expect(csv).toBe(
      'Time (s),Altitude (m),Velocity (m/s),Acceleration (m/s²),Mass (kg),Thrust (N),'
      + 'Drag force (N),Mach number,Stability margin (cal),CP location (m),CG location (m),'
      + 'Angle of attack (rad),T — Air temperature (K)\n'
      + '0,0,0,0,0.05,0,0,0,1.3,0.29,0.26,0,288.15\n'
      + '0.05,1,10,100,0.049,10,0.1,0.03,1.3,0.29,0.26,0,287.5',
    );
  });
});
