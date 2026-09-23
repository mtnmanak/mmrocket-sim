// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The panel's one-shot geometry buttons, pinned from the OUTSIDE — what each
 * offers, what it says and what it writes — so the rules behind them can move
 * out of the component (audit 2026-09-22, extractions carried from 8 September:
 * rail-button auto-place, fin-tab and shoulder fit, the spill-hole ceiling)
 * with proof that nothing a user sees or gets moved with them.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREFS_KEY = 'online-openrocket.prefs.v1';

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

beforeEach(() => {
  localStorage.clear();
  patches = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const render = (tree: RocketTree, node: ComponentNode, extra: Record<string, unknown> = {}) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} {...extra}
      onPatch={(p) => patches.push(p as Record<string, unknown>)} />
  </PrefsProvider>,
));

const button = (label: RegExp) => [...host.querySelectorAll('button')]
  .find((b) => label.test(b.textContent ?? '')) ?? null;

/** What a one-shot button offers: its hover text, whether it is live, and what one press writes. */
const press = (label: RegExp) => {
  const b = button(label);
  if (!b) return null;
  const before = patches.length;
  act(() => { b.click(); });
  return { title: b.title, disabled: b.disabled, patch: patches[before] ?? null };
};

const stageOf = (children: Record<string, unknown>[]): RocketTree => ({
  name: 'R',
  components: [{ id: 's1', type: 'stage', children }],
} as unknown as RocketTree);

const find = (tree: RocketTree, id: string): ComponentNode => {
  const walk = (ns: ComponentNode[]): ComponentNode | null => {
    for (const n of ns) {
      if (n.id === id) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.components)!;
};

describe('📍 Auto-place rail buttons', () => {
  /** A 100 mm nose, then a 1 m tube carrying the button: the tube spans 100-1100 mm. */
  const rocket = (button: Record<string, unknown>) => stageOf([
    { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.027 },
    { id: 'b1', type: 'bodytube', length: 1, outerRadius: 0.027, thickness: 0.001, children: [button] },
  ]);
  const RB = { id: 'rb', type: 'railbutton', outerDiameter: 0.0097, angleOffset: 0 };
  const place = (btn: Record<string, unknown>, rocketInfo: unknown, positionX: number | null = 0.6) => {
    const tree = rocket(btn);
    render(tree, find(tree, 'rb'), {
      info: { length: 0, mass: 0.002, sectionMass: 0.002, cgX: 0, ...(positionX === null ? {} : { positionX }) },
      rocketInfo,
    });
    return press(/Auto-place rail buttons/);
  };

  it('offers the pair across the CG and an inch off the tail, and says so', () => {
    const got = place({ ...RB, position: { method: 'middle', offset: 0 } }, { length: 1.1, cg: 0.55 });
    expect(got!.disabled).toBe(false);
    expect(got!.title).toBe('Places two buttons: forward one at the CG (550 mm — the loaded CG when a motor is'
      + ' loaded), aft one 25 mm from the aft end. Press again after the CG moves; typed values always win'
      + ' afterwards.');
    expect(got!.patch!['instanceCount']).toBe(2);
    expect(got!.patch!['instanceSeparation'] as number).toBeCloseTo(1.1 - 0.0254 - 0.55, 12);
    const pos = got!.patch!['position'] as { method: string; offset: number };
    expect(pos.method).toBe('middle');
    expect(pos.offset).toBeCloseTo(-0.05, 12);
  });

  it('a button with no position is placed on the top method', () => {
    // positionX 0.1: the kernel's station for a zero-length part at the top of the tube.
    const got = place({ ...RB }, { length: 1.1, cg: 0.55 }, 0.1);
    const pos = got!.patch!['position'] as { method: string; offset: number };
    expect(pos.method).toBe('top');
    expect(pos.offset).toBeCloseTo(0.45, 12);
  });

  it('with no kernel station it takes the tube to start at the nose tip', () => {
    const got = place({ ...RB, position: { method: 'top', offset: 0 } }, { length: 1.1, cg: 0.55 }, null);
    // 0-1000 mm, so the aft button's 1075 mm is off the end of it.
    expect(got!.disabled).toBe(true);
    expect(got!.title).toContain('this tube spans 0–1000 mm');
    expect(got!.patch).toBeNull();
  });

  it('refuses a CG forward of this tube, and names both spans', () => {
    const got = place({ ...RB, position: { method: 'middle', offset: 0 } }, { length: 1.1, cg: 0.05 });
    expect(got!.disabled).toBe(true);
    expect(got!.title).toBe('Both buttons would have to sit outside this tube (they want 50–1075 mm from the'
      + ' nose; this tube spans 100–1100 mm). Move the rail button to the tube that spans the CG and the aft'
      + ' end, or place them by hand.');
  });

  it('refuses a CG within an inch of the tail: the two would collide', () => {
    const got = place({ ...RB, position: { method: 'middle', offset: 0 } }, { length: 1.1, cg: 1.06 });
    expect(got!.disabled).toBe(true);
    expect(got!.title).toBe('The CG sits within an inch of the aft end — two buttons cannot straddle it.'
      + ' Place them by hand.');
  });

  it('the pair must be more than 20 mm apart', () => {
    // aftX = 1.0746: 19 mm of room is refused, 21 mm is offered.
    expect(place({ ...RB, position: { method: 'middle', offset: 0 } }, { length: 1.1, cg: 1.0556 })!.disabled)
      .toBe(true);
    expect(place({ ...RB, position: { method: 'middle', offset: 0 } }, { length: 1.1, cg: 1.0536 })!.disabled)
      .toBe(false);
  });

  it('is not offered without the rocket figures or the part figures', () => {
    const tree = rocket({ ...RB, position: { method: 'middle', offset: 0 } });
    render(tree, find(tree, 'rb'), { rocketInfo: { length: 1.1, cg: 0.55 } });
    expect(button(/Auto-place rail buttons/)).toBeNull();
    render(tree, find(tree, 'rb'), { info: { length: 0, mass: 0, sectionMass: 0, cgX: 0, positionX: 0.6 } });
    expect(button(/Auto-place rail buttons/)).toBeNull();
  });
});

describe('Fit tab to motor tube', () => {
  const FIN = {
    id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.1, tipChord: 0.05,
    sweep: 0.03, height: 0.06, thickness: 0.003, position: { method: 'bottom', offset: 0 },
  };
  const tube = (children: Record<string, unknown>[], extra: Record<string, unknown> = {}) => stageOf([
    { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.0508, thickness: 0.0015, children, ...extra },
  ]);
  const MMT = { id: 'mmt', type: 'innertube', length: 0.3, outerRadius: 0.0286, thickness: 0.001 };
  const fit = (tree: RocketTree) => {
    render(tree, find(tree, 'f1'));
    return press(/Fit tab to motor tube/);
  };

  it('reaches the motor tube: depth, a 60 % root-chord tab, centred', () => {
    const got = fit(tube([MMT, FIN]));
    expect(got!.title).toBe('Set tab depth to reach the motor tube (22.2 mm)');
    expect(got!.patch).toEqual({
      tabHeight: 0.0508 - 0.0286, tabLength: 0.1 * 0.6, tabOffsetMethod: 'middle', tabOffset: 0,
    });
  });

  it('with no motor tube, goes to the wall', () => {
    const got = fit(tube([FIN]));
    expect(got!.title).toBe('No motor tube found — set tab depth to the tube wall (1.5 mm)');
    expect(got!.patch!['tabHeight']).toBe(0.0015);
  });

  it('with no motor tube and no wall stated, takes 1 mm', () => {
    const tree = tube([FIN]);
    delete (tree.components[0]!.children![0]! as Record<string, unknown>)['thickness'];
    expect(fit(tree)!.patch!['tabHeight']).toBe(0.001);
  });

  it('keeps a tab offset method already chosen, and a tab length already set', () => {
    const got = fit(tube([MMT, { ...FIN, tabLength: 0.04, tabOffsetMethod: 'top', tabOffset: 0.01 }]));
    expect(got!.patch).toEqual({ tabHeight: 0.0508 - 0.0286 });
  });

  it('takes the first inner tube that states a radius', () => {
    const got = fit(tube([{ ...MMT, id: 'x', outerRadius: undefined }, { ...MMT, outerRadius: 0.019 }, FIN]));
    expect(got!.patch!['tabHeight']).toBeCloseTo(0.0508 - 0.019, 15);
  });

  it('is not offered where there is no depth to fill, or no tube to fill it in', () => {
    expect(fit(tube([{ ...MMT, outerRadius: 0.0508 }, FIN]))).toBeNull(); // mount as wide as the tube
    expect(fit(stageOf([
      { id: 't1', type: 'transition', length: 0.1, foreRadius: 0.03, aftRadius: 0.02, children: [FIN] },
    ]))).toBeNull();
    expect(fit(tube([FIN], { outerRadius: undefined }))).toBeNull();
  });

  it('prints the depth in the length unit chosen', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ units: { length: 'in' } }));
    expect(fit(tube([MMT, FIN]))!.title).toBe('Set tab depth to reach the motor tube (0.874016 in)');
  });
});

describe('Fit shoulder to tube ⌀', () => {
  const NOSE = { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.027 };
  const fit = (tree: RocketTree, id = 'n1') => {
    render(tree, find(tree, id));
    return press(/Fit shoulder to tube/);
  };

  it('sets the shoulder to the next tube\'s inner radius, and says so as a diameter', () => {
    const got = fit(stageOf([NOSE, { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001 }]));
    expect(got!.title).toBe('Set the shoulder to the adjacent tube\'s inner diameter (52 mm)');
    expect(got!.patch).toEqual({ shoulderRadius: 0.027 - 0.001 });
  });

  it('skips what is not a body tube, and never looks FORWARD of the nose', () => {
    const got = fit(stageOf([
      { id: 'b0', type: 'bodytube', length: 0.5, outerRadius: 0.05, thickness: 0.002 },
      NOSE,
      { id: 't1', type: 'transition', length: 0.05, foreRadius: 0.027, aftRadius: 0.03 },
      { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.03, thickness: 0.0015 },
    ]));
    expect(got!.patch).toEqual({ shoulderRadius: 0.03 - 0.0015 });
  });

  it('a tube with no wall stated is its own outer radius', () => {
    const got = fit(stageOf([NOSE, { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.027 }]));
    expect(got!.patch).toEqual({ shoulderRadius: 0.027 });
  });

  it('reads as a radius where the preference is radii', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ radiusMode: 'radius' }));
    const got = fit(stageOf([NOSE, { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001 }]));
    expect(got!.title).toBe('Set the shoulder to the adjacent tube\'s inner radius (26 mm)');
    expect(got!.patch).toEqual({ shoulderRadius: 0.027 - 0.001 });
  });

  it('is not offered with no body tube behind the nose, or one with no radius', () => {
    expect(fit(stageOf([NOSE]))).toBeNull();
    expect(fit(stageOf([NOSE, { id: 'b1', type: 'bodytube', length: 0.5 }]))).toBeNull();
  });
});

describe('the spill-hole ceiling is the flown one', () => {
  const chute = (extra: Record<string, unknown>) => stageOf([
    { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.027, thickness: 0.001, children: [
      { id: 'p1', type: 'parachute', cd: 0.8, spillHoleDiameter: 0.02, ...extra },
    ] },
  ]);
  const sliderMax = (tree: RocketTree) => {
    render(tree, find(tree, 'p1'));
    const s = [...host.querySelectorAll('input[type="range"]')]
      .find((el) => (el.getAttribute('aria-label') ?? '').startsWith('Spill hole')) as HTMLInputElement;
    return Number(s.max);
  };

  it('0.95 of the canopy (mm)', () => expect(sliderMax(chute({ diameter: 0.1 }))).toBeCloseTo(95, 9));
  it('a canopy with no stated diameter: 0.95 of the 0.3 m the kernel is handed', () => {
    expect(sliderMax(chute({}))).toBeCloseTo(285, 9);
  });
  it('a canopy stated as 0: no ceiling below the field\'s own 500 mm', () => {
    expect(sliderMax(chute({ diameter: 0 }))).toBeCloseTo(500, 9);
  });
});
