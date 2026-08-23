// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The "Use instead of everything inside" override flags (issue 2026-08-22a,
 * relabelled 2026-08-23 — the old "…and everything inside" read as though the
 * contents were being added in, when ticking makes them stop counting). The .ork
 * reader and writer always carried <overridesubcomponents*>, but nothing in
 * the UI could set it — so the thing users actually ask for, one Cd standing
 * for the whole rocket, was unreachable. It hangs off a STAGE most of the
 * time, because the stage is the component that contains everything.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const stage = (over: Record<string, unknown> = {}): ComponentNode => ({
  id: 's1',
  type: 'stage',
  name: 'Sustainer',
  ...over,
  children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005 }],
} as unknown as ComponentNode);

const leaf: ComponentNode = {
  id: 'n1', type: 'nosecone', length: 0.1, aftRadius: 0.012, thickness: 0.002, shape: 'ogive',
  overrideCD: 0.4,
} as unknown as ComponentNode;

const treeOf = (node: ComponentNode): RocketTree => (node.type === 'stage'
  ? ({ name: 'R', components: [node] } as unknown as RocketTree)
  : ({ name: 'R', components: [{ id: 's1', type: 'stage', children: [node] }] } as unknown as RocketTree));

const mount = (node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={treeOf(node)} node={node} onPatch={(p) => patches.push(p)} />
  </PrefsProvider>,
));

const subsBoxes = (): HTMLInputElement[] =>
  [...host.querySelectorAll('.override-subs input[type=checkbox]')] as HTMLInputElement[];

const boxFor = (quantity: string): HTMLInputElement =>
  subsBoxes().find((b) => (b.getAttribute('aria-label') ?? '').includes(quantity))!;

// React's checkbox handling hangs off the CLICK event and dedupes against its
// own value tracker, so a hand-set `.checked` plus a synthetic change is
// ignored. el.click() toggles and dispatches the way a real click does.
const click = (el: HTMLInputElement) => act(() => { el.click(); });

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

describe('PropertyPanel — override "Use instead of everything inside" flags', () => {
  it('a stage gets the full override block', () => {
    mount(stage());
    expect([...host.querySelectorAll('input')].map((i) => i.getAttribute('aria-label')))
      .toEqual(expect.arrayContaining([
        'Mass override', 'CG override, from component top', 'Drag coefficient (Cd) override',
      ]));
  });

  it('offers no flag until the override has a value', () => {
    mount(stage());
    expect(subsBoxes()).toHaveLength(0);
  });

  it('offers one flag per override that has a value', () => {
    mount(stage({ overrideCD: 0.45 }));
    expect(subsBoxes()).toHaveLength(1);
    expect(boxFor('Cd')).toBeTruthy();
    // The visible wording is the ruling, not a detail: "…and everything inside"
    // read as though the contents were being added in (owner, 2026-08-23).
    expect(boxFor('Cd').closest('label')!.textContent)
      .toContain('Use instead of everything inside');

    patches = [];
    mount(stage({ overrideCD: 0.45, overrideMass: 2, overrideCGX: 0.5 }));
    expect(subsBoxes()).toHaveLength(3);
  });

  it('ticking the Cd flag patches overrideSubcomponentsCD', () => {
    mount(stage({ overrideCD: 0.45 }));
    click(boxFor('Cd'));
    expect(patches).toEqual([{ overrideSubcomponentsCD: true }]);
  });

  it('says so when an ancestor is standing in for this component', () => {
    // A body tube inside a stage whose mass override covers everything.
    const tree = {
      name: 'R',
      components: [{
        id: 's1', type: 'stage', name: 'Sustainer',
        overrideMass: 2, overrideSubcomponentsMass: true,
        children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005 }],
      }],
    } as unknown as RocketTree;
    const tube = (tree.components[0]!.children as ComponentNode[])[0]!;
    act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={tube} onPatch={(p) => patches.push(p)} />
      </PrefsProvider>,
    ));
    const note = host.querySelector('.override-suppressed');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('Sustainer');
    expect(note!.textContent).toContain('mass');
    // It has to name the control the user must untick, by its shipped label.
    expect(note!.textContent).toContain('Use instead of everything inside');
    // Only the suppressed quantity says so — CG and Cd are unaffected.
    expect(host.querySelectorAll('.override-suppressed')).toHaveLength(1);
  });

  it('a bare subcomponents flag with no value suppresses nothing', () => {
    // A .ork can carry <overridesubcomponentsmass>true</overridesubcomponentsmass>
    // with no <overridemass>; the kernel needs BOTH to suppress, so we must too.
    const tree = {
      name: 'R',
      components: [{
        id: 's1', type: 'stage', name: 'Sustainer',
        overrideSubcomponentsMass: true,
        children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005 }],
      }],
    } as unknown as RocketTree;
    const tube = (tree.components[0]!.children as ComponentNode[])[0]!;
    act(() => root.render(
      <PrefsProvider>
        <PropertyPanel tree={tree} node={tube} onPatch={(p) => patches.push(p)} />
      </PrefsProvider>,
    ));
    expect(host.querySelector('.override-suppressed')).toBeNull();
  });

  it('unticking clears the flag rather than storing false', () => {
    mount(stage({ overrideCD: 0.45, overrideSubcomponentsCD: true }));
    const box = boxFor('Cd');
    expect(box.checked).toBe(true);
    click(box);
    expect(patches).toEqual([{ overrideSubcomponentsCD: undefined }]);
  });

  it('hides the flag on a component with nothing inside it', () => {
    mount(leaf);
    expect(subsBoxes()).toHaveLength(0);
  });

  it('the container hint names Cd, not just mass, as the thing that ADDS', () => {
    // Measured 2026-08-23: on a stage / pod set / booster an unticked mass AND
    // an unticked Cd both add to what the contents compute (base 0.60236 + a
    // 1.0 Cd override = 1.60236), while an unticked CG moves nothing until a
    // mass override gives it something to position. The copy used to name only
    // mass, which is the gap the owner kept hitting.
    mount(stage({ overrideCD: 0.45 }));
    const hint = [...host.querySelectorAll('p.hint')]
      .map((p) => p.textContent ?? '')
      .find((t) => t.includes('stage, pod set or booster'));
    expect(hint).toBeTruthy();
    // Assert the three quantities are each accounted for, not one phrasing of
    // it — the wording was rewritten once already when "does nothing at all"
    // turned out to be wrong.
    expect(hint).toMatch(/\bCd\b/);
    expect(hint).toMatch(/\bmass\b/);
    expect(hint).toMatch(/\bCG\b/);
    expect(hint).toMatch(/\badds\b|\badded\b/);

    // And it stays container-only — a nose cone has geometry to replace.
    mount(leaf);
    expect([...host.querySelectorAll('p.hint')]
      .some((p) => (p.textContent ?? '').includes('stage, pod set or booster'))).toBe(false);
  });
});

/**
 * The stage CG override that "still doesn't do anything" (issues-2026-08-23b,
 * from the owner while checking the release blurb).
 *
 * It is not a blanket no-op. An unticked override on a container describes a
 * PHANTOM POINT MASS the container contributes: the mass override gives that
 * point its weight, the CG override its station. A CG with no mass beside it is
 * positioning zero kilograms, so nothing moves — measured and pinned in
 * orkEngine.test.ts. That is the one case where the user types a number, sees
 * nothing happen, and has nothing on screen to explain it.
 */
describe('PropertyPanel — a container CG override with nothing to position', () => {
  const warning = () => host.querySelector('.override-inert');

  it('warns when a stage CG is set unticked with no mass override', () => {
    mount(stage({ overrideCGX: 0.2 }));
    expect(warning()).not.toBeNull();
    expect(warning()!.textContent).toMatch(/no mass of its own/i);
  });

  it('stops warning once a mass override gives it something to position', () => {
    mount(stage({ overrideCGX: 0.2, overrideMass: 1 }));
    expect(warning()).toBeNull();
  });

  it('stops warning once the box is ticked', () => {
    mount(stage({ overrideCGX: 0.2, overrideSubcomponentsCG: true }));
    expect(warning()).toBeNull();
  });

  it('offers a one-click fix that ticks the box', () => {
    mount(stage({ overrideCGX: 0.2 }));
    const fix = [...host.querySelectorAll('button')]
      .find((b) => /use instead of everything inside/i.test(b.textContent ?? ''))!;
    expect(fix).toBeTruthy();
    act(() => { fix.click(); });
    expect(patches).toContainEqual({ overrideSubcomponentsCG: true });
  });

  it('never warns on a component that has geometry of its own', () => {
    mount({
      id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
      overrideCGX: 0.2,
    } as unknown as ComponentNode);
    expect(warning()).toBeNull();
  });

  it('says nothing when no CG override is set at all', () => {
    mount(stage());
    expect(warning()).toBeNull();
  });

  it('describes the container rule as a point mass, and no longer as "does nothing at all"', () => {
    mount(stage({ overrideCGX: 0.2 }));
    const text = host.textContent ?? '';
    expect(text).toMatch(/point mass/i);
    expect(text).not.toMatch(/does nothing at all/i);
  });
});
