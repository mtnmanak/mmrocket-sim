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

const trigger = () => host.querySelector('button') as HTMLButtonElement;
const openMenu = () => act(() => trigger().click());
const popup = () => host.querySelector('.image-export-popup');
const widthButtons = () =>
  [...host.querySelectorAll('.image-export-popup button')] as HTMLButtonElement[];
const fitBox = () => host.querySelector('.image-export-popup input[type="checkbox"]') as HTMLInputElement | null;

describe('ImageExportMenu — fit-to-frame toggle', () => {
  it('offers the checkbox only when asked, and defaults it ON', () => {
    const onPick = vi.fn();
    act(() => root.render(<ImageExportMenu label="x" title="t" onPick={onPick} />));
    openMenu();
    expect(fitBox()).toBeNull();

    act(() => root.render(<ImageExportMenu label="x" title="t" fitOption onPick={onPick} />));
    expect(fitBox()!.checked).toBe(true);
    expect(host.querySelector('.image-export-popup label')!.textContent).toContain('Fit rocket to frame');
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
    expect(popup()).toBeNull();
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

/**
 * Audit 2026-09-22: the header's own export popups were fixed and this sibling
 * was not. It declared `role="menu"` over plain buttons (not menuitems, so
 * assistive tech prunes them — an empty menu), Escape did not dismiss it, and
 * its six buttons had three names: "HD", "4K", "8K", each twice.
 */
describe('ImageExportMenu — a disclosure, keyboard-complete', () => {
  it('is a disclosure: no menu roles, a named group, and aria-expanded on the trigger', () => {
    act(() => root.render(<ImageExportMenu label="⬇ Image" title="t" onPick={vi.fn()} />));
    expect(trigger().getAttribute('aria-haspopup')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    openMenu();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(popup()!.getAttribute('role')).toBe('group');
    expect(popup()!.getAttribute('aria-label')).toBe('Image export — format and width');
  });

  it('gives every width button its own name, format first-class, visible text first', () => {
    act(() => root.render(<ImageExportMenu label="⬇ Image" title="t" onPick={vi.fn()} />));
    openMenu();
    const names = widthButtons().map((b) => b.getAttribute('aria-label') ?? '');
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('HD PNG, 1920 px wide');
    expect(names).toContain('8K JPG, 7680 px wide');
    // Label in name: each accessible name opens with the text on the button,
    // so "click HD" still works for voice control.
    for (const b of widthButtons()) {
      expect(b.getAttribute('aria-label')!.startsWith(b.textContent!)).toBe(true);
    }
  });

  it('Escape closes it and puts focus back on the trigger', () => {
    act(() => root.render(<ImageExportMenu label="⬇ Image" title="t" onPick={vi.fn()} />));
    trigger().focus();
    openMenu();
    act(() => widthButtons()[0]!.focus());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('a pick puts focus back on the trigger rather than dropping it to <body>', () => {
    act(() => root.render(<ImageExportMenu label="⬇ Image" title="t" onPick={vi.fn()} />));
    trigger().focus();
    openMenu();
    const b = widthButtons()[1]!;
    act(() => b.focus());
    act(() => b.click());
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
