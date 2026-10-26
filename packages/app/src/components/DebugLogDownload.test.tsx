// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { DebugLogDownload } from './DebugLogDownload.js';
import { sessionDebugLog } from '../services/sessionDebugLog.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('C-H3 downloads diagnostics locally with a fixed filename, exposes privacy copy and reports completion', async () => {
  let saved: BlobPart | undefined;
  let options: { suggestedName: string } | undefined;
  const picker = async (opts: { suggestedName: string }) => {
    options = opts;
    return { name: opts.suggestedName, createWritable: async () => ({
      write: async (data: BlobPart) => { saved = data; }, close: async () => {},
    }) };
  };
  (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
  sessionDebugLog.record('import-failed', new Error('No stage found'));
  act(() => root.render(<DebugLogDownload />));
  const status = host.querySelector('[role="status"]');
  expect(status).not.toBeNull();
  expect(status!.textContent).toBe('');
  const button = host.querySelector<HTMLButtonElement>('button')!;
  expect(button.textContent).toBe('Download session debug log');
  expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toContain('No design');
  expect(host.textContent).toContain('64 KiB');
  expect(host.textContent).toContain('only if you attach');
  await act(async () => { button.click(); });
  expect(options?.suggestedName).toBe('mmrocket-sim-session-debug.txt');
  expect(String(saved)).toContain('import-failed: Error: No stage found');
  expect(String(saved)).toContain('debug-log-download');
  expect(host.querySelector('[role="status"]')).toBe(status);
  expect(status!.textContent).toContain('Saved');
  expect(button.disabled).toBe(false);
});

it('C-H3 keeps cancellation quiet and the control usable after a failed download', async () => {
  (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => { throw new DOMException('cancel', 'AbortError'); };
  act(() => root.render(<DebugLogDownload />));
  const button = host.querySelector<HTMLButtonElement>('button')!;
  await act(async () => { button.click(); });
  expect(host.querySelector('[role="status"]')?.textContent).toBe('');
  expect(button.disabled).toBe(false);
  delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('download failed'); });
  await act(async () => { button.click(); });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('could not be downloaded');
  expect(button.disabled).toBe(false);
});

it('C-H3 keeps Feedback open when the privacy note or download status is clicked', async () => {
  (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = async () => ({
    name: 'mmrocket-sim-session-debug.txt',
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
  });
  function Feedback() {
    const [open, setOpen] = useState(true);
    return open ? <div className="feedback-menu" onClick={() => setOpen(false)}><DebugLogDownload /></div> : null;
  }
  act(() => root.render(<Feedback />));
  act(() => host.querySelector<HTMLElement>('.debug-log-download p')!.click());
  expect(host.querySelector('.feedback-menu')).not.toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); });
  act(() => host.querySelector<HTMLElement>('[role="status"]')!.click());
  expect(host.querySelector('.feedback-menu')).not.toBeNull();
  // The rest of the menu still owns its close-on-click behavior.
  act(() => host.querySelector<HTMLElement>('.feedback-menu')!.click());
  expect(host.querySelector('.feedback-menu')).toBeNull();
});
