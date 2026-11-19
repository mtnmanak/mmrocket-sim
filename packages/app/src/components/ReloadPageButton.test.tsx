// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReloadPageButton } from './ReloadPageButton.js';
import { setReloadHold } from '../services/swUpdate.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('r2 keeps the warning region mounted and offers an explicit reload for a persistent hold', () => {
  setReloadHold(() => true);
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(<ReloadPageButton />));
    const region = host.querySelector('[role="status"]');
    expect(region?.textContent).toBe('');
    act(() => host.querySelector('button')!.click());
    expect(host.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toContain('lose');
    expect(reload).not.toHaveBeenCalled();
    const proceed = [...host.querySelectorAll('button')].find(b => b.textContent === 'Reload anyway');
    expect(proceed).toBeDefined();
    act(() => proceed!.click());
    expect(reload).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); reload.mockRestore(); setReloadHold(() => false); }
});
