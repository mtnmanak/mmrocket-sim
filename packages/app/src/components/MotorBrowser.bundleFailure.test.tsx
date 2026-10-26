// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MOTOR_DB, displayDesignation, hasMassData } from '../services/motorDb.js';
import { MotorBrowser } from './MotorBrowser.js';

vi.mock('../data/motorCurves.json', () => { throw new Error('curve chunk unavailable'); });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('lets a motor with unknown bundle mass evidence load usable network masses', async () => {
  const bundle = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../data/motorCurves.json'), 'utf8')) as {
    curves: Record<string, { format: string; masses?: { totalWeightG: number; propWeightG: number }; samples: [number, number][] }[]>;
  };
  const motor = MOTOR_DB.find(m => !hasMassData(m) && bundle.curves[m.motorId]?.some(f =>
    f.masses && f.masses.totalWeightG > f.masses.propWeightG && f.masses.propWeightG > 0))!;
  expect(motor).toBeDefined();
  const file = bundle.curves[motor.motorId]!.find(f => f.masses && f.masses.totalWeightG > f.masses.propWeightG && f.masses.propWeightG > 0)!;
  const masses = file.masses!;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ format: file.format,
    samples: file.samples.map(([time, thrust]) => ({ time, thrust })),
    data: btoa(`<engine initWt="${masses.totalWeightG}" propWt="${masses.propWeightG}"/>`),
  }] }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  localStorage.clear();
  localStorage.setItem('online-openrocket.motor-filters.v1', JSON.stringify({ includeOOP: true }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const selected: MotorSpec[] = [];
  const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 10)); }); };
  try {
    await act(async () => root.render(<PrefsProvider><MotorBrowser mountDiameterMm={motor.diameter}
      maxMotorLengthM={null} onClose={() => {}} onSelect={(_label, spec) => selected.push(spec)} /></PrefsProvider>));
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, motor.designation);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const row = [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].find(r =>
      r.cells[0]?.textContent?.replace(/OOP$/, '').trim() === displayDesignation(motor.designation, motor.manufacturerAbbrev))!;
    expect(row).toBeDefined();
    for (let i = 0; i < 100 && row.hasAttribute('aria-disabled'); i++) await settle();
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.title).not.toContain('publishes no usable weight');
    await act(async () => row.click());
    const load = [...host.querySelectorAll<HTMLButtonElement>('.motor-load-row button')].find(b => b.textContent?.includes('Load'))!;
    await act(async () => load.click());
    for (let i = 0; i < 100 && !selected.length; i++) await settle();
    expect(selected).toHaveLength(1);
    expect(selected[0]!.masses[0]).toBeCloseTo(masses.totalWeightG / 1000, 12);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
  }
});
