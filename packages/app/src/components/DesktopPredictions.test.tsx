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
