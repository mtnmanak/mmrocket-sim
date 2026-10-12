// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { downloadBlob } from '../services/saveFile.js';
import { svgToImage } from '../services/schematicExport.js';
import { finTemplatePixelSize } from '../services/finTemplate.js';
import { QUANTITY_LABEL } from '../prefs/units.js';
import * as dxfExport from '../services/dxfExport.js';

vi.mock('../services/saveFile.js', () => ({ downloadBlob: vi.fn() }));
vi.mock('../services/schematicExport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/schematicExport.js')>()),
  svgToImage: vi.fn(),
}));

/**
 * @atestani (TRF, 2026-10-11): "the DXF export doesn't respect my units
 * preference" and "the background of the exported image is grey and when
 * converted/saved as a jpeg, is black". Wired end to end: the ✂ DXF button
 * reads the Rocket dimensions (`prefs.units.length`) preference, and 📐 Fin template offers a white SVG (first),
 * the transparent one, and 300 dpi PNG/JPG images.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const fins = {
  id: 'fins', type: 'trapezoidfinset', name: 'Fins', finCount: 3, rootChord: 0.1, tipChord: 0.05,
  sweep: 0.05, height: 0.06, thickness: 0.003,
} as unknown as ComponentNode;
const tree = {
  name: 'Rocket',
  components: [{ id: 's1', type: 'stage', children: [{
    id: 'b1', type: 'bodytube', outerRadius: 0.0195, thickness: 0.0005, length: 0.6, children: [fins],
  }] }],
} as unknown as RocketTree;

const mount = () => act(() => root.render(
  <PrefsProvider><PropertyPanel tree={tree} node={fins} onPatch={() => {}} /></PrefsProvider>,
));
const buttons = () => [...host.querySelectorAll('button')];
const trigger = () => buttons().find((b) => b.textContent!.startsWith('📐'))!;
const popup = () => host.querySelector('[role="group"][aria-label="Fin template — file format"]');
const choices = () => [...(popup()?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
const pick = async (startsWith: string) => {
  act(() => trigger().click());
  const b = choices().find((c) => c.textContent!.startsWith(startsWith))!;
  await act(async () => { b.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
/** The [blob, filename, description] of the one download. */
const saved = (): [Blob, string, string] => {
  expect(downloadBlob).toHaveBeenCalledOnce();
  return vi.mocked(downloadBlob).mock.calls[0] as [Blob, string, string];
};
const alertText = () => host.querySelector('.print-note-warn[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.mocked(downloadBlob).mockReset();
  vi.mocked(svgToImage).mockReset();
});

describe('📐 Fin template — one control, four files', () => {
  it('opens a labelled choice with the white SVG first, and closes on Escape', () => {
    mount();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    act(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(choices().map((c) => c.textContent)).toEqual([
      'SVG, white background (recommended)',
      'SVG, transparent background',
      'PNG image, white, 300 dpi',
      'JPG image, white, 300 dpi',
    ]);
    for (const c of choices()) expect(c.title.length).toBeGreaterThan(20);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(popup()).toBeNull();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('the white SVG: a CSS page colour on the root <svg>, no rectangle, the ruler kept', async () => {
    mount();
    await pick('SVG, white');
    const [blob, name] = saved();
    expect(name).toBe('Fins-template.svg');
    expect(blob.type).toBe('image/svg+xml');
    const svg = await blob.text();
    expect(svg.split('\n')[0]).toMatch(/ style="background:#fff">$/);
    expect(svg).not.toMatch(/<rect\b/);
    expect(svg).toContain('the ruler below must measure exactly 50 mm');
    expect(popup()).toBeNull();
  });

  it('the transparent SVG is the page the button always wrote', async () => {
    mount();
    await pick('SVG, transparent');
    const [blob, name] = saved();
    expect(name).toBe('Fins-template-transparent.svg');
    const svg = await blob.text();
    expect(svg).not.toContain('background');
    expect(svg).toContain('the ruler below must measure exactly 50 mm');
  });

  it.each([
    ['PNG', 'png', 'Fins-template-300dpi.png'],
    ['JPG', 'jpeg', 'Fins-template-300dpi.jpg'],
  ] as const)('the %s draws the WHITE svg at 300 dpi and writes the resolution into the file', async (label, format, file) => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    vi.mocked(svgToImage).mockResolvedValue(new Blob([format === 'png' ? png : jpg], { type: `image/${format}` }));
    mount();
    await pick(label);
    expect(svgToImage).toHaveBeenCalledOnce();
    const [svg, width, fmt, height] = vi.mocked(svgToImage).mock.calls[0]!;
    expect(fmt).toBe(format);
    expect(svg.split('\n')[0]).toContain('style="background:#fff"');
    expect({ width, height }).toEqual(finTemplatePixelSize(svg, 300));
    const [blob, name, what] = saved();
    expect(name).toBe(file);
    expect(blob.type).toBe(`image/${format}`);
    expect(what).toBe(`${label} cut template`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (format === 'png') {
      expect(String.fromCharCode(...bytes.subarray(37, 41))).toBe('pHYs');
    } else {
      expect(String.fromCharCode(...bytes.subarray(6, 10))).toBe('JFIF');
      expect((bytes[14]! << 8) | bytes[15]!).toBe(300);
    }
    expect(alertText()).toBeNull();
  });

  it('a raster that fails to draw says so, and points at the SVG', async () => {
    vi.mocked(svgToImage).mockRejectedValue(new Error('SVG rasterize failed'));
    mount();
    await pick('PNG');
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(alertText()).toBe('Could not draw the fin template as an image: SVG rasterize failed — the SVG options still work.');
  });
});

describe('✂ DXF follows the Rocket dimensions (`prefs.units.length`) preference', () => {
  it('CR-5: the tooltip reads the drawing-unit word from the exporter', () => {
    const word = vi.spyOn(dxfExport, 'dxfUnitWord').mockReturnValue('drawing unit word');
    try {
      mount();
      expect(buttons().find(b => b.textContent!.startsWith('✂'))!.title).toContain('R12 DXF in drawing unit word');
    } finally {
      word.mockRestore();
    }
  });

  it('CR-3: the tooltip follows a rename of the rendered quantity label', () => {
    const original = QUANTITY_LABEL.length;
    try {
      QUANTITY_LABEL.length = 'Rocket size (renamed)';
      mount();
      expect(buttons().find(b => b.textContent!.startsWith('✂'))!.title).toContain(QUANTITY_LABEL.length);
    } finally {
      QUANTITY_LABEL.length = original;
    }
  });

  const dxf = async (): Promise<string> => {
    const b = buttons().find((x) => x.textContent!.startsWith('✂'))!;
    await act(async () => { b.click(); });
    return saved()[0].text();
  };
  const insunits = (text: string): string => {
    const lines = text.split('\r\n');
    return lines[lines.indexOf('$INSUNITS') + 2]!;
  };

  it('inches when Rocket dimensions is in', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'in' } }));
    mount();
    const text = await dxf();
    expect(insunits(text)).toBe('1');
    expect(text).toContain('root 3.937 in | span 2.362 in');
    expect(text).toContain('1:1 in inches');
    expect(buttons().find((x) => x.textContent!.startsWith('✂'))!.title).toContain('R12 DXF in inches');
  });

  it('inches when Rocket dimensions is ft', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'ft' } }));
    mount();
    expect(insunits(await dxf())).toBe('1');
  });

  it('millimetres when Rocket dimensions is cm (or the default mm)', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'cm' } }));
    mount();
    const text = await dxf();
    expect(insunits(text)).toBe('4');
    expect(text).toContain('root 100.0 mm | span 60.0 mm');
    expect(text).toContain('1:1 in millimetres');
  });
});
