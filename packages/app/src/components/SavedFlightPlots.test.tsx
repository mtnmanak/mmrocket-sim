// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { SavedFlightPlots } from './SavedFlightPlots.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const apply = vi.fn();
const current = { panels: ['altitude', 'stabilityPercent'], comparison: 'phase' };
const render = () => act(() => root.render(<PrefsProvider><SavedFlightPlots current={current} onApply={apply} /></PrefsProvider>));
const click = (text: string) => act(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)!.click());
const name = (value: string) => act(() => {
  const input = host.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
beforeEach(() => { localStorage.clear(); apply.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('saves, reloads, recalls, renames and deletes a viewer layout with undo', () => {
  render(); name(' Coast '); click('Save current plots');
  expect(host.textContent).toContain('Saved Coast.');
  act(() => root.unmount()); root = createRoot(host); render();
  act(() => { const select = host.querySelector('select')!; select.value = select.options[1]!.value; select.dispatchEvent(new Event('change', { bubbles: true })); });
  click('Apply'); expect(apply).toHaveBeenLastCalledWith(current);
  name('Landing'); click('Rename');
  expect(host.querySelector('option:last-child')!.textContent).toBe('Landing');
  click('Delete'); expect(host.querySelectorAll('option')).toHaveLength(1);
  click('Undo delete'); expect(host.querySelector('option:last-child')!.textContent).toBe('Landing');
});
it.each(['randomUUID', 'crypto'])('saves distinct layouts, reloads and applies them without %s', missing => {
  vi.stubGlobal('crypto', missing === 'crypto' ? undefined : { getRandomValues: crypto.getRandomValues.bind(crypto) });
  render(); name('Coast'); click('Save current plots');
  expect(host.textContent).toContain('Saved Coast.');
  name('Landing'); click('Save current plots');
  expect(host.textContent).toContain('Saved Landing.');
  const ids = Array.from(host.querySelectorAll('option')).slice(1).map(option => option.value);
  expect(ids).toHaveLength(2);
  expect(ids.every(id => id.length > 0 && id.length <= 100)).toBe(true);
  expect(new Set(ids).size).toBe(2);
  expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!)).toMatchObject({
    flightPlots: [{ ...current, name: 'Coast', id: ids[0] }, { ...current, name: 'Landing', id: ids[1] }],
  });
  act(() => root.unmount()); root = createRoot(host); render();
  expect(Array.from(host.querySelectorAll('option')).slice(1).map(option => option.value)).toEqual(ids);
  for (const id of ids) {
    act(() => { const select = host.querySelector('select')!; select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); });
    click('Apply'); expect(apply).toHaveBeenLastCalledWith(current);
  }
  expect(apply).toHaveBeenCalledTimes(2);
});
it('rejects blank and duplicate names, preserves the original, and loads corrupt preferences safely', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ flightPlots: [null, { panels: 'bad' }] }));
  render(); click('Save current plots'); expect(host.querySelector('[role="alert"]')!.textContent).toContain('Enter a name');
  name('Coast'); click('Save current plots'); name('COAST'); click('Save current plots');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('already used');
  expect(host.querySelectorAll('option')).toHaveLength(2);
});
it('reports storage failure beside the saved layouts and keeps them usable this session', () => {
  render(); vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  name('Coast'); click('Save current plots'); click('Apply');
  expect(apply).toHaveBeenCalledWith(current);
  expect(host.textContent).toContain('only for this session');
});
