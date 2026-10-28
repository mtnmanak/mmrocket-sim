// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { TreeSchematic } from './TreeSchematic.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { makeNode } from '../tree/treeModel.js';
import { downloadBlob } from '../services/saveFile.js';
import { svgToImage } from '../services/schematicExport.js';

vi.mock('../services/saveFile.js', () => ({ downloadBlob: vi.fn() }));
vi.mock('../services/schematicExport.js', async original => ({
  ...(await original<typeof import('../services/schematicExport.js')>()), svgToImage: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fins = { ...makeNode('freeformfinset'), id: 'fins', name: 'Fins', crossSection: 'airfoil' } as ComponentNode;
const holes = { ...makeNode('tubehole'), id: 'holes' };
const tube = { ...makeNode('bodytube'), id: 'tube', children: [fins, holes] };
const tree = { name: 'Rocket', components: [{ type: 'stage', id: 'stage', children: [tube] }] } as RocketTree;
let root: Root, host: HTMLDivElement;
/** Text in any alert region: the regions stay mounted, empty, between messages. */
const alertTexts = () => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').filter(Boolean);
const mount = (node = fins, design = tree) => act(() => root.render(
  <PrefsProvider><PropertyPanel tree={design} node={node} onPatch={() => {}} /></PrefsProvider>,
));
const trigger = () => [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Fin alignment jig'))!;
const popup = () => host.querySelector('[role="group"][aria-label="Fin alignment jig — file format"]');
const pick = async (label: string) => {
  act(() => trigger().click());
  const button = [...popup()!.querySelectorAll('button')].find(b => b.textContent!.startsWith(label))!;
  await act(async () => { button.click(); await new Promise(r => setTimeout(r, 0)); });
};
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.clearAllMocks(); });

it('explains fabrication scope beside the hole fields and offers no physical overrides', () => {
  mount(holes);
  expect(host.textContent).toMatch(/Fabrication only.*mass, CG, drag or any flight number/);
  expect(host.textContent).toMatch(/does not calculate vent pressure/);
  expect(host.querySelector('[aria-label="Hole diameter (mm)"]')).not.toBeNull();
  expect(host.textContent).not.toContain('Overrides (blank');
  expect(host.querySelector('[aria-label="Component color"]')).toBeNull();
});

it('renders selectable hole marks in the 2D component with a keyboard target and a non-colour cue', () => {
  const onSelect = vi.fn();
  const body = { ...tube, children: [{ ...holes, holeCount: 4 }] };
  const design = { ...tree, components: [{ ...tree.components[0]!, children: [body] }] };
  act(() => root.render(<PrefsProvider><div className="viz-root" data-contrast="high" style={{ width: 360 }}>
    <TreeSchematic tree={design} info={null} onSelect={onSelect} />
  </div></PrefsProvider>));
  const marks = host.querySelectorAll('[data-part="tube-hole"]');
  expect(marks).toHaveLength(4);
  const target = host.querySelector('[aria-label="Select Vent / marking hole"]')!;
  expect(target.getAttribute('tabindex')).toBe('0');
  expect(target.querySelector('title')!.textContent).toContain('fabrication only');
  expect(target.querySelectorAll('path')).toHaveLength(2);
  expect(target.getAttribute('stroke')).toBe('#000');
  expect(target.querySelector('path')!.getAttribute('fill')).toBe('#fff');
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  expect(onSelect).toHaveBeenCalledWith('holes');
  expect([...marks].some(mark => mark.hasAttribute('stroke-dasharray'))).toBe(true);
});

it('offers four jig formats, keyboard Escape, explicit total clearance and scale advice', () => {
  mount();
  const button = trigger();
  button.focus(); act(() => button.click());
  expect(popup()!.querySelectorAll('button')).toHaveLength(4);
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(popup()).toBeNull(); expect(document.activeElement).toBe(button);
  expect(host.textContent).toMatch(/total clearance.*both sides/);
  expect(host.textContent).toMatch(/100%.*ruler/);
  expect(host.querySelector('label[for]')?.getAttribute('for')).toBeTruthy();
});

it('exports white and transparent SVG with the selected clearance and preferred units', async () => {
  mount();
  const input = host.querySelector('[aria-label="Slot clearance (mm)"]') as HTMLInputElement;
  act(() => input.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0.5');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await pick('SVG, white');
  const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]!;
  expect(name).toBe('Fins-alignment-jig.svg');
  expect(await blob.text()).toContain('slot width 3.5 mm');
  expect(await blob.text()).toContain('background:#fff');
  await pick('SVG, transparent');
  expect(await vi.mocked(downloadBlob).mock.calls[1]![0].text()).not.toContain('background:#fff');
});

it.each([['PNG', 'png'], ['JPG', 'jpeg']] as const)('exports %s at physical 300 dpi', async (label, format) => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  vi.mocked(svgToImage).mockResolvedValue(new Blob([format === 'png' ? png : new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
  mount(); await pick(label);
  const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]!;
  expect(name).toBe(`Fins-alignment-jig-300dpi.${format === 'png' ? 'png' : 'jpg'}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (format === 'png') expect(new TextDecoder().decode(bytes.subarray(37, 41))).toBe('pHYs');
  else expect((bytes[14]! << 8) | bytes[15]!).toBe(300);
  expect(vi.mocked(svgToImage).mock.calls[0]![2]).toBe(format);
});

it('reports raster failure with an SVG retry and invalid cant beside the control', async () => {
  mount(); vi.mocked(svgToImage).mockRejectedValue(new Error('Canvas unavailable'));
  await pick('PNG');
  expect(host.querySelector('.fin-jig-alert[role="alert"]')!.textContent).toMatch(/Caution:.*Canvas unavailable.*SVG/);
  await pick('SVG, white'); expect(alertTexts()).toEqual([]);
  const canted = { ...fins, cant: 0.01 };
  const body = { ...tube, children: [canted] };
  mount(canted, { ...tree, components: [{ ...tree.components[0]!, children: [body] }] });
  expect(host.textContent).toMatch(/Caution:.*cant/);
});

it('keeps oversized jigs at 1:1 in SVG and refuses a raster before allocating a large canvas', async () => {
  const body = { ...tube, outerRadius: 0.5 };
  mount(fins, { ...tree, components: [{ ...tree.components[0]!, children: [body] }] });
  await pick('PNG');
  expect(svgToImage).not.toHaveBeenCalled();
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(host.querySelector('.fin-jig-alert[role="alert"]')!.textContent).toBe('⚠ Caution: Could not export the fin alignment jig: too large for a 300 dpi image (limits: 16 million pixels in total, 8192 pixels on either side) — try an SVG option.');
  await pick('SVG, white');
  expect(downloadBlob).toHaveBeenCalledTimes(1);
});
