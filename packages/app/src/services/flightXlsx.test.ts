import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { FlightResult, FlightSeries, FlightSummary } from '@online-openrocket/engine';
import { IMPERIAL_UNITS } from '../prefs/units.js';
import { flightXlsx } from './flightXlsx.js';

const summary: FlightSummary = {
  maxAltitude: 100, maxVelocity: 50, maxAcceleration: 100, maxMachNumber: 0.2,
  timeToApogee: 4, flightTime: 20, groundHitVelocity: 4, launchRodVelocity: 15,
  deploymentVelocity: 5, optimumDelay: 4,
};

/** Friendly dozen + one symbol extra; stability carries a NaN-as-null sample. */
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
    stability: [null as unknown as number, 1.3, 1.4],
    cpLocation: [0.29, 0.29, 0.29],
    cgLocation: [0.26, 0.26, 0.26],
    aoa: [0, 0, 0],
  };
  s['Vz'] = [0, 9.8, 19.5];
  return s;
}

function singleFlight(): FlightResult {
  return { summary, events: [], series: fakeSeries() };
}

function stagedFlight(): FlightResult {
  const boosterSeries = fakeSeries();
  boosterSeries.time = [0, 0.05, 0.1, 0.15]; // longer than the sustainer
  boosterSeries.altitude = [0, 1, 2, 1];
  return {
    summary,
    events: [],
    series: fakeSeries(),
    branches: [
      { name: 'Sustainer', events: [], series: fakeSeries() },
      { name: 'Booster', events: [], series: boosterSeries },
    ],
  };
}

describe('flightXlsx', () => {
  it('one data sheet with unit-labelled headers and typed numeric cells', () => {
    const files = unzipSync(flightXlsx(singleFlight(), IMPERIAL_UNITS));
    const wb = strFromU8(files['xl/workbook.xml']!);
    expect(wb).toContain('name="Flight data"');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    // Headers reuse flightDataCsv's specs: friendly name + preference unit.
    expect(sheet).toContain('Altitude (ft)');
    expect(sheet).toContain('Velocity (ft/s)');
    expect(sheet).toContain('Mass (oz)');
    expect(sheet).toContain('Vz — Vertical velocity (ft/s)');
    // Values are NUMBER cells, converted: 1 m = 3.280839895013123 ft in B3.
    expect(sheet).toContain(`<c r="B3" s="0"><v>${String(1 / 0.3048)}</v></c>`);
    // No inline strings outside the header row (all data cells typed numeric).
    const body = sheet.slice(sheet.indexOf('<row r="2"'));
    expect(body).not.toContain('inlineStr');
  });

  it('NaN samples become empty cells (chart gaps), not zeros', () => {
    const files = unzipSync(flightXlsx(singleFlight()));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    // stability (column I, SI export) sample 1 is null → no I2 cell at all.
    expect(sheet).not.toContain('<c r="I2"');
    expect(sheet).toContain('<c r="I3" s="0"><v>1.3</v></c>');
  });

  it('charts altitude, velocity and acceleration against the time column', () => {
    const files = unzipSync(flightXlsx(singleFlight(), IMPERIAL_UNITS));
    const wb = strFromU8(files['xl/workbook.xml']!);
    expect(wb).toContain('name="Altitude"');
    expect(wb).toContain('name="Velocity"');
    expect(wb).toContain('name="Acceleration"');
    expect(Object.keys(files)).toContain('xl/charts/chart3.xml');
    expect(Object.keys(files)).not.toContain('xl/charts/chart4.xml');
    const alt = strFromU8(files['xl/charts/chart1.xml']!);
    // x = time column A, y = altitude column B, rows 2..4, on the data sheet.
    expect(alt).toContain("<c:xVal><c:numRef><c:f>'Flight data'!$A$2:$A$4</c:f></c:numRef></c:xVal>");
    expect(alt).toContain("<c:yVal><c:numRef><c:f>'Flight data'!$B$2:$B$4</c:f></c:numRef></c:yVal>");
    // Axis titles carry the preference units.
    expect(alt).toContain('<a:t>Time (s)</a:t>');
    expect(alt).toContain('<a:t>Altitude (ft)</a:t>');
    const vel = strFromU8(files['xl/charts/chart2.xml']!);
    expect(vel).toContain("<c:yVal><c:numRef><c:f>'Flight data'!$C$2:$C$4</c:f></c:numRef></c:yVal>");
    expect(vel).toContain('<a:t>Velocity (ft/s)</a:t>');
    const acc = strFromU8(files['xl/charts/chart3.xml']!);
    expect(acc).toContain("<c:yVal><c:numRef><c:f>'Flight data'!$D$2:$D$4</c:f></c:numRef></c:yVal>");
  });

  it('skips a chart whose series is absent from the flight', () => {
    const result = singleFlight();
    (result.series as Record<string, unknown>)['acceleration'] = [];
    const files = unzipSync(flightXlsx(result));
    const wb = strFromU8(files['xl/workbook.xml']!);
    expect(wb).toContain('name="Altitude"');
    expect(wb).not.toContain('name="Acceleration"');
    expect(Object.keys(files)).toContain('xl/charts/chart2.xml');
    expect(Object.keys(files)).not.toContain('xl/charts/chart3.xml');
  });

  it('staged flights: one data sheet per branch, one chart series per stage', () => {
    const files = unzipSync(flightXlsx(stagedFlight()));
    const wb = strFromU8(files['xl/workbook.xml']!);
    // Branch 0 (the sustainer stack) IS the top-level series — its own sheet.
    expect(wb).toContain('name="Sustainer"');
    expect(wb).toContain('name="Booster"');
    expect(wb).not.toContain('name="Flight data"');
    // Booster keeps its own longer time base on its own sheet (4 data rows).
    const booster = strFromU8(files['xl/worksheets/sheet2.xml']!);
    expect(booster).toContain('<c r="A5" s="0"><v>0.15</v></c>');
    // The altitude chart holds one series per stage, each on its own sheet.
    const alt = strFromU8(files['xl/charts/chart1.xml']!);
    expect(alt).toContain("<c:f>'Sustainer'!$B$2:$B$4</c:f>");
    expect(alt).toContain("<c:f>'Booster'!$B$2:$B$5</c:f>");
    expect(alt).toContain('<c:v>Sustainer</c:v>');
    expect(alt).toContain('<c:v>Booster</c:v>');
    // ≥2 series → legend present, stage colors follow the palette order.
    expect(alt).toContain('<c:legend>');
    expect(alt).toContain('<a:srgbClr val="2A78D6"/>');
    expect(alt).toContain('<a:srgbClr val="1BAF7A"/>');
  });
});
