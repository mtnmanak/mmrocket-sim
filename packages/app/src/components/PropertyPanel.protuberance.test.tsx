// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The protuberance panel's Cd sentence (code review 2026-08-25b, findings 7
 * and 12). Two defects, both of which put a number on screen with a false
 * explanation under it:
 *
 *  - the panel resolved the drag class ITSELF, with `String(node['dragClass']
 *    ?? 'streamlinedbase')`, while treeModel used a `typeof === 'string'`
 *    test. A dragClass that was present but not a string (a hand-edited or
 *    third-party file) therefore gave the panel a class treeModel never
 *    returns, `streamlined` came out false, and the whole "where this Cd came
 *    from" paragraph vanished — leaving a bare 0.354 with nothing to check it
 *    against, which is the exact thing that copy exists to prevent.
 *  - `cdFrontal: 0` counted as an explicit override, so the left stop of the
 *    slider zeroed the component's drag while the panel confirmed it with
 *    "The Cd is the one you typed."
 *
 * Both are now single resolvers in treeModel (protuberanceClass /
 * protuberanceExplicitCd) that the panel and the engine lowering share, so
 * these tests are really asserting that there is only ONE rule.
 *
 * The `plate` class deliberately carries the first two cases: it is the one
 * class that needs no kernel probe, so they stay millisecond tests.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

/** A protuberance alone under a stage — enough for the plate class. */
const bare = (over: Record<string, unknown>): { tree: RocketTree; node: ComponentNode } => {
  const node = {
    id: 'x1', type: 'protuberance', name: 'Bump',
    width: 0.02, height: 0.01, length: 0.06, count: 1, mass: 0,
    ...over,
  } as unknown as ComponentNode;
  return {
    node,
    tree: { name: 'R', components: [{ id: 's1', type: 'stage', children: [node] }] } as unknown as RocketTree,
  };
};

/** Nose + tube + protuberance: a real airframe, so the body-CD probe measures. */
const onBody = (over: Record<string, unknown>): { tree: RocketTree; node: ComponentNode } => {
  const node = {
    id: 'x1', type: 'protuberance', name: 'Bump',
    width: 0.02, height: 0.01, length: 0.06, count: 1, mass: 0,
    ...over,
  } as unknown as ComponentNode;
  return {
    node,
    tree: {
      name: 'R',
      components: [{
        id: 's1',
        type: 'stage',
        children: [
          { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.2, aftRadius: 0.05, thickness: 0.002 },
          { id: 'b1', type: 'bodytube', length: 0.5, outerRadius: 0.05, thickness: 0.001 },
          node,
        ],
      }],
    } as unknown as RocketTree,
  };
};

const mount = ({ tree, node }: { tree: RocketTree; node: ComponentNode }) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={() => {}} />
  </PrefsProvider>,
));

/** The stats line under the fields, with JSX's line breaks collapsed. */
const stats = (): string =>
  (host.querySelector('.comp-stats')?.textContent ?? '').replace(/\s+/g, ' ').trim();

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

describe('PropertyPanel — protuberance Cd sentence', () => {
  it('a typed 0 takes the class Cd, and says so instead of claiming you typed it', () => {
    mount(bare({ dragClass: 'plate', plateAngle: Math.PI / 4, cdFrontal: 0 }));
    const text = stats();
    // 1.17 · sin²45° = 0.585 — the class value. On the old code this read
    // "Cd 0.000", with "The Cd is the one you typed." under it.
    expect(text).toContain('Cd 0.585');
    expect(text).not.toContain('The Cd is the one you typed');
    expect(text).toContain('A typed 0 is not an override');
  });

  it('a real typed Cd still wins, and still says so', () => {
    mount(bare({ dragClass: 'plate', plateAngle: Math.PI / 4, cdFrontal: 0.37 }));
    const text = stats();
    expect(text).toContain('Cd 0.370');
    expect(text).toContain('The Cd is the one you typed');
    expect(text).not.toContain('A typed 0 is not an override');
  });

  it('a non-string dragClass still gets the explanation the class it uses deserves', () => {
    // dragClass present but not a string: the panel used to compute '7' here,
    // decide the class was not streamlined, and print the Cd with no
    // explanation at all — while the engine used streamlinedbase.
    mount(onBody({ dragClass: 7 }));
    const text = stats();
    expect(text).toContain('Streamlined Protuberance method');
    expect(text).toContain('including base drag');
    // The probe measured a real body, so the placeholder wording stays away.
    expect(text).not.toContain('could not evaluate this design');
  }, 60000);

  it('an unknown class string lands on the same default as the engine', () => {
    mount(onBody({ dragClass: 'wharrgarbl' }));
    expect(stats()).toContain('including base drag');
  }, 60000);
});
