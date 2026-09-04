// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { StatsChip, clampToVisible } from './StatTiles.js';
import { RULER_LEFT, RULER_TOP } from './TreeSchematic.js';
import { ROLL_COL } from './RollControl.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHIP_KEY = 'online-openrocket.chip.v1';

const INFO = {
  length: 0.37, refDiameter: 0.024, mass: 0.0513, massEmpty: 0.0273,
  cg: 0.262, cgEmpty: 0.198, cp: 0.299, stabilityCalibers: 1.52,
  // A rocket that is stable at 1.52 cal necessarily generates normal force,
  // and the readout now checks that rather than trusting the margin alone:
  // cna = 0 means the CP and the margin are artefacts, not answers.
  cna: 8.995,
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

  const mount = (drawerOpen = false) => act(() => root.render(
    <PrefsProvider><StatsChip info={INFO} drawerOpen={drawerOpen} /></PrefsProvider>,
  ));
  const chip = () => host.querySelector('.stats-chip') as HTMLDivElement;

  it('shows the five readings, starting clear of the ruler gutters', () => {
    mount();
    const labels = Array.from(host.querySelectorAll('.stats-chip-label')).map((el) => el.textContent);
    expect(labels).toEqual(['Length', 'Mass loaded', 'CG', 'CP', 'Stability']);
    // v0.078: the 2D view's rulers and roll column own the top-left corner
    // the chip used to start in.
    expect(chip().style.left).toBe(`${ROLL_COL + RULER_LEFT + 8}px`);
    expect(chip().style.top).toBe(`${RULER_TOP + 8}px`);
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

  /**
   * v0.092 — owner report 2026-09-01: "The gadget square has no room anymore,
   * there is almost no way to fit it in the canvas window without covering
   * part of the rocket when the 'All Stats' drawer is open."
   *
   * The drawer shows a strict SUPERSET of the chip's five numbers — length,
   * loaded mass, CG, CP and stability are all tiles in it — so an unfolded
   * chip over an open drawer is duplicate information sitting on the rocket.
   * Measured in the built app at 1920x1080: the chip is 124px tall and the sky
   * above the rocket is ~15px with the drawer open, so no amount of canvas
   * growth would fit it there.
   */
  describe('while the All Stats drawer is open', () => {
    it('DEFAULTS TO OPEN, even though the drawer starts open', () => {
      // Owner ruling, 2026-09-01b: "the gadget auto fold is fine, but default
      // it to open." The drawer is open by default, so folding on the first
      // render meant a new user never saw the full readout at all. The fold is
      // a response to OPENING the drawer, not to finding it already open.
      mount(true);
      expect(chip().className).not.toContain('stats-chip-folded');
    });

    it('folds to the one-line pill when the drawer is opened', () => {
      mount(false);
      mount(true);
      expect(chip().className).toContain('stats-chip-folded');
    });

    it('does NOT overwrite the folded preference the user chose', () => {
      // The automatic fold is a display decision, not the user's. Persisting it
      // would silently rewrite their setting the first time they opened the
      // drawer, and the chip would come back folded forever after.
      mount(false);
      mount(true);
      expect(localStorage.getItem(CHIP_KEY)).toBeNull();
    });

    it('unfolds again when the drawer closes', () => {
      mount(false);
      mount(true);
      expect(chip().className).toContain('stats-chip-folded');
      mount(false);
      expect(chip().className).not.toContain('stats-chip-folded');
    });

    it('leaves a chip the user folded themselves folded afterwards', () => {
      localStorage.setItem(CHIP_KEY, JSON.stringify({ x: 64, y: 26, folded: true }));
      mount(false);
      mount(true);
      mount(false);
      expect(chip().className, 'their own fold was undone by the drawer closing')
        .toContain('stats-chip-folded');
    });

  });
});

/**
 * The clamp arithmetic, tested apart from the DOM.
 *
 * It has to be: happy-dom reports a zero-size layout, which is why the drag
 * test above degrades to "a number was written". The real numbers below are
 * the hero canvas measured in the built app at 1920x1080 — a 1041x670 stage
 * with a 269px drawer and a 210x124 chip.
 */
describe('clampToVisible', () => {
  const STAGE = { hostW: 1041, hostH: 670, elW: 210, elH: 124 };

  it('keeps the chip inside the stage when no drawer is showing', () => {
    expect(clampToVisible({ ...STAGE, covered: 0, x: 64, y: 26 })).toEqual({ x: 64, y: 26 });
    expect(clampToVisible({ ...STAGE, covered: 0, x: 5000, y: 5000 }))
      .toEqual({ x: 1041 - 210, y: 670 - 124 });
    expect(clampToVisible({ ...STAGE, covered: 0, x: -80, y: -80 })).toEqual({ x: 0, y: 0 });
  });

  it('will not leave the chip under the drawer, where it is painted over', () => {
    // 670 - 269 - 124 = 277 is the lowest the chip can sit and still be seen.
    const under = clampToVisible({ ...STAGE, covered: 269, x: 64, y: 500 });
    expect(under.y).toBe(277);
    expect(under.y + STAGE.elH, 'the chip overlaps the drawer')
      .toBeLessThanOrEqual(STAGE.hostH - 269);
  });

  it('does not move a chip that is already clear of the drawer', () => {
    expect(clampToVisible({ ...STAGE, covered: 269, x: 64, y: 26 })).toEqual({ x: 64, y: 26 });
  });

  it('falls back to the origin rather than a negative position', () => {
    // A drawer taller than the stage leaves no legal band at all. Pinning the
    // chip to 0 keeps it visible above the drawer instead of off-canvas.
    expect(clampToVisible({ ...STAGE, covered: 900, x: 64, y: 200 }).y).toBe(0);
  });
});
