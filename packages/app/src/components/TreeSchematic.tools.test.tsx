// @vitest-environment happy-dom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { TreeSchematic } from './TreeSchematic.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { schematicSvg } from '../services/schematicExport.js';
import { INITIAL_UNITS } from '../prefs/units.js';
const stylesheet = readFileSync('src/styles.css', 'utf8');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const select = vi.fn(), patch = vi.fn();
const tree = { name: 'Tools', components: [{ id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02, thickness: 0.002 }] } as RocketTree;
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (label: string) => { act(() => { button(label).click(); }); };
const svg = () => host.querySelector('svg')!;
const key = (target: Element, value: string, altKey = false) => { act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: value, altKey, bubbles: true, cancelable: true })); }); };
const pointer = (x: number, y: number) => act(() => {
  svg().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    pointerType: 'touch', clientX: x, clientY: y, button: 0, buttons: 1 }));
  svg().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: x, clientY: y }));
});
const exported = () => schematicSvg(svg(), 1000, 640, 240, { name: 'T', info: null, units: INITIAL_UNITS, withMotors: false, appVersion: '0' });
const mount = () => act(() => root.render(<PrefsProvider><TreeSchematic tree={tree} info={null} onSelect={select} onPatchNode={patch} /></PrefsProvider>));

beforeEach(() => {
  localStorage.clear(); select.mockClear(); patch.mockClear();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 640, height: 240 } as DOMRect);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.querySelector('[data-tools-test-style]')?.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('N033 and N044 view tools', () => {
  it.each([false, true].flatMap(walls2d => ['mm', 'in'].flatMap(unit => [
    { walls2d, unit, angleOffset: Math.PI / 3, roll: 0 },
    { walls2d, unit, angleOffset: 0, roll: Math.PI / 3 },
  ])))('touch measures a rotated lug in $unit with walls $walls2d, angle $angleOffset, roll $roll', ({ walls2d, unit, angleOffset, roll }) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d, units: { length: unit } }));
    const lug = { name: 'Rotated lug', components: [{ id: 'b', type: 'bodytube', length: 2, outerRadius: 0.02,
      children: [{ id: 'lug', type: 'launchlug', length: 0.05, outerRadius: 0.0022, angleOffset,
        position: { method: 'top', offset: 0.1 } }] }] } as RocketTree;
    const before = JSON.stringify(lug);
    act(() => root.render(<PrefsProvider><TreeSchematic tree={lug} info={null} roll={roll}
      onSelect={select} onPatchNode={patch} /></PrefsProvider>));
    click('Caliper: measure two points');
    const body = svg().querySelector<SVGRectElement>('rect[fill="rgba(127,127,127,0.001)"], rect[fill="#e7e5e0"]')!;
    const x0 = Number(body.getAttribute('x')), scale = Number(body.getAttribute('width')) / 2;
    const cy = Number(body.getAttribute('y')) + Number(body.getAttribute('height')) / 2;
    const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
    const effectiveLug = svg().querySelector<SVGRectElement>('rect[fill="#c8c5be"]')!;
    expect(Number(effectiveLug.getAttribute('y'))).toBeCloseTo(cy - 0.0133 * scale, 10);
    expect(Number(effectiveLug.getAttribute('height'))).toBeCloseTo(0.0044 * scale, 10);
    expect(Number(effectiveLug.getAttribute('width'))).toBeCloseTo(0.05 * scale, 10);
    // Independent physical stations: (20 + 2.2)*cos(60) +/- 2.2 mm.
    pointer(x0 + 0.1 * scale, (cy - 0.0089 * scale) * 240 / h);
    pointer(x0 + 0.1 * scale, (cy - 0.0133 * scale) * 240 / h);
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toBe(unit === 'mm'
      ? 'Horizontal 0 mm · Vertical 4.4 mm · Straight 4.4 mm'
      : 'Horizontal 0 in · Vertical 0.173 in · Straight 0.173 in');
    expect(select).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
    expect(JSON.stringify(lug)).toBe(before);
    key(svg(), 'Escape'); expect(svg().querySelector('[data-caliper]')).toBeNull();
  });

  it('keeps the visible Caliper label in the inactive accessible name', () => {
    mount();
    const caliper = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Caliper')!;
    expect(caliper.getAttribute('aria-label') ?? caliper.textContent).toMatch(/Caliper/i);
  });

  it.each([false, true])('touch measures the centred 10 mm bulkhead diameter with radial fields and walls %s', walls2d => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d }));
    const centred = { name: 'Centred bulkhead', components: [{ id: 'b', type: 'bodytube', length: 2, outerRadius: 0.02,
      children: [{ id: 'r', type: 'bulkhead', length: 0.005, outerRadius: 0.005, radialPosition: 0.01,
        radialDirection: 0, position: { method: 'top', offset: 0.1 } }] }] } as RocketTree;
    act(() => root.render(<PrefsProvider><TreeSchematic tree={centred} info={null} roll={Math.PI / 3}
      onSelect={select} onPatchNode={patch} /></PrefsProvider>));
    click('Caliper: measure two points');
    expect(host.querySelector<HTMLInputElement>('.schematic-tool-notes input[type="checkbox"]')!.checked).toBe(true);
    const part = svg().querySelector<SVGRectElement>('rect[stroke-dasharray="3 2"]')!;
    const x = Number(part.getAttribute('x')), y = Number(part.getAttribute('y'));
    const height = Number(part.getAttribute('height'));
    const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
    pointer(x, y * 240 / h); pointer(x, (y + height) * 240 / h);
    expect(host.querySelector('[data-caliper-readout]')!.textContent)
      .toBe('Horizontal 0 mm · Vertical 10 mm · Straight 10 mm');
    expect(select).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
    key(svg(), 'Escape');
    expect(svg().querySelector('[data-caliper]')).toBeNull();
  });

  it.each([false, true])('touch measures a 5 mm engine block at 360 px with walls %s', walls2d => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 360, height: 240 } as DOMRect);
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d }));
    const long = { name: 'Engine block', components: [{ id: 'b', type: 'bodytube', length: 2, outerRadius: 0.02,
      children: [{ id: 'e', type: 'engineblock', length: 0.005, position: { method: 'top', offset: 0.1 } }] }] } as RocketTree;
    act(() => { root.render(<PrefsProvider><TreeSchematic tree={long} info={null} onSelect={select} onPatchNode={patch} /></PrefsProvider>); });
    click('Caliper: measure two points');
    const part = svg().querySelector<SVGRectElement>('rect[stroke-dasharray="3 2"]')!;
    const x = Number(part.getAttribute('x')), y = Number(part.getAttribute('y'));
    const width = Number(part.getAttribute('width'));
    const measure = () => {
      const [dx, dy, k] = svg().querySelector('g')!.getAttribute('transform')!.match(/[-\d.]+/g)!.map(Number);
      const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
      pointer(dx! + k! * x, (dy! + k! * y) * 240 / h);
      pointer(dx! + k! * (x + width), (dy! + k! * y) * 240 / h);
      expect(host.querySelector('[data-caliper-readout]')!.textContent)
        .toBe('Horizontal 5 mm · Vertical 0 mm · Straight 5 mm');
    };
    measure(); click('Zoom in'); measure();
    expect(select).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
    key(svg(), 'Escape');
    act(() => { part.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(select).toHaveBeenCalledWith('e');
  });

  it.each([
    { type: 'nosecone', flipped: false, prefix: '', key: 'n:shoulder', fore: false },
    { type: 'nosecone', flipped: true, prefix: '', key: 'n:shoulder', fore: true },
    { type: 'transition', prefix: 'fore', key: 'n:shoulder-fore', fore: true },
    { type: 'transition', prefix: 'aft', key: 'n:shoulder-aft', fore: false },
  ])('exports the closed-end material of $key ($type flipped $flipped) only with Walls on', ({ type, flipped, prefix, key: wallKey, fore }) => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d: true }));
    for (const capped of [false, true]) {
      const caps = { name: 'Caps', components: [{ id: 'n', type, flipped, length: 0.1, aftRadius: 0.02, foreRadius: 0.02,
        [`${prefix}ShoulderLength`.replace(/^Shoulder/, 'shoulder')]: 0.02,
        [`${prefix}ShoulderRadius`.replace(/^Shoulder/, 'shoulder')]: 0.018,
        [`${prefix}ShoulderThickness`.replace(/^Shoulder/, 'shoulder')]: 0.001,
        [`${prefix}ShoulderCapped`.replace(/^Shoulder/, 'shoulder')]: capped } as ComponentNode] };
      act(() => root.render(<PrefsProvider><TreeSchematic tree={caps} info={null} /></PrefsProvider>));
      const path = svg().querySelector(`[data-wall="${wallKey}"]`)!.getAttribute('d')!;
      const coords = path.match(/[-\d.]+/g)!.map(Number);
      const x = coords[0]!, width = coords[2]! - x;
      // 1 mm cap in a 20 mm shoulder occupies 5% of its axial span.
      expect((coords[8]! - x) / width).toBeCloseTo(capped && fore ? 0.05 : 0, 10);
      expect((coords[10]! - x) / width).toBeCloseTo(capped && !fore ? 0.95 : 1, 10);
      const doc = new DOMParser().parseFromString(exported(), 'image/svg+xml');
      expect(doc.querySelector(`[data-wall="${wallKey}"]`)!.getAttribute('d')).toBe(path);
    }
    click('Hide schematic walls');
    expect(new DOMParser().parseFromString(exported(), 'image/svg+xml').querySelector('[data-wall]')).toBeNull();
  });

  it.each([360, 640].flatMap(width => [false, true].flatMap(walls2d => [
    { width, walls2d, type: 'innertube', length: 0.002, distance: '2 mm' },
    { width, walls2d, type: 'tubecoupler', length: 0.01, distance: '10 mm' },
  ])))('touch measures a short $type at $width px with walls $walls2d before and after zoom', ({ width, walls2d, type, length, distance }) => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width, height: 240 } as DOMRect);
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d }));
    const short = { name: 'Short tube', components: [{ id: 'b', type: 'bodytube', length: 2,
      outerRadius: 0.02, children: [{ id: 'i', type, length, outerRadius: 0.01, thickness: 0.001,
        position: { method: 'top', offset: 0.1 } }] }] } as RocketTree;
    act(() => root.render(<PrefsProvider><TreeSchematic tree={short} info={null} onSelect={select} onPatchNode={patch} /></PrefsProvider>));
    click('Caliper: measure two points');
    const inner = svg().querySelector<SVGRectElement>('rect[stroke-dasharray="3 2"]')!;
    const x = Number(inner.getAttribute('x')), y = Number(inner.getAttribute('y'));
    const tubeWidth = Number(inner.getAttribute('width'));
    const measure = () => {
      const [dx, dy, k] = svg().querySelector('g')!.getAttribute('transform')!.match(/[-\d.]+/g)!.map(Number);
      const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
      pointer(dx! + k! * x, (dy! + k! * y) * 240 / h);
      pointer(dx! + k! * (x + tubeWidth), (dy! + k! * y) * 240 / h);
      expect(host.querySelector('[data-caliper-readout]')!.textContent)
        .toBe(`Horizontal ${distance} · Vertical 0 mm · Straight ${distance}`);
    };
    measure(); click('Zoom in'); measure();
    expect(select).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
    key(svg(), 'Escape');
    const hit = svg().querySelector('[data-tube-hit]');
    expect(!!hit).toBe(tubeWidth < 2);
    act(() => { (hit ?? inner).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(select).toHaveBeenCalledWith('i');
  });

  it.each([false, true])('measures a fitting internal tube at its 38 mm diameter with walls %s', (walls2d) => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d }));
    const nested = { name: 'Fitting tube', components: [{ id: 'b', type: 'bodytube',
      length: 0.2, outerRadius: 0.02, thickness: 0.0003, children: [
        { id: 'i', type: 'innertube', length: 0.1, outerRadius: 0.019, thickness: 0.0005 },
      ] }] } as RocketTree;
    act(() => root.render(<PrefsProvider><TreeSchematic tree={nested} info={null} /></PrefsProvider>));
    click('Caliper: measure two points');
    const inner = svg().querySelector<SVGRectElement>('rect[stroke-dasharray="3 2"]')!;
    const x = Number(inner.getAttribute('x')), y = Number(inner.getAttribute('y'));
    const height = Number(inner.getAttribute('height'));
    const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
    pointer(x, y * 240 / h); pointer(x, (y + height) * 240 / h);
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toBe('Horizontal 0 mm · Vertical 38 mm · Straight 38 mm');
  });

  it.each([640, 360])('keeps station labels and spans above Walls and Caliper notes at %s px', (width) => {
    host.classList.add('viz-root'); host.dataset.theme = 'dark'; host.dataset.contrast = 'high';
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240);
    vi.stubGlobal('ResizeObserver', class {
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { this.callback(); }
      disconnect() {}
    });
    mount(); click('Add station guide'); click('Add station guide');
    const style = document.createElement('style'); style.textContent = stylesheet;
    style.dataset.toolsTestStyle = ''; document.head.appendChild(style);
    click('Show schematic walls');
    const aboveNotes = () => {
      const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
      expect(Number(svg().getAttribute('viewBox')!.split(' ')[2])).toBe(width);
      const plates = svg().querySelectorAll('[data-guide="x"] rect, [data-guide-span="x"] rect');
      expect(plates).toHaveLength(3);
      for (const plate of plates) expect(Number(plate.getAttribute('y')) + Number(plate.getAttribute('height'))).toBeLessThanOrEqual(h - 80);
      for (const line of svg().querySelectorAll('[data-guide="x"] line')) expect(Number(line.getAttribute('y2'))).toBeLessThanOrEqual(h - 80);
      const notes = host.querySelector<HTMLDivElement>('.schematic-tool-notes')!;
      expect(notes.style.left).toBe('26px');
      const css = getComputedStyle(notes);
      const outerCap = parseFloat(css.maxHeight) + (css.boxSizing === 'border-box' ? 0
        : parseFloat(css.paddingTop) + parseFloat(css.paddingBottom));
      expect(outerCap).toBeLessThanOrEqual(80);
    };
    aboveNotes(); click('Caliper: measure two points'); aboveNotes();
    click('Hide schematic walls'); aboveNotes();
  });

  it('describes the focused caliper keyboard controls and restores pan instructions on clearing', () => {
    mount(); click('Caliper: measure two points');
    expect(document.activeElement).toBe(svg());
    expect(svg().getAttribute('aria-label')).toContain('Caliper');
    expect(svg().getAttribute('aria-label')).not.toMatch(/drag components|arrow keys to pan/);
    const helpId = svg().getAttribute('aria-describedby');
    expect(helpId).toBeTruthy();
    const help = document.getElementById(helpId!)!;
    expect(help?.textContent).toMatch(/arrows move.*Enter places.*Alt \+ arrows pan.*Escape clears/);
    key(svg(), 'Enter'); key(svg(), 'ArrowRight'); key(svg(), 'Enter');
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toContain('Horizontal 1 mm');
    key(svg(), 'Escape');
    expect(svg().getAttribute('aria-describedby')).toBeNull();
    expect(svg().getAttribute('aria-label')).toContain('arrow keys to pan');
  });

  it.each([
    { length: 'mm', rulerReference2d: 'aft', grid2d: true, distance: '200 mm' },
    { length: 'in', rulerReference2d: 'offset', grid2d: false, distance: '7.874 in' },
  ])('keeps caliper distances and walls with a $rulerReference2d ruler in $length', (settings) => {
    const stored = { units: { length: settings.length }, walls2d: true,
      rulerReference2d: settings.rulerReference2d, rulerOffset2dM: -0.0254,
      rulerReversed2d: true, grid2d: settings.grid2d, fieldPrecision: 4 };
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify(stored));
    mount();
    expect(host.firstElementChild!.classList.contains('tree-schematic')).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Ruler reference"]')!.value).toBe(settings.rulerReference2d);
    expect(host.querySelector('summary')!.textContent).toContain('(reversed)');
    click('Caliper: measure two points');
    expect(host.querySelector('[aria-label="Ruler reference"]')).toBeNull();
    expect(svg().querySelector('[data-grid]') !== null).toBe(settings.grid2d);
    const body = svg().querySelector<SVGRectElement>(':scope > g > rect')!;
    const x = Number(body.getAttribute('x')), y = Number(body.getAttribute('y'));
    const width = Number(body.getAttribute('width'));
    const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
    pointer(x + 2, y * 240 / h); pointer(x + width - 2, y * 240 / h);
    const readout = host.querySelector('[data-caliper-readout]')!.textContent;
    expect(readout).toContain(`Horizontal ${settings.distance}`);
    expect(readout).toContain(`Vertical 0 ${settings.length}`);
    expect(readout).toContain(`Straight ${settings.distance}`);
    click('Zoom in');
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toBe(readout);
    const drawing = exported();
    expect(drawing).toContain('data-wall');
    expect(drawing).not.toContain('data-caliper');
    expect(drawing.includes('data-grid="fit"')).toBe(settings.grid2d);
    key(svg(), 'Escape');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Ruler reference"]')!.value).toBe(settings.rulerReference2d);
    click('Hide schematic walls');
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!)).toMatchObject({ ...stored, walls2d: false });
    expect(patch).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });

  it('defaults walls off, toggles them in exports and preserves component selection', () => {
    mount();
    expect(svg().querySelector('[data-wall]')).toBeNull();
    click('Show schematic walls');
    expect(button('Hide schematic walls').getAttribute('aria-pressed')).toBe('true');
    expect(exported()).toContain('data-wall');
    expect(exported()).toContain('Schematic cutaway');
    expect(host.textContent).toContain('Schematic cutaway');
    act(() => { host.querySelector<SVGElement>('[aria-label="Select Body tube"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(select).toHaveBeenCalledWith('b');
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!).walls2d).toBe(true);
    click('Hide schematic walls'); expect(exported()).not.toContain('data-wall');
  });

  it('drops malformed stored wall settings', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ walls2d: 'true' }));
    mount(); expect(button('Show schematic walls').getAttribute('aria-pressed')).toBe('false');
  });

  it('picks two points by touch, shows three distances and clears with Escape without editing', () => {
    mount(); click('Caliper: measure two points');
    pointer(200, 130); pointer(350, 160);
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toMatch(/Horizontal .* mm.*Vertical .* mm.*Straight .* mm/);
    expect(svg().querySelectorAll('[data-caliper-point]')).toHaveLength(2);
    expect(exported()).not.toContain('data-caliper');
    expect(patch).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    key(svg(), 'Escape'); expect(svg().querySelector('[data-caliper]')).toBeNull();
    expect(button('Caliper: measure two points').getAttribute('aria-pressed')).toBe('false');
  });

  it('supports keyboard placement and adjustment without panning, and units follow preferences', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'in' } }));
    mount(); click('Caliper: measure two points');
    expect(document.activeElement).toBe(svg());
    key(svg(), 'Enter'); key(svg(), 'ArrowRight'); key(svg(), 'ArrowUp'); key(svg(), 'Enter');
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toContain('in');
    expect(svg().querySelector('g')!.getAttribute('transform')).toBe('translate(0 0) scale(1)');
    expect(svg().querySelectorAll('[data-caliper-point]')).toHaveLength(2);
    key(svg(), 'Escape');
    click('Add station guide'); expect(svg().querySelector('[data-guide]')).not.toBeNull();
  });

  it('snaps a tap near tube corners and keeps its SI measurement through zoom and pan', () => {
    mount();
    click('Caliper: measure two points');
    const body = svg().querySelector<SVGRectElement>(':scope > g > rect')!;
    const x = Number(body.getAttribute('x')), y = Number(body.getAttribute('y'));
    const width = Number(body.getAttribute('width'));
    const h = Number(svg().getAttribute('viewBox')!.split(' ')[3]);
    pointer(x + 2, y * 240 / h); pointer(x + width - 2, y * 240 / h);
    const text = () => host.querySelector('[data-caliper-readout]')!.textContent;
    expect(text()).toBe('Horizontal 200 mm · Vertical 0 mm · Straight 200 mm');
    click('Zoom in'); expect(text()).toBe('Horizontal 200 mm · Vertical 0 mm · Straight 200 mm');
    const markerX = Number(svg().querySelector('[data-caliper-point="1"] circle')!.getAttribute('cx'));
    key(svg(), 'ArrowLeft', true);
    expect(text()).toBe('Horizontal 200 mm · Vertical 0 mm · Straight 200 mm');
    expect(Number(svg().querySelector('[data-caliper-point="1"] circle')!.getAttribute('cx'))).toBeCloseTo(markerX + 64, 10);
    // Exit measurement, pan, then start another caliper: inversion includes the pan.
    key(svg(), 'Escape'); key(svg(), 'ArrowLeft');
    const transform = svg().querySelector('g')!.getAttribute('transform')!.match(/[-\d.]+/g)!.map(Number);
    const pickX = transform[0]! + transform[2]! * (x + width / 4);
    const pickY = transform[1]! + transform[2]! * (y + Number(body.getAttribute('height')) / 2);
    click('Caliper: measure two points');
    pointer(pickX, pickY * 240 / h); pointer(pickX + transform[2]! * width / 4, pickY * 240 / h);
    expect(text()).toBe('Horizontal 50 mm · Vertical 0 mm · Straight 50 mm');
    expect(Number(svg().querySelector('[data-caliper-point="1"] circle')!.getAttribute('cx'))).toBeCloseTo(pickX, 10);
    key(svg(), 'Escape');
    click('Caliper: measure two points'); key(svg(), 'Enter'); key(svg(), 'ArrowRight'); key(svg(), 'Enter');
    expect(text()).toBe('Horizontal 1 mm · Vertical 0 mm · Straight 1 mm');
  });

  it('clears on a design or roll change, and undo cannot resurrect old endpoints', () => {
    mount(); click('Caliper: measure two points'); pointer(200, 130); pointer(350, 160);
    act(() => { root.render(<PrefsProvider><TreeSchematic tree={{ ...tree, name: 'Changed' }} info={null} /></PrefsProvider>); });
    mount(); expect(svg().querySelector('[data-caliper]')).toBeNull();
    click('Caliper: measure two points'); pointer(200, 130); pointer(350, 160);
    act(() => { root.render(<PrefsProvider><TreeSchematic tree={tree} info={null} roll={0.3} /></PrefsProvider>); });
    expect(svg().querySelector('[data-caliper]')).toBeNull();
  });
});
