// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DragSweep, OrkRocket } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DragPanel } from './DragPanel.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and uPlot draws into one on a rAF tick — an
// unhandled "Cannot read properties of null (reading 'clearRect')" that fails
// the file long after the assertions passed. A no-op 2D context is enough:
// these tests are about the OPTIONS the panel computes, never about pixels.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;
const realError = console.error.bind(console);

/**
 * The panel's CONDITIONS control (sweep altitude / imported Mach-Alt table).
 * The regression that matters most here is the negative one: with the control
 * left alone the kernel must be called exactly as it was before the control
 * existed — no `machAlt` key at all. Sea level in the kernel is
 * FlightConditions' own default (101325 Pa at 293.15 K); ISA sea level is
 * 288.15 K, and passing `[[0, 0]]` instead of nothing moves CD by up to
 * 0.0017 on the ARCAS fixture. "Nothing" is therefore not a formality.
 */

const machs = [0.5, 1, 1.5, 2, 2.5, 3];
const flat = (v: number) => machs.map(() => v);

function stubSweep(): DragSweep {
  return {
    machs,
    hasNozzle: false,
    cp: flat(0.5),
    cna: flat(12),
    powerOff: { total: flat(0.4), friction: flat(0.1), pressure: flat(0.2), base: flat(0.1) },
    powerOn: { total: flat(0.35), friction: flat(0.1), pressure: flat(0.2), base: flat(0.05) },
    components: [{ name: 'Nose cone', cd: flat(0.1) }],
  } as DragSweep;
}

/** Records every options object the panel hands the kernel. */
function stubRocket(calls: unknown[]): OrkRocket {
  return {
    dragSweep: (opts: unknown) => { calls.push(opts); return stubSweep(); },
    staticInfo: () => ({ length: 1.2 }),
  } as unknown as OrkRocket;
}

describe('DragPanel — sweep conditions', () => {
  let host: HTMLDivElement;
  let root: Root;
  let calls: unknown[];

  beforeEach(() => {
    localStorage.clear();
    calls = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    // uPlot finishes drawing on a microtask AFTER mount and calls back into
    // React state (the chart's zoom reporter), which React reports as "not
    // wrapped in act(...)" — a dozen stack dumps per run in a suite that never
    // asserts on pixels. ONLY that message is swallowed.
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
      realError(...args);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const mount = (fileMachAlt?: [number, number][]) => act(() => root.render(
    <PrefsProvider>
      <DragPanel rocket={stubRocket(calls)} designName="Test rocket" fileMachAlt={fileMachAlt} />
    </PrefsProvider>,
  ));
  const openPanel = () => act(() => {
    (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click();
  });
  const condSelect = () => host.querySelector('select[aria-label="Sweep conditions"]') as HTMLSelectElement;
  const altInput = () => host.querySelector('input[aria-label^="Sweep altitude"]') as HTMLInputElement | null;
  const setSelect = (el: HTMLSelectElement, value: string) => act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  /** React tracks the last value it wrote; go through the native setter or the
   *  synthetic onChange never fires (same helper as PreferencesDialog.test). */
  const type = (el: HTMLInputElement, value: string) => act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const caption = () => Array.from(host.querySelectorAll('p'))
    .map((p) => p.textContent ?? '').find((t) => t.startsWith('Conditions:')) ?? '';

  it('sweeps with no machAlt key at all until the user asks for one', () => {
    mount();
    openPanel();
    expect(calls.length).toBeGreaterThan(0);
    for (const opts of calls) {
      expect(Object.keys(opts as object)).toEqual(['machMax']);
    }
    expect(caption()).toMatch(/sea level \(101325 Pa; 20 °C/);
  });

  it('offers the file Mach-Alt table only when the design carries one', () => {
    mount();
    openPanel();
    expect(Array.from(condSelect().options).map((o) => o.value)).toEqual(['sealevel', 'altitude']);

    act(() => root.unmount());
    root = createRoot(host);
    calls = [];
    mount([[0, 0], [0.9, 7620], [5, 19202.4]]);
    openPanel();
    expect(Array.from(condSelect().options).map((o) => o.value))
      .toEqual(['sealevel', 'altitude', 'file']);
    // Offered, NOT applied: the default curve is unchanged by the import.
    expect(Object.keys(calls[calls.length - 1] as object)).toEqual(['machMax']);
    expect(caption()).toMatch(/Mach-Alt table/); // the nudge to switch
  });

  it('passes the file table through verbatim when chosen', () => {
    const table: [number, number][] = [[0, 0], [0.9, 7620], [5, 19202.4]];
    mount(table);
    openPanel();
    setSelect(condSelect(), 'file');
    const opts = calls[calls.length - 1] as { machMax: number; machAlt: [number, number][] };
    expect(opts.machAlt).toEqual(table);
    expect(caption()).toMatch(/file Mach-Alt table — 3 points from Mach 0 to 5 \(0–19202 m ISA\)/);
    expect(caption()).toMatch(/Reynolds number is matched/);
  });

  it('stamps the SAME conditions into the exported CSV as the chart caption shows', async () => {
    mount([[0, 0], [0.9, 7620], [5, 19202.4]]);
    openPanel();
    setSelect(condSelect(), 'file');
    let csv = '';
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return 'blob:conditions-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // Match the label exactly — it also pins it. Every download button on the
    // Results tab now names its DATA, with the format as the parenthetical;
    // three different datasets used to be labelled "⬇ CSV".
    const csvBtn = Array.from(host.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Drag table (.csv)')) as HTMLButtonElement;
    expect(csvBtn).toBeTruthy();
    let saved = '';
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved = this.download;
    };
    try {
      act(() => { csvBtn.click(); });
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    // The design name is stamped into the filename: the code comment above
    // exportCsv records a bare drag-analysis.csv being posted to a forum under
    // the wrong model's name.
    expect(saved).toBe('Test_rocket-drag-table.csv');
    csv = await blobs[0]!.text();
    const line = csv.split('\n').find((l) => l.startsWith('# conditions:'))!;
    expect(line).toBe(`# conditions: ${caption().replace(/^Conditions: /, '').replace(/ — Reynolds.*$/, '')}`);
    expect(line).toMatch(/file Mach-Alt table/);
    // Commas would read as extra cells in a naive parser — the header block is
    // deliberately comma-free even though the table below it is not.
    expect(line).not.toContain(',');
  });

  it('turns a typed altitude into a constant-altitude table, and blank back into sea level', () => {
    mount();
    openPanel();
    setSelect(condSelect(), 'altitude');
    // Empty box is still the default sweep — nothing typed, nothing changed.
    expect(Object.keys(calls[calls.length - 1] as object)).toEqual(['machMax']);

    const input = altInput()!;
    type(input, '3048'); // metres: the app's default distance unit
    const opts = calls[calls.length - 1] as { machAlt: [number, number][] };
    expect(opts.machAlt[0]![1]).toBeCloseTo(3048, 6);
    // Both rows share the altitude, so every Mach in the sweep sees it.
    expect(opts.machAlt[1]![1]).toBeCloseTo(3048, 6);
    expect(opts.machAlt[1]![0]).toBeGreaterThan(25); // above any selectable machMax
    expect(caption()).toMatch(/ISA at 3048 m/);

    type(input, '');
    expect(Object.keys(calls[calls.length - 1] as object)).toEqual(['machMax']);
  });
});
