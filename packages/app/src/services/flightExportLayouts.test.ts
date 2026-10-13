import { describe, expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { UNITS } from '../prefs/units.js';
import { flightDataCsv, exportColumnCatalog } from './flightDataCsv.js';
import { normalizeExportLayouts, type FlightExportLayout } from './flightExportLayouts.js';

const result = {
  summary: {}, events: [{ type: 'BURNOUT', time: 1 }, { type: 'APOGEE', time: 2 }],
  series: { time: [0, 1, 2, 3], altitude: [0, 10, 20, 0], velocity: [0, 5, null, 2], T: [273.15, 288.15, 300, 280] },
} as unknown as FlightResult;
const layout: FlightExportLayout = {
  id: 'ascent', name: 'Ascent', columns: [{ key: 'velocity', unit: 'mph' }, { key: 'time', unit: 's' }, { key: 'altitude', unit: 'ft' }],
  events: { from: 'BURNOUT', to: 'APOGEE' },
};

describe('saved flight export layouts (N038)', () => {
  it('orders selected columns, converts units, includes both event boundaries and keeps null blank', () => {
    const original = structuredClone(result);
    const lines = flightDataCsv(result, undefined, layout).split('\n');
    expect(lines[0]).toBe('Velocity (mph),Time (s),Altitude (ft)');
    expect(lines).toHaveLength(3);
    expect(Number(lines[1]!.split(',')[0])).toBeCloseTo(5 / 0.44704, 10);
    expect(lines[2]!.split(',')).toEqual(['', '2', String(20 / 0.3048)]);
    expect(result).toEqual(original);
  });

  it('filters each branch using its own events and preserves requested missing columns', () => {
    const staged = { ...result, branches: [
      { name: 'Sustainer', series: result.series, events: result.events },
      { name: 'Booster', series: { ...result.series, time: [0, 1, 2, 3], velocity: undefined },
        events: [{ type: 'BURNOUT', time: 2 }, { type: 'APOGEE', time: 3 }] },
    ] } as unknown as FlightResult;
    const lines = flightDataCsv(staged, undefined, layout).split('\n');
    expect(lines[0]).toContain('Booster — Velocity (mph),Booster — Time (s),Booster — Altitude (ft)');
    expect(lines[1]!.split(',')[4]).toBe('2');
    expect(lines[2]!.split(',')[4]).toBe('3');
    expect(lines[1]!.split(',')[3]).toBe('');
    expect(flightDataCsv({ ...result, events: [] }, undefined, layout).split('\n')).toHaveLength(1);
  });

  it('uses the first start event and the first end event at or after it', () => {
    const flight = { ...result, events: [{ type: 'APOGEE', time: 0 }, { type: 'BURNOUT', time: 1 },
      { type: 'BURNOUT', time: 2 }, { type: 'APOGEE', time: 2 }, { type: 'APOGEE', time: 3 }] };
    expect(flightDataCsv(flight, undefined, layout).split('\n')).toHaveLength(3);
  });

  // Every unit offered by the editor must have a numeric/header oracle. These
  // are unit arithmetic, not kernel float baselines (10 digits allows rounding).
  const siByQuantity = { distance: 10, velocity: 5, acceleration: 9.80665, mass: 1, length: 1,
    angle: Math.PI, pressure: 101325, windspeed: 5, temperature: 288.15, density: 1.225 };
  for (const column of exportColumnCatalog()) {
    if (!column.quantity) continue;
    const q = column.quantity;
    for (const unit of UNITS[q]) {
      it(`converts ${column.key} to ${unit.symbol} with its unit in the header`, () => {
        const si = siByQuantity[q as keyof typeof siByQuantity];
        const flight = { ...result, series: { ...result.series, [column.key]: [si] } } as FlightResult;
        const csv = flightDataCsv(flight, undefined, { id: 'unit', name: 'Unit', columns: [{ key: column.key, unit: unit.symbol }], events: {} }).split('\n');
        expect(csv[0]).toContain(`(${unit.symbol}${column.suffix ?? ''})`);
        expect(Number(csv[1])).toBeCloseTo(si / unit.toSI - (unit.offset ?? 0), 10);
      });
    }
  }

  it('rejects malformed layouts and misleading units, without sacrificing valid layouts', () => {
    expect(normalizeExportLayouts([null, {}, { ...layout, columns: [] }, { ...layout, columns: [{ key: 'altitude', unit: 'mph' }] },
      { ...layout, columns: [{ key: 'unknown', unit: 'ft' }] }, { ...layout, events: { from: 12 } }, layout, layout]))
      .toEqual([layout]);
    expect(normalizeExportLayouts('bad')).toEqual([]);
  });
});
