// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecentDesignsDialog } from './RecentDesignsDialog.js';
import * as recent from '../services/recentDesigns.js';

vi.mock('../services/recentDesigns.js', () => ({ listRecentDesigns: vi.fn(), recentDesignFile: vi.fn(), clearRecentDesigns: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onClose = vi.fn();
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!;
const show = async () => { await act(async () => root.render(<RecentDesignsDialog onOpen={onOpen} onClose={onClose} />)); };
const click = async (text: string) => { await act(async () => { button(text).click(); }); };
beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(recent.listRecentDesigns).mockResolvedValue([{ name: 'café.ork', openedAt: 1, size: 10 }]);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('opens the stored file through its caller and labels it as a browser copy', async () => {
  const file = new File(['same original bytes'], 'café.ork');
  vi.mocked(recent.recentDesignFile).mockResolvedValue(file);
  await show();
  expect(host.textContent).toContain('copies');
  expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Recent designs');
  await click('café.ork');
  expect(onOpen).toHaveBeenCalledWith(file);
});
it('keeps the current design when another tab removed a file', async () => {
  vi.mocked(recent.recentDesignFile).mockResolvedValue(null);
  await show(); await click('café.ork');
  expect(onOpen).not.toHaveBeenCalled();
  expect(host.textContent).toContain('no longer');
});
it('confirms Clear recent, preserves the list on failure, and clears only after success', async () => {
  vi.mocked(recent.clearRecentDesigns).mockRejectedValueOnce(new Error('Quota failure')).mockResolvedValueOnce();
  await show(); await click('Clear recent');
  expect(recent.clearRecentDesigns).not.toHaveBeenCalled();
  await click('Clear copies');
  expect(host.textContent).toContain('Quota failure');
  expect(host.textContent).toContain('café.ork');
  await click('Clear recent'); await click('Clear copies');
  expect(host.textContent).toContain('No recent designs');
});
it('reports storage failure and allows retry', async () => {
  vi.mocked(recent.listRecentDesigns).mockRejectedValueOnce(new Error('Storage blocked')).mockResolvedValueOnce([]);
  await show(); expect(host.textContent).toContain('Storage blocked');
  await click('Retry'); expect(host.textContent).toContain('No recent designs');
});
