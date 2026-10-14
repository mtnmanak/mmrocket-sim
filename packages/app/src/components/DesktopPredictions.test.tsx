// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { DesktopPredictions } from './DesktopPredictions.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { DesktopStoredPrediction } from '../services/orkFile.js';
import type { SimRun } from '../services/simReport.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const predictions: DesktopStoredPrediction[] = [
  { name: 'First', configId: 'a', sourceVersion: '24.12', data: { maxAltitude: 123, maxVelocity: 45 } },
  { name: 'Second', configId: 'b', data: { maxAltitude: 789 } },
  { name: 'Other flight', configId: 'a', data: { maxAltitude: 234 } },
];

describe('desktop prediction comparison', () => {
  it.each([5, 0, -1])('compares the kernel last-burnout delay %s rather than primary Auto delay', lastBurnoutOptimalDelayS => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const run = { flightConfigId: 'a', optimumDelayS: 8, lastBurnoutOptimalDelayS } as SimRun;
    act(() => root.render(<PrefsProvider><DesktopPredictions
      predictions={[{ name: 'Two motors', configId: 'a', data: { optimumDelay: lastBurnoutOptimalDelayS } }]}
      configId="a" run={run} /></PrefsProvider>));
    const row = [...host.querySelectorAll('tbody tr')].find(tr => tr.querySelector('th')?.textContent?.startsWith('Optimal delay'))!;
    expect(row.querySelector('th')?.textContent).toContain('last burnout');
    expect([...row.querySelectorAll('td')].map(td => td.textContent)).toEqual([
      lastBurnoutOptimalDelayS.toFixed(2), lastBurnoutOptimalDelayS.toFixed(2),
    ]);
    expect(host.textContent).toContain("primary mount's Auto delay");
    expect(run.optimumDelayS).toBe(8);
    act(() => root.unmount());
  });

  it.each([undefined, null, NaN, Infinity])('keeps missing or invalid last-burnout delay %s blank without falling back to Auto', lastBurnoutOptimalDelayS => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const run = { flightConfigId: 'a', optimumDelayS: 8, lastBurnoutOptimalDelayS } as SimRun;
    act(() => root.render(<PrefsProvider><DesktopPredictions
      predictions={[{ name: 'Legacy', configId: 'a', data: { optimumDelay: 5 } }]}
      configId="a" run={run} /></PrefsProvider>));
    const row = [...host.querySelectorAll('tbody tr')].find(tr => tr.querySelector('th')?.textContent?.startsWith('Optimal delay'))!;
    expect(row.querySelector('td:last-child')?.textContent).toBe('—');
    act(() => root.unmount());
  });

  it.each([0, 5])('compares the last deployment ground speed for dual deployment with %s m/s drift', wind => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const groundSpeed = Math.hypot(19.5, wind);
    const run = {
      flightConfigId: 'a', velocityAtDeployment: 2, lastDeploymentGroundSpeed: groundSpeed,
      deployments: [
        { time: 7, velocityAtDeployment: 2, groundSpeedAtDeployment: 2 },
        { time: 30, velocityAtDeployment: 19.5, groundSpeedAtDeployment: groundSpeed },
      ],
    } as SimRun;
    const desktop = [{ name: 'Dual deploy', configId: 'a', data: { deploymentVelocity: groundSpeed } }];
    act(() => root.render(<PrefsProvider><DesktopPredictions predictions={desktop} configId="a" run={run} /></PrefsProvider>));
    const row = [...host.querySelectorAll('tbody tr')].find(tr => tr.querySelector('th')?.textContent === 'Last deployment ground speed')!;
    expect(row).toBeDefined();
    const cells = row.querySelectorAll('td');
    expect(cells[0]!.textContent).toBe(cells[1]!.textContent);
    expect(cells[1]!.textContent).toBe(`${groundSpeed.toFixed(1)} m/s`);
    expect(host.textContent).toContain('Older app runs without this recorded value show —');
    expect(run.velocityAtDeployment).toBe(2);
    act(() => root.unmount());
  });

  it('keeps legacy deployment evidence blank rather than using the first or last opening speed', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const run = { flightConfigId: 'a', velocityAtDeployment: 2,
      deployments: [{ velocityAtDeployment: 19.5, groundSpeedAtDeployment: 20.1 }],
    } as SimRun;
    act(() => root.render(<PrefsProvider><DesktopPredictions
      predictions={[{ name: 'Legacy', configId: 'a', data: { deploymentVelocity: 20.1 } }]}
      configId="a" run={run} /></PrefsProvider>));
    const row = [...host.querySelectorAll('tbody tr')].find(tr => tr.querySelector('th')?.textContent === 'Last deployment ground speed')!;
    expect(row).toBeDefined();
    expect(row.querySelector('td:last-child')?.textContent).toBe('—');
    act(() => root.unmount());
  });

  it('excludes external summaries even from a previously saved session', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const external: DesktopStoredPrediction = {
      name: 'Measured flight', configId: 'a', status: 'external', sourceVersion: '24.12', data: { maxAltitude: 456 },
    };
    act(() => root.render(<PrefsProvider><DesktopPredictions predictions={[external]} configId="a" /></PrefsProvider>));
    expect(host.textContent).toBe('');
    act(() => root.render(<PrefsProvider><DesktopPredictions predictions={[external, ...predictions]} configId="a" /></PrefsProvider>));
    expect(host.textContent).not.toContain('Measured flight');
    expect(host.textContent).not.toContain('456');
    expect(host.querySelectorAll('details')).toHaveLength(2);
    act(() => root.unmount());
  });

  it.each([false, true])('keeps unidentified history visible with configuration a and shown run %s', shownRun => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const unknown: DesktopStoredPrediction = { name: 'Legacy', configId: null, data: { maxAltitude: 456 } };
    const run = shownRun ? { flightConfigId: 'a', maxAltitude: 120 } as SimRun : undefined;
    for (const summaries of [[unknown], [...predictions, unknown]]) {
      act(() => root.render(<PrefsProvider><DesktopPredictions predictions={summaries} configId="a" run={run} /></PrefsProvider>));
      const legacy = [...host.querySelectorAll('details')].find(detail => detail.querySelector('summary')?.textContent?.includes('Legacy'));
      expect(legacy).toBeDefined();
      expect(legacy!.textContent).toContain('Configuration identity was not recorded');
      expect(legacy!.textContent).not.toContain('configuration ID is the same');
      expect(legacy!.querySelector('tbody tr td')?.textContent).toContain('456');
      for (const cell of legacy!.querySelectorAll('tbody tr td:last-child')) expect(cell.textContent).toBe('—');
      if (summaries.length > 1) {
        const first = host.querySelector('details')!;
        expect(first.textContent).toContain('configuration ID is the same');
        expect(first.querySelector('tbody tr td:last-child')?.textContent).toBe(shownRun ? '120 m' : '—');
        expect(host.textContent).not.toContain('Second');
      }
    }
    act(() => root.unmount());
  });

  it('compares only the same configuration, labels provenance and carries its caveat', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const run = { flightConfigId: 'a', maxAltitude: 120, maxVelocity: 40 } as SimRun;
    act(() => root.render(<PrefsProvider><DesktopPredictions predictions={predictions} configId="a" run={run} /></PrefsProvider>));
    expect(host.textContent).toContain('Desktop OpenRocket 24.12');
    expect(host.textContent).toContain('stored predictions');
    expect(host.textContent).toContain('may describe older settings');
    expect(host.textContent).toContain('not used as simulation inputs');
    expect(host.textContent).not.toContain('Second');
    expect(host.querySelectorAll('details')).toHaveLength(2);
    const firstRow = host.querySelector('tbody tr')!;
    expect(firstRow.textContent).toContain('123');
    expect(firstRow.textContent).toContain('120');
    expect(host.querySelector('summary')).not.toBeNull();
    act(() => root.unmount());
  });

  it('leaves app values blank without an app run from this configuration', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    for (const run of [undefined, { flightConfigId: 'a', maxAltitude: 999 } as SimRun]) {
      act(() => root.render(<PrefsProvider><DesktopPredictions predictions={predictions} configId="b" run={run} /></PrefsProvider>));
      expect(host.textContent).toContain('Second');
      expect(host.textContent).not.toContain('First');
      expect(host.querySelector('tbody tr td:last-child')?.textContent).toBe('—');
      expect(host.textContent).not.toContain('999');
    }
    act(() => root.unmount());
  });

  it('shows nothing for unmatched or unknown configuration identities', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    for (const configId of ['missing', null]) {
      act(() => root.render(<PrefsProvider><DesktopPredictions predictions={predictions} configId={configId} /></PrefsProvider>));
      expect(host.textContent).toBe('');
    }
    act(() => root.unmount());
  });

  it('keeps a configuration-less summary historical without claiming an identity match', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const unknown = [{ name: 'Legacy', configId: null, data: { maxAltitude: 123 } }];
    act(() => root.render(<PrefsProvider><DesktopPredictions predictions={unknown} configId={null} /></PrefsProvider>));
    expect(host.textContent).toContain('Configuration identity was not recorded');
    expect(host.textContent).not.toContain('configuration ID is the same');
    expect(host.querySelector('tbody tr td:last-child')?.textContent).toBe('—');
    act(() => root.unmount());
  });
});
