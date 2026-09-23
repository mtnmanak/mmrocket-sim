// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { TreeSchematic } from './TreeSchematic.js';
import { importOrk } from '../services/orkFile.js';
import { importRkt } from '../services/rocksimFile.js';
import { importCdx1 } from '../services/rasaeroFile.js';

/**
 * THE SIDE VIEW'S DRAWN GEOMETRY, PINNED ATTRIBUTE BY ATTRIBUTE (audit
 * 2026-09-22, the `schematicLayout` extraction).
 *
 * Written against the component BEFORE its layout moved out of the render body
 * into `tree/schematicLayout.ts`, and the extraction had to reproduce every
 * snapshot here unchanged: a refactor that moves a number is a bug. The matrix
 * is chosen for coverage of the drawing's branches, not realism — every part
 * type the view draws, at rest and rolled (the wireframe path), selected and
 * hovered, nose-up, zoomed (the second ruler copy), with motors, pods and a
 * parallel stage, and five real files from three importers.
 *
 * The serialization is the DOM, not React's tree, with each element's
 * attributes SORTED: attribute order is an artefact of prop-spread order and
 * means nothing to a browser, so it is the one thing the pin leaves free. Event
 * handlers are not in the DOM at all; the pointer, keyboard and a11y suites
 * pin those.
 *
 * An INTENDED change to the drawing updates these with `vitest -u` — and the
 * diff is then the review of what moved.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(here, '..', 'services', '__fixtures__', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

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

/** FNV-1a, for the ruler gutters below. */
const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};

/**
 * One line per element, attributes sorted, text content quoted. A ruler
 * gutter is a few hundred tick marks the layout does not own (rulerTicks.ts,
 * pinned in TreeSchematic.rulers.test.tsx), so it is pinned here by a hash of
 * its own serialization — exact, and a line instead of most of the file.
 */
function serialize(el: Element, depth = 0): string {
  const pad = '  '.repeat(depth);
  const attrs = [...el.attributes].map((a) => `${a.name}="${a.value}"`).sort().join(' ');
  const lines = [`${pad}<${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ''}>`];
  if (el.hasAttribute('data-ruler')) {
    const ticks = [...el.children].map((c) => serialize(c)).join('\n');
    return `${lines[0]} ${el.children.length} children, fnv1a ${hash(ticks)}`;
  }
  for (const c of el.childNodes) {
    if (c.nodeType === 1) lines.push(serialize(c as Element, depth + 1));
    else if (c.nodeType === 3 && (c.textContent ?? '') !== '') lines.push(`${pad}  ${JSON.stringify(c.textContent)}`);
  }
  return lines.join('\n');
}
const drawn = () => serialize(host.querySelector('svg')!);

const info = (over: Partial<StaticInfo> = {}): StaticInfo => ({
  length: 0.62, lengthAerodynamic: 0.62, mass: 0.4, massEmpty: 0.3, cgEmpty: 0.3, cg: 0.33, cp: 0.45,
  rotationalInertia: 1.2e-4, longitudinalInertia: 3.4e-3,
  rotationalInertiaEmpty: 1.0e-4, longitudinalInertiaEmpty: 3.0e-3,
  cna: 10, stabilityCalibers: 1.6, refDiameter: 0.041, warnings: 0, warningTexts: [],
  ...over,
});

const R = 0.0205;
/** Every part type the side view draws, on one airframe. */
const busy = {
  name: 'Busy',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', name: 'Nose', shape: 'ogive', length: 0.12, aftRadius: R,
        shoulderLength: 0.03, shoulderRadius: 0.0195, color: '#e34948',
        children: [{ id: 'nm', type: 'masscomponent', name: 'Nose weight', length: 0.02, radius: 0.012,
          position: { method: 'bottom', offset: -0.01 } }] },
      {
        id: 'b1', type: 'bodytube', name: 'Upper', length: 0.2, outerRadius: R,
        children: [
          { id: 'pc', type: 'parachute', name: 'Main', length: 0.05, packedRadius: 0.015,
            position: { method: 'top', offset: 0.02 } },
          { id: 'sc', type: 'shockcord', name: 'Cord', length: 0.04, packedRadius: 0.012,
            position: { method: 'top', offset: 0.08 } },
          { id: 'st', type: 'streamer', name: 'Streamer', length: 0.04, packedRadius: 0.01,
            position: { method: 'bottom', offset: 0 } },
          { id: 'fr', type: 'fairing', name: 'Camera', length: 0.06, height: 0.018, width: 0.02,
            fairingForeShape: 'halfround', fairingAftShape: 'streamlined', angleOffset: 0.4,
            position: { method: 'middle', offset: 0 } },
          { id: 'pr1', type: 'protuberance', name: 'Plate', length: 0.03, height: 0.008,
            dragClass: 'plate', angleOffset: 2.6, position: { method: 'top', offset: 0.01 } },
        ],
      },
      { id: 'tc', type: 'transition', name: 'Adapter', shape: 'ogive', length: 0.05,
        foreRadius: R, aftRadius: 0.0165, foreShoulderLength: 0.02, foreShoulderRadius: 0.0195,
        aftShoulderLength: 0.025, aftShoulderRadius: 0.016 },
      {
        id: 'b2', type: 'bodytube', name: 'Booster', length: 0.3, outerRadius: 0.0165, motorMount: true,
        children: [
          { id: 'f1', type: 'trapezoidfinset', name: 'Main fins', finCount: 3, rootChord: 0.07,
            tipChord: 0.03, sweep: 0.04, height: 0.045, tabHeight: 0.01, tabLength: 0.04,
            position: { method: 'bottom', offset: 0 }, color: '#2a78d6' },
          { id: 'f2', type: 'ellipticalfinset', name: 'Canards', finCount: 4, rootChord: 0.04,
            height: 0.02, rotation: 0.3, position: { method: 'top', offset: 0.02 } },
          { id: 'f3', type: 'freeformfinset', name: 'Strakes', finCount: 2, rotation: 1.1,
            points: [[0, 0], [0.03, 0.02], [0.07, 0.022], [0.05, 0]], tabHeight: 0.005, tabLength: 0.02,
            position: { method: 'middle', offset: 0 } },
          { id: 'tf', type: 'tubefinset', name: 'Tube fins', finCount: 6, length: 0.05,
            position: { method: 'top', offset: 0.1 } },
          { id: 'lg', type: 'launchlug', name: 'Lug', length: 0.04, outerRadius: 0.003,
            angleOffset: 3.4, position: { method: 'top', offset: 0.05 } },
          { id: 'rb', type: 'railbutton', name: 'Buttons', outerDiameter: 0.01, totalHeight: 0.0097,
            instanceCount: 2, instanceSeparation: 0.12, angleOffset: Math.PI,
            position: { method: 'top', offset: 0.03 } },
          { id: 'pr2', type: 'protuberance', name: 'Bump', length: 0.04, height: 0.006,
            dragClass: 'streamlined', angleOffset: 1.3, position: { method: 'middle', offset: 0.02 } },
          { id: 'pr3', type: 'protuberance', name: 'Blister', length: 0.035, height: 0.005,
            angleOffset: 5.0, position: { method: 'top', offset: 0.2 } },
          { id: 'cr', type: 'centeringring', name: 'Ring', length: 0.006, outerRadius: 0.0158,
            position: { method: 'bottom', offset: -0.01 } },
          { id: 'bh', type: 'bulkhead', name: 'Bulkhead', length: 0.008, outerRadius: 0.0158,
            position: { method: 'top', offset: 0 } },
          { id: 'eb', type: 'engineblock', name: 'Block', length: 0.01, outerRadius: 0.009,
            position: { method: 'top', offset: 0.15 } },
          { id: 'mt', type: 'innertube', name: 'Motor tubes', length: 0.1, outerRadius: 0.006,
            cluster: '3-ring', clusterScale: 1.2, clusterRotation: 0.2, motorMount: true, motorOverhang: 0.004,
            position: { method: 'bottom', offset: 0 },
            children: [{ id: 'mb', type: 'engineblock', name: 'Inner block', length: 0.005, outerRadius: 0.005,
              position: { method: 'top', offset: 0 } }] },
          { id: 'sp', type: 'innertube', name: 'Split', length: 0.06, outerRadius: 0.004,
            radialPosition: 0.008, radialDirection: 0.7, position: { method: 'top', offset: 0.04 } },
          { id: 'cp1', type: 'tubecoupler', name: 'Coupler', length: 0.05, outerRadius: 0.016,
            position: { method: 'top', offset: 0.06 } },
        ],
      },
    ],
  }],
} as unknown as RocketTree;

/** Off-axis assemblies: a pod set and a parallel stage (boosters). */
const pods = {
  name: 'Pods',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'conical', length: 0.1, aftRadius: 0.015 },
      {
        id: 'b1', type: 'bodytube', length: 0.35, outerRadius: 0.015,
        children: [
          { id: 'f1', type: 'trapezoidfinset', finCount: 4, rootChord: 0.05, tipChord: 0.02,
            sweep: 0.03, height: 0.03, position: { method: 'bottom', offset: 0 } },
          { id: 'p1', type: 'podset', name: 'Pods', instanceCount: 3, radiusOffset: 0.03, angleOffset: 0.2,
            position: { method: 'top', offset: 0.1 },
            children: [
              { id: 'pn', type: 'nosecone', name: 'Pod nose', shape: 'haack', length: 0.03, aftRadius: 0.006 },
              { id: 'pb', type: 'bodytube', name: 'Pod tube', length: 0.08, outerRadius: 0.006,
                children: [
                  { id: 'pf', type: 'trapezoidfinset', name: 'Pod fins', finCount: 3, rootChord: 0.02,
                    tipChord: 0.01, sweep: 0.01, height: 0.01, position: { method: 'bottom', offset: 0 } },
                  { id: 'pm', type: 'innertube', name: 'Pod mount', length: 0.04, outerRadius: 0.004,
                    motorMount: true, position: { method: 'bottom', offset: 0 } },
                ] },
            ] },
          { id: 'ps', type: 'parallelstage', name: 'Boosters', instanceCount: 2, angleOffset: 1.2,
            position: { method: 'bottom', offset: 0 },
            children: [
              { id: 'bt', type: 'bodytube', name: 'Booster tube', length: 0.15, outerRadius: 0.01 },
              { id: 'bx', type: 'transition', name: 'Booster tail', shape: 'conical', length: 0.02,
                foreRadius: 0.01, aftRadius: 0.006 },
            ] },
        ],
      },
    ],
  }],
} as unknown as RocketTree;

type Props = Parameters<typeof TreeSchematic>[0];
const show = (tree: RocketTree, extra: Partial<Props> = {}) => act(() => root.render(
  <TreeSchematic tree={tree} info={null} {...extra} />,
));
const hover = (label: string) => act(() => {
  const el = [...host.querySelectorAll('[aria-label]')].find((e) => e.getAttribute('aria-label') === label)!;
  el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
});
/**
 * One press of the + button: 1.5x about the drawing's centre. Not the wheel —
 * happy-dom's WheelEvent drops clientX/clientY, so a synthetic wheel zoomed
 * about NaN and this case pinned `translate(NaN NaN)`, a view no browser
 * draws (review of the extraction). The snapshot that replaced it was written
 * by the component as it stood BEFORE the extraction, and the extracted one
 * reproduces it byte for byte, like every other case here.
 */
const zoomIn = () => act(() => {
  (host.querySelector('button[aria-label="Zoom in"]') as HTMLButtonElement).click();
});
/** The zoomed group's transform, which must be a real one to be worth pinning. */
const viewTransform = () => host.querySelector('svg > g[transform^="translate("]')?.getAttribute('transform');
const noop = () => {};

describe('the side view draws what it drew before the layout extraction', () => {
  it('every part type, at rest', () => {
    show(busy);
    expect(drawn()).toMatchSnapshot();
  });
  it('every part type, rolled (the wireframe path), with CG/CP callouts', () => {
    show(busy, { roll: 0.6, info: info() });
    expect(drawn()).toMatchSnapshot();
  });
  it('every part type, rolled past the quarter turn', () => {
    show(busy, { roll: 2.2 });
    expect(drawn()).toMatchSnapshot();
  });
  it('interactive: selection, grab cursors and tab stops', () => {
    show(busy, { selectedId: 'f1', onSelect: noop, onPatchNode: noop, info: info({ stabilityCalibers: 0.6 }) });
    expect(drawn()).toMatchSnapshot();
  });
  it('an inner part selected and a rail button hovered, rolled', () => {
    show(busy, { selectedId: 'mt', onSelect: noop, onPatchNode: noop, roll: 0.9 });
    hover('Select Buttons');
    expect(drawn()).toMatchSnapshot();
  });
  it('motors drawn to scale, in a cluster and in a minimum-diameter tube', () => {
    show(busy, {
      motors: { mt: { length: 0.07, diameter: 0.011, label: 'D12-5' }, b2: { length: 0.095, diameter: 0.029, label: 'G80T-7' } },
      info: info(),
    });
    expect(drawn()).toMatchSnapshot();
  });
  it('nose-up, selectable', () => {
    show(busy, { vertical: true, onSelect: noop, info: info(),
      motors: { mt: { length: 0.07, diameter: 0.011, label: 'D12-5' } } });
    expect(drawn()).toMatchSnapshot();
  });
  it('zoomed in (the fit-view ruler copy rides along)', () => {
    show(busy, { onSelect: noop, onPatchNode: noop, info: info() });
    zoomIn();
    expect(viewTransform()).toMatch(/^translate\(-?\d+(\.\d+)? -?\d+(\.\d+)?\) scale\(1\.5\)$/);
    expect(drawn()).toMatchSnapshot();
  });
  it('the hero canvas: fill height, top reserve', () => {
    show(busy, { fillHeight: true, topReserve: 140, info: info(), maxHeight: 300 });
    expect(drawn()).toMatchSnapshot();
  });
  it('pods and a parallel stage, at rest, pod tube hovered', () => {
    show(pods, { onSelect: noop, onPatchNode: noop });
    hover('Select Pod tube');
    expect(drawn()).toMatchSnapshot();
  });
  it('pods and a parallel stage, rolled', () => {
    show(pods, { roll: 0.9, selectedId: 'pf', onSelect: noop });
    expect(drawn()).toMatchSnapshot();
  });
});

describe('real files', () => {
  const files: [string, () => RocketTree][] = [
    ['kitchensink.ork', () => importOrk(fixture('kitchensink.ork')).tree],
    ['reference.ork', () => importOrk(fixture('reference.ork')).tree],
    ['FinsOnTransitions.rkt', () => importRkt(fixture('FinsOnTransitions.rkt')).tree],
    ['TubeFins2.rkt', () => importRkt(fixture('TubeFins2.rkt')).tree],
    ['Three-stage rocket.CDX1', () => importCdx1(fixture('Three-stage rocket.CDX1')).tree],
  ];
  for (const [name, load] of files) {
    it(`${name}, at rest`, () => {
      show(load(), { onSelect: noop, onPatchNode: noop, info: info() });
      expect(drawn()).toMatchSnapshot();
    });
    it(`${name}, rolled`, () => {
      show(load(), { roll: 0.8 });
      expect(drawn()).toMatchSnapshot();
    });
  }
});
