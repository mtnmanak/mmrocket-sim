// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WarningCode } from '../components/WarningCode.js';
import { Modal } from '../components/Modal.js';
import { openModalCount } from '../components/useDialog.js';
import { installFatalErrorBar } from './fatalErrorBar.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;
let stop: (() => void) | undefined;
beforeEach(() => {
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  root = createRoot(host);
  style = document.createElement('style');
  style.textContent = readFileSync('src/styles.css', 'utf8');
  document.head.append(style);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  act(() => root.unmount());
  host.remove();
  style.remove();
  vi.restoreAllMocks();
});

function report(channel: string, message = 'Modal-time failure') {
  if (channel === 'error') window.dispatchEvent(new ErrorEvent('error', { message }));
  else {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: new Error(message) });
    window.dispatchEvent(event);
  }
}

function tab(from: HTMLElement, shiftKey = false) {
  from.focus();
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  act(() => { from.dispatchEvent(event); });
  return event;
}

function openLookup() {
  act(() => root.render(<WarningCode code="I03.left-out" />));
  const trigger = host.querySelector<HTMLButtonElement>('.warning-code')!;
  trigger.focus();
  act(() => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[aria-label="Note explanations"]')!;
  const overlay = dialog.closest<HTMLElement>('.prefs-overlay')!;
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ZERO_AREA_FIN');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.focus();
  return { dialog, overlay, input };
}

it.each(['error', 'unhandledrejection'])('makes fatal actions available during Note explanations for %s, then restores the dialog', async channel => {
  let downloads = 0;
  stop = installFatalErrorBar({ downloadSessionDebugLog: () => { downloads++; } });
  const { dialog, overlay, input } = openLookup();
  expect(getComputedStyle(overlay).display).toBe('flex');
  report(channel);
  const bar = document.querySelector<HTMLElement>('.fatal-error-bar')!;
  const dismiss = bar.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!;
  const download = bar.querySelector<HTMLButtonElement>('[data-debug-log]')!;
  // No viewport-covering backdrop remains to intercept a pointer to the bar.
  expect(getComputedStyle(overlay).display).toBe('none');
  expect(overlay.hasAttribute('inert')).toBe(true);
  expect(bar.nextElementSibling).toBe(host);
  expect(getComputedStyle(bar).position).not.toMatch(/fixed|sticky|absolute/);
  expect(document.activeElement).toBe(dismiss);
  expect(tab(dismiss, true).defaultPrevented).toBe(false);
  // happy-dom does not execute native Tab: focus its preceding enabled control.
  download.focus();
  expect(document.activeElement).toBe(download);
  expect(tab(download).defaultPrevented).toBe(false);
  download.click();
  await vi.waitFor(() => expect(downloads).toBe(1));
  dismiss.click();
  expect(document.querySelector('.fatal-error-bar')).toBeNull();
  expect(getComputedStyle(overlay).display).toBe('flex');
  expect(overlay.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('[aria-label="Note explanations"]')).toBe(dialog);
  expect(input.value).toBe('ZERO_AREA_FIN');
  expect(document.activeElement).toBe(input);
  const first = dialog.querySelector<HTMLButtonElement>('button')!;
  const last = [...dialog.querySelectorAll<HTMLButtonElement>('button')].at(-1)!;
  expect(tab(last).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(first);
});

it('keeps nested modals suspended through replacement errors and restores the topmost focus on cleanup', () => {
  const { dialog, overlay, input } = openLookup();
  act(() => root.render(<><WarningCode code="I03.left-out" /><Modal label="Keep design" onClose={() => {}}>
    <button>Keep</button><button>Cancel</button>
  </Modal></>));
  // The lookup remains mounted when its sibling confirmation opens.
  expect(document.querySelector('[aria-label="Note explanations"]')).toBe(dialog);
  const modal = document.querySelector<HTMLElement>('[aria-label="Keep design"]')!;
  const backdrop = modal.closest<HTMLElement>('.modal-backdrop')!;
  const cancel = modal.querySelectorAll<HTMLButtonElement>('button')[1]!;
  cancel.focus();
  stop = installFatalErrorBar();
  report('error');
  report('unhandledrejection', 'Replacement failure');
  expect(document.querySelectorAll('.fatal-error-bar')).toHaveLength(1);
  expect(document.querySelector('.fatal-error-bar')?.textContent).toContain('Replacement failure');
  expect(getComputedStyle(overlay).display).toBe('none');
  expect(getComputedStyle(backdrop).display).toBe('none');
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => { document.activeElement?.dispatchEvent(escape); });
  expect(escape.defaultPrevented).toBe(false);
  expect(openModalCount()).toBe(2);
  stop();
  expect(overlay.style.display).toBe('');
  expect(backdrop.style.display).toBe('');
  expect(overlay.hasAttribute('inert')).toBe(false);
  expect(backdrop.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(cancel);
  expect(input.value).toBe('ZERO_AREA_FIN');
});

it('suspends a dialog mounted after an error without stealing fatal focus', () => {
  stop = installFatalErrorBar();
  report('error');
  const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!;
  act(() => root.render(<Modal label="Late dialog" onClose={() => {}}><button>Keep</button></Modal>));
  const backdrop = host.querySelector<HTMLElement>('.modal-backdrop')!;
  expect(getComputedStyle(backdrop).display).toBe('none');
  expect(document.activeElement).toBe(dismiss);
  dismiss.click();
  expect(backdrop.style.display).toBe('');
  expect(document.activeElement?.textContent).toBe('Keep');
});

it('leaves a modal and its focus intact for benign observer-loop errors', () => {
  const { overlay, input } = openLookup();
  stop = installFatalErrorBar();
  report('error', 'ResizeObserver loop limit exceeded');
  report('unhandledrejection', 'ResizeObserver loop completed with undelivered notifications.');
  expect(document.querySelector('.fatal-error-bar')).toBeNull();
  expect(getComputedStyle(overlay).display).toBe('flex');
  expect(overlay.hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(input);
});

it('does not pull focus away from fatal actions when a suspended modal unmounts', () => {
  openLookup();
  stop = installFatalErrorBar();
  report('error');
  const dismiss = document.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]')!;
  act(() => root.render(<p>App recovered</p>));
  expect(openModalCount()).toBe(0);
  expect(document.activeElement).toBe(dismiss);
  dismiss.click();
  expect(document.querySelector('.fatal-error-bar')).toBeNull();
  expect(host.textContent).toBe('App recovered');
});
