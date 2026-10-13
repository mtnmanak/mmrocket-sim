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

/** A FILLED fin, not the wire outline a rolled view draws instead (v0.084). */
const FILLED_FIN = 'polygon:not([data-fin="wire"]):not([data-fin-hit])';

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
  rotationalInertia: 1.2e-4, longitudinalInertia: 3.4e-3,
  rotationalInertiaEmpty: 1.0e-4, longitudinalInertiaEmpty: 3.0e-3,
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
  const storedView = (settings: Record<string, unknown>) => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify(settings));
    show(<PrefsProvider><TreeSchematic tree={finTree(3)} info={info} /></PrefsProvider>);
  };
  const axialLabel = (text: string) => [...host.querySelectorAll('[data-ruler="view"] g text')]
    .find((el) => el.textContent === text && el.parentElement?.querySelector('line')?.getAttribute('x1')
      === el.parentElement?.querySelector('line')?.getAttribute('x2'))!;

  it('N013 reads zero at the aft end, increases toward the nose, and preserves geometry', () => {
    storedView({ rulerReference2d: 'aft' });
    const nose = host.querySelector('svg > g > path')!.getAttribute('d');
    expect(axialLabel('0')).toBeDefined();
    expect(axialLabel('100')).toBeDefined();
    const zeroX = Number(axialLabel('0').getAttribute('x'));
    const hundredX = Number(axialLabel('100').getAttribute('x'));
    expect(hundredX).toBeLessThan(zeroX);
    const noseX = Number(/M\s*([\d.]+)/.exec(nose!)![1]);
    expect(zeroX - noseX - 1.5).toBeCloseTo(400 / 100 * (zeroX - hundredX), 6);
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Ruler reference"]')!;
    act(() => { select.value = 'nose'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.querySelector('svg > g > path')!.getAttribute('d')).toBe(nose);
    expect(Number(axialLabel('0').getAttribute('x'))).toBeCloseTo(noseX + 1.5, 6);
  });

  it('N013 applies offset and reversed direction in display units', () => {
    storedView({ units: { length: 'in' }, rulerReference2d: 'offset', rulerOffset2dM: 0.0254,
      rulerReversed2d: true });
    const zeroX = Number(axialLabel('0').getAttribute('x'));
    const minusOneX = Number(axialLabel('-1').getAttribute('x'));
    const noseX = Number(/M\s*([\d.]+)/.exec(host.querySelector('svg > g > path')!.getAttribute('d')!)![1]);
    expect(minusOneX).toBeGreaterThan(zeroX);
    expect(zeroX - noseX - 1.5).toBeCloseTo(minusOneX - zeroX, 6);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Ruler zero from nose (in)"]')!.value).toBe('1');
  });

  it.each([false, true])('N013 anchors a short airframe aft ruler to its body end, reversed=%s, including fit export', (reversed) => {
    const tree = { name: 'Short', components: [{ id: 's', type: 'stage', children: [
      { id: 'n', type: 'nosecone', length: 0.01, aftRadius: 0.001 },
      { id: 'b', type: 'bodytube', length: 0.02, outerRadius: 0.001 },
    ] }] } as unknown as RocketTree;
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
      rulerReference2d: 'aft', rulerReversed2d: reversed,
    }));
    show(<PrefsProvider><TreeSchematic tree={tree} info={null} /></PrefsProvider>);
    const body = host.querySelector('svg > g rect')!;
    const aftX = Number(body.getAttribute('x')) + Number(body.getAttribute('width'));
    const zero = (svg: Element, kind: string) => [...svg.querySelectorAll(`[data-ruler="${kind}"] g`)]
      .find(g => g.querySelector('text')?.textContent === '0'
        && g.querySelector('line')?.getAttribute('x1') === g.querySelector('line')?.getAttribute('x2'))!
      .querySelector('line')!;
    expect(Number(zero(host, 'view').getAttribute('x1'))).toBeCloseTo(aftX, 8); // SVG coordinate roundoff
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    const svg = schematicSvg(host.querySelector('svg')!, 100, 640, 300, {
      name: 'Short', info: null, units: INITIAL_UNITS, withMotors: false, appVersion: '0',
    });
    const exported = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(Number(zero(exported.documentElement, 'fit').getAttribute('x1'))).toBeCloseTo(aftX, 8);
  });

  it('N013 keeps measuring guides at their nose-based stations when the reference changes', () => {
    storedView({ rulerReference2d: 'nose' });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Add station guide"]')!.click());
    const guide = host.querySelector('[data-guide="x"]')!;
    const before = guide.innerHTML;
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Ruler reference"]')!;
    act(() => { select.value = 'aft'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.querySelector('[data-guide="x"]')!.innerHTML).toBe(before);
  });

  it('N013 stores typed negative offsets in metres and reverses only the displayed axis', () => {
    storedView({ units: { length: 'in' }, rulerReference2d: 'offset' });
    const box = host.querySelector<HTMLInputElement>('[aria-label="Ruler zero from nose (in)"]')!;
    const label = host.querySelector<HTMLLabelElement>(`label[for="${box.id}"]`)!;
    expect(label.control).toBe(box);
    act(() => {
      box.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, '-1');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => box.blur());
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!).rulerOffset2dM).toBeCloseTo(-0.0254, 12);
    const nose = host.querySelector('svg > g > path')!.getAttribute('d');
    const reverse = host.querySelector<HTMLInputElement>('.schematic-ruler-card input[type="checkbox"]')!;
    act(() => reverse.click());
    expect(host.querySelector('summary')!.textContent).toContain('(reversed)');
    expect(host.querySelector('svg > g > path')!.getAttribute('d')).toBe(nose);
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!).rulerReversed2d).toBe(true);
  });

  it.each(['mm', 'in'])('N009 grid measures in %s and scales with zoom', (length) => {
    storedView({ units: { length } });
    const lines = () => [...host.querySelectorAll('[data-grid="view"] line[data-axis="x"]')]
      .map(el => Number(el.getAttribute('x1')));
    const before = lines();
    const noseX = Number(/M\s*([\d.]+)/.exec(host.querySelector('svg > g > path')!.getAttribute('d')!)![1]);
    const hundredX = Number(axialLabel(length === 'mm' ? '100' : '2').getAttribute('x'));
    const metresPerDivision = length === 'mm' ? 0.05 : 0.0254;
    const metresAtLabel = length === 'mm' ? 0.1 : 0.0508;
    const scale = (hundredX - noseX - 1.5) / metresAtLabel;
    expect(before[1]! - before[0]!).toBeCloseTo(scale * metresPerDivision, 8);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    const transform = host.querySelector('svg > g')!.getAttribute('transform')!;
    const zoom = Number(/scale\(([^)]+)\)/.exec(transform)![1]);
    expect((lines()[1]! - lines()[0]!) * zoom).toBeCloseTo((before[1]! - before[0]!) * 1.5, 8);
  });

  it('N009 grid follows ruler ticks through zoom and pan, exports fit spacing, and switches independently', () => {
    storedView({ grid2d: true });
    const gridX = () => {
      const transform = host.querySelector('svg > g')!.getAttribute('transform')!;
      const [x, , k] = [...transform.matchAll(/-?[\d.]+/g)].map(m => Number(m[0]));
      return [...host.querySelectorAll('[data-grid="view"] line[data-axis="x"]')]
        .map(el => x! + Number(el.getAttribute('x1')) * k!);
    };
    const before = gridX();
    expect(before.length).toBeGreaterThan(2);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(gridX()).not.toEqual(before);
    act(() => { host.querySelector('svg')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    const ticks = [...host.querySelectorAll('[data-ruler="view"] g')].filter(g => g.querySelector('text'))
      .map(g => g.querySelector('line')).filter(l => l?.getAttribute('x1') === l?.getAttribute('x2'))
      .map(l => Number(l!.getAttribute('x1')));
    expect(gridX()).toHaveLength(ticks.length);
    gridX().forEach((x, i) => expect(x).toBeCloseTo(ticks[i]!, 8)); // inverse SVG transform roundoff
    const svg = schematicSvg(host.querySelector('svg')!, 100, 640, 300, {
      name: 'Rocket', info: null, units: INITIAL_UNITS, withMotors: false, appVersion: '0',
    });
    expect(svg).toContain('data-grid="fit"');
    expect(svg).not.toContain('data-grid="view"');
    expect(svg).not.toContain('display="none"');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Hide rulers"]')!.click());
    expect(gridX().length).toBeGreaterThan(2);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Hide grid"]')!.click());
    expect(host.querySelector('[data-grid]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!).grid2d).toBe(false);
  });

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
    return [...host.querySelectorAll(FILLED_FIN)].map((p) => {
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

  it('rolling 90° takes the upright fin edge-on and KEEPS it, as a line', () => {
    show(<TreeSchematic tree={finTree(3)} info={null} roll={Math.PI / 2} />);
    // Rolled, so wireframe (v0.084): all three are on screen and nothing is
    // filled. cos(90°) = 0 for the first fin, which is what edge-on means —
    // desktop draws it as a line through the body, and so do we. Dropping it,
    // as every version up to v0.083 did, is precisely what made a fin
    // impossible to follow through the edge-on angle.
    expect(host.querySelectorAll(FILLED_FIN)).toHaveLength(0);
    const wires = [...host.querySelectorAll('polygon[data-fin="wire"]')];
    expect(wires).toHaveLength(3);
    const cy = centreY();
    const spans = wires.map((p) => {
      const ys = p.getAttribute('points')!.split(' ').map((q) => Number(q.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    }).sort((a, b) => a - b);
    // One collapsed onto the centreline, two reaching cos(±30°) either way.
    expect(spans[0]).toBeCloseTo(0, 6);
    expect(spans[1]).toBeCloseTo(spans[2]!, 6);
    expect(spans[1]).toBeGreaterThan(0);
    for (const p of wires) {
      const ys = p.getAttribute('points')!.split(' ').map((q) => Number(q.split(',')[1]));
      if (Math.max(...ys) - Math.min(...ys) < 1e-6) expect(ys[0]).toBeCloseTo(cy, 6);
    }
  });

  it('a fin set’s own rotation moves it before any roll does', () => {
    show(<TreeSchematic tree={finTree(3, { rotation: Math.PI / 2 })} info={null} />);
    expect(host.querySelectorAll(FILLED_FIN)).toHaveLength(2);
    // …and the matching roll cancels it. The view is rolled, so the drawing is
    // a wireframe — but the PROJECTION must be the at-rest one exactly: one
    // fin at full span up, two at half span down.
    const upright = finReaches().sort((a, b) => a - b);
    show(<TreeSchematic tree={finTree(3)} info={null} />);
    const rest = finReaches().sort((a, b) => a - b);
    show(<TreeSchematic tree={finTree(3, { rotation: Math.PI / 2 })} info={null} roll={-Math.PI / 2} />);
    const cy = centreY();
    const rolled = [...host.querySelectorAll('polygon[data-fin="wire"]')].map((p) => {
      const ys = p.getAttribute('points')!.split(' ').map((q) => Number(q.split(',')[1]));
      const far = ys.reduce((a, b) => (Math.abs(b - cy) > Math.abs(a - cy) ? b : a), cy);
      return cy - far;
    }).sort((a, b) => a - b);
    expect(rolled).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(rolled[i]).toBeCloseTo(rest[i]!, 6);
    // The un-cancelled rotation is a different picture — or the test proves nothing.
    expect(upright).not.toHaveLength(3);
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
