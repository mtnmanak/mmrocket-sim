// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AeroDiagnostics, OrkRocket } from '@online-openrocket/engine';
import { DragPanel } from './DragPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { chartInk } from '../chartTheme.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Every stroke the canvas draws, with the style it was drawn in. The worst-plane
// marker is the one SOLID 1 px stroke in the reference ink (re-pinned for brand
// v1: it was the only [2, 4] dash, and the series styles now include dots).
const strokes: { style: unknown; width: unknown; dash: number[] }[] = [];
let dash: number[] = [];
const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
  get: (t, p) => p === 'measureText' ? () => ({ width: 0 })
    : p === 'setLineDash' ? (d: number[]) => { dash = d; }
      : p === 'stroke' ? () => { strokes.push({ style: t['strokeStyle'], width: t['lineWidth'], dash }); }
        : () => undefined,
  set: (t, p, v) => { t[p] = v; return true; },
});
const marker = () => strokes.some((s) => s.style === chartInk(null).reference && s.width === (globalThis.devicePixelRatio || 1)
  && s.dash.length === 0);
HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { localStorage.clear(); strokes.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('N022 queries only on request, shares AoA, names conditions, gaps and worst plane in preferred units', async () => {
  const planes: AeroDiagnostics['cp'][] = Array.from({ length: 360 }, (_v, i) => [i === 0 ? 0 : i === 90 ? 0.4 : 0.8, 0, 0, i === 0 ? 0 : 2]);
  const diagnostic = vi.fn(() => ({ cp: planes[0], worstCP: planes[90], cpByTheta: planes, stallMargin: 0.1 }));
  const sweep = { machs: [0.3, 1], cp: [0.8, 0.8], cna: [2, 2], hasNozzle: false,
    powerOff: { total: [0.4, 0.4] }, powerOn: { total: [0.4, 0.4] }, components: [] };
  const rocket = { aeroDiagnostics: diagnostic, dragSweep: () => sweep,
    staticInfo: () => ({ length: 1, cg: 0.3, mass: 0.5, refDiameter: 0.1, cp: 0.8, cna: 2, cpWorst: 0.4, cnaWorst: 2 }) } as unknown as OrkRocket;
  await act(async () => root.render(<PrefsProvider><DragPanel rocket={rocket} open /></PrefsProvider>));
  expect(diagnostic).not.toHaveBeenCalled();
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show CP vs roll-plane angle');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(diagnostic).toHaveBeenLastCalledWith(0.3, 0);
  const panel = host.querySelector('.roll-plane-panel')!;
  expect(panel.textContent).toContain('Mach 0.3');
  expect(panel.textContent).toContain('angle of attack 0°');
  expect(panel.textContent).toContain('No lift in this plane: 0°');
  expect(panel.textContent).toContain('Worst plane: 90°');
  expect(marker()).toBe(true);
  expect(panel.textContent).toContain('400 mm from nose');
  expect(panel.textContent).toContain('1 cal');
  expect(panel.textContent).toContain('Launch CG');
  expect(panel.textContent).toContain('no flight changes');
  expect(panel.textContent).toContain("the app's static stability margin");
  expect(panel.textContent).toContain('Flight uses the CP of the plane the airflow is in');
  expect(panel.textContent).toContain('a flight can show more margin than this worst plane');
  expect(panel.textContent).not.toContain('same convention used in flight');
  for (const c of panel.querySelectorAll('canvas')) {
    expect(c.getAttribute('aria-label')).toContain('roll-plane angle');
    expect(c.getAttribute('aria-label')).not.toContain('Drag table');
  }
  const aoa = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Angle of attack'))!.querySelector('select')!;
  await act(async () => { aoa.value = '10'; aoa.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(diagnostic).toHaveBeenLastCalledWith(0.3, 10 * Math.PI / 180);
  const mach = panel.querySelector('select')!;
  await act(async () => { mach.value = '1'; mach.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(diagnostic).toHaveBeenLastCalledWith(1, 10 * Math.PI / 180);
  expect(panel.textContent).toContain('Mach 1');
  const details = panel.querySelector('details')!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(panel.querySelectorAll('details tbody tr')).toHaveLength(360);
  expect(panel.querySelectorAll('details tbody tr')[0]!.textContent).toContain('No lift in this plane');
  expect(panel.querySelectorAll('details tbody tr')[90]!.textContent).toContain('90 · worst40');
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'mm from nose')!.click());
  expect(panel.querySelectorAll('details tbody tr')[90]!.textContent).toContain('90 · worst400');
  expect(diagnostic).toHaveBeenCalledTimes(3);
});

it('N022 shows no worst direction or table marker when CP differs only by rounding', async () => {
  const planes: AeroDiagnostics['cp'][] = Array.from({ length: 360 }, (_v, i) => [0.4 + (i % 2) * 1e-16, 0, 0, 2]);
  const sweep = { machs: [0.3, 1], cp: [0.4, 0.4], cna: [2, 2], hasNozzle: false,
    powerOff: { total: [0.4, 0.4] }, powerOn: { total: [0.4, 0.4] }, components: [] };
  const rocket = { aeroDiagnostics: () => ({ cp: planes[0], worstCP: planes[0], cpByTheta: planes, stallMargin: 0.1 }),
    dragSweep: () => sweep,
    staticInfo: () => ({ length: 1, cg: 0.3, mass: 0.5, refDiameter: 0.1, cp: 0.4, cna: 2, cpWorst: 0.4, cnaWorst: 2 }) } as unknown as OrkRocket;
  await act(async () => root.render(<PrefsProvider><DragPanel rocket={rocket} open /></PrefsProvider>));
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show CP vs roll-plane angle')!.click());
  const panel = host.querySelector('.roll-plane-panel')!;
  expect(panel.textContent).toContain('CP is the same in every roll plane (to rounding); no single worst plane.');
  expect(panel.textContent).not.toContain('Worst plane:');
  expect(panel.textContent).not.toContain('marked by a thin vertical line');
  expect(strokes.length).toBeGreaterThan(0);
  expect(marker()).toBe(false);
  for (const canvas of panel.querySelectorAll('canvas')) {
    expect(canvas.getAttribute('aria-label')).toContain('no single worst plane');
    expect(canvas.getAttribute('aria-label')).not.toContain('marked by a thin vertical line');
  }
  const details = panel.querySelector('details')!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(panel.querySelectorAll('details tbody tr')).toHaveLength(360);
  expect(details.textContent).not.toContain('· worst');
});

it.each(['no lift', 'query failure'])('N022 explains %s without showing a margin', async (state) => {
  const diagnostic = () => {
    if (state === 'query failure') throw new Error('test diagnostic failure');
    const cp: AeroDiagnostics['cp'] = [0, 0, 0, 0];
    return { cp, worstCP: cp, cpByTheta: Array.from({ length: 360 }, () => cp), stallMargin: 0.1 };
  };
  const sweep = { machs: [0.3, 1], cp: [0, 0], cna: [0, 0], hasNozzle: false,
    powerOff: { total: [0.4, 0.4] }, powerOn: { total: [0.4, 0.4] }, components: [] };
  const rocket = { aeroDiagnostics: diagnostic, dragSweep: () => sweep,
    staticInfo: () => ({ length: 1, cg: 0.3, mass: 0.5, refDiameter: 0.1, cp: 0, cna: 0, cpWorst: 0, cnaWorst: 0 }) } as unknown as OrkRocket;
  await act(async () => root.render(<PrefsProvider><DragPanel rocket={rocket} open /></PrefsProvider>));
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show CP vs roll-plane angle')!.click());
  const panel = host.querySelector('.roll-plane-panel')!;
  if (state === 'query failure') {
    expect(panel.querySelector('.roll-plane-alert[role="alert"]')?.textContent).toContain('Roll-plane CP could not be computed: test diagnostic failure');
  } else {
    expect(panel.textContent).toContain('No defined worst plane.');
    expect(panel.textContent).toContain('No lift in this plane: every sampled angle');
    expect(panel.querySelectorAll('canvas')).toHaveLength(2);
  }
  expect(panel.textContent).not.toMatch(/NaN|Infinity|margin: -3/);
});

// Live-region sweep (audit 2026-09-22): the alert was one arm of a ternary,
// inserted with its text already in place.
it('N022 reports a failed roll-plane query into an alert region that was there, empty, with the charts', async () => {
  let fail = false;
  const planes: AeroDiagnostics['cp'][] = Array.from({ length: 360 }, () => [0.8, 0, 0, 2]);
  const diagnostic = () => {
    if (fail) throw new Error('test diagnostic failure');
    return { cp: planes[0]!, worstCP: planes[0]!, cpByTheta: planes, stallMargin: 0.1 };
  };
  const sweep = { machs: [0.3, 1], cp: [0.8, 0.8], cna: [2, 2], hasNozzle: false,
    powerOff: { total: [0.4, 0.4] }, powerOn: { total: [0.4, 0.4] }, components: [] };
  const rocket = { aeroDiagnostics: diagnostic, dragSweep: () => sweep,
    staticInfo: () => ({ length: 1, cg: 0.3, mass: 0.5, refDiameter: 0.1, cp: 0.8, cna: 2, cpWorst: 0.8, cnaWorst: 2 }) } as unknown as OrkRocket;
  await act(async () => root.render(<PrefsProvider><DragPanel rocket={rocket} open /></PrefsProvider>));
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show CP vs roll-plane angle')!.click());
  const panel = host.querySelector('.roll-plane-panel')!;
  const alert = panel.querySelector('.roll-plane-alert');
  expect(alert?.getAttribute('role')).toBe('alert');
  expect(alert!.textContent).toBe('');
  expect(panel.textContent).toContain('CP position vs roll-plane angle');
  fail = true;
  const mach = panel.querySelector<HTMLSelectElement>('select')!;
  const other = [...mach.options].find((o) => o.value !== mach.value)!.value;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(mach, other);
    mach.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(panel.querySelector('.roll-plane-alert')).toBe(alert);
  expect(alert!.textContent).toBe('⛔ Danger: Roll-plane CP could not be computed: test diagnostic failure');
  expect(panel.textContent).not.toContain('CP position vs roll-plane angle');
});
