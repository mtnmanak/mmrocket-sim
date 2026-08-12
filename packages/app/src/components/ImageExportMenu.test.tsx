// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageExportMenu } from './ImageExportMenu.js';
import { IMAGE_WIDTHS } from '../services/schematicExport.js';

/**
 * Rendered through react-dom's own root API with React's `act` — there is no
 * @testing-library in this workspace (see SiteBand.test.tsx).
 *
 * What must hold: "Fit rocket to frame" defaults ON where it is offered, and
 * every caller that does NOT offer it keeps getting the old, unfitted export.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const openMenu = () => act(() => (host.querySelector('button') as HTMLButtonElement).click());
const widthButtons = () =>
  [...host.querySelectorAll('[role="menu"] button')] as HTMLButtonElement[];
const fitBox = () => host.querySelector('[role="menu"] input[type="checkbox"]') as HTMLInputElement | null;

describe('ImageExportMenu — fit-to-frame toggle', () => {
  it('offers the checkbox only when asked, and defaults it ON', () => {
    const onPick = vi.fn();
    act(() => root.render(<ImageExportMenu label="x" title="t" onPick={onPick} />));
    openMenu();
    expect(fitBox()).toBeNull();

    act(() => root.render(<ImageExportMenu label="x" title="t" fitOption onPick={onPick} />));
    expect(fitBox()!.checked).toBe(true);
    expect(host.querySelector('[role="menu"] label')!.textContent).toContain('Fit rocket to frame');
  });

  it('passes fit:true with the format and width, and closes the menu', () => {
    const onPick = vi.fn();
    act(() => root.render(<ImageExportMenu label="x" title="t" fitOption onPick={onPick} />));
    openMenu();
    // PNG row then JPG row, each of IMAGE_WIDTHS; take the last (JPG 8K).
    const buttons = widthButtons();
    expect(buttons).toHaveLength(2 * IMAGE_WIDTHS.length);
    act(() => buttons[buttons.length - 1]!.click());
    expect(onPick).toHaveBeenCalledWith('jpeg', IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1], { fit: true });
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('passes fit:false once unchecked — the old behaviour stays reachable', () => {
    const onPick = vi.fn();
    act(() => root.render(<ImageExportMenu label="x" title="t" fitOption onPick={onPick} />));
    openMenu();
    // .click() is what makes React see a change: assigning .checked directly
    // updates React's own value tracker, so onChange would never fire.
    act(() => fitBox()!.click());
    expect(fitBox()!.checked).toBe(false);
    act(() => widthButtons()[0]!.click());
    expect(onPick).toHaveBeenCalledWith('png', IMAGE_WIDTHS[0], { fit: false });
  });

  it('reports fit:false to a caller that never offered the toggle', () => {
    // TreeSchematic's 2D export takes (format, width) only; a stray fit:true
    // there would be a lie about what was rendered.
    const onPick = vi.fn();
    act(() => root.render(<ImageExportMenu label="x" title="t" onPick={onPick} />));
    openMenu();
    act(() => widthButtons()[0]!.click());
    expect(onPick).toHaveBeenCalledWith('png', IMAGE_WIDTHS[0], { fit: false });
  });
});
