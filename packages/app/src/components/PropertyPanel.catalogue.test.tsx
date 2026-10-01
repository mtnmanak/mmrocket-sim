// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { detachPatch, presetPatch, type Preset } from '../services/presets.js';

/**
 * THE CONFLICT MARKER, tiers (b) and (c) — the property-panel half of the
 * design Eric approved on 2026-09-07 (docs/testing/response-2026-09-03b.md §3):
 * a quiet ≠ chip on a field whose value differs from the part's catalogue row,
 * with a one-click "use", and a Catalogue line naming the row with Detach. No
 * modal and no stored "dismissed" state: the only ways to clear a marker are
 * real edits that already persist — take the catalogue's value, or detach.
 *
 * The catalogue is stood in for by a small fixture, so every figure below is
 * known; services/presets.test.ts pins the table against the shipped rows.
 */
const { loadPresets } = vi.hoisted(() => ({ loadPresets: vi.fn() }));
vi.mock('../services/presets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/presets.js')>()),
  loadPresets,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHUTE: Preset = {
  kind: 'Parachute', manufacturer: 'Test Chutes', partNo: 'TC-36', description: '36 in',
  diameter: 0.9144, dragCoefficient: 1.5, spillHoleDiameter: 0.0762, lineCount: 12, lineLength: 0.9144,
  material: { name: 'Ripstop nylon', type: 'SURFACE', density: 0.067 },
};
/** A shroud-line count over the app's own ceiling (schema.ts MAX_SHROUD_LINES, 256). */
const OVERLINED: Preset = { ...CHUTE, partNo: 'TC-OVER', lineCount: 300 };
/**
 * The same canopy rated with NO vent — the shape of 188 of the 473 shipped
 * canopy rows (a rated Cd, no spill hole), whose pick leaves the vent blank.
 */
const UNVENTED: Preset = {
  kind: 'Parachute', manufacturer: 'Test Chutes', partNo: 'TC-36U', description: '36 in, no vent',
  diameter: 0.9144, dragCoefficient: 1.5, lineCount: 12, lineLength: 0.9144,
  material: { name: 'Ripstop nylon', type: 'SURFACE', density: 0.067 },
};
const COUPLER: Preset = {
  kind: 'TubeCoupler', manufacturer: 'Test Tubes', partNo: 'TC-98', description: '',
  length: 0.2, outsideDiameter: 0.0985, insideDiameter: 0.0955,
};
const CATALOGUE = [CHUTE, OVERLINED, UNVENTED, COUPLER];

/** A canopy picked from `row` — the link and every catalogue value — then edited. */
const linkedChute = (over: Record<string, unknown> = {}, row: Preset = CHUTE): ComponentNode => ({
  type: 'parachute', id: 'p1', ...(presetPatch('parachute', row) as Record<string, unknown>), name: 'Main', ...over,
}) as ComponentNode;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];
/** The node as the harness last rendered it — what a reload would read back. */
let current: ComponentNode;

/**
 * The app's own edit path in miniature: every patch is spread over the node,
 * as `updateNode` does, and the panel re-renders with the result — so a
 * marker that clears here clears because the DESIGN changed, not the view.
 */
function Harness({ initial }: { initial: ComponentNode }) {
  const [node, setNode] = useState(initial);
  current = node;
  const tree = {
    name: 'R',
    components: [{
      id: 's1', type: 'stage',
      children: [{ id: 'b1', type: 'bodytube', length: 0.6, outerRadius: 0.05, thickness: 0.001, children: [node] }],
    }],
  } as unknown as RocketTree;
  return (
    <PrefsProvider>
      <PropertyPanel tree={tree} node={node} onPatch={(p) => {
        patches.push(p as Record<string, unknown>);
        setNode((n) => ({ ...n, ...p }) as ComponentNode);
      }} />
    </PrefsProvider>
  );
}

/** Renders, then lets the lazily loaded catalogue arrive. */
const show = async (node: ComponentNode) => {
  await act(async () => { root.render(<Harness initial={node} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];
const useButtons = () => buttons().filter((b) => (b.getAttribute('aria-label') ?? '').startsWith('Use catalogue'));
const byLabel = (label: string) => buttons().find((b) => b.getAttribute('aria-label') === label);
const detach = () => buttons().find((b) => b.textContent === 'Detach');
const click = (el: HTMLElement) => act(() => { el.click(); });

beforeEach(() => {
  localStorage.clear();
  loadPresets.mockReset();
  loadPresets.mockResolvedValue(CATALOGUE);
  patches = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('the conflict marker in the property panel — tier (b), the ≠ chip', () => {
  it('a field that differs from its catalogue row shows ≠ and a one-click use, naming the figure', async () => {
    await show(linkedChute({ lineCount: 6 }));
    expect(useButtons()).toHaveLength(1);
    const use = byLabel('Use catalogue value 12 for Line count')!;
    expect(use, 'no use button with a real accessible name').toBeTruthy();
    expect(use.tagName).toBe('BUTTON');
    expect(use.textContent).toBe('use 12');
    // The tooltip names the catalogue's figure and the row it comes from.
    expect(use.title).toMatch(/Test Chutes TC-36/);
    expect(use.title).toMatch(/12/);
    const mark = host.querySelector('.catalogue-diff-mark')!;
    expect(mark.textContent).toBe('≠');
    expect(mark.getAttribute('title')).toBe(use.title);
  });

  it('a field that matches, or sits inside its threshold, shows nothing', async () => {
    // 914.0 mm typed for a 36 in (914.4 mm) canopy is the same canopy.
    await show(linkedChute({ diameter: 0.914 }));
    expect(useButtons()).toHaveLength(0);
    expect(host.textContent).not.toContain('≠');
    // The link itself is still shown, quietly.
    expect(host.querySelector('.catalogue-line')?.textContent).toContain('Test Chutes TC-36');
  });

  it('"use" writes the catalogue value through the typed path, and it persists', async () => {
    await show(linkedChute({ lineCount: 6 }));
    click(byLabel('Use catalogue value 12 for Line count')!);
    // ONE edit through onPatch — the same commit a typed 12 makes, so one undo
    // takes it back — and it carries the field alone.
    expect(patches).toEqual([{ lineCount: 12 }]);
    expect(current['lineCount']).toBe(12);
    expect(current['presetPartNo']).toBe('TC-36'); // the link stays
    expect(useButtons()).toHaveLength(0);
    expect(host.textContent).not.toContain('≠');
  });

  it('"use" is held to the limits table, exactly as typing the figure is', async () => {
    await show(linkedChute({ lineCount: 6 }, OVERLINED));
    click(byLabel('Use catalogue value 300 for Line count')!);
    expect(patches).toEqual([{ lineCount: 256 }]);
    // Still not the catalogue's figure, so the marker honestly stays.
    expect(byLabel('Use catalogue value 300 for Line count')).toBeTruthy();
  });

  it('the canopy pair is taken whole, from either half’s chip', async () => {
    // Desktop states a Cd and has no vent; the maker's 1.5 is measured against
    // their 3 in vent, so the two move together or not at all.
    await show(linkedChute({ cd: 1.55, spillHoleDiameter: undefined }));
    expect(useButtons()).toHaveLength(2);
    const cd = useButtons().find((b) => /Drag coefficient/.test(b.getAttribute('aria-label')!))!;
    expect(cd.getAttribute('aria-label')).toBe('Use catalogue value 1.5 for Drag coefficient');
    expect(cd.title).toMatch(/spill hole/);
    click(cd);
    expect(patches).toHaveLength(1);
    expect(patches[0]!['cd']).toBe(1.5);
    expect(patches[0]!['spillHoleDiameter']).toBe(0.0762);
    expect(useButtons()).toHaveLength(0);
  });

  it('a vent cut in a canopy rated without one is marked, and its use takes the pair', async () => {
    // The row's Cd is rated for an unvented canopy, so a 100 mm hole typed on
    // it differs by the table's own measure (RECOVERY: 1 %, 2 mm floor). The
    // row's figure is "no vent" — the field's own "0 = none" — and the edit
    // that takes it leaves the vent blank, which is no box value at all.
    await show(linkedChute({ spillHoleDiameter: 0.1 }, UNVENTED));
    expect(useButtons()).toHaveLength(1);
    const vent = byLabel('Use catalogue value 0 mm for Spill hole ⌀')!;
    expect(vent, 'the spill hole differs and carries no use button').toBeTruthy();
    expect(vent.textContent).toBe('use 0 mm');
    expect(vent.title).toMatch(/Cd 1\.5 with no spill hole/);
    expect(vent.title).toMatch(/with a 100 mm spill hole/);
    click(vent);
    // The typed path's "0" (one edit, held to the limits), with the rated Cd.
    expect(patches).toEqual([{ cd: 1.5, spillHoleDiameter: 0 }]);
    expect(useButtons()).toHaveLength(0);
    expect(host.textContent).not.toContain('≠');
  });

  it('an automatic Cd against a rated canopy is marked, and says what it flies', async () => {
    await show(linkedChute({ cd: undefined }));
    const cd = byLabel('Use catalogue value 1.5 for Drag coefficient')!;
    expect(cd).toBeTruthy();
    expect(cd.title).toMatch(/automatic/);
  });

  it('a value with no box of its own is marked on the Catalogue line', async () => {
    // A coupler's outside diameter is the catalogue's to set (the panel has no
    // box for it), so its marker sits on the line that names the row.
    const coupler = {
      type: 'tubecoupler', id: 'c1', name: 'Coupler',
      ...(presetPatch('tubecoupler', COUPLER) as Record<string, unknown>), outerRadius: 0.048,
    } as ComponentNode;
    await show(coupler);
    const line = host.querySelector('.catalogue-line')!;
    const use = [...line.querySelectorAll('button')].find((b) => /^Use catalogue/.test(b.getAttribute('aria-label')!))!;
    expect(use.getAttribute('aria-label')).toBe('Use catalogue value 98.5 mm for outer diameter');
    click(use);
    expect(patches).toEqual([{ outerRadius: 0.04925 }]);
    expect(useButtons()).toHaveLength(0);
  });
});

describe('the conflict marker in the property panel — tier (c), the Catalogue line', () => {
  it('names the row the part is linked to, with Detach', async () => {
    await show(linkedChute());
    const line = host.querySelector('.catalogue-line')!;
    expect(line.textContent).toContain('Test Chutes TC-36');
    expect(detach()!.tagName).toBe('BUTTON');
  });

  it('Detach removes the link and its markers through one edit, and says what it did', async () => {
    await show(linkedChute({ lineCount: 6 }));
    expect(useButtons()).toHaveLength(1);
    click(detach()!);
    // Strict: an `undefined` entry is the edit (updateNode spreads the patch),
    // and a plain toEqual would pass an empty patch that removed nothing.
    expect(patches).toStrictEqual([detachPatch()]);
    expect(Object.keys(patches[0]!)).toEqual(expect.arrayContaining(['presetManufacturer', 'presetPartNo']));
    // Every value on the part stays — Detach is not a reset.
    expect(current['lineCount']).toBe(6);
    expect(current['cd']).toBe(1.5);
    expect(current['presetPartNo']).toBeUndefined();
    expect(host.querySelector('.catalogue-line')).toBeNull();
    expect(useButtons()).toHaveLength(0);
    const said = host.querySelector('[role="status"]')!;
    expect(said.textContent).toMatch(/Detached from Test Chutes TC-36/);
    expect(said.textContent).toMatch(/keeps every value/);
  });

  it('a link to a row this browser does not have is shown, and can still be detached', async () => {
    await show(linkedChute({ presetPartNo: 'GONE-1' }));
    expect(host.querySelector('.catalogue-line')!.textContent).toMatch(/not in this browser/);
    expect(useButtons()).toHaveLength(0);
    expect(detach()).toBeTruthy();
  });
});

/**
 * THE CATALOGUE THE PANEL COMPARES WITH IS THE CURRENT ONE (wave 3 verifier).
 * The preset picker's CSV import adds rows to this browser's catalogue while
 * the panel is open; the panel had read the catalogue once, for the part's
 * first link, and kept it — so the row the user had just imported and picked
 * was "not in this browser's catalogue", with no markers, until the part was
 * selected again.
 */
describe('the conflict marker in the property panel — a row added while the part is shown', () => {
  /** A canopy the user's own CSV adds (PresetPicker's import stores it; loadPresets returns it). */
  const MINE: Preset = {
    kind: 'Parachute', manufacturer: 'My Shop', partNo: 'CSV-1', description: 'my canopy',
    diameter: 0.6, dragCoefficient: 1.2, lineCount: 8, lineLength: 0.6,
  };
  const openPicker = async () => {
    click(buttons().find((b) => /Choose from preset database/.test(b.textContent ?? ''))!);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const line = () => host.querySelector('.catalogue-line')?.textContent ?? '';

  it('is found once picked: the line names it as a catalogue row, and compares with it', async () => {
    await show(linkedChute());
    loadPresets.mockResolvedValue([...CATALOGUE, MINE]);
    await openPicker();
    const mine = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('CSV-1'));
    expect(mine, 'the picker does not list the imported row').toBeTruthy();
    click(mine!);
    // Not even for the moment before the catalogue is read again: the read
    // made before the import is no evidence that the row is missing.
    expect(line()).toContain('My Shop CSV-1');
    expect(line()).not.toMatch(/not in this browser/);
    await settle();
    expect(current['presetPartNo']).toBe('CSV-1');
    expect(line()).toContain('My Shop CSV-1');
    expect(line()).not.toMatch(/not in this browser/);
    // Compared with it: a line count typed away from the row's 8 is marked.
    const lines = host.querySelector<HTMLInputElement>('input[type="text"][aria-label="Line count"]')!;
    act(() => { lines.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(lines, '6');
      lines.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { lines.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(current['lineCount']).toBe(6);
    expect(byLabel('Use catalogue value 8 for Line count')).toBeTruthy();
  });

  it('is found once the picker closes, for a link the browser lacked until the import', async () => {
    // Linked by a file to the user's own row, which this browser did not have.
    await show(linkedChute({ presetManufacturer: 'My Shop', presetPartNo: 'CSV-1' }));
    expect(line()).toMatch(/not in this browser/);
    loadPresets.mockResolvedValue([...CATALOGUE, MINE]);
    await openPicker();
    click(byLabel('Close presets')!);
    await settle();
    expect(line()).toContain('My Shop CSV-1');
    expect(line()).not.toMatch(/not in this browser/);
  });
});

describe('a design with no catalogue links', () => {
  it('renders as it always has: no catalogue load, no line, no marker', async () => {
    await show({ type: 'parachute', id: 'p1', name: 'Main', diameter: 0.9, lineCount: 6 } as ComponentNode);
    expect(loadPresets).not.toHaveBeenCalled();
    expect(host.querySelector('.catalogue-line')).toBeNull();
    expect(host.querySelector('.catalogue-diff')).toBeNull();
    expect(host.textContent).not.toContain('≠');
    expect(detach()).toBeUndefined();
  });
});
