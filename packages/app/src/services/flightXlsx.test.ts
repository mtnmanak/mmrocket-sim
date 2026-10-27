import { describe, expect, it } from 'vitest';
import { LIGHT_PALETTE, lineStyle, slotOf, type ChartToken } from '../chartTheme.js';
import { strFromU8, unzipSync } from 'fflate';
import type { FlightResult, FlightSeries, FlightSummary } from '@online-openrocket/engine';
import { IMPERIAL_UNITS } from '../prefs/units.js';
import { flightXlsx } from './flightXlsx.js';
import type { FlightExportLayout } from './flightExportLayouts.js';

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

/**
 * A full-mode-shaped series: members of three different chart groups plus four
 * symbols no group claims, so the completeness rule has something to sweep up.
 */
function richSeries(): FlightSeries {
  const s = fakeSeries();
  s['Cd'] = [0.51, 0.5, 0.49];
  s['Cdf'] = [0.2, 0.2, 0.19];
  s['Cdp'] = [0.2, 0.19, 0.19];
  s['Cdb'] = [0.11, 0.11, 0.11];
  s['Il'] = [0.05, 0.05, 0.049];
  s['Ir'] = [2e-5, 2e-5, 1.9e-5];
  s['ρ'] = [1.225, 1.2249, 1.2248];
  s['R'] = [0, 120000, 240000];
  s['Twr'] = [0, 20.4, 18.7];
  s['dt'] = [0.01, 0.01, 0.02];
  return s;
}

function singleFlight(): FlightResult {
  return { summary, events: [], series: fakeSeries() };
}

it('N032 keeps altitude and horizontal position on separate unit-labelled Excel axes', () => {
  const result = singleFlight();
  result.series.ha = [304.8, 609.6, 914.4];
  result.series.Px = [0, 1000, 2000];
  result.series.Py = [0, 1000, 2000];
  result.series.Pl = [0, 1000, 2000];
  const before = structuredClone(result);
  const files = unzipSync(flightXlsx(result, { ...IMPERIAL_UNITS, altitude: 'ft', distance: 'km' }));
  const data = strFromU8(files['xl/worksheets/sheet1.xml']!);
  expect(data).toContain('Altitude (ft)');
  expect(data).toContain('Altitude above sea level (ft)');
  expect(data).toContain('Lateral distance (km)');
  const charts = Object.entries(files).filter(([p]) => p.startsWith('xl/charts/chart')).map(([, b]) => strFromU8(b));
  const position = charts.find(c => c.includes('Position East of launch'))!;
  expect(position).toContain('Distance (km)');
  expect(position).not.toContain('Altitude above sea level');
  expect(charts.some(c => c.includes('Altitude above sea level (ft)'))).toBe(true);
  expect(result).toEqual(before);
});

describe('N038 saved workbook layout', () => {
  const layout: FlightExportLayout = { id: 'chosen', name: 'Chosen', columns: [
    { key: 'altitude', unit: 'ft' }, { key: 'time', unit: 's' }, { key: 'velocity', unit: 'mph' },
  ], events: { from: 'BURNOUT' } };
  it('reorders numeric cells and charts against the selected, filtered time column', () => {
    const flight = { ...singleFlight(), events: [{ type: 'BURNOUT', time: 0.05 }] };
    const files = unzipSync(flightXlsx(flight, undefined, layout));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('Altitude (ft)');
    expect(sheet).not.toContain('Acceleration');
    expect(sheet).toContain(`<c r="A2" s="0"><v>${String(1 / 0.3048)}</v></c>`);
    expect(sheet).toContain('<c r="B2" s="0"><v>0.05</v></c>');
    expect(sheet).not.toContain('r="4"');
    const chart = strFromU8(files['xl/charts/chart1.xml']!);
    expect(chart).toContain("'Flight data'!$B$2:$B$3");
    expect(chart).toContain("'Flight data'!$A$2:$A$3");
  });
  it('exports without charts when time is omitted, and separates mixed-unit chart groups', () => {
    const flight = singleFlight();
    flight.series['Θ'] = [0, Math.PI, 0];
    flight.series['Φ'] = [0, Math.PI, 0];
    const files = unzipSync(flightXlsx(flight, undefined, { ...layout, events: {}, columns: [
      { key: 'time', unit: 's' }, { key: 'Θ', unit: '°' }, { key: 'Φ', unit: 'rad' },
    ] }));
    const charts = Object.entries(files).filter(([p]) => p.startsWith('xl/charts/chart')).map(([, b]) => strFromU8(b));
    expect(charts).toHaveLength(2);
    expect(charts.filter(c => c.includes('(rad)'))).toHaveLength(1);
    expect(charts.filter(c => c.includes('(°)'))).toHaveLength(1);
    const noTime = unzipSync(flightXlsx(flight, undefined, { ...layout, events: {}, columns: [{ key: 'altitude', unit: 'm' }] }));
    expect(Object.keys(noTime).some(p => p.startsWith('xl/charts/chart'))).toBe(false);
  });
});

function richFlight(): FlightResult {
  return { summary, events: [], series: richSeries() };
}

/** Three stages with the app's own default names — the tab-name worst case. */
function threeStageFlight(): FlightResult {
  const withGroups = (): FlightSeries => {
    const s = fakeSeries();
    s['Cn'] = [0.1, 0.2, 0.3];
    s['Cθ'] = [0.01, 0.02, 0.03];
    return s;
  };
  return {
    summary,
    events: [],
    series: withGroups(),
    branches: [
      { name: 'Sustainer', events: [], series: withGroups() },
      { name: 'Booster', events: [], series: withGroups() },
      { name: 'Booster 2', events: [], series: withGroups() },
    ],
  };
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

/** Sheet names as the workbook declares them, in tab order. */
function tabNames(files: Record<string, Uint8Array>): string[] {
  const wb = strFromU8(files['xl/workbook.xml']!);
  return [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
}

/** Every data-sheet column letter some chart plots on its y axis. */
function chartedColumns(files: Record<string, Uint8Array>): Set<string> {
  const out = new Set<string>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('xl/charts/chart')) continue;
    for (const m of strFromU8(bytes).matchAll(/<c:yVal><c:numRef><c:f>'[^']+'!\$([A-Z]+)\$/g)) {
      out.add(m[1]!);
    }
  }
  return out;
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

  it('one tab per headline quantity, in flight-panel order', () => {
    const files = unzipSync(flightXlsx(singleFlight(), IMPERIAL_UNITS));
    // The data sheet leads; the headline quantities follow in panel order.
    expect(tabNames(files).slice(0, 12)).toEqual([
      'Flight data',
      'Altitude', 'Velocity', 'Acceleration', 'Mass', 'Thrust', 'Drag force',
      'Mach number', 'Stability margin', 'CP location', 'CG location', 'Angle of attack',
    ]);
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
    const names = tabNames(unzipSync(flightXlsx(result)));
    expect(names).toContain('Altitude');
    expect(names).toContain('Velocity');
    expect(names).not.toContain('Acceleration');
  });

  it('every exported column reaches a chart — the completeness rule', () => {
    const files = unzipSync(flightXlsx(richFlight()));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    const header = sheet.slice(sheet.indexOf('<row r="1"'), sheet.indexOf('<row r="2"'));
    const columns = [...header.matchAll(/<c r="([A-Z]+)1"/g)].map((m) => m[1]!);
    expect(columns.length).toBe(23); // friendly 12 + Vz + the ten added here
    const charted = chartedColumns(files);
    for (const c of columns) {
      // A is Time — it is every chart's x axis, never a y series.
      if (c === 'A') continue;
      expect(charted, `column ${c} is exported but never charted`).toContain(c);
    }
  });

  it('collects a coefficient family onto one tab under a shared axis', () => {
    const files = unzipSync(flightXlsx(richFlight()));
    const names = tabNames(files);
    expect(names).toContain('Drag coefficients');
    expect(names).toContain('Moments of inertia');
    // Vz is the only member of its group this flight carries — still its tab.
    expect(names).toContain('Velocity components');
    const idx = names.indexOf('Drag coefficients');
    // One data sheet precedes the chart tabs, so chart N is tab index N.
    const drag = strFromU8(files[`xl/charts/chart${idx}.xml`]!);
    // Four members present (Cda is absent from this flight and is left out).
    expect(drag).toContain('<c:v>Drag coefficient</c:v>');
    expect(drag).toContain('<c:v>Friction drag coefficient</c:v>');
    expect(drag).toContain('<c:v>Pressure drag coefficient</c:v>');
    expect(drag).toContain('<c:v>Base drag coefficient</c:v>');
    expect(drag).not.toContain('Axial drag coefficient');
    // Dimensionless members ⇒ a bare axis label, and a legend for the family.
    expect(drag).toContain('<a:t>Coefficient</a:t>');
    expect(drag).toContain('<c:legend>');
  });

  it('unclaimed columns get their own tab, named for the quantity', () => {
    const names = tabNames(unzipSync(flightXlsx(richFlight())));
    // No group owns these four, so rule 3 gives each one a tab of its own —
    // and the symbol prefix and unit are stripped out of the tab name.
    expect(names).toContain('Air density');
    expect(names).toContain('Reynolds number');
    expect(names).toContain('Thrust-to-weight ratio');
    expect(names).toContain('Simulation time step');
  });

  // Until the fix pass the workbook coloured by CHART ORDER: Mass took the
  // pressure colour, CP altitude's, CG velocity's, angle of attack
  // acceleration's, and Vz / Az in their group tabs altitude's. Now each
  // column is the app catalog's look for its series: colour and pattern.
  it('colours each column by QUANTITY, with the app catalog’s line pattern', () => {
    const series = fakeSeries();
    series['Az'] = [0, 99, 89]; series['dynamicPressure'] = [0, 60, 240]; series['P'] = [101325, 101300, 101280];
    series['Cd'] = [0.5, 0.5, 0.49];
    const files = unzipSync(flightXlsx({ summary, events: [], series }));
    const looks = new Map<string, { color: string; dash: string }>();
    for (const [path, bytes] of Object.entries(files)) {
      if (!/^xl\/charts\/chart\d+\.xml$/.test(path)) continue;
      for (const ser of strFromU8(bytes).split('<c:ser>').slice(1)) {
        const name = /<c:tx><c:v>([^<]*)<\/c:v>/.exec(ser)![1]!;
        const color = /<a:srgbClr val="([0-9A-F]{6})"\/>/.exec(ser)![1]!;
        const dash = [...ser.matchAll(/<a:ds d="(\d+)" sp="(\d+)"\/>/g)]
          .flatMap((m) => [Number(m[1]) / 50000, Number(m[2]) / 50000]).join(',');
        looks.set(name, { color, dash });
      }
    }
    const want = (token: ChartToken, tier = 0) => ({
      color: LIGHT_PALETTE[slotOf(token)]!.slice(1).toUpperCase(), dash: (lineStyle(slotOf(token), tier) ?? []).join(','),
    });
    expect(looks.get('Altitude (m)')).toEqual(want('altitude'));
    expect(looks.get('Velocity (m/s)')).toEqual(want('velocity'));
    expect(looks.get('Vertical velocity')).toEqual(want('velocity', 1));
    expect(looks.get('Acceleration (m/s²)')).toEqual(want('acceleration'));
    expect(looks.get('Vertical acceleration')).toEqual(want('acceleration', 2));
    expect(looks.get('Thrust (N)')).toEqual(want('thrust'));
    expect(looks.get('Drag force (N)')).toEqual(want('drag'));
    expect(looks.get('Mach number')).toEqual(want('mach'));
    expect(looks.get('Stability margin (cal)')).toEqual(want('reference'));
    expect(looks.get('Stability margin (cal)')!.dash).toBe('6,4');
    expect(looks.get('Dynamic pressure (Pa)')).toEqual(want('pressure'));
    expect(looks.get('P — Air pressure (Pa)')).toEqual(want('pressure', 2));
    // The non-quantities take the catalog's next free pairs (tier 1), as on
    // screen; so the re-flown Az and P, allocated after them, are tier 2.
    expect(looks.get('Mass (kg)')).toEqual(want('altitude', 1));
    expect(looks.get('CP location (m)')).toEqual(want('acceleration', 1));
    expect(looks.get('CG location (m)')).toEqual(want('pressure', 1));
    // No two series of one workbook draw the same colour and pattern.
    const pairs = [...looks.values()].map((l) => `${l.color}|${l.dash}`);
    expect(new Set(pairs).size).toBe(pairs.length);
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
    // ≥2 series → legend present, stage colors follow the palette order —
    // DERIVED from chartTheme.LIGHT_PALETTE (v0.076): a literal here re-pins the
    // hand-copied palette drift the review caught.
    expect(alt).toContain('<c:legend>');
    expect(alt).toContain(`<a:srgbClr val="${LIGHT_PALETTE[0]!.slice(1).toUpperCase()}"/>`);
    expect(alt).toContain(`<a:srgbClr val="${LIGHT_PALETTE[1]!.slice(1).toUpperCase()}"/>`);
  });

  it('staged flights: grouped tabs split per branch, not members × stages', () => {
    const names = tabNames(unzipSync(flightXlsx(stagedFlight())));
    // Both branches carry Vz, so its group gets a tab each rather than one
    // tab holding every member of every stage.
    expect(names).toContain('Velocity components — Sustainer');
    expect(names).toContain('Velocity components — Booster');
    expect(names).not.toContain('Velocity components');
  });

  it('staged flights: a long group label gives way, the stage name never does', () => {
    // Excel caps a sheet name at 31 characters and xlsx.ts slices the TAIL,
    // so an untrimmed "Force & moment coeffs — Sustainer" (33) lost the stage
    // — and on a three-stage rocket two of them truncated onto the same name
    // and came back from the de-duplicator as "…— Boos_20", naming no stage
    // at all. Every grouped tab must end in its branch name, whole.
    const names = tabNames(unzipSync(flightXlsx(threeStageFlight())))
      .filter((n) => n.includes(' — '));
    expect(names.length).toBe(3 * 2); // two groups this flight can fill × 3 branches
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(['Sustainer', 'Booster', 'Booster 2'].some((b) => n.endsWith(` — ${b}`)),
        `"${n}" does not end in a whole stage name`).toBe(true);
    }
    expect(new Set(names).size).toBe(names.length); // no two truncated together
    expect(names).toContain('Force & moment coef — Booster 2');
  });
});
