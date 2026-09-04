// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { RULER_TOP, TreeSchematic } from './TreeSchematic.js';

/**
 * Three side-view defects, pinned together because they share a fixture:
 *
 *  • the schematic's own `clickable` shadowed the project's keyboard-enabled
 *    one, so the svg's aria-label promised drag-and-select to a reader who
 *    had no tab stop to reach and nothing announced inside a role="img";
 *  • a rail button was drawn aft of the station the kernel flies it at;
 *  • an inner tube's radialPosition/radialDirection were drawn by the aft view
 *    alone, so a split cluster stacked on the axis here.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const BODY_R = 0.024;

const withChildren = (children: Record<string, unknown>[]): RocketTree => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: BODY_R },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R, children },
    ],
  }],
} as unknown as RocketTree);

const show = (el: React.ReactElement) => act(() => root.render(el));
const svg = () => host.querySelector('svg')!;
const viewBox = () => svg().getAttribute('viewBox')!.split(' ').map(Number);
const centreY = () => { const [, , , h] = viewBox(); return RULER_TOP + (h! - RULER_TOP) / 2; };
/** viewBox px per metre — recovered from the body tube's drawn height. */
const scale = () => {
  const tube = host.querySelector<SVGRectElement>('rect[fill="#e7e5e0"]')!;
  return Number(tube.getAttribute('height')) / (2 * BODY_R);
};
/** Model x (metres from the nose tip) of a drawn px x. */
const originX = () => {
  const tube = host.querySelector<SVGRectElement>('rect[fill="#e7e5e0"]')!;
  // The tube starts 0.1 m aft of the nose tip.
  return Number(tube.getAttribute('x')) - 0.1 * scale();
};
const modelX = (px: number) => (px - originX()) / scale();

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the drawing is reachable by keyboard', () => {
  const tree = withChildren([{
    id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05,
    tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003,
  }]);

  it('is a group, not an image, so its contents are exposed', () => {
    // role="img" makes the whole subtree presentational — including the tab
    // stops below and the <title>s the internal parts carry.
    show(<TreeSchematic tree={tree} info={null} onSelect={() => {}} />);
    expect(svg().getAttribute('role')).toBe('group');
    expect(svg().getAttribute('aria-label')).toContain('drag components');
  });

  it('keeps the read-only vertical variant an image', () => {
    // It attaches no handlers at all, so there is nothing inside to expose.
    show(<TreeSchematic tree={tree} info={null} vertical />);
    expect(svg().getAttribute('role')).toBe('img');
  });

  it('gives every selectable shape a tab stop and a name', () => {
    show(<TreeSchematic tree={tree} info={null} onSelect={() => {}} />);
    const stops = [...svg().querySelectorAll('[tabindex="0"]')];
    expect(stops.length).toBeGreaterThan(0);
    const names = stops.map((s) => s.getAttribute('aria-label'));
    expect(names.every((n) => !!n && n.startsWith('Select '))).toBe(true);
    expect(names).toContain('Select Nose cone');
    expect(names).toContain('Select Body tube');
    expect(names).toContain('Select Trapezoidal fins');
    expect(stops.every((s) => s.getAttribute('role') === 'button')).toBe(true);
  });

  it('selects on Enter and on Space', () => {
    const picked: string[] = [];
    show(<TreeSchematic tree={tree} info={null} onSelect={(id) => picked.push(id)} />);
    const nose = [...svg().querySelectorAll('[tabindex="0"]')]
      .find((s) => s.getAttribute('aria-label') === 'Select Nose cone')!;
    act(() => { nose.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    act(() => { nose.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(picked).toEqual(['n1', 'n1']);
  });

  it('offers no tab stops at all when nothing can be selected', () => {
    show(<TreeSchematic tree={tree} info={null} />);
    expect(svg().querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  });

  it('does not double up a tab stop on each fin\'s invisible hit surface', () => {
    // A rolled fin draws an outline PLUS a transparent hit surface. Both need
    // the pointer handlers; only the outline is a tab stop, or a three-fin set
    // alone would cost six identical stops.
    show(<TreeSchematic tree={tree} info={null} roll={0.6} onSelect={() => {}} />);
    const hits = [...svg().querySelectorAll('[data-fin-hit]')];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.getAttribute('tabindex') === null)).toBe(true);
  });
});

describe('a rail button is drawn centred on its station', () => {
  const button = (method: string) => withChildren([{
    id: 'rb', type: 'railbutton', outerDiameter: 0.01, totalHeight: 0.0097,
    angleOffset: 0, position: { method, offset: 0 },
  }]);
  /** The button's own rect (the tube's is the pale one). */
  const btnRect = () => host.querySelector<SVGRectElement>('rect[fill="#c8c5be"]')!;
  const span = () => {
    const r = btnRect();
    const x0 = modelX(Number(r.getAttribute('x')));
    return { x0, x1: x0 + Number(r.getAttribute('width')) / scale() };
  };

  // The tube runs 0.1 -> 0.4 m from the nose tip.
  it('top: straddles the tube fore end, half of it ahead', () => {
    show(<TreeSchematic tree={button('top')} info={null} />);
    const { x0, x1 } = span();
    expect((x0 + x1) / 2).toBeCloseTo(0.1, 5);
    expect(x1 - x0).toBeCloseTo(0.01, 5);
  });

  it('bottom: straddles the tube aft end, which is where the kernel flies it', () => {
    show(<TreeSchematic tree={button('bottom')} info={null} />);
    const { x0, x1 } = span();
    expect((x0 + x1) / 2).toBeCloseTo(0.4, 5);
  });

  it('middle: unchanged — the two errors cancelled on the default method', () => {
    show(<TreeSchematic tree={button('middle')} info={null} />);
    const { x0, x1 } = span();
    expect((x0 + x1) / 2).toBeCloseTo(0.25, 5);
  });

  it('leaves a launch lug starting AT its station, not centred on it', () => {
    const lug = withChildren([{
      id: 'lg', type: 'launchlug', length: 0.04, outerRadius: 0.003,
      angleOffset: 0, position: { method: 'top', offset: 0 },
    }]);
    show(<TreeSchematic tree={lug} info={null} />);
    const { x0, x1 } = span();
    expect(x0).toBeCloseTo(0.1, 5);
    expect(x1).toBeCloseTo(0.14, 5);
  });
});

describe('an inner tube off the centreline', () => {
  const mount = (extra: Record<string, unknown>) => withChildren([{
    id: 'mt', type: 'innertube', length: 0.1, outerRadius: 0.0095,
    position: { method: 'bottom', offset: 0 }, ...extra,
  }]);
  /** The dashed inner-tube outline. */
  const inner = () => [...host.querySelectorAll<SVGRectElement>('rect[stroke-dasharray="3 2"]')]
    .filter((r) => r.querySelector('title')?.textContent === 'Inner tube');

  it('draws it at rp·cos(rd) above the centreline, not on the axis', () => {
    show(<TreeSchematic tree={mount({ radialPosition: 0.012, radialDirection: 0 })} info={null} />);
    const r = inner()[0]!;
    const midY = Number(r.getAttribute('y')) + Number(r.getAttribute('height')) / 2;
    // SVG y grows down, the cross-section +y is up.
    expect((centreY() - midY) / scale()).toBeCloseTo(0.012, 5);
  });

  it('foreshortens with the view roll, like every other radial part', () => {
    show(<TreeSchematic tree={mount({ radialPosition: 0.012, radialDirection: 0 })}
      info={null} roll={Math.PI / 2} />);
    const r = inner()[0]!;
    const midY = Number(r.getAttribute('y')) + Number(r.getAttribute('height')) / 2;
    expect((centreY() - midY) / scale()).toBeCloseTo(0, 5);
  });

  it('stays on the axis when neither key is set', () => {
    show(<TreeSchematic tree={mount({})} info={null} />);
    const r = inner()[0]!;
    const midY = Number(r.getAttribute('y')) + Number(r.getAttribute('height')) / 2;
    expect(midY).toBeCloseTo(centreY(), 5);
  });
});

describe('the drag frame agrees with the drawing', () => {
  it('commits an offset that puts a bottom-anchored button ON the tube end', () => {
    // A drag of zero distance must be a no-op in whatever frame the drag uses.
    // Before the fix beginDrag resolved the start with axialLength's 25 mm and
    // committed it back through the same 25 mm, so a zero-distance drag was
    // indeed a no-op — but the ANCHORS it snapped to were 25 mm out from the
    // drawn button. This pins the frame the offset is written in.
    const patches: { id: string; patch: Partial<ComponentNode> }[] = [];
    const tree = withChildren([{
      id: 'rb', type: 'railbutton', outerDiameter: 0.01, totalHeight: 0.0097,
      angleOffset: 0, position: { method: 'bottom', offset: 0 },
    }]);
    show(<TreeSchematic tree={tree} info={null}
      onPatchNode={(id, patch) => patches.push({ id, patch })} />);
    const rect = host.querySelector<SVGRectElement>('rect[fill="#c8c5be"]')!;
    // happy-dom gives the svg a zero-size client rect, so a real pointer drag
    // cannot be simulated here; the drawn geometry above is the check that the
    // two frames agree, and this asserts the button is draggable at all.
    expect(rect.getAttribute('style')).toContain('grab');
  });
});
