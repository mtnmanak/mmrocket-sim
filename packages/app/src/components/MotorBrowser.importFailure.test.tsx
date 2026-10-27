// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MotorBrowser } from './MotorBrowser.js';

// The wrapper's JSDoc says callers fire it with `void`, so a throw from the
// service must land in the alert region, not become an unhandled rejection.
vi.mock('../services/importMotorFiles.js', () => ({
  importMotorFiles: vi.fn(async () => { throw new Error('Motor Z9: refused by the service.'); }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('A reports a thrown motor import in the always-mounted alert region', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    await act(async () => root.render(<PrefsProvider><MotorBrowser mountDiameterMm={29}
      maxMotorLengthM={null} onClose={() => {}} onSelect={() => {}} /></PrefsProvider>));
    const alert = host.querySelector('.motor-import-notes [role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toBe('');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Import EX motor files (.eng or .rse)"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'z9.eng')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(host.querySelector('.motor-import-notes [role="alert"]')).toBe(alert);
    expect(alert.textContent).toContain('Motor Z9: refused by the service.');
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
    act(() => root.unmount()); host.remove(); localStorage.clear();
  }
});
