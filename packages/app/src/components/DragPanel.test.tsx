// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DragSweep, OrkRocket } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { LOCALE_DECIMAL_COMMA } from '../prefs/units.js';
import { DragPanel } from './DragPanel.js';
import { foldTypography } from '../services/textFold.js';

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

  const mount = (fileMachAlt?: [number, number][], designName = 'Test rocket') => act(() => root.render(
    <PrefsProvider>
      <DragPanel rocket={stubRocket(calls)} designName={designName} fileMachAlt={fileMachAlt} />
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

  /** Click "Drag table (.csv)"; the saved filename and the file's text. */
  const exportCsv = async (): Promise<{ saved: string; csv: string }> => {
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
    expect(blobs.length).toBe(1);
    return { saved, csv: await blobs[0]!.text() };
  };

  it('stamps the SAME conditions into the exported CSV as the chart caption shows', async () => {
    mount([[0, 0], [0.9, 7620], [5, 19202.4]]);
    openPanel();
    setSelect(condSelect(), 'file');
    const { saved, csv } = await exportCsv();
    // The design name is stamped into the filename: the code comment above
    // exportCsv records a bare drag-analysis.csv being posted to a forum under
    // the wrong model's name.
    expect(saved).toBe('Test_rocket-drag-table.csv');
    const line = csv.split('\n').find((l) => l.startsWith('# conditions:'))!;
    // The same words as the caption, with its typography folded to ASCII
    // (textFold.foldTypography) — the file carries no BOM, so an em dash here
    // is what Excel opened as "â€”" (audit 2026-09-22).
    expect(line).toBe(
      `# conditions: ${foldTypography(caption().replace(/^Conditions: /, '').replace(/ — Reynolds.*$/, ''))}`);
    expect(line).toBe('# conditions: file Mach-Alt table - 3 points from Mach 0 to 5 (0-19202 m ISA)');
    // Commas would read as extra cells in a naive parser — the header block is
    // deliberately comma-free even though the table below it is not.
    expect(line).not.toContain(',');
  });

  it('writes an ASCII header block that opens clean in Excel, and one line per field', async () => {
    // No BOM, by design (the leading # block is parsed by other tools), so
    // Excel reads the file as ANSI: the sea-level line's "20 °C — the kernel
    // default" opened as "20 Â°C â€” the kernel default" (audit 2026-09-22).
    mount(undefined, 'Big “Bertha”\nMk 2, rev B');
    openPanel();
    const { csv } = await exportCsv();
    expect(csv.charCodeAt(0)).not.toBe(0xFEFF);
    const lines = csv.split('\n');
    const header = lines.slice(0, lines.findIndex((l) => l.startsWith('mach,')) + 1);
    expect(header).toHaveLength(5);
    for (const l of header) expect(l).toMatch(/^[\x20-\x7e]*$/);
    expect(header[1]).toBe('# design: Big "Bertha" Mk 2; rev B');
    expect(header[3]).toBe('# conditions: sea level (101325 Pa; 20 degC - the kernel default)');
    // ...while the chart caption on screen keeps the real typography.
    expect(caption()).toMatch(/20 °C — the kernel default/);
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

  /**
   * Audit 2026-09-22: the bare box read "10,000" as NaN and swept at SEA LEVEL
   * while still showing 10,000; only the caption under the chart said so. It
   * is a NumField now, so a draft it cannot read is marked at the input.
   */
  it('marks "10,000" invalid at the box instead of silently sweeping at sea level', () => {
    mount();
    openPanel();
    setSelect(condSelect(), 'altitude');
    const input = altInput()!;
    act(() => input.focus());
    type(input, '10,000');
    if (!LOCALE_DECIMAL_COMMA) {
      expect(input.getAttribute('aria-invalid')).toBe('true');
      // Nothing was committed, so the sweep is honestly still the default one,
      // and leaving the box shows the blank it is flying rather than 10,000.
      expect(Object.keys(calls[calls.length - 1] as object)).toEqual(['machMax']);
      act(() => input.blur());
      expect(input.value).toBe('');
    }
  });

  it('converts a typed altitude from the display unit', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: 'ft' } }));
    mount();
    openPanel();
    setSelect(condSelect(), 'altitude');
    type(altInput()!, '10000');
    const opts = calls[calls.length - 1] as { machAlt: [number, number][] };
    expect(opts.machAlt[0]![1]).toBeCloseTo(3048, 6);
  });

  /**
   * Audit 2026-09-22, Performance: the Max Mach range was clamped by an effect,
   * one render late. App rebuilds the rocket when the aero model changes, so
   * switching the supersonic model off at Mach 25 swept the new Barrowman
   * handle to Mach 25 first — the costliest sweep there is, on a model the
   * menu does not even offer it for — and then again to 5.
   */
  it('switching the supersonic model off at Mach 25 sweeps once, to Mach 5', () => {
    // A new handle per render, as App's buildResult hands one over per model.
    const render = (supersonicModel: boolean) => act(() => root.render(
      <PrefsProvider>
        <DragPanel rocket={stubRocket(calls)} supersonicModel={supersonicModel} />
      </PrefsProvider>,
    ));
    const machsSince = (n: number) => calls.slice(n).map((o) => (o as { machMax: number }).machMax);
    render(true);
    openPanel();
    const machSel = host.querySelector('select') as HTMLSelectElement; // Max Mach, the first control
    setSelect(machSel, '25');
    expect(machsSince(calls.length - 1)).toEqual([25]);
    let before = calls.length;
    render(false);
    expect(machsSince(before)).toEqual([5]);
    expect(machSel.value).toBe('5');
    // Back on, the range starts from 5, as it always has.
    before = calls.length;
    render(true);
    expect(machsSince(before)).toEqual([5]);
    expect(machSel.value).toBe('5');
  });

  /**
   * Audit 2026-09-22, Performance: every keystroke NumField could read was a
   * new atmosphere and a whole synchronous sweep in render — typing "10000" at
   * Mach 25 swept at 1, 10, 100, 1000 and 10000 ft, ~1.5 s of a frozen page
   * on LEM-IV. What is typed now waits for the box to let go.
   */
  describe('a typed altitude sweeps once, when the box lets go', () => {
    const typeFocused = (drafts: string[]) => {
      const input = altInput()!;
      act(() => input.focus());
      for (const d of drafts) type(input, d);
      return input;
    };
    const lastAlt = () => (calls[calls.length - 1] as { machAlt?: [number, number][] }).machAlt?.[0]?.[1];

    beforeEach(() => {
      localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: 'ft' } }));
    });

    it('five keystrokes are no sweep; the blur is one, at the whole number', () => {
      mount();
      openPanel();
      setSelect(condSelect(), 'altitude');
      const before = calls.length;
      const input = typeFocused(['1', '10', '100', '1000', '10000']);
      expect(calls.length).toBe(before);
      // The chart has not moved, and neither has the caption that names its air.
      expect(caption()).toMatch(/sea level/);
      act(() => input.blur());
      expect(calls.length).toBe(before + 1);
      expect(lastAlt()).toBeCloseTo(3048, 6);
      expect(caption()).toMatch(/ISA at 10000 ft/);
    });

    it('Enter lets go of the box, and sweeps', () => {
      mount();
      openPanel();
      setSelect(condSelect(), 'altitude');
      const before = calls.length;
      const input = typeFocused(['5', '50', '500']);
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(calls.length).toBe(before + 1);
      expect(lastAlt()).toBeCloseTo(152.4, 6);
    });

    it('clearing a typed altitude back to blank sweeps sea level once, on blur', () => {
      mount();
      openPanel();
      setSelect(condSelect(), 'altitude');
      type(altInput()!, '10000'); // unfocused: a direct commit
      expect(lastAlt()).toBeCloseTo(3048, 6);
      const before = calls.length;
      const input = typeFocused(['1000', '100', '10', '1', '']);
      expect(calls.length).toBe(before);
      act(() => input.blur());
      expect(calls.length).toBe(before + 1);
      expect(Object.keys(calls[calls.length - 1] as object)).toEqual(['machMax']);
    });

    it('a spinner click never focuses the box, so it sweeps at once', () => {
      mount();
      openPanel();
      setSelect(condSelect(), 'altitude');
      const before = calls.length;
      const up = altInput()!.closest('.numfield')!.querySelector('button[aria-label="Increment"]') as HTMLButtonElement;
      act(() => up.click());
      expect(calls.length).toBe(before + 1);
      // One step of the box's own ladder from blank = 0 ft.
      expect(lastAlt()).toBeGreaterThan(0);
    });

    it('leaving the box without typing sweeps nothing', () => {
      mount();
      openPanel();
      setSelect(condSelect(), 'altitude');
      const before = calls.length;
      const input = typeFocused([]);
      act(() => input.blur());
      expect(calls.length).toBe(before);
    });
  });

  /**
   * Review of the audit fix: the bare input had its own `width: 76`, and the
   * NumField that replaced it sat in a 96 px wrapper that nothing made it
   * fill — outside a `.field` no rule sizes a NumField's input, so it drew at
   * the browser's default ~159 px with the spinner on its digits. There is no
   * layout in this suite, so this pins the two halves that decide it: the box
   * is inside the sizing wrapper, and the sheet sizes an input there.
   */
  it('the altitude box fills its wrapper instead of the default input width', () => {
    mount();
    openPanel();
    setSelect(condSelect(), 'altitude');
    const wrap = altInput()!.closest('.inline-numfield') as HTMLElement | null;
    expect(wrap).not.toBeNull();
    expect(wrap!.style.width).toBe('96px');
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.inline-numfield\s+\.numfield\s+input\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'no .inline-numfield .numfield input rule').not.toBeNull();
    expect(rule![1]).toMatch(/(?:^|[;\s])width:\s*100%/);
    expect(rule![1]).toMatch(/(?:^|[;\s])box-sizing:\s*border-box/);
  });
});

/**
 * Audit 2026-09-22, row 463: the three drag charts' ↺ and ⤢ buttons shared one
 * name ("Reset chart view", "Expand chart") across all three, and the charts
 * were unnamed canvases that never said the Drag table (.csv) holds the same
 * numbers.
 */
describe('DragPanel — charts a screen reader can tell apart', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
      realError(...args);
    });
    act(() => root.render(
      <PrefsProvider>
        <DragPanel rocket={stubRocket([])} designName="Test rocket" />
      </PrefsProvider>,
    ));
    act(() => { (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('names each chart button for its own chart', () => {
    const names = [...host.querySelectorAll('.chart-head-btns button')].map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'Reset the drag coefficient chart view', 'Expand the drag coefficient chart',
      'Reset the center of pressure chart view', 'Expand the center of pressure chart',
      'Reset the drag breakdown chart view', 'Expand the drag breakdown chart',
    ]);
  });

  it('names each chart canvas with its curves and the CSV that holds them', () => {
    const named = [...host.querySelectorAll('canvas[role="img"]')].map((c) => c.getAttribute('aria-label') ?? '');
    expect(named).toHaveLength(3);
    expect(named[0]).toMatch(/^Drag coefficient vs Mach, Mach 0\.5 to Mach 3\. /);
    expect(named[0]).toContain('0.4 at Mach 0.5');
    expect(named[1]).toMatch(/^Center of pressure vs Mach/);
    expect(named[2]).toMatch(/^Drag breakdown \(power-off\) vs Mach/);
    expect(named[2]).toContain('Nose cone');
    for (const n of named) expect(n).toContain('The Drag table (.csv) download above holds the same numbers.');
  });
});
