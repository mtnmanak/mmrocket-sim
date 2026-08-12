// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { printerFromPreset } from '../prefs/printers.js';

/**
 * The 🖨 button, wired. printPack.test.ts pins the wording; this pins that the
 * panel actually shows it — and, above all, that a user with no printer
 * configured sees the button exactly as it has always read, with nothing
 * underneath it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'online-openrocket.prefs.v1';

let host: HTMLDivElement;
let root: Root;

/** The named 3" 4:1 ogive nose: 304.8 mm of cone + 76.2 mm shoulder = 381 mm. */
const nose = {
  id: 'n1', type: 'nosecone', name: 'Nose',
  shape: 'ogive', shapeParameter: 1, length: 0.3048, aftRadius: 0.0381, thickness: 0.002,
  shoulderRadius: 0.0356, shoulderLength: 0.0762, shoulderThickness: 0.002,
} as unknown as ComponentNode;

const tree = {
  name: 'Rocket',
  components: [{ id: 's1', type: 'stage', children: [nose] }],
} as unknown as RocketTree;

const printButton = (): HTMLButtonElement =>
  [...host.querySelectorAll('button')].find((b) => b.textContent!.startsWith('🖨'))!;
const note = (): HTMLElement | null => host.querySelector('.print-note');

const mount = () => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={nose} onPatch={() => {}} />
  </PrefsProvider>,
));

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
});

describe('PropertyPanel — the print button', () => {
  it('with no printer configured: unchanged caption, one advisory line', () => {
    mount();
    expect(printButton().textContent).toBe('🖨 STL for printing (mm)');
    expect(note()!.textContent).toBe('381 mm long — set your printer in Preferences to check it fits.');
    expect(note()!.className).toBe('print-note');
  });

  it('with a printer that swallows the part: unchanged caption, quiet confirmation', () => {
    // 385 mm of Z less the 8 mm kept clear at the top is 377 usable — 381 mm
    // upright is 4 mm too much, but tipped 30° it stands
    // 381*cos30 + 76.2*sin30 = 330.0 + 38.1 = 368.1 mm and goes in whole.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ printer: printerFromPreset('neptune-4-plus') }));
    mount();
    expect(printButton().textContent).toBe('🖨 STL for printing (mm)');
    expect(note()!.textContent)
      .toBe('381 mm — fits your Elegoo Neptune 4 Plus leaned 30° off vertical.');
    expect(note()!.className).toBe('print-note');
  });

  it('with a printer it does not fit: the piece count is in the button, in amber', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ printer: printerFromPreset('bambu-h2d') }));
    mount();
    // 325 mm of Z less the 8 mm kept clear at the TOP (the part stands on the
    // bed, so nothing comes off the bottom) is 317 usable; 381 - 317 = 64.
    expect(printButton().textContent).toBe('🖨 STL for printing — 2 pieces');
    expect(note()!.textContent).toContain('64 mm too long for your Bambu H2D');
    expect(note()!.className).toContain('print-note-warn');
  });

  it('a fin set keeps the plain caption and says nothing, printer or not', () => {
    const fin = { id: 'f1', type: 'trapezoidfinset', name: 'Fins', rootChord: 0.06, tipChord: 0.03, height: 0.05, thickness: 0.003 } as unknown as ComponentNode;
    const finTree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{ id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.002, length: 0.6, children: [fin] }] }],
    } as unknown as RocketTree;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ printer: printerFromPreset('bambu-a1mini') }));
    act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={finTree} node={fin} onPatch={() => {}} />
      </PrefsProvider>,
    ));
    expect(printButton().textContent).toBe('🖨 STL for printing (mm)');
    expect(note()).toBeNull();
  });
});
