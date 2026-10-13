// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { TreeSchematic } from './TreeSchematic.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { schematicSvg } from '../services/schematicExport.js';
import { INITIAL_UNITS } from '../prefs/units.js';

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
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); });

describe('N033 and N044 view tools', () => {
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
    click('Measure two points');
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
    mount(); click('Measure two points');
    pointer(200, 130); pointer(350, 160);
    expect(host.querySelector('[data-caliper-readout]')!.textContent).toMatch(/Horizontal .* mm.*Vertical .* mm.*Straight .* mm/);
    expect(svg().querySelectorAll('[data-caliper-point]')).toHaveLength(2);
    expect(exported()).not.toContain('data-caliper');
    expect(patch).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
    key(svg(), 'Escape'); expect(svg().querySelector('[data-caliper]')).toBeNull();
    expect(button('Measure two points').getAttribute('aria-pressed')).toBe('false');
  });

  it('supports keyboard placement and adjustment without panning, and units follow preferences', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'in' } }));
    mount(); click('Measure two points');
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
    click('Measure two points');
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
    click('Measure two points');
    pointer(pickX, pickY * 240 / h); pointer(pickX + transform[2]! * width / 4, pickY * 240 / h);
    expect(text()).toBe('Horizontal 50 mm · Vertical 0 mm · Straight 50 mm');
    expect(Number(svg().querySelector('[data-caliper-point="1"] circle')!.getAttribute('cx'))).toBeCloseTo(pickX, 10);
    key(svg(), 'Escape');
    click('Measure two points'); key(svg(), 'Enter'); key(svg(), 'ArrowRight'); key(svg(), 'Enter');
    expect(text()).toBe('Horizontal 1 mm · Vertical 0 mm · Straight 1 mm');
  });

  it('clears on a design or roll change, and undo cannot resurrect old endpoints', () => {
    mount(); click('Measure two points'); pointer(200, 130); pointer(350, 160);
    act(() => { root.render(<PrefsProvider><TreeSchematic tree={{ ...tree, name: 'Changed' }} info={null} /></PrefsProvider>); });
    mount(); expect(svg().querySelector('[data-caliper]')).toBeNull();
    click('Measure two points'); pointer(200, 130); pointer(350, 160);
    act(() => { root.render(<PrefsProvider><TreeSchematic tree={tree} info={null} roll={0.3} /></PrefsProvider>); });
    expect(svg().querySelector('[data-caliper]')).toBeNull();
  });
});
