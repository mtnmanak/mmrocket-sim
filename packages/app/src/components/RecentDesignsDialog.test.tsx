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

it.each(['Close', 'Escape', 'unmount'])('ignores a pending read after %s', async dismissal => {
  let resolveRead!: (file: File) => void;
  vi.mocked(recent.recentDesignFile).mockImplementation(() => new Promise<File>(resolve => { resolveRead = resolve; }));
  await show(); await click('café.ork');
  if (dismissal === 'Close') await click('Close');
  else if (dismissal === 'Escape') await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  else await act(async () => { root.render(null); });
  if (dismissal !== 'unmount') expect(onClose).toHaveBeenCalledOnce();
  await act(async () => { resolveRead(new File(['old choice'], 'café.ork')); });
  expect(onOpen).not.toHaveBeenCalled();
});

it('accepts a pending read through the current caller after a rerender', async () => {
  let resolveRead!: (file: File) => void;
  vi.mocked(recent.recentDesignFile).mockImplementation(() => new Promise<File>(resolve => { resolveRead = resolve; }));
  await show(); await click('café.ork');
  const currentOpen = vi.fn();
  await act(async () => { root.render(<RecentDesignsDialog onOpen={currentOpen} onClose={onClose} />); });
  const file = new File(['chosen bytes'], 'café.ork');
  await act(async () => { resolveRead(file); });
  expect(currentOpen).toHaveBeenCalledWith(file);
  expect(onOpen).not.toHaveBeenCalled();
});

it.each(['missing', 'failed'])('ignores a cancelled read that later reports %s storage', async result => {
  let resolveRead!: (file: File | null) => void;
  let rejectRead!: (error: Error) => void;
  vi.mocked(recent.recentDesignFile).mockImplementation(() => new Promise<File | null>((resolve, reject) => {
    resolveRead = resolve; rejectRead = reject;
  }));
  await show(); await click('café.ork'); await click('Close');
  await act(async () => {
    if (result === 'missing') resolveRead(null);
    else rejectRead(new Error('Late storage error'));
  });
  expect(onOpen).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('no longer');
  expect(host.textContent).not.toContain('Late storage error');
  // The close callback can defer unmount; a cancelled completion must not update it.
  expect(button('café.ork').disabled).toBe(true);
});
