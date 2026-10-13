// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { PresetPicker } from './PresetPicker.js';
import { DEFAULT_PREFS, PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';
import { loadCustomPresets, loadPresets, presetPatch, saveCustomPresets, type Preset } from '../services/presets.js';

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
// Passed through unchanged; one test makes a single reload fail.
vi.mock('../services/presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/presets.js')>();
  return { ...real, loadPresets: vi.fn(real.loadPresets) };
});

/**
 * The first loadPresets() in a file pays for the dynamic import of the mocked
 * catalogue: under 1 ms under vitest 2 and 270-340 ms under vitest 5,
 * measured. So a render that `flush` below waits for still said "Loading
 * preset database…", and every test that reads the table failed (AUDIT row
 * 528, vitest 2 -> 5). Paid once here, every render below finds the module's
 * cached catalogue, as it did.
 */
beforeAll(async () => { await loadPresets(); });

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

/**
 * `vi.spyOn(localStorage, 'setItem')`, taken off again when the test ends.
 * Since vitest 3.2 a spy on an INHERITED method is restored by deleting the
 * instance's property, and happy-dom's Storage proxy refuses that delete (its
 * deleteProperty trap removes stored items only), so `vi.restoreAllMocks()`
 * left the throwing setItem on localStorage and it failed every later test in
 * this file (AUDIT row 528, vitest 2 -> 5). happy-dom's own bound copy goes
 * back through the proxy's defineProperty trap, the way the spy went on.
 */
function spyOnSetItem() {
  const own = localStorage.setItem;
  onTestFinished(() => {
    Object.defineProperty(localStorage, 'setItem', {
      ...Object.getOwnPropertyDescriptor(Object.getPrototypeOf(localStorage), 'setItem'), value: own,
    });
  });
  return vi.spyOn(window.localStorage, 'setItem');
}

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

describe('N026 parachute preset comparisons', () => {
  const CHUTES: Preset[] = [
    { kind: 'Parachute', manufacturer: 'ACME', partNo: 'VENT', description: 'Vented canopy',
      diameter: 1, dragCoefficient: 2, spillHoleDiameter: 0.1, mass: 0.1,
      packedDiameter: 0.05, packedLength: 0.2 },
    { kind: 'Parachute', manufacturer: 'ACME', partNo: 'OPEN', description: 'Unvented canopy',
      diameter: 1, dragCoefficient: 2, mass: 0.02, packedDiameter: 0.08 },
    { kind: 'Parachute', manufacturer: 'ACME', partNo: 'LENGTH', description: 'Length only',
      diameter: 0.5, dragCoefficient: 0.8, packedLength: 0.1 },
    { kind: 'Parachute', manufacturer: 'ACME', partNo: 'UNKNOWN', description: 'No rated Cd', diameter: 1 },
  ];
  const bodyRows = () => [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  const cells = (partNo: string) => [...bodyRows().find((r) => r.cells[1]!.textContent === partNo)!.cells]
    .map((c) => c.textContent);
  const sort = (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('thead button')]
      .find((b) => b.textContent?.startsWith(label));
    expect(button, `sortable ${label} header`).toBeDefined();
    act(() => { button!.click(); });
    return button!.closest('th')!;
  };
  const open = async (chutes = CHUTES, node?: ComponentNode, parentRadius?: number) => {
    saveCustomPresets(chutes);
    const onApply = vi.fn();
    const onClose = vi.fn();
    function ChangeUnits() {
      const { prefs, setPrefs } = usePrefs();
      return <button onClick={() => setPrefs({ ...prefs, units: { ...prefs.units, length: 'in', mass: 'oz' } })}>
        Change units
      </button>;
    }
    act(() => root.render(<PrefsProvider>
      <ChangeUnits />
      <PresetPicker type="parachute" node={node} parentRadius={parentRadius} onApply={onApply} onClose={onClose} />
    </PrefsProvider>));
    await flush();
    return { onApply, onClose };
  };

  it('shows source mass and each published packed dimension, leaving missing halves blank', async () => {
    await open();
    expect(cells('VENT').slice(5, 8)).toEqual(['100', '50', '200']);
    expect(cells('OPEN').slice(5, 8)).toEqual(['20', '80', '']);
    expect(cells('LENGTH').slice(5, 8)).toEqual(['', '', '100']);
    expect(cells('UNKNOWN').slice(5)).toEqual(['', '', '', '']);
    expect(host.querySelector('thead')!.textContent).toContain('Mass (g)');
    expect(host.querySelector('thead')!.textContent).toContain('Packed diameter (mm)');
    expect(host.querySelector('thead')!.textContent).toContain('Packed length (mm)');
    expect(text()).toContain('Packed sizes are as published');
  });

  it('keeps Cd and vent area together and does not fill unknown Cd with the flight default', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      ...DEFAULT_PREFS, units: { ...DEFAULT_PREFS.units, length: 'm' },
    }));
    await open();
    // Rounded display tolerance (3 significant figures), not a kernel float literal.
    expect(Number(cells('VENT')[8])).toBeCloseTo(2 * Math.PI * (1 - 0.1 ** 2) / 4, 2);
    expect(Number(cells('OPEN')[8])).toBeCloseTo(2 * Math.PI / 4, 2);
    expect(cells('UNKNOWN')[8]).toBe('');
    expect(host.querySelector('thead')!.textContent).toContain('Effective CdA (m²)');
  });

  it('converts mass, packed lengths and drag area when display units change', async () => {
    await open();
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Change units')!.click());
    expect(host.querySelector('thead')!.textContent).toContain('Mass (oz)');
    expect(host.querySelector('thead')!.textContent).toContain('Packed diameter (in)');
    expect(host.querySelector('thead')!.textContent).toContain('Effective CdA (in²)');
    expect(Number(cells('VENT')[5])).toBeCloseTo(0.1 / 0.0283495231, 2);
    expect(Number(cells('VENT')[6])).toBeCloseTo(0.05 / 0.0254, 2);
    expect(Number(cells('VENT')[7])).toBeCloseTo(0.2 / 0.0254, 2);
    expect(Number(cells('VENT')[8])).toBeCloseTo((2 * Math.PI * (1 - 0.1 ** 2) / 4) / 0.0254 ** 2, 1);
  });

  it.each(['mass', 'packedDiameter', 'packedLength', 'diameter', 'dragCoefficient'])(
    'leaves invalid %s blank instead of inventing a zero or default', async (field) => {
      const invalid = [0, -1, NaN, Infinity, '0.1', null].map((v, i) => ({ ...CHUTES[0]!, partNo: `BAD-${i}`, [field]: v }));
      await open(invalid);
      const col = { mass: 5, packedDiameter: 6, packedLength: 7, diameter: 8, dragCoefficient: 8 }[field]!;
      for (const p of invalid) expect(cells(p.partNo)[col]).toBe('');
    });

  it.each([
    ['Mass', ['OPEN', 'VENT', 'LENGTH', 'UNKNOWN']],
    ['Packed diameter', ['VENT', 'OPEN', 'LENGTH', 'UNKNOWN']],
    ['Packed length', ['LENGTH', 'VENT', 'OPEN', 'UNKNOWN']],
    ['Effective CdA', ['LENGTH', 'VENT', 'OPEN', 'UNKNOWN']],
  ])('sorts %s numerically in both directions with blanks last, without applying', async (label, ascending) => {
    const { onApply, onClose } = await open();
    const header = sort(label);
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(bodyRows().map((r) => r.cells[1]!.textContent)).toEqual(ascending);
    act(() => header.querySelector('button')!.click());
    expect(header.getAttribute('aria-sort')).toBe('descending');
    const knownCount = label === 'Mass' || label.startsWith('Packed') ? 2 : 3;
    expect(bodyRows().map((r) => r.cells[1]!.textContent))
      .toEqual([...ascending.slice(0, knownCount)].reverse().concat(ascending.slice(knownCount)));
    expect(bodyRows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sorts before the 300-row display cap and keeps the full filtered list available', async () => {
    await open(Array.from({ length: 301 }, (_, i) => ({ ...CHUTES[0]!, partNo: `P-${i}`, mass: 1 / (i + 1) })));
    sort('Mass');
    expect(bodyRows()).toHaveLength(300);
    expect(bodyRows()[0]!.cells[1]!.textContent).toBe('P-300');
    expect(text()).toContain('Showing 300 of 301');
  });

  it.each([
    ['Manufacturer', ['Z-2', 'Z-10']],
    ['Part number', ['Z-2', 'Z-10']],
    ['Description', ['Z-2', 'Z-10']],
    ['Dimensions', ['Z-2', 'Z-10']],
    ['Material', ['Z-2', 'Z-10']],
  ])('sorts the existing %s column while preserving its columnheader role', async (label, ascending) => {
    await open([
      { ...CHUTES[0]!, manufacturer: 'Maker 10', partNo: 'Z-10', description: 'Canopy 10', diameter: 1,
        material: { name: 'Nylon 10', type: 'SURFACE', density: 0.067 } },
      { ...CHUTES[0]!, manufacturer: 'Maker 2', partNo: 'Z-2', description: 'Canopy 2', diameter: 0.5,
        material: { name: 'Nylon 2', type: 'SURFACE', density: 0.067 } },
    ]);
    const header = sort(label);
    expect(header.getAttribute('role')).toBeNull();
    expect(header.getAttribute('scope')).toBe('col');
    expect(header.querySelector('button')!.tabIndex).toBe(0);
    expect(bodyRows().map((r) => r.cells[1]!.textContent)).toEqual(ascending);
  });

  it('keeps the comparison sort when the manufacturer filter changes', async () => {
    await open();
    sort('Mass');
    act(() => {
      const filter = host.querySelector<HTMLSelectElement>('select[aria-label="Filter by manufacturer"]')!;
      filter.value = 'ACME';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(bodyRows().map((r) => r.cells[1]!.textContent)).toEqual(['OPEN', 'VENT', 'LENGTH', 'UNKNOWN']);
    expect(host.querySelector('th[aria-sort="ascending"]')!.textContent).toContain('Mass');
  });

  it('keeps the other part types at their existing five columns', async () => {
    await render();
    expect([...host.querySelectorAll('th')].map((h) => h.textContent))
      .toEqual(['Manufacturer', 'Part number', 'Description', 'Dimensions', 'Material']);
    expect(host.querySelectorAll('thead button')).toHaveLength(0);
    expect(host.querySelector('.preset-comparison-note')).toBeNull();
  });

  it('preserves the exact pick patch including the parent-adjusted packed size', async () => {
    const node: ComponentNode = { type: 'parachute', id: 'p', name: 'Previous', cd: 0.8, packedRadius: 0.02, packedLength: 0.12 };
    const { onApply, onClose } = await open(CHUTES, node, 0.04);
    sort('Mass');
    // The comparison shows the source size, even though applying uses the bay radius.
    expect(cells('VENT').slice(6, 8)).toEqual(['50', '200']);
    for (const p of CHUTES) {
      const row = bodyRows().find((r) => r.cells[1]!.textContent === p.partNo)!;
      act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
      expect(onApply).toHaveBeenLastCalledWith(presetPatch('parachute', p, { node, presets: CHUTES }, { parentRadius: 0.04 }));
    }
    expect(onApply).toHaveBeenCalledTimes(CHUTES.length);
    expect(onClose).toHaveBeenCalledTimes(CHUTES.length);
  });
});

describe('PresetPicker — CSV import', () => {
  it('B5b S1c-7 S3c-2 reports a refused replacement instead of claiming the old row is updated', async () => {
    await render();
    await importCsv(CSV);
    spyOnSetItem().mockImplementation(() => { throw new DOMException('QuotaExceededError'); });
    await importCsv(CSV.replace('BULK,680', 'BULK,1250'));
    expect(text()).toContain('Could not store 1 of 1 preset(s)');
    expect(text()).not.toContain('Imported 1 preset(s)');
    expect(loadCustomPresets()[0]!.material!.density).toBe(680);
  });

  it('imports the sound row and skips the one whose density is not a number', async () => {
    await render();
    await importCsv(CSV);

    expect(text()).toContain('Imported 1 preset(s)');
    expect(text()).toContain('1 row(s) skipped');
    expect(text()).toContain('BAD-1'); // named, so the user can go fix that row
    expect(host.querySelector('.message-caution')?.textContent).toContain('1 row(s) skipped');

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
    expect(host.querySelector('.message-caution')).toBeNull();
    expect(loadCustomPresets()).toEqual([]);
  });

  it('does not claim an import was stored when localStorage refused it', async () => {
    await render();
    // Exactly what a private window or a full quota does: setItem throws, and
    // saveCustomPresets swallows it.
    spyOnSetItem().mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    await importCsv(CSV);

    expect(text()).toContain('Could not store 1 of 1 preset(s)');
    expect(text()).not.toContain('Imported 1 preset(s)');
    expect(text()).toContain('1 row(s) skipped'); // the bad row is still reported
    expect(host.querySelector('.message-caution')?.textContent).toContain('not saved');
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

  /**
   * Review of the audit fixes, 2026-10-01: a material type presetPatch never
   * applies — a typo, LINE, or the other kind's type — passed the soundness
   * check and imported as a success. presetPatch writes a density only for
   * BULK on a structural part and SURFACE on a canopy or streamer, so picking
   * such a row left the part on its OLD material under the new part's name: a
   * fibreglass tube weighed as cardboard, or a canopy back on the default
   * fabric, with nothing said. The type a kind takes is a fixed rule (shipped
   * catalogue: Parachute and Streamer all SURFACE, no other kind SURFACE), so
   * such a row is skipped and named, like a bad density.
   */
  it('skips and names a row whose material type its part cannot take', async () => {
    await render();
    await importCsv([
      'kind,manufacturer,partNo,description,materialName,materialType,materialDensity,outsideDiameter,lineMaterialName,lineMaterialDensity',
      'BodyTube,ACME,TYPO-1,Typo in the type,Fiberglass,BULKK,1850,0.024',
      'BodyTube,ACME,GOOD-1,Sound row,Cardboard,BULK,680,0.024',
      'BodyTube,ACME,LOWER-1,Typed in lower case,Cardboard, bulk ,680,0.024',
      'BodyTube,ACME,BLANK-1,Type left blank,Cardboard,,680,0.024',
      'BodyTube,ACME,LINE-1,A line material on a tube,Kevlar,LINE,0.002,0.024',
      'Parachute,ACME,CHUTE-1,Bulk fabric on a canopy,Ripstop nylon,BULK,1160',
      'Parachute,ACME,CHUTE-2,Sound canopy,Ripstop nylon,SURFACE,0.067',
      'Parachute,ACME,CHUTE-3,Sound canopy and its lines,Ripstop nylon,SURFACE,0.067,,Kevlar,0.0005',
    ].join('\n'));

    expect(text()).toContain('Imported 5 preset(s)');
    expect(text()).toContain('3 row(s) skipped');
    expect(text()).toContain('the type its part takes (SURFACE for a parachute or streamer, BULK for anything else)');
    expect(text()).toContain('(first: TYPO-1)');
    expect(loadCustomPresets().map((p) => p.partNo)).toEqual(['GOOD-1', 'LOWER-1', 'BLANK-1', 'CHUTE-2', 'CHUTE-3']);
    expect(loadCustomPresets().at(-1)!.lineMaterial).toEqual({ name: 'Kevlar', type: 'LINE', density: 0.0005 });
  });

  /**
   * Audit 2026-09-22: after an import the list is reloaded, and that promise
   * had no catch. A reload that failed was an unhandled rejection that left
   * `all` null under an "Imported" note — and with a note on screen the
   * "Loading…" line is hidden, so the dialog showed an empty table as if the
   * catalogue had gone.
   */
  it('a list that cannot be reloaded after an import keeps the old one and says so', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      saveCustomPresets([{
        kind: 'BodyTube', manufacturer: 'ACME', partNo: 'OLD-1', description: 'Already here',
      } as Preset]);
      await render();
      expect(text()).toContain('OLD-1');
      vi.mocked(loadPresets).mockRejectedValueOnce(new Error('chunk failed to load'));
      await importCsv(CSV);
      await flush();
      expect(text()).toContain('Imported 1 preset(s)');
      expect(text()).toContain('could not be reloaded (chunk failed to load)');
      expect(text()).toContain('OLD-1'); // the list it had, not an empty table
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
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
 * Audit 2026-09-30 (PresetPicker.tsx:228): every row spread clickable(), so
 * each was its own tab stop — up to ROW_CAP = 300 of them between the search
 * box and the way back to Close or the CSV buttons inside the focus trap — and
 * nothing told a screen reader that Enter on a row applies that part and
 * closes the dialog. MotorBrowser fixed the same pattern with a roving
 * tabindex; the two pickers now share it (useRovingRows).
 */
describe('PresetPicker — the table is ONE tab stop, walked with the arrows', () => {
  const PARTS: Preset[] = ['T-1', 'T-2', 'T-3', 'T-4'].map((partNo, i) => ({
    kind: 'BodyTube', manufacturer: 'ACME', partNo, description: `tube ${i + 1}`,
    outsideDiameter: 0.024 + i * 0.01, length: 0.3,
  }));
  const open = async () => {
    saveCustomPresets(PARTS);
    const onApply = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <PrefsProvider>
          <PresetPicker type={'bodytube' as ComponentNode['type']} onApply={onApply} onClose={onClose} />
        </PrefsProvider>,
      );
    });
    await flush();
    return { onApply, onClose };
  };
  const bodyRows = () => [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  const stops = () => bodyRows().filter((tr) => tr.tabIndex >= 0);
  /** A keydown that bubbles to the dialog's capture-phase Tab trap, as a real one does. */
  const key = (el: Element, k: string) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    act(() => { el.dispatchEvent(e); });
    return e;
  };

  it('makes exactly one row tabbable, where every row used to be', async () => {
    await open();
    expect(bodyRows()).toHaveLength(4);
    expect(stops()).toEqual([bodyRows()[0]]);
  });

  it('moves focus — and the tab stop — with ArrowDown/Up, Home and End, without applying', async () => {
    const { onApply, onClose } = await open();
    act(() => bodyRows()[0]!.focus());
    expect(key(bodyRows()[0]!, 'ArrowDown').defaultPrevented).toBe(true); // the table does not scroll too
    expect(document.activeElement).toBe(bodyRows()[1]);
    expect(stops()).toEqual([bodyRows()[1]]);
    key(bodyRows()[1]!, 'End');
    expect(document.activeElement).toBe(bodyRows()[3]);
    key(bodyRows()[3]!, 'ArrowDown'); // stays at the end
    expect(document.activeElement).toBe(bodyRows()[3]);
    key(bodyRows()[3]!, 'Home');
    expect(document.activeElement).toBe(bodyRows()[0]);
    key(bodyRows()[0]!, 'ArrowUp'); // stays at the top
    expect(document.activeElement).toBe(bodyRows()[0]);
    // Passing over a part must not apply it: a pick closes the dialog.
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies the focused part on Enter, and closes', async () => {
    const { onApply, onClose } = await open();
    act(() => bodyRows()[0]!.focus());
    key(bodyRows()[0]!, 'ArrowDown');
    key(bodyRows()[1]!, 'ArrowDown');
    key(document.activeElement!, 'Enter');
    expect(onApply).toHaveBeenCalledOnce();
    expect((onApply.mock.calls[0]![0] as Record<string, unknown>)['presetPartNo']).toBe('T-3');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('lets Tab leave the table from its one stop, back to the dialog’s buttons', async () => {
    await open();
    const csv = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CSV'))!;
    act(() => bodyRows()[0]!.focus());
    key(bodyRows()[0]!, 'ArrowDown');
    // The trap wraps from the dialog's last tab stop; with every row a stop,
    // the next row was "next" and the keyboard walked on through the table.
    key(document.activeElement!, 'Tab');
    expect(document.activeElement).toBe(csv);
  });

  it('tells a screen reader that a row is an action that closes the dialog, and keeps it a row', async () => {
    await open();
    for (const tr of bodyRows()) {
      // A role="button" on the <tr> would cost the cells their column headers.
      expect(tr.getAttribute('role')).toBeNull();
      const hint = document.getElementById(tr.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent).toMatch(/Enter applies this part and closes/);
    }
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
