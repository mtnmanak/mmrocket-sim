// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { MotorBrowser } from './MotorBrowser.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { displayDesignation, hasMassData, MOTOR_DB, MOTOR_DB_DATE, setCatalogueOverlay } from '../services/motorDb.js';
import { knownNoPublishedCurve } from '../services/thrustcurve.js';
import { screenEntry } from '../services/catalogueOverlay.js';

vi.mock('../data/motors.json', async importOriginal => {
  const real = await importOriginal<{ default: { generated: string } }>();
  return { default: { generated: real.default.generated, count: 1, motors: [{
    motorId: 'closure-shipped-no-mass', designation: 'ClosureShipped', commonName: 'E20',
    manufacturerAbbrev: 'AT', diameter: 29, length: 100, avgThrustN: 20, maxThrustN: 40,
    totImpulseNs: 40, burnTimeS: 2, type: 'SU',
    impulseClass: 'E', availability: 'regular', delays: '5',
  }] } };
});

vi.mock('../data/motorCurves.json', async () => {
  const { MOTOR_DB_DATE } = await import('../services/motorDb.js');
  return { default: { catalogueGenerated: MOTOR_DB_DATE, complete: true, curves: {} } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it.each(['overlay', 'shipped'])('loads network masses for a %s motor absent from the complete bundle after a catalogue check', async source => {
  let motor = { ...MOTOR_DB[0]!, motorId: 'closure-new-motor', designation: 'ClosureNew', availability: 'regular' as const };
  if (source === 'shipped') {
    motor = { ...MOTOR_DB[0]!, availability: 'regular' };
  }
  expect(hasMassData(motor)).toBe(false);
  expect(screenEntry(motor)).toBeNull();
  localStorage.clear();
  localStorage.setItem('online-openrocket.motor-filters.v1', JSON.stringify({ includeOOP: true }));
  const overlay = { baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(Date.parse(MOTOR_DB_DATE) + 86400_000).toISOString(),
    liveCount: MOTOR_DB.length + 1, added: source === 'overlay' ? [motor] : [], changed: [], removed: [], rejected: [] };
  setCatalogueOverlay(source === 'overlay' ? overlay : null);
  if (source === 'shipped') expect(await knownNoPublishedCurve(motor.motorId)).toBe(true);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ format: 'RASP',
    samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 40 }, { time: 2, thrust: 0 }],
    data: btoa('ClosureNew 29 100 P 0.05 0.1 Home\n0 0\n1 40\n2 0'),
  }] }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const selected: MotorSpec[] = [];
  try {
    await act(async () => root.render(<PrefsProvider><MotorBrowser mountDiameterMm={motor.diameter} maxMotorLengthM={null}
      onClose={() => {}} onSelect={(_label, spec) => selected.push(spec)} /></PrefsProvider>));
    const search = host.querySelector<HTMLInputElement>('input[type=search]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, motor.designation);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const label = displayDesignation(motor.designation, motor.manufacturerAbbrev);
    const row = [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].find(r => r.cells[0]?.textContent?.replace(/OOP$/, '').trim() === label)!;
    expect(row).toBeDefined();
    if (source === 'shipped') {
      expect(row.getAttribute('aria-disabled'), host.textContent ?? '').toBe('true');
      await act(async () => { setCatalogueOverlay(overlay); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    }
    expect(row.getAttribute('aria-disabled')).toBeNull();
    await act(async () => row.click());
    const load = [...host.querySelectorAll<HTMLButtonElement>('.motor-load-row button')].find(b => b.textContent?.includes('Load'))!;
    await act(async () => {
      load.click();
      await vi.waitFor(() => expect(selected).toHaveLength(1));
    });
    expect(selected, host.textContent ?? '').toHaveLength(1);
    expect(selected[0]!.masses[0]).toBeCloseTo(0.1, 12);
    expect(fetcher).toHaveBeenCalledOnce();
    if (source === 'shipped') {
      await act(async () => { setCatalogueOverlay(null); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      expect(row.getAttribute('aria-disabled')).toBe('true');
    }
  } finally {
    act(() => root.unmount()); host.remove(); setCatalogueOverlay(null); localStorage.clear(); vi.unstubAllGlobals();
  }
});
