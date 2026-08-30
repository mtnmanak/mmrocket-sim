// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { RULER_LEFT, RULER_TOP, TreeSchematic } from './TreeSchematic.js';
import { ROLL_COL } from './RollControl.js';
import { schematicSvg } from '../services/schematicExport.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { INITIAL_UNITS } from '../prefs/units.js';

/**
 * v0.078 — the dimensional rulers (@atestani: "Scales as in OpenRocket like
 * the top and left side") and the roll slider.
 *
 * The tick ladder itself is tested in services/rulerTicks.test.ts. What
 * matters here is that the gutters exist, that the DRAWING gives up the space
 * rather than being drawn under them, that the export gets a fit-view ruler
 * instead of the zoomed one, and that each fin is foreshortened by
 * cos(clock angle) the way the desktop foreshortens it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const finTree = (finCount: number, extra: Record<string, unknown> = {}) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
      {
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
        children: [{
          id: 'f1', type: 'trapezoidfinset', finCount,
          rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, ...extra,
        }],
      },
    ],
  }],
} as unknown as RocketTree);

const info: StaticInfo = {
  length: 0.4, lengthAerodynamic: 0.4, mass: 0.1, massEmpty: 0.08, cgEmpty: 0.2, cg: 0.2, cp: 0.28,
  cna: 10, stabilityCalibers: 1.52, refDiameter: 0.024, warnings: 0, warningTexts: [],
};

const show = (el: React.ReactElement) => act(() => root.render(el));

/** viewBox height, and the centreline the drawing is built around. */
const viewH = () => Number(host.querySelector('svg')!.getAttribute('viewBox')!.split(' ')[3]);
const centreY = () => RULER_TOP + (viewH() - RULER_TOP) / 2;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('dimensional rulers', () => {
  const rulerGroup = () => host.querySelector<SVGGElement>('[data-ruler="view"]');
  /** The nose cone's leading edge — the first path INSIDE the view group
   *  (`querySelector('path')` finds the bulkhead hatch in <defs> instead). */
  const noseStartX = (): number => {
    const d = host.querySelector('svg > g > path')!.getAttribute('d')!;
    return Number(/M\s*([\d.]+)/.exec(d)![1]);
  };

  it('draws both gutters, labelled ticks and the unit in the corner', () => {
    show(<TreeSchematic tree={finTree(3)} info={info} />);
    const g = rulerGroup()!;
    expect(g).not.toBeNull();
    const labels = [...g.querySelectorAll('text')].map((t) => t.textContent ?? '');
    // The corner reports the Preferences length unit (the default store's mm).
    expect(labels).toContain('mm');
    const numbers = labels.filter((l) => l !== 'mm');
    expect(numbers.length).toBeGreaterThan(2);
    expect(numbers.every((l) => /^-?[\d.]+$/.test(l))).toBe(true);
    // Ticks on both axes: verticals in the top band, horizontals in the left.
    const lines = [...g.querySelectorAll('line')];
    expect(lines.some((l) => l.getAttribute('x1') === l.getAttribute('x2'))).toBe(true);
    expect(lines.some((l) => l.getAttribute('y1') === l.getAttribute('y2'))).toBe(true);
  });

  it('the vertical ruler reads from the centreline, signed both ways', () => {
    show(<TreeSchematic tree={finTree(3)} info={info} />);
    const g = rulerGroup()!;
    const labels = [...g.querySelectorAll('text')].map((t) => t.textContent ?? '');
    expect(labels).toContain('0');
    expect(labels.some((l) => l.startsWith('-'))).toBe(true);
  });

  it('insets the drawing by the gutters instead of drawing under them', () => {
    show(<TreeSchematic tree={finTree(3)} info={info} />);
    const withRulers = noseStartX();
    expect(withRulers).toBeGreaterThanOrEqual(RULER_LEFT + ROLL_COL);

    // Same rocket with the preference off: the drawing reclaims the gutter.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ rulers2d: false }));
    act(() => root.unmount());
    root = createRoot(host);
    show(<PrefsProvider><TreeSchematic tree={finTree(3)} info={info} /></PrefsProvider>);
    expect(rulerGroup()).toBeNull();
    expect(noseStartX()).toBe(withRulers - RULER_LEFT);
  });

  it('hands the export a fit-view ruler once the view is zoomed', () => {
    show(<TreeSchematic tree={finTree(3)} info={info} />);
    // Not zoomed: one ruler, and it is already the fit view.
    expect(host.querySelector('[data-ruler="fit"]')).toBeNull();

    const zoomIn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Zoom in')!;
    act(() => { zoomIn.click(); });

    const fit = host.querySelector('[data-ruler="fit"]')!;
    expect(fit).not.toBeNull();
    expect(fit.getAttribute('display')).toBe('none');
    // The two disagree — which is the whole reason the second copy exists.
    const firstTickX = (which: string) =>
      host.querySelector(`[data-ruler="${which}"] line`)!.getAttribute('x1');
    expect(firstTickX('view')).not.toBe(firstTickX('fit'));

    // The exporter drops the on-screen copy and reveals the fit one.
    const svg = schematicSvg(host.querySelector('svg')!, 100, 640, 300, {
      name: 'Rocket', info: null, units: INITIAL_UNITS, withMotors: false, appVersion: '0',
    });
    expect(svg).not.toContain('data-ruler="view"');
    expect(svg).toContain('data-ruler="fit"');
    expect(svg).not.toContain('display="none"');
  });
});

describe('fin projection and roll', () => {
  /** Each fin polygon's furthest reach from the centreline (+ = above). */
  const finReaches = (): number[] => {
    const cy = centreY();
    return [...host.querySelectorAll('polygon')].map((p) => {
      const ys = p.getAttribute('points')!.split(' ').map((pt) => Number(pt.split(',')[1]));
      const far = ys.reduce((a, b) => (Math.abs(b - cy) > Math.abs(a - cy) ? b : a), cy);
      return cy - far;
    });
  };

  it('4 fins: the familiar mirrored pair, unchanged', () => {
    show(<TreeSchematic tree={finTree(4)} info={null} />);
    const r = finReaches();
    expect(r).toHaveLength(2);
    expect(r[0]! + r[1]!).toBeCloseTo(0, 6); // symmetric about the centreline
    expect(Math.abs(r[0]!)).toBeGreaterThan(0);
  });

  it('3 fins: one at full span up, two at half span down', () => {
    show(<TreeSchematic tree={finTree(3)} info={null} />);
    const d = finReaches().sort((a, b) => a - b);
    expect(d).toHaveLength(3);
    // cos 120° = cos 240° = −0.5, so the two lower fins reach exactly half as
    // far as the upper one, and downwards.
    expect(d[0]).toBeCloseTo(d[1]!, 6);
    expect(d[0]).toBeLessThan(0);
    expect(d[2]).toBeCloseTo(-2 * d[0]!, 6);
  });

  it('rolling 90° takes the upright fin edge-on and drops it', () => {
    show(<TreeSchematic tree={finTree(3)} info={null} roll={Math.PI / 2} />);
    // cos(90°) = 0 for the first fin — its whole silhouette falls inside the
    // airframe, so it is hidden rather than collapsed onto the centreline.
    expect(host.querySelectorAll('polygon')).toHaveLength(2);
  });

  it('a fin set’s own rotation moves it before any roll does', () => {
    show(<TreeSchematic tree={finTree(3, { rotation: Math.PI / 2 })} info={null} />);
    expect(host.querySelectorAll('polygon')).toHaveLength(2);
    // …and the matching roll puts it back upright.
    show(<TreeSchematic tree={finTree(3, { rotation: Math.PI / 2 })} info={null} roll={-Math.PI / 2} />);
    expect(host.querySelectorAll('polygon')).toHaveLength(3);
  });

  it('the roll slider reports the angle and resets it', () => {
    const onRoll = vi.fn();
    show(<TreeSchematic tree={finTree(3)} info={null} roll={Math.PI / 4} onRoll={onRoll} />);
    const readout = host.querySelector<HTMLButtonElement>('.roll-reset')!;
    expect(readout.textContent).toBe('45°');
    act(() => { readout.click(); });
    expect(onRoll).toHaveBeenCalledWith(0);
  });

  it('keeps its own angle when the caller does not own one', () => {
    show(<TreeSchematic tree={finTree(3)} info={null} />);
    const slider = host.querySelector<HTMLInputElement>('.roll-slider')!;
    expect(slider.value).toBe('0');
  });
});
