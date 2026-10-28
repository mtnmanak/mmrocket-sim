// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { downloadBlob } from '../services/saveFile.js';
import { svgToImage } from '../services/schematicExport.js';

vi.mock('../services/saveFile.js', () => ({ downloadBlob: vi.fn() }));
vi.mock('../services/schematicExport.js', async (original) => ({
  ...(await original<typeof import('../services/schematicExport.js')>()), svgToImage: vi.fn(),
}));
const cssText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fins = { id: 'fins', type: 'freeformfinset', name: 'Fins', points: [[0, 0], [0.04, 0.03], [0.05, 0]],
  finCount: 3, thickness: 0.002, crossSection: 'rounded' } as ComponentNode;
const tube = { id: 'tube', type: 'bodytube', name: 'Tube', outerRadius: 0.0127,
  length: 0.1, children: [fins] } as ComponentNode;
const tree = { name: 'Rocket', components: [{ id: 'stage', type: 'stage', children: [tube] }] } as RocketTree;
let host: HTMLDivElement;
/** Text in any alert region: the regions stay mounted, empty, between messages. */
const alertTexts = () => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? '').filter(Boolean);
let root: Root;
let style: HTMLStyleElement;
const mount = (selected: ComponentNode = tube, design = tree) => act(() => root.render(
  <PrefsProvider><PropertyPanel tree={design} node={selected} onPatch={() => {}} /></PrefsProvider>,
));
const trigger = () => [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Tube wrap'));
const popup = () => host.querySelector('[role="group"][aria-label="Tube wrap — file format"]');
const pick = async (label: string) => {
  act(() => trigger()!.click());
  const button = [...popup()!.querySelectorAll('button')].find(b => b.textContent!.startsWith(label))!;
  await act(async () => { button.click(); await new Promise(r => setTimeout(r, 0)); });
};
beforeEach(() => {
  localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  style = document.createElement('style'); style.textContent = cssText; document.head.append(style);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); style.remove(); localStorage.clear(); vi.clearAllMocks();
});

it('offers the wrap on the tube and its freeform fins; Escape restores keyboard focus', () => {
  mount(fins);
  const button = trigger()!;
  button.focus(); act(() => button.click());
  expect(popup()!.querySelectorAll('button')).toHaveLength(4);
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(popup()).toBeNull(); expect(document.activeElement).toBe(button);
  expect(host.textContent).toMatch(/100%.*ruler/);
  expect(host.textContent).toMatch(/no cutting allowance/);
});

it('downloads a single white SVG using preferred units and physical dimensions', async () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'in', angle: 'rad' } }));
  mount(); await pick('SVG, white');
  const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]!;
  expect(name).toBe('Tube-wrap.svg'); expect(blob.type).toBe('image/svg+xml');
  const svg = await blob.text();
  expect(svg).toContain('OD 1 in'); expect(svg).toContain('rad');
  expect(svg).toContain('width="210mm" height="279mm"'); expect(svg).toContain('background:#fff');
});

it('packages all tiled SVG sheets in one ZIP with printing instructions', async () => {
  const big = { ...tube, length: 0.5, outerRadius: 0.05 };
  const design = { ...tree, components: [{ ...tree.components[0]!, children: [big] }] };
  mount(big, design); await pick('SVG, transparent');
  const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]!;
  expect(name).toBe('Tube-wrap-transparent-6-pages.zip');
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  expect(Object.keys(files)).toHaveLength(7);
  expect(strFromU8(files['README.txt']!)).toMatch(/100%.*no fit to page/);
  expect(strFromU8(files['Tube-wrap-transparent-c2-r3.svg']!)).toContain('Page 6/6');
  expect(strFromU8(files['Tube-wrap-transparent-c2-r3.svg']!)).not.toContain('background:#fff');
});

it.each([['PNG', 'png'], ['JPG', 'jpeg']] as const)('writes %s images with physical 300 dpi metadata', async (label, format) => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  vi.mocked(svgToImage).mockResolvedValue(new Blob([format === 'png' ? png : new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
  mount(); await pick(label);
  const [blob, name] = vi.mocked(downloadBlob).mock.calls[0]!;
  expect(name).toBe(`Tube-wrap-300dpi.${format === 'png' ? 'png' : 'jpg'}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (format === 'png') expect(strFromU8(bytes.subarray(37, 41))).toBe('pHYs');
  else { expect(strFromU8(bytes.subarray(6, 10))).toBe('JFIF'); expect((bytes[14]! << 8) | bytes[15]!).toBe(300); }
  expect(vi.mocked(svgToImage).mock.calls[0]!.slice(1)).toEqual([2480, format, 3295]);
});

it('reports raster failures beside the wrap control with SVG recovery', async () => {
  vi.mocked(svgToImage).mockRejectedValue(new Error('Canvas unavailable'));
  mount(); await pick('PNG');
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(host.querySelector('.tube-wrap-alert[role="alert"]')!.textContent).toMatch(/Caution:.*Canvas unavailable.*SVG/);
  expect(trigger()!.disabled).toBe(false);
});

it.each([
  ['PNG', 'success'], ['PNG', 'failure'], ['JPG', 'success'], ['JPG', 'failure'],
] as const)('keeps keyboard focus through pending %s export and %s without allowing duplicates', async (label, outcome) => {
  let resolveImage!: (blob: Blob) => void;
  let rejectImage!: (reason: Error) => void;
  vi.mocked(svgToImage).mockImplementation(() => new Promise((resolve, reject) => {
    resolveImage = resolve; rejectImage = reject;
  }));
  mount();
  host.className = 'viz-root';
  if (label === 'JPG') host.dataset.contrast = 'high';
  const opener = trigger()!;
  opener.focus(); act(() => opener.click());
  const choice = [...popup()!.querySelectorAll('button')].find(b => b.textContent!.startsWith(label))!;
  choice.focus(); expect(document.activeElement).toBe(choice);
  await act(async () => { choice.click(); });
  expect(popup()).toBeNull();
  expect(document.activeElement === opener).toBe(true);
  expect(opener.getAttribute('aria-disabled')).toBe('true');
  expect(getComputedStyle(opener).opacity).toBe(label === 'JPG' ? '1' : '0.5');
  const wrapStatus = [...host.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes('Preparing tube wrap'));
  expect(wrapStatus).toBeDefined();
  act(() => opener.click());
  expect(popup()).toBeNull();
  act(() => opener.click());
  expect(popup()).toBeNull();
  expect(svgToImage).toHaveBeenCalledOnce();
  await act(async () => {
    if (outcome === 'failure') rejectImage(new Error('Canvas unavailable'));
    else resolveImage(new Blob([label === 'PNG' ? Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]) : new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]));
  });
  expect(document.activeElement === opener).toBe(true);
  expect(opener.getAttribute('aria-disabled')).toBe('false');
  if (outcome === 'failure') {
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(host.querySelector('.tube-wrap-alert[role="alert"]')!.textContent).toMatch(/Canvas unavailable.*SVG/);
    await pick('SVG, white');
    expect(vi.mocked(downloadBlob).mock.calls[0]![1]).toBe('Tube-wrap.svg');
    expect(alertTexts()).toEqual([]);
  } else {
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(wrapStatus!.isConnected).toBe(true);
    expect(wrapStatus!.textContent).toContain('1 page prepared');
    act(() => opener.click()); expect(popup()).not.toBeNull();
  }
});

it('does not offer a straight-tube wrap on a transition or on its fins', () => {
  const transition = { ...tube, type: 'transition' } as ComponentNode;
  const design = { ...tree, components: [{ ...tree.components[0]!, children: [transition] }] };
  mount(transition, design); expect(trigger()).toBeUndefined();
  mount(fins, design); expect(trigger()).toBeUndefined();
});
