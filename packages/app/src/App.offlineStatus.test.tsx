// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { useOfflineStatus, type OfflineStatus } from './services/offlineStatus.js';

vi.mock('./services/offlineStatus.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./services/offlineStatus.js')>(),
  useOfflineStatus: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('keeps offline readiness in the existing polite version readout, independently of update checks', async () => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (status: OfflineStatus) => {
    vi.mocked(useOfflineStatus).mockReturnValue(status);
    await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  };
  try {
    await render({ kind: 'unknown' });
    const region = host.querySelector('.version-check')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.querySelector('.offline-status')).toBeNull();
    const versionButton = region.querySelector('button');
    await render({ kind: 'ready', detail: 'Download finished' });
    expect(region.querySelector('.offline-status')?.textContent).toBe('Offline copy ready');
    expect(region.querySelector('.offline-status')?.getAttribute('title')).toBe('Download finished');
    expect(region.textContent).toContain('Version unknown');
    await render({ kind: 'unavailable', reason: 'registration failed', detail: 'Blocked by browser' });
    expect(region.querySelector('.offline-status')?.textContent).toBe('Offline copy not available — registration failed');
    expect(region.querySelector('button')).toBe(versionButton);
    await render({ kind: 'unavailable', reason: 'unsupported', detail: 'No service worker' });
    expect(region.querySelector('.offline-status')?.textContent).toBe('Offline copy not available in this browser');
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
});
