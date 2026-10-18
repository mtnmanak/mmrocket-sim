// @vitest-environment happy-dom
import { act, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GlossaryHelp } from './GlossaryHelp.js';

// Throw from the export read in lazy().then(), so Vitest does not wrap the chunk error.
vi.mock('./GuideDialog.js', () => ({
  get GuideDialog(): never { throw new TypeError('Failed to fetch dynamically imported module'); },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class OuterBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? <p className="hero-fallback">App failed</p> : this.props.children; }
}

it('S3c-2 contains a rejected guide import in a closable User guide dialog', async () => {
  const host = document.createElement('div'); host.className = 'viz-root'; document.body.append(host);
  const root = createRoot(host);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    act(() => root.render(<OuterBoundary><GlossaryHelp term="fin" label="Fin" /></OuterBoundary>));
    const opener = host.querySelector<HTMLButtonElement>('button')!;
    opener.focus();
    await act(async () => { opener.click(); await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(host.querySelector('.hero-fallback')).toBeNull();
    const dialog = host.querySelector('[role="dialog"][aria-label="User guide"]');
    expect(dialog?.textContent).toContain('could not be downloaded');
    expect(dialog?.textContent).toContain('Reload the page');
    act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Close user guide"]')!.click(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  } finally { act(() => root.unmount()); host.remove(); log.mockRestore(); }
});
