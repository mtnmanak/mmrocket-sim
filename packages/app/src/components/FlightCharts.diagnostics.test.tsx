// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import type uPlot from 'uplot';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { FlightCharts } from './FlightCharts.js';

const recorded = vi.hoisted(() => [] as { options: uPlot.Options; data: uPlot.AlignedData }[]);
vi.mock('uplot', () => ({ default: class {
  scales = { x: { min: 0, max: 3 } };
  series: uPlot.Series[];
  constructor(options: uPlot.Options, data: uPlot.AlignedData, el: HTMLElement) {
    this.series = options.series; recorded.push({ options, data });
    el.appendChild(document.createElement('canvas'));
  }
  setScale() {} setSize() {} destroy() {} redraw() {}
} }));
vi.mock('./GuideDialog.js', () => ({ GuideDialog: ({ initialAnchor, onClose }: { initialAnchor: string; onClose: () => void }) =>
  <div data-guide-anchor={initialAnchor}><button onClick={onClose}>Close test guide</button></div> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  localStorage.clear();
  recorded.length = 0;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
const result = (): FlightResult => ({ events: [{ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 3 }],
  series: { time: [0, 1, 2, 3], altitude: [0, 1, 2, 1], velocity: [0, 1, 1, 1], acceleration: [0, 1, 0, 0],
    stability: [null, 1, 1, -1], cpLocation: [null, 1, 1, 0], cgLocation: [0.8, 0.8, 0.8, 0.8],
    aoa: [0, 0.1, 0.2, null], Cn: [null, 0.1, 0.2, 99],
    'ωn': [0, 2, 3, null], 'dΦ': [0, -1, 4.5, 9], 'CNα': [99, 3, 2, 99], Ccm: [0, 0.4, -0.1, 99],
    'dθ': [0, 0.2, 0.1, null], 'Cθ': [null, 0.1, 0.1, null], 'Cζθ': [null, 0.01, 0.02, null] },
} as unknown as FlightResult);
const mount = (flight = result()) => act(() => root.render(<PrefsProvider><FlightCharts result={flight} flightName="Starter" /></PrefsProvider>));
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.flight-series-picker button')].find(b => b.textContent === name)!;
const note = () => [...host.querySelectorAll('.chart-comparison-note')].find(el => el.textContent?.includes('These are diagnostics;'));
const panelTitles = () => [...host.querySelectorAll('.charts-grid > .chart-panel h3')].map(h =>
  [...h.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').split(' — ')[0]!.trim());
const change = (select: HTMLSelectElement, value: string) => act(() => {
  select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
});

it('selects ten panels in one click and restores the previous session selection and comparison', () => {
  mount();
  expect(note()).toBeUndefined();
  const select = host.querySelector<HTMLSelectElement>('.comparison-controls select')!;
  act(() => { select.value = 'altitude-velocity'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  button('Stability diagnostics').focus();
  expect(document.activeElement).toBe(button('Stability diagnostics'));
  act(() => button('Stability diagnostics').click());
  expect(panelTitles()).toEqual(['Stability margin (cal)', 'Pitch natural frequency (rad/s)',
    'Roll rate ÷ pitch natural frequency',
    'Corrective moment coefficient (N·m/rad)', 'Angle of attack', 'Pitch rate (rad/s)', 'Normal force coefficient',
    'Normal force slope (CNα) (/rad)', 'Pitch moment coefficient (about CG)', 'Pitch damping coefficient']);
  expect(select.value).toBe('');
  expect(note()).toBeTruthy();
  expect(localStorage.getItem('online-openrocket.prefs.v1')).toBeNull();
  act(() => button('Restore previous plots').click());
  expect(host.querySelectorAll('.charts-grid > .chart-panel')).toHaveLength(3);
  expect(select.value).toBe('altitude-velocity');
  expect(note()).toBeUndefined();
});

it('hands gated diagnostic arrays to the actual panel plot', () => {
  const flight = result();
  mount(flight);
  act(() => button('Stability diagnostics').click());
  for (const [title, values] of [
    ['Normal force slope (CNα) (/rad)', [null, 3, 2, null]],
    ['Pitch natural frequency (rad/s)', [null, 2, 3, null]],
    ['Roll rate ÷ pitch natural frequency', [null, 0.5, 1.5, null]],
    ['Corrective moment coefficient (N·m/rad)', [null, 0.4, -0.1, null]],
    ['Normal force coefficient', [null, 0.1, 0.2, null]],
    ['Pitch rate (rad/s)', [null, 0.2, 0.1, null]],
    ['Stability margin (cal)', [null, 1, 1, null]],
  ] as const) {
    const plot = recorded.find(p => p.options.series[1]?.label === title)!;
    expect(plot.data[1]).toEqual(values);
  }
  expect(flight.series['ωn']).toEqual([0, 2, 3, null]);
});

it('gates stability and CP in panels, the stability preset and custom axes while retaining CG', () => {
  mount();
  act(() => { button('Stability margin').click(); button('CP location').click(); });
  const select = host.querySelector<HTMLSelectElement>('.comparison-controls select')!;
  for (const mode of ['', 'stability', 'custom']) {
    change(select, mode);
    if (mode === 'custom') {
      change(host.querySelector('[aria-label="Custom X axis"]')!, 'cpLocation');
      change(host.querySelector('[aria-label="Custom Y axis"]')!, 'stability');
    }
    const stability = [...recorded].reverse().find(p => p.options.series[1]?.label === 'Stability margin (cal)')!;
    const cp = [...recorded].reverse().find(p => p.options.series[1]?.label === 'CP location (mm)')!;
    expect(stability.data[1]).toEqual([null, 1, 1, null]);
    expect(cp.data[1]).toEqual([null, 1000, 1000, null]);
  }
  const comparison = recorded.filter(p => p.options.series.length === 4).at(-1)!;
  expect(comparison.data.slice(1)).toEqual([[null, 1, 1, null], [null, 1000, 1000, null], [800, 800, 800, 800]]);
  const custom = recorded.at(-1)!;
  expect(custom.options.series[0]?.label).toBe('CP location (mm)');
  expect(custom.data).toEqual([[1000, 1000], [1, 1]]);
});

it('uses the separated booster events to blank finite diagnostics, stability and CP', () => {
  const flight = result();
  const booster = structuredClone(flight.series);
  for (const key of ['ωn', 'CNα', 'Ccm', 'Cn', 'Cθ', 'Cζθ', 'dθ', 'stability', 'cpLocation']) booster[key] = [null, 1, 99, 99];
  flight.branches = [{ name: 'Sustainer', series: flight.series, events: flight.events },
    { name: 'Separated', series: booster, events: [{ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 2 }] }];
  mount(flight);
  const branch = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Flight branch'))!.querySelector('select')!;
  change(branch, '1');
  recorded.length = 0;
  act(() => button('Stability diagnostics').click());
  for (const title of ['Pitch natural frequency (rad/s)', 'Pitch rate (rad/s)',
    'Normal force slope (CNα) (/rad)', 'Corrective moment coefficient (N·m/rad)',
    'Normal force coefficient', 'Pitch moment coefficient (about CG)', 'Pitch damping coefficient', 'Stability margin (cal)']) {
    const plot = recorded.find(p => p.options.series[1]?.label === title)!;
    expect(plot.data[1]).toEqual([null, 1, null, null]);
  }
  act(() => button('CP location').click());
  expect(recorded.at(-1)!.options.series[1]?.label).toBe('CP location (mm)');
  expect(recorded.at(-1)!.data[1]).toEqual([null, 1000, null, null]);
  expect(booster['ωn']).toEqual([null, 1, 99, 99]);
});

it.each(['saved', 'panels', 'comparison', 'custom axes'])('restores the selection immediately before the last set click after %s changes', path => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ flightPlots: [
    { id: 'saved', name: 'Saved coast', panels: ['altitude'], comparison: 'altitude-velocity' },
  ] }));
  mount();
  act(() => button('Stability diagnostics').click());
  const select = host.querySelector<HTMLSelectElement>('.comparison-controls select')!;
  if (path === 'saved') {
    change(host.querySelector('.saved-flight-plots select')!, 'saved');
    act(() => [...host.querySelectorAll<HTMLButtonElement>('.saved-flight-plots button')].find(b => b.textContent === 'Apply')!.click());
  } else if (path === 'panels') act(() => button('Altitude').click());
  else {
    change(select, path === 'comparison' ? 'altitude-velocity' : 'custom');
    if (path === 'custom axes') change(host.querySelector('[aria-label="Custom X axis"]')!, 'velocity');
  }
  expect(button('Restore previous plots')).toBeUndefined();
  const expected = panelTitles(), expectedComparison = select.value;
  act(() => button('Stability diagnostics').click());
  act(() => button('Stability diagnostics').click());
  act(() => button('Restore previous plots').click());
  expect(panelTitles()).toEqual(expected);
  expect(select.value).toBe(expectedComparison);
  if (path === 'custom axes') expect(host.querySelector<HTMLSelectElement>('[aria-label="Custom X axis"]')!.value).toBe('velocity');
});

it('returns keyboard focus to the diagnostics button when Restore unmounts', () => {
  mount();
  act(() => button('Stability diagnostics').click());
  const restore = button('Restore previous plots');
  restore.focus();
  expect(document.activeElement).toBe(restore);
  // Native buttons dispatch a detail-zero click for Enter/Space activation.
  act(() => { restore.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
  expect(document.activeElement).toBe(button('Stability diagnostics'));
});

it('applies stored slope and moment panels with their explanations', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ flightPlots: [
    { id: 'new-diagnostics', name: 'Slope and moment', panels: ['CNα', 'Ccm'], comparison: '' },
  ] }));
  mount();
  change(host.querySelector('.saved-flight-plots select')!, 'new-diagnostics');
  act(() => [...host.querySelectorAll<HTMLButtonElement>('.saved-flight-plots button')].find(b => b.textContent === 'Apply')!.click());
  expect(panelTitles()).toEqual(['Corrective moment coefficient (N·m/rad)', 'Normal force slope (CNα) (/rad)']);
  expect(note()).toBeTruthy();
});

it('keeps keyboard focus in the series group when Restore is used on a branch with no diagnostics', () => {
  // Closure review r2: the set's button is not rendered there, so focus needs a fallback.
  const flight = result();
  const booster = structuredClone(flight.series);
  for (const key of ['ωn', 'CNα', 'Ccm', 'Cn', 'Cθ', 'Cζθ', 'dθ']) booster[key] = [null, null, null, null];
  flight.branches = [{ name: 'Sustainer', series: flight.series, events: flight.events },
    { name: 'Separated', series: booster, events: flight.events }];
  mount(flight);
  act(() => button('Stability diagnostics').click());
  change([...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Flight branch'))!.querySelector('select')!, '1');
  expect(button('Stability diagnostics')).toBeUndefined();
  const restore = button('Restore previous plots');
  restore.focus();
  act(() => { restore.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
  expect(document.activeElement).toBe(host.querySelector('.flight-series-picker .series-chip'));
});

it('opens each diagnostic definition at its own distinct glossary anchor', async () => {
  mount();
  act(() => button('Stability diagnostics').click());
  const anchors = [
    ['Pitch natural frequency (ωn)', 'pitch-natural-frequency-n'], ['Pitch rate', 'pitch-rate'],
    ['Normal-force coefficient', 'normal-force-coefficient-cn-cn'], ['Pitch moment coefficient', 'pitch-moment-coefficient'],
    ['Pitch damping coefficient', 'pitch-damping-coefficient'],
    ['CNα (normal-force slope)', 'cn-normal-force-slope'],
    ['Corrective moment coefficient (Ccm)', 'corrective-moment-coefficient-ccm'],
    ['Roll–pitch resonance', 'roll-pitch-resonance'],
  ];
  for (const [label, anchor] of anchors) {
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="Definition: ${label}"]`)!.click());
    await vi.waitFor(() => expect(document.querySelector('[data-guide-anchor]')?.getAttribute('data-guide-anchor')).toBe(`glossary-${anchor}`));
    act(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Close test guide')!.click());
  }
});

it.each(['Pitch natural frequency', 'Roll rate ÷ pitch natural frequency', 'Pitch rate', 'Normal force coefficient', 'Pitch moment coefficient (about CG)', 'Pitch damping coefficient',
  'Normal force slope (CNα)', 'Corrective moment coefficient'])(
  'explains %s before the charts whenever it is selected', title => {
    mount();
    act(() => button(title).click());
    const explanation = note()!;
    expect(explanation).toBeTruthy();
    expect(explanation.textContent).toContain('no pass/fail on dynamic stability');
    expect(explanation.textContent).toContain('same model that flew it');
    expect(explanation.textContent).toContain('CP is ahead of CG');
    expect(explanation.textContent).toContain('random disturbance');
    expect(explanation.textContent).toContain('multiplied by three');
    expect(explanation.textContent).toContain('it is not a damping ratio');
    expect(explanation.textContent).not.toContain('newer desktop OR');
    expect(explanation.textContent).toContain('aerodynamic pitch moment about the nose tip');
    expect(explanation.textContent).toContain("desktop OR 24.12's model");
    expect(explanation.textContent).not.toContain('OpenRocket');
    expect(explanation.textContent).toContain('seven diagnostic figures');
    expect(explanation.textContent).toContain('dynamic pressure × reference area × CNα × (CP − CG distance)');
    expect(explanation.textContent).toContain('signed corrective stiffness');
    expect(explanation.textContent).toContain('the restoring moment per radian of angle of attack at small angles');
    expect(explanation.textContent).toContain('At large angles of attack it is a stiffness estimate, not the moment the rocket actually feels');
    expect(explanation.textContent).toContain("each instant's Mach, angle of attack and roll orientation");
    expect(explanation.textContent).toContain('zero-angle value against Mach in its roll plane');
    expect(explanation.textContent).not.toContain('the same quantity for the design without a flight');
    expect(explanation.textContent).toContain('ωn² equals Ccm divided by the pitch moment of inertia');
    expect(explanation.querySelectorAll('button[aria-label^="Definition:"]')).toHaveLength(8);
    expect(explanation.compareDocumentPosition(host.querySelector('.charts-grid')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

it('explains a diagnostic used as a custom X axis with no diagnostic panels selected', () => {
  mount();
  const select = host.querySelector<HTMLSelectElement>('.comparison-controls select')!;
  act(() => { select.value = 'custom'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const x = host.querySelector<HTMLSelectElement>('[aria-label="Custom X axis"]')!;
  act(() => { x.value = 'Ccm'; x.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(note()).toBeTruthy();
});

it('offers no empty diagnostic chips or set for a summary-only recording', () => {
  const summary = result();
  for (const key of ['ωn', 'CNα', 'Ccm', 'Cn', 'Cθ', 'Cζθ', 'dθ']) delete summary.series[key];
  mount(summary);
  expect(button('Stability diagnostics')).toBeUndefined();
  expect(button('Pitch natural frequency')).toBeUndefined();
  expect(button('Roll rate ÷ pitch natural frequency')).toBeUndefined();
  expect(note()).toBeUndefined();
});

it('shows the ratio alone with its band, accessible description and interpolated figures', () => {
  const flight = result();
  flight.events.push({ type: 'APOGEE', time: 2 });
  mount(flight);
  act(() => button('Roll rate ÷ pitch natural frequency').click());
  const text = note()!.textContent!;
  expect(text).toContain('crossed ωn 1 time (at 1.50 s) and spent 0.30 s within ±15 %');
  expect(text).toContain('Before apogee on this flight');
  expect(text).toContain('no pass/fail');
  expect(text).toContain('individual fins\' build misalignment');
  expect(text).toContain('0.85 to 1.15');
  const plot = recorded.find(p => p.options.series[1]?.label === 'Roll rate ÷ pitch natural frequency')!;
  expect(plot.options.scales?.['y']?.range).toBeTypeOf('function');
  act(() => button('Pitch damping coefficient').click());
  const damping = recorded.find(p => p.options.series[1]?.label === 'Pitch damping coefficient')!;
  expect(damping.options.scales?.['y']?.range).toBeUndefined();
  expect(plot.options.plugins?.some(p => p.hooks?.drawAxes)).toBe(true);
  expect(recorded.filter(p => p.options.series[1]?.label === 'Altitude (m)').every(p => !p.options.plugins?.some(p => p.hooks?.drawAxes))).toBe(true);
  const canvas = [...host.querySelectorAll('canvas')].find(c => c.getAttribute('aria-label')?.includes('Roll rate ÷'))!;
  expect(canvas.getAttribute('aria-label')).toContain('Shaded band: 0.85 to 1.15; reference line: 1');
  expect(canvas.getAttribute('aria-label')).toContain('not in flight-data downloads');
});

it('shares the ratio style across its chip, panel and custom plot without colliding with Time', () => {
  mount();
  const title = 'Roll rate ÷ pitch natural frequency';
  act(() => button(title).click());
  const look = (series: uPlot.Series) => ({ color: series.stroke, dash: series.dash ?? [] });
  const panel = recorded.find(p => p.options.series[1]?.label === title)!.options.series[1]!;
  const chip = button(title).querySelector('line')!;
  expect(chip.getAttribute('stroke')).toBe(panel.stroke);
  expect(chip.getAttribute('stroke-dasharray') ?? '').toBe((panel.dash ?? []).join(' '));
  change(host.querySelector('.comparison-controls select')!, 'custom');
  change(host.querySelector('[aria-label="Custom Y axis"]')!, 'time');
  const time = [...recorded].reverse().find(p => p.options.series[1]?.label === 'Time (s)')!.options.series[1]!;
  expect(look(time)).not.toEqual(look(panel));
  recorded.length = 0;
  change(host.querySelector('[aria-label="Custom Y axis"]')!, 'rollPitchRatio');
  const custom = recorded.find(p => p.options.series[1]?.label === title)!.options.series[1]!;
  expect(look(custom)).toEqual(look(panel));
});

it('states the no-apogee fallback, never-near figures and unavailable pre-apogee data', () => {
  const flight = result(); flight.series['dΦ'] = [0, 0, 0, 0];
  mount(flight);
  act(() => button('Roll rate ÷ pitch natural frequency').click());
  expect(note()!.textContent).toContain('last recorded ratio sample (no apogee was recorded)');
  expect(note()!.textContent).toContain('never crossed ωn and spent no time within ±15 %');
  const noAscent = { ...flight, events: [{ type: 'APOGEE', time: 0.5 }] };
  mount(noAscent);
  expect(note()!.textContent).toContain('no ratio samples are available in this window');
});

it('lists at most five crossing times and counts the remainder', () => {
  const flight = result();
  flight.events = [{ type: 'APOGEE', time: 7 }];
  flight.series = { time: Array.from({ length: 8 }, (_, i) => i), Cn: Array(8).fill(1),
    'ωn': Array(8).fill(1), 'dΦ': [0, 2, 0, 2, 0, 2, 0, 2] } as unknown as FlightResult['series'];
  mount(flight);
  act(() => button('Roll rate ÷ pitch natural frequency').click());
  expect(note()!.textContent).toContain('crossed ωn 7 times (at 0.50 s, 1.50 s, 2.50 s, 3.50 s, 4.50 s and 2 more)');
  expect(note()!.textContent).not.toContain('5.50 s');
});

it('explains a ratio used as a custom X axis', () => {
  mount();
  change(host.querySelector('.comparison-controls select')!, 'custom');
  change(host.querySelector('[aria-label="Custom X axis"]')!, 'rollPitchRatio');
  expect(note()!.textContent).toContain('roll–pitch resonance');
});

it('uses the shown booster apogee for resonance figures and the window label', () => {
  const flight = result();
  flight.events.push({ type: 'APOGEE', time: 1.25 });
  flight.branches = [{ name: 'Sustainer', series: flight.series, events: flight.events },
    { name: 'Separated', series: structuredClone(flight.series), events: [{ type: 'APOGEE', time: 2 }] }];
  mount(flight);
  change([...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Flight branch'))!.querySelector('select')!, '1');
  act(() => button('Roll rate ÷ pitch natural frequency').click());
  expect(note()!.textContent).toContain('Before apogee on this flight: roll rate crossed ωn 1 time (at 1.50 s) and spent 0.30 s');
  const withoutApogee = { ...flight, branches: [flight.branches[0]!, { ...flight.branches[1]!, events: [] }] };
  mount(withoutApogee);
  change([...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Flight branch'))!.querySelector('select')!, '1');
  expect(note()!.textContent).toContain('last recorded ratio sample (no apogee was recorded)');
});

it.each([[0.002, 'under 0.01'], [0.005, '0.01'], [0.01, '0.01']] as const)(
  'describes positive in-band durations honestly at %s s', (duration, formatted) => {
  const flight = result();
  flight.events = [{ type: 'APOGEE', time: duration }];
  flight.series = { time: [0, duration], Cn: [1, 1], 'ωn': [1, 1], 'dΦ': [0.9, 0.9] } as unknown as FlightResult['series'];
  mount(flight);
  act(() => button('Roll rate ÷ pitch natural frequency').click());
  expect(note()!.textContent).toContain(`spent ${formatted} s within ±15 %`);
  expect(note()!.textContent).not.toContain('spent 0.00 s');
});

it.each(['X', 'Y'])('names download absence for a ratio on custom %s in the chart canvas', axis => {
  act(() => root.render(<PrefsProvider><FlightCharts result={result()} flightName="Starter" onFullSeries={vi.fn()} /></PrefsProvider>));
  change([...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Comparison chart'))!.querySelector('select')!, 'custom');
  change(host.querySelector(`[aria-label="Custom ${axis} axis"]`)!, 'rollPitchRatio');
  const canvas = host.querySelector('.comparison-chart canvas') ?? [...host.querySelectorAll('canvas')]
    .find(c => c.getAttribute('aria-label')?.includes('Custom plot'));
  expect(canvas?.getAttribute('aria-label')).toContain('This display ratio is not in flight-data downloads');
  expect(canvas?.getAttribute('aria-label')).not.toContain('download above holds every timestep');
});
