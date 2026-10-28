// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveFile } from './services/saveFile.js';

const mount = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('virtual:pwa-register', () => ({ registerSW: () => async () => {} }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: () => {
  if (mount.error) throw mount.error;
} }) }));
vi.mock('./root.js', () => ({ AppRoot: () => null }));
vi.mock('./services/saveFile.js', () => ({ saveFile: vi.fn(async () => ({ kind: 'saved', name: 'debug.txt' })) }));

let root: HTMLDivElement;
const listeners: { type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions }[] = [];
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mount.error = null;
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    listeners.push({ type, listener, options }); add(type, listener, options);
  });
  vi.stubGlobal('navigator', { userAgent: 'Merge test browser', serviceWorker: new EventTarget() });
  vi.stubGlobal('fetch', fetchSpy);
  root = document.createElement('div'); root.id = 'root'; root.textContent = 'Mounted app';
  document.body.append(root);
});
afterEach(() => {
  document.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')?.click();
  for (const { type, listener, options } of listeners.splice(0)) window.removeEventListener(type, listener, options);
  root.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

const fetchSpy = vi.fn(async () => new Response('{}'));
// No App mounted, so no restore and no catalogue request (main.catalogueCheck.test.tsx has the positive case).
afterEach(() => {
  expect(fetchSpy.mock.calls.map(c => String((c as unknown[])[0])).filter(u => u.startsWith('https://catalogue.mountainmanrockets.com/'))).toEqual([]);
});

const download = () => document.querySelector<HTMLButtonElement>('[data-debug-log]')!;

it('merges global fatal presentation with privacy-filtered capture and a working local download', async () => {
  await import('./main.js');
  window.dispatchEvent(new ErrorEvent('error', { error: new TypeError("Cannot read properties of undefined (reading 'Private rocket')") }));
  expect(document.querySelector('.fatal-error-bar')?.nextElementSibling).toBe(root);
  expect(root.textContent).toBe('Mounted app');
  expect(download().disabled).toBe(false);
  download().click();
  await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  const [text, options] = vi.mocked(saveFile).mock.calls[0]!;
  expect(options).toEqual({ suggestedName: 'mmrocket-sim-session-debug.txt', mime: 'text/plain;charset=utf-8', extensions: ['.txt'], description: 'Session debug log' });
  expect(String(text)).toContain('uncaught-error: TypeError: Cannot read properties of undefined (property omitted)');
  expect(String(text)).toContain('debug-log-download');
  expect(String(text)).not.toContain('Private rocket');
  document.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click();
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: new Error('No stage found') });
  window.dispatchEvent(rejection);
  expect(document.querySelector('.fatal-error-bar')?.textContent).toContain('No stage found');
  const { sessionDebugLog } = await import('./services/sessionDebugLog.js');
  expect(sessionDebugLog.text()).toContain('unhandled-rejection: Error: No stage found');
  expect(sessionDebugLog.text().match(/uncaught-error:/g)).toHaveLength(1);
});

it('records a synchronous mount failure and makes the same diagnostic available from its fatal bar', async () => {
  mount.error = new Error('No stage found');
  await import('./main.js');
  expect(document.querySelector('.fatal-error-bar')?.textContent).toContain('No stage found');
  expect(download().disabled).toBe(false);
  download().click();
  await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  expect(String(vi.mocked(saveFile).mock.calls[0]![0])).toContain('app-error: Error: No stage found');
});

it('contains a download failure in the bar and permits a retry without replacing the original error', async () => {
  await import('./main.js');
  vi.mocked(saveFile).mockRejectedValueOnce(new Error('Download refused'));
  window.dispatchEvent(new ErrorEvent('error', { message: 'Original error' }));
  download().click();
  await vi.waitFor(() => expect(document.querySelector('.fatal-error-bar [role="status"]')?.textContent).toContain('Download refused'));
  expect(document.querySelector('.fatal-error-bar [role="alert"]')?.textContent).toContain('Original error');
  expect(download().disabled).toBe(false);
  download().click();
  await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2));
});
