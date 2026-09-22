// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MotorBrowser } from './MotorBrowser.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The motor database's sortable column headers.
 *
 * They carried `role="button"` alongside `aria-sort`. `aria-sort` is defined
 * only on a columnheader, so the role override made the attribute on that very
 * element inert — a screen reader said "Impulse (Ns), button" and never "sorted
 * descending", and got no feedback at all when the sort changed. Worse, with
 * all six headers no longer columnheaders the 400 data rows below lost their
 * column association, so arrowing through them stopped announcing which column
 * a cell was in.
 *
 * The fix keeps the tab stop and the Enter/Space handler and drops only the
 * role — the rule clickable.ts already states for the rest of the app.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MotorBrowser — sortable headers stay column headers', () => {
  let host: HTMLDivElement;
  let root: Root;

  const headers = () => Array.from(host.querySelectorAll('thead th'));
  const impulse = () => headers()
    .find((th) => (th.textContent ?? '').includes('Impulse'))!;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(
      <PrefsProvider>
        <MotorBrowser mountDiameterMm={24} maxMotorLengthM={null}
          onSelect={() => {}} onClose={() => {}} />
      </PrefsProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('sets no role, so the implicit columnheader survives', () => {
    expect(headers().length).toBe(6);
    for (const th of headers()) expect(th.getAttribute('role')).toBe(null);
  });

  it('keeps the tab stop that made sorting reachable in the first place', () => {
    for (const th of headers()) expect(th.getAttribute('tabindex')).toBe('0');
  });

  it('still sorts on Enter, and aria-sort now means something', () => {
    // Default sort is by impulse; activating its header flips the direction.
    const before = impulse().getAttribute('aria-sort');
    expect(before).not.toBeNull();
    act(() => {
      impulse().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(impulse().getAttribute('aria-sort')).not.toBe(before);
  });

  it('marks exactly one column as sorted', () => {
    expect(headers().filter((th) => th.hasAttribute('aria-sort')).length).toBe(1);
  });
});

// ---------------------------------------------------------------- harness
//
// Audit 2026-09-22 (row 478): the four tests above were the whole of this
// file's coverage — nothing drove a pick, a load, an import or the catalogue
// check. The blocks below do, through the real component and the real shipped
// catalogue, the way a user does: search, click a row, press Load.

const FILTERS_KEY = 'online-openrocket.motor-filters.v1';

interface Harness {
  host: HTMLDivElement;
  root: Root;
  selected: { label: string; ejectionDelay: number }[];
}

function openBrowser(props: { mountDiameterMm: number; filters?: Record<string, unknown> }): Harness {
  if (props.filters) localStorage.setItem(FILTERS_KEY, JSON.stringify(props.filters));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const selected: Harness['selected'] = [];
  act(() => root.render(
    <PrefsProvider>
      <MotorBrowser mountDiameterMm={props.mountDiameterMm} maxMotorLengthM={null}
        onSelect={(label, spec) => selected.push({ label, ejectionDelay: spec.ejectionDelay })}
        onClose={() => {}} />
    </PrefsProvider>,
  ));
  return { host, root, selected };
}

function closeBrowser(h: Harness): void {
  act(() => h.root.unmount());
  h.host.remove();
  localStorage.clear();
}

/** Native setter + input event — how React sees a real keystroke. */
function typeInto(el: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const search = (h: Harness, text: string) =>
  typeInto(h.host.querySelector<HTMLInputElement>('input[type="search"]')!, text);
const bodyRows = (h: Harness) => Array.from(h.host.querySelectorAll<HTMLTableRowElement>('tbody tr'));
const rowFor = (h: Harness, mfr: string, designation: string) => bodyRows(h).find((tr) =>
  tr.cells[1]?.textContent === mfr && (tr.cells[0]?.textContent ?? '').replace(/OOP$/, '').trim() === designation);
const delaySelect = (h: Harness) => h.host.querySelector<HTMLSelectElement>('.motor-load-row select');
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
/** Lets pending promises (a lazy JSON chunk, a file read) settle inside act. */
const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const loadButton = (h: Harness) => Array.from(h.host.querySelectorAll('button'))
  .find((b) => /Load motor|Loading/.test(b.textContent ?? ''));

describe('MotorBrowser — the delay a fresh pick starts at (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  it('a motor that lists no usable delay starts on Auto, not on a made-up 0 s', () => {
    // KBA G135R's catalogue delay field is "M" — nothing a number can be read from.
    h = openBrowser({ mountDiameterMm: 29, filters: { includeOOP: true } });
    search(h, 'G135');
    click(rowFor(h, 'KBA', 'G135R')!);
    expect(delaySelect(h)!.value).toBe('auto');
  });

  it('an ordinary motor still starts on its longest prescribed delay', () => {
    h = openBrowser({ mountDiameterMm: 18 });
    search(h, 'C6');
    click(rowFor(h, 'Estes', 'C6')!);
    expect(delaySelect(h)!.value).toBe('7');
  });
});

describe('MotorBrowser — a motor refused on its catalogue weight but not its file (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  it('Estes 1/2A6 — no catalogue weight, good bundled file — is pickable and loads', async () => {
    h = openBrowser({ mountDiameterMm: 18 });
    search(h, '1/2A6');
    // The bundle chunk behind fileMassed is 840 kB of JSON; wait for it.
    for (let i = 0; i < 100 && rowFor(h, 'Estes', '1/2A6')!.hasAttribute('aria-disabled'); i++) await settle(50);
    const row = rowFor(h, 'Estes', '1/2A6')!;
    expect(row.getAttribute('aria-disabled')).toBeNull();
    click(row);
    click(loadButton(h)!);
    for (let i = 0; i < 20 && h.selected.length === 0; i++) await settle(10);
    expect(h.selected.map((s) => s.label)).toEqual(['1/2A6-2']);
  });

  it('a motor with no weight anywhere stays locked', async () => {
    // KBA K1000S carries no catalogue weight and has no bundled file at all.
    h = openBrowser({ mountDiameterMm: 54, filters: { includeOOP: true } });
    search(h, 'K1000S');
    await settle(500);
    const row = rowFor(h, 'KBA', 'K1000S');
    expect(row, 'KBA K1000S has left the catalogue').toBeTruthy();
    expect(row!.getAttribute('aria-disabled')).toBe('true');
  });
});
