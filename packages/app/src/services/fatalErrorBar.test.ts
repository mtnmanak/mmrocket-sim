// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installFatalErrorBar } from './fatalErrorBar.js';

let stop: () => void;
let root: HTMLDivElement;
beforeEach(() => { root = document.createElement('div'); root.id = 'root'; root.textContent = 'Running app'; document.body.append(root); });
afterEach(() => { stop?.(); root.remove(); vi.restoreAllMocks(); });
const bar = () => document.querySelector<HTMLElement>('.fatal-error-bar');
const error = (message: string) => window.dispatchEvent(new ErrorEvent('error', { message, cancelable: true }));

it('shows an uncaught error above the running app, safely as text, and dismisses only the bar', () => {
  stop = installFatalErrorBar();
  error('<img src=x onerror=alert(1)>\nstack line');
  expect(bar()?.textContent).toContain('Something went wrong');
  expect(bar()?.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(bar()?.querySelector('img')).toBeNull();
  expect(bar()?.textContent).not.toContain('stack line');
  expect(bar()?.nextElementSibling).toBe(root);
  expect(bar()?.querySelector<HTMLButtonElement>('[data-debug-log]')?.disabled).toBe(true);
  bar()!.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!.click();
  expect(bar()).toBeNull();
  expect(root.textContent).toBe('Running app');
  error('Next error');
  expect(bar()?.textContent).toContain('Next error');
});

it('reports rejection reasons including objects without suppressing browser reporting', () => {
  stop = installFatalErrorBar();
  const event = new Event('unhandledrejection', { cancelable: true });
  Object.defineProperty(event, 'reason', { value: { message: 'Asynchronous failure' } });
  window.dispatchEvent(event);
  expect(bar()?.textContent).toContain('Asynchronous failure');
  expect(event.defaultPrevented).toBe(false);
});

it.each(['error', 'unhandledrejection'])('reveals an offscreen fatal bar for %s on a scrolled phone page', channel => {
  // happy-dom has no layout: model the normal-flow bar above a 1,200 px scroll.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: -1200, bottom: -1040, left: 0, right: 360, width: 360, height: 160,
    x: 0, y: -1200, toJSON: () => ({}),
  });
  const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  stop = installFatalErrorBar();
  if (channel === 'error') error('Scrolled page failure');
  else {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: new Error('Scrolled page failure') });
    window.dispatchEvent(event);
  }
  expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: 'start', behavior: 'instant' });
  expect(reveal.mock.instances[0]).toBe(bar());
  expect(bar()?.nextElementSibling).toBe(root);
  expect(bar()?.textContent).toContain('Scrolled page failure');
});

it.each([
  [-10, 150, true],
  [600, 760, true],
  [0, 160, false],
  [480, 640, false],
] as const)('reveals only a bar outside the viewport (top %s, bottom %s)', (top, bottom, offscreen) => {
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top, bottom, left: 0, right: 360, width: 360, height: 160,
    x: 0, y: top, toJSON: () => ({}),
  });
  const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  stop = installFatalErrorBar();
  error('Viewport boundary failure');
  expect(reveal).toHaveBeenCalledTimes(offscreen ? 1 : 0);
});

it.each(['ResizeObserver loop limit exceeded', 'ResizeObserver loop completed with undelivered notifications.'])(
  'ignores benign %s on both global channels', message => {
    stop = installFatalErrorBar();
    error(message);
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: new Error(message) });
    window.dispatchEvent(event);
    expect(bar()).toBeNull();
    error('A different ResizeObserver failure');
    expect(bar()).not.toBeNull();
    error(message);
    expect(bar()?.textContent).toContain('A different ResizeObserver failure');
  });

it('uses the separate C-H3 download hook and reports its failure without creating more bars', async () => {
  let downloaded = false;
  stop = installFatalErrorBar({ downloadSessionDebugLog: () => { downloaded = true; throw new Error('Download blocked'); } });
  error('Original failure');
  bar()!.querySelector<HTMLButtonElement>('[data-debug-log]')!.click();
  await vi.waitFor(() => expect(bar()?.textContent).toContain('Download blocked'));
  expect(downloaded).toBe(true);
  expect(document.querySelectorAll('.fatal-error-bar')).toHaveLength(1);
  stop();
  error('After cleanup');
  expect(bar()).toBeNull();
});

it('also reports synchronous startup failures while the root is empty', () => {
  root.textContent = '';
  const controller = installFatalErrorBar();
  stop = controller;
  controller.report(new Error('Startup failure'));
  expect(bar()?.textContent).toContain('Startup failure');
  expect(root.childElementCount).toBe(0);
});

it('allows one download at a time and enables retry when it finishes', async () => {
  let downloads = 0;
  let finish: () => void = () => {};
  stop = installFatalErrorBar({ downloadSessionDebugLog: () => {
    downloads++;
    return new Promise<void>(resolve => { finish = resolve; });
  } });
  error('Flight panel failure');
  const download = bar()!.querySelector<HTMLButtonElement>('[data-debug-log]')!;
  download.click();
  expect(download.disabled).toBe(true);
  download.click();
  await vi.waitFor(() => expect(downloads).toBe(1));
  finish();
  await vi.waitFor(() => expect(download.disabled).toBe(false));
});
