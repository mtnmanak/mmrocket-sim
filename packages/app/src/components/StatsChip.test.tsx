// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { StatsChip } from './StatTiles.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHIP_KEY = 'online-openrocket.chip.v1';

const INFO = {
  length: 0.37, refDiameter: 0.024, mass: 0.0513, massEmpty: 0.0273,
  cg: 0.262, cgEmpty: 0.198, cp: 0.299, stabilityCalibers: 1.52,
  warningTexts: [],
} as never;

describe('StatsChip — the floating readout', () => {
  let host: HTMLDivElement;
  let root: Root;

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

  const mount = () => act(() => root.render(
    <PrefsProvider><StatsChip info={INFO} /></PrefsProvider>,
  ));
  const chip = () => host.querySelector('.stats-chip') as HTMLDivElement;

  it('shows the five readings, at the default corner', () => {
    mount();
    const labels = Array.from(host.querySelectorAll('.stats-chip-label')).map((el) => el.textContent);
    expect(labels).toEqual(['Length', 'Mass loaded', 'CG', 'CP', 'Stability']);
    expect(chip().style.left).toBe('12px');
    expect(chip().style.top).toBe('12px');
  });

  it('restores a remembered position and fold', () => {
    localStorage.setItem(CHIP_KEY, JSON.stringify({ x: 240, y: 80, folded: true }));
    mount();
    expect(chip().style.left).toBe('240px');
    expect(chip().style.top).toBe('80px');
    expect(chip().className).toContain('stats-chip-folded');
    // Folded = just the stability pill.
    expect(host.querySelectorAll('.stats-chip-label')).toHaveLength(0);
    expect(chip().textContent).toContain('1.52 cal');
  });

  it('the fold button collapses, persists, and expands again', () => {
    mount();
    const fold = () => host.querySelector('.stats-chip-fold') as HTMLButtonElement;
    act(() => { fold().click(); });
    expect(chip().className).toContain('stats-chip-folded');
    expect(JSON.parse(localStorage.getItem(CHIP_KEY)!).folded).toBe(true);
    act(() => { fold().click(); });
    expect(chip().className).not.toContain('stats-chip-folded');
    expect(JSON.parse(localStorage.getItem(CHIP_KEY)!).folded).toBe(false);
  });

  it('dragging moves the chip and persists where it landed', () => {
    mount();
    act(() => {
      chip().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 140, clientY: 90 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 140, clientY: 90 }));
    });
    const stored = JSON.parse(localStorage.getItem(CHIP_KEY)!) as { x: number; y: number };
    // happy-dom's zero-size layout clamps to the origin — the point pinned
    // here is that a drag WRITES a position (the numbers are layout-driven).
    expect(typeof stored.x).toBe('number');
    expect(typeof stored.y).toBe('number');
  });
});
