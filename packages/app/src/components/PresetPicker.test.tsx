// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { PresetPicker } from './PresetPicker.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { loadCustomPresets, saveCustomPresets, type Preset } from '../services/presets.js';

/**
 * The CSV round trip this dialog advertises (⬇ CSV, "Import an edited CSV") is
 * the one path in the app where a spreadsheet's idea of a number reaches a
 * component's material. Two things had to be true and were not:
 *
 *  - a density cell a spreadsheet wrote as "1,250" or "0.68 g/cm3" is NaN, and
 *    `csvToPresets` sets it unguarded. Stored, that row applies its material
 *    NAME while the density silently vanishes (JSON turns NaN into null and
 *    presetPatch skips null) — a part relabelled fibreglass still weighed as
 *    cardboard, with no error anywhere.
 *  - `saveCustomPresets` swallows a localStorage failure, and localStorage is
 *    the ONLY store, so a blocked or full browser reported "Imported 2
 *    preset(s) — stored in this browser" over a list that had not changed.
 *
 * The bundled catalogue is a 1.3 MB lazy JSON import; it is mocked away so the
 * table shows nothing but what these tests import.
 */
vi.mock('../data/presets.json', () => ({ default: { presets: [] } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const CSV = [
  'kind,manufacturer,partNo,description,materialName,materialType,materialDensity,outsideDiameter,length',
  'BodyTube,ACME,GOOD-1,Sound row,Cardboard,BULK,680,0.024,0.3',
  'BodyTube,ACME,BAD-1,Density with a unit on it,Fiberglass,BULK,0.68 g/cm3,0.024,0.3',
].join('\n');

const render = async () => {
  act(() => {
    root.render(
      <PrefsProvider>
        <PresetPicker
          type={'bodytube' as ComponentNode['type']}
          onApply={() => {}}
          onClose={() => {}}
        />
      </PrefsProvider>,
    );
  });
  await flush();
};

/** Flush the microtask `loadPresets` resolves on, inside act(). */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

/** Feed a CSV through the hidden file input the ⬆ CSV label wraps. */
const importCsv = async (text: string) => {
  const el = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([text], 'presets.csv', { type: 'text/csv' });
  Object.defineProperty(el, 'files', { configurable: true, value: [file] });
  await act(async () => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // The read is async (File.text()), then two more setStates land on the
    // loadPresets promise.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await flush();
};

const text = () => host.textContent ?? '';

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('PresetPicker — CSV import', () => {
  it('imports the sound row and skips the one whose density is not a number', async () => {
    await render();
    await importCsv(CSV);

    expect(text()).toContain('Imported 1 preset(s)');
    expect(text()).toContain('1 row(s) skipped');
    expect(text()).toContain('BAD-1'); // named, so the user can go fix that row

    const stored = loadCustomPresets();
    expect(stored.map((p) => p.partNo)).toEqual(['GOOD-1']);
    expect(stored[0]!.material).toEqual({ name: 'Cardboard', type: 'BULK', density: 680 });
  });

  it('imports nothing, and says so, when every row has a bad density', async () => {
    await render();
    await importCsv([
      'kind,manufacturer,partNo,description,materialName,materialType,materialDensity',
      'BodyTube,ACME,BAD-1,Thousands separator,Fiberglass,BULK,"1,250"',
    ].join('\n'));

    expect(text()).toContain('Nothing imported.');
    expect(loadCustomPresets()).toEqual([]);
  });

  it('does not claim an import was stored when localStorage refused it', async () => {
    await render();
    // Exactly what a private window or a full quota does: setItem throws, and
    // saveCustomPresets swallows it.
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    await importCsv(CSV);

    expect(text()).toContain('Could not store 1 of 1 preset(s)');
    expect(text()).not.toContain('Imported 1 preset(s)');
    expect(text()).toContain('1 row(s) skipped'); // the bad row is still reported
  });

  /**
   * Audit 2026-09-22: a CSV with a density column but NO materialName column
   * parsed each material with an undefined name, and the soundness check's
   * `m.name.trim()` threw — "CSV import failed: Cannot read properties of
   * undefined", nothing imported and no row named. A missing name is a half
   * pair like any other: that row is skipped and named, and the rest import.
   */
  it('skips and names a row whose material has a density but no name column', async () => {
    await render();
    await importCsv([
      'kind,manufacturer,partNo,description,materialDensity,outsideDiameter',
      'BodyTube,ACME,NONAME-1,Density only,680,0.024',
      'BodyTube,ACME,PLAIN-1,No material at all,,0.024',
    ].join('\n'));

    expect(text()).not.toContain('CSV import failed');
    expect(text()).toContain('Imported 1 preset(s)');
    expect(text()).toContain('1 row(s) skipped');
    expect(text()).toContain('NONAME-1');
    expect(loadCustomPresets().map((p) => p.partNo)).toEqual(['PLAIN-1']);
  });
});

describe('PresetPicker — dimensions', () => {
  const T24 = JSON.stringify([{
    kind: 'BodyTube', manufacturer: 'ACME', partNo: 'T-24', description: '',
    outsideDiameter: 0.02413, length: 0.4572,
  }]);

  it('keeps a part’s size readable in metres rather than "⌀0.0 L0.5 m"', async () => {
    // Audit 2026-09-22: one fixed decimal in the DISPLAY unit printed a 24 mm
    // tube as ⌀0.0 in metres, and every sub-50 mm part the same way.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'm' } }));
    localStorage.setItem('online-openrocket.custom-presets.v1', T24);
    await render();
    expect(text()).toContain('⌀0.0241 L0.457 m');
  });

  it('shows millimetres to one decimal, as before', async () => {
    localStorage.setItem('online-openrocket.custom-presets.v1', T24);
    await render();
    expect(text()).toContain('⌀24.1 L457.2 mm');
  });
});

describe('PresetPicker — labelling', () => {
  it('gives the search box an accessible name naming all three fields it matches', async () => {
    await render();
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    // A placeholder is not an accessible name; without this the box was
    // announced as a bare "search edit".
    expect(search.getAttribute('aria-label'))
      .toBe('Search part number, description or manufacturer');
  });

  it('keeps the ⬆ CSV file input in the Tab order, named (audit 2026-09-22)', async () => {
    // display:none took it out of the Tab order; the App header's Open… was
    // fixed the same way (styles.css .file-btn-input).
    await render();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.style.display).not.toBe('none');
    expect(input.classList.contains('file-btn-input')).toBe(true);
    expect(input.tabIndex).not.toBe(-1);
    expect(input.getAttribute('aria-label')).toBe('Import presets from a CSV file');
  });

  it('keeps its status region mounted before the first message (audit 2026-09-22)', async () => {
    // Rendered only with its text in place, it was announced unreliably.
    await render();
    const region = host.querySelector('.motor-browser > [role="status"]')!;
    expect(region.textContent).toBe('');
    await importCsv(CSV);
    expect(host.querySelector('.motor-browser > [role="status"]')).toBe(region);
    expect(region.textContent).toMatch(/Imported 1 preset\(s\)/);
  });
});

/**
 * Review of the audit 2026-09-22 presetPatch fix: a pick of a part with no
 * catalogue mass cleared EVERY mass override, including one the user typed.
 * The picker now hands presetPatch the node it replaces and the catalogue it
 * shows, so only the previous part's catalogue mass is cleared.
 */
describe('PresetPicker — a pick and the mass override', () => {
  const rows: Preset[] = [
    { kind: 'BodyTube', manufacturer: 'ACME', partNo: 'HEAVY-1', description: 'massed', mass: 0.04,
      outsideDiameter: 0.041, insideDiameter: 0.04, length: 0.3 },
    { kind: 'BodyTube', manufacturer: 'ACME', partNo: 'PLAIN-1', description: 'no mass',
      outsideDiameter: 0.041, insideDiameter: 0.04, length: 0.45 },
  ];
  const pickPlain = async (node: ComponentNode) => {
    saveCustomPresets(rows);
    const onApply = vi.fn();
    act(() => {
      root.render(
        <PrefsProvider>
          <PresetPicker type={node.type} node={node} onApply={onApply} onClose={() => {}} />
        </PrefsProvider>,
      );
    });
    await flush();
    const tr = [...host.querySelectorAll<HTMLTableRowElement>('tr.motor-row')]
      .find((r) => r.textContent?.includes('PLAIN-1'))!;
    act(() => { tr.click(); });
    expect(onApply).toHaveBeenCalledTimes(1);
    return onApply.mock.calls[0]![0] as Record<string, unknown>;
  };

  it('keeps a mass the user typed', async () => {
    const patch = await pickPlain({ type: 'bodytube', id: 'b', overrideMass: 0.25 } as ComponentNode);
    expect('overrideMass' in patch).toBe(false);
  });

  it('clears the previous part’s catalogue mass', async () => {
    const patch = await pickPlain({
      type: 'bodytube', id: 'b', overrideMass: 0.04, presetManufacturer: 'ACME', presetPartNo: 'HEAVY-1',
    } as ComponentNode);
    expect('overrideMass' in patch && patch['overrideMass'] === undefined).toBe(true);
  });
});
