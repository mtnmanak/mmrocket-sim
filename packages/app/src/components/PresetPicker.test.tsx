// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { PresetPicker } from './PresetPicker.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { loadCustomPresets } from '../services/presets.js';

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
});
