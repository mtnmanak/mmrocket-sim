// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { couplerRingFitNote } from './ringFit.js';

/**
 * The ✂ DXF and 🖨 STL buttons size a ring-type part from the tube it sits in
 * — wired end to end (audit 2026-09-22). The panel's context builder read the
 * bore only off a parent with a numeric `outerRadius`, which an Add-menu
 * coupler never has, so a bulkhead in a coupler cut and printed as a 24.0 mm
 * disc labelled plainly "Bulkhead" on any airframe, with nothing on screen to
 * say the size was a guess.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const bulkhead = { id: 'bh', type: 'bulkhead', name: 'AV bay bulkhead', length: 0.004 } as unknown as ComponentNode;

const mount = (tree: RocketTree, node: ComponentNode) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} onPatch={() => {}} />
  </PrefsProvider>,
));

/** Click the button whose text starts with `glyph` and return the file text it hands to the browser. */
async function downloadText(glyph: string): Promise<string> {
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return 'blob:dxf-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {};
  try {
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent!.startsWith(glyph))!;
    await act(async () => { btn.click(); });
    // 📐 opens a format choice: take its first entry, the white SVG.
    if (btn.getAttribute('aria-expanded') === 'true') {
      const pick = host.querySelector('[aria-label="Fin template — file format"] button') as HTMLButtonElement;
      await act(async () => { pick.click(); });
    }
  } finally {
    HTMLAnchorElement.prototype.click = orig;
  }
  expect(blobs.length).toBe(1);
  return blobs[0]!.text();
}

/** Click the ✂ DXF button and return the file text it hands to the browser. */
const dxfText = (): Promise<string> => downloadText('✂');

/** Every CIRCLE radius in a DXF, in mm (group 40 follows the centre). */
const circleRadii = (dxf: string): number[] => {
  const lines = dxf.split('\r\n');
  const out: number[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i] === '0' && lines[i + 1] === 'CIRCLE') {
      for (let j = i + 2; j + 1 < lines.length && lines[j] !== '0'; j += 2) {
        if (lines[j] === '40') out.push(Number(lines[j + 1]));
      }
    }
  }
  return out;
};

const note = (): HTMLElement | null => host.querySelector('.print-note');

it.each([0.0099, 0.01, 0.0101, 0.01025, 0.0103])('HF7 advises only in the accepted coupler fit band (%s m)', async radius => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003,
    innerRadius: 0.01, position: { method: 'top', offset: 0.2 } };
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'body', length: 0.4,
    outerRadius: 0.03, children: [ring, { type: 'tubecoupler', length: 0.1,
      position: { method: 'top', offset: 0 }, children: [{ type: 'innertube', length: 0.3,
        outerRadius: radius, position: { method: 'top', offset: 0 } }] }] }] };
  mount(tree, ring);
  const warns = radius > 0.01 && radius <= 0.01025;
  expect(host.textContent!.includes('The tube cannot pass through the stated hole')).toBe(warns);
  if (warns) {
    expect(host.textContent).toContain('Check the tube and hole dimensions before cutting or printing');
    expect(host.textContent).toContain(radius === 0.0101 ? '0.2 mm' : '0.5 mm');
    const exported = await dxfText();
    expect(circleRadii(exported).some(r => Math.abs(r - 10) < 1e-8)).toBe(true);
    expect(exported).toContain('Caution: The stated hole is');
    expect(exported).toContain('The tube cannot pass through the stated hole.');
    const labels = [...exported.matchAll(/\r\n1\r\n([^\r]*)\r\n/g)].map(m => m[1]);
    expect(labels.join(' ')).toContain(`Caution: ${couplerRingFitNote(tree, ring)}`);
    expect(labels.every(s => s!.length <= 255)).toBe(true);
    expect(host.textContent).toContain('The tube cannot pass through the stated hole');
  }
});

it('r8 shows base inner diameter for a nose with omitted aft radius', () => {
  const nose: ComponentNode = { type: 'nosecone', id: 'nose', length: 0.1 };
  mount({ components: [nose] }, nose);
  const label = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Base inner diameter'));
  expect(label).toBeDefined();
  const field = document.getElementById(label!.htmlFor) as HTMLInputElement;
  expect(Number(field.value)).toBeCloseTo(20, 6); // 12 mm default base radius, 2 mm wall.
});

it.each([true, false])('r8 cuts contained coupler contents without off-axis advice (direct tube %s)', async direct => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: direct ? 0.005 : 0.01 };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.7, outerRadius: 0.03, children: [
    ring, ...(direct ? [{ type: 'innertube', length: 0.7, outerRadius: 0.009 } as ComponentNode] : []),
    { type: 'tubecoupler', length: 0.7, children: [
      { type: 'innertube', length: 0.7, outerRadius: direct ? 0.007 : 0.003, radialPosition: direct ? 0 : 0.002 },
    ] },
  ] }] };
  mount(tree, ring);
  expect(circleRadii(await dxfText())).toHaveLength(2);
  expect(host.textContent).not.toContain('cannot lay out');
  expect(host.textContent).not.toContain('cannot place off-axis holes');
});

it.each(['bodytube', 'innertube'] as const)('shows inner diameter for a %s with omitted radius', type => {
  const tube: ComponentNode = { type, id: 'tube', length: 0.3 };
  mount({ components: [tube] }, tube);
  expect([...host.querySelectorAll('label')].some(label => label.textContent?.startsWith('Inner diameter'))).toBe(true);
});

it.each(['bulkhead', 'centeringring'] as const)('explains no bore for automatic %s exports in solid parents', async type => {
  const ring: ComponentNode = { type, id: 'ring', length: 0.003 };
  for (const extra of [{ filled: true, thickness: 0.002 }, { thickness: 0.03 }]) {
    const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3,
      outerRadius: 0.03, ...extra, children: [ring] }] };
    mount(tree, ring);
    expect(note()!.textContent).toContain('parent has no bore');
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-export');
    for (const title of ['Flat 1:1', 'Watertight solid STL']) {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.title.startsWith(title))!;
      await act(async () => button.click());
      expect(host.querySelector('.part-export-alert')!.textContent).toContain('parent has no bore');
      expect(made).not.toHaveBeenCalled();
    }
    vi.restoreAllMocks();
  }
});

it.each([true, false])('r9 explains a wider centred coupler tube for STL and DXF (direct=%s)', async direct => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003,
    innerRadius: direct ? 0.012 : 0.01 };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03, children: [ring,
    ...(direct ? [{ type: 'innertube', length: 0.3, outerRadius: 0.009 } as ComponentNode] : []),
    { type: 'tubecoupler', length: 0.3, children: [
      { type: 'innertube', length: 0.3, outerRadius: direct ? 0.011 : 0.012 },
    ] },
  ] }] };
  const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-export');
  mount(tree, ring);
  for (const title of ['Flat 1:1', 'Watertight solid STL']) {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.title.startsWith(title))!;
    await act(async () => button.click());
    const text = host.querySelector('.part-export-alert')!.textContent;
    expect(text).toContain(direct
      ? "a tube held in a coupler is wider than the ring's direct mount tube"
      : "a tube held in a coupler is wider than this ring's hole");
    if (direct) expect(text).not.toContain('cannot pass');
    expect(text).not.toMatch(/off-centre|off-axis/);
    expect(made).not.toHaveBeenCalled();
  }
});

it('reports zero ring OD as nothing to cut, without blaming mount holes', async () => {
  const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003, outerRadius: 0 };
  const tree: RocketTree = { components: [{ type: 'bodytube', length: 0.3, outerRadius: 0.03, children: [ring] }] };
  const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-export');
  mount(tree, ring);
  const button = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('✂'))!;
  await act(async () => button.click());
  expect(made).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Nothing to cut for this component.');
  expect(host.textContent).not.toContain('cannot lay out');
});

it.each([undefined, 0.01])('reports an empty ring STL without blaming mount holes (ID radius %s)', async innerRadius => {
  const ring = { type: 'centeringring', id: 'ring', length: 0, innerRadius } as ComponentNode;
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
    { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
      { type: 'innertube', id: 'mount', outerRadius: 0.01, length: 0.3 }, ring,
    ] },
  ] }] };
  const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-export');
  mount(tree, ring);
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.title.startsWith('Watertight solid STL'))!;
  await act(async () => button.click());
  expect(made).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Nothing to export for this component.');
  expect(host.textContent).not.toContain('cannot lay out');
});

it.each(['✂', '🖨'])('refuses the %s ring export with an off-axis stated bore and gives usable advice', async glyph => {
  const ring = { type: 'centeringring', id: 'ring', length: 0.003, innerRadius: 0.015 } as ComponentNode;
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
    { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.03, thickness: 0.001, children: [
      { type: 'innertube', id: 'mount', outerRadius: 0.01, length: 0.3, radialPosition: 0.012 }, ring,
    ] },
  ] }] };
  const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-export');
  mount(tree, ring);
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.startsWith(glyph))!;
  await act(async () => button.click());
  expect(made).not.toHaveBeenCalled();
  expect(host.textContent).toContain('one centred opening would not fit');
  expect(host.textContent).toContain('Lay out the holes by hand.');
  expect(host.textContent).toContain('The ring’s stated ID cannot place off-axis holes.');
  expect(host.textContent).not.toContain('or state the ring ID');
});

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
  vi.restoreAllMocks();
});

describe('PropertyPanel — a ring part sizes to the tube it sits in', () => {
  it('a bulkhead in an Add-menu coupler cuts at the coupler bore, not a 24 mm placeholder', async () => {
    // 3" airframe (R 38.1 mm, 1 mm wall) -> automatic coupler OD 74.2 mm ->
    // 0.5 mm coupler wall -> bulkhead OD 73.2 mm.
    const tree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6,
        children: [{ id: 'c1', type: 'tubecoupler', length: 0.15, thickness: 0.0005, children: [bulkhead] }],
      }] }],
    } as unknown as RocketTree;
    mount(tree, bulkhead);
    const dxf = await dxfText();
    expect(circleRadii(dxf)).toEqual([36.6]);
    expect(dxf).toContain('OD 73.2 mm');
    expect(dxf).not.toContain('ASSUMED');
    // Nothing was assumed, so the panel says nothing.
    expect(note()).toBeNull();
  });

  it('refuses to cut a part at a resolved zero bore without inventing stock', async () => {
    // A bulkhead at the very tip of a nose cone: the inner radius there is 0.
    const tipBulkhead = { ...bulkhead, position: { method: 'top', offset: 0 } } as unknown as ComponentNode;
    const tree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'n1', type: 'nosecone', shape: 'conical', length: 0.2, aftRadius: 0.03, thickness: 0.002,
        children: [tipBulkhead],
      }] }],
    } as unknown as RocketTree;
    mount(tree, tipBulkhead);
    expect(note()!.textContent).toContain('parent has no bore');
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:should-not-export');
    const button = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('✂'))!;
    await act(async () => button.click());
    expect(made).not.toHaveBeenCalled();
    expect(host.textContent).toContain('parent has no bore');
  });

  it('a centering ring no inner tube passes through says its bore is assumed, under the button too', async () => {
    // LEM-IV's "Retainer Plate" (a tester's file): a 99.1 mm ring with an
    // automatic bore, 41 mm aft of the 80.3 mm motor tube. No tube overlaps
    // it, so the bore is the half-OD placeholder (the kernel flies a solid
    // disc), and until the 2026-09-30 review only the label INSIDE the STL and
    // the DXF's own note said so.
    const plate = {
      id: 'rp', type: 'centeringring', name: 'Retainer Plate', length: 0.0032, outerRadius: 0.04953,
      position: { method: 'top', offset: 0.8033 },
    } as unknown as ComponentNode;
    const tree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'b1', type: 'bodytube', outerRadius: 0.051054, thickness: 0.0015, length: 0.7779,
        children: [
          { id: 'mmt', type: 'innertube', outerRadius: 0.0401574, thickness: 0.001, length: 0.6858,
            position: { method: 'top', offset: 0.0762 }, motorMount: true },
          plate,
        ],
      }] }],
    } as unknown as RocketTree;
    mount(tree, plate);
    expect(note()!.textContent).toBe('Bore assumed: 49.53 mm (1.95 in) is a placeholder — no motor mount passes '
      + 'through this ring. Measure what goes through it before you print or cut it.');
    expect(note()!.className).toContain('print-note-warn');
    const dxf = await dxfText();
    expect(dxf).toContain('OD 99.1 mm | bore 49.5 mm');
    expect(dxf).toContain('BORE ASSUMED: no motor mount passes through this ring');
  });

  it('the two buttons describe the sizing they do, not "from the parent tube"', () => {
    // A part's OWN stated diameter comes first, and the bore may be a
    // coupler's, a nose cone's or a transition's (audit 2026-09-22).
    mount({
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [{
        id: 'b1', type: 'bodytube', outerRadius: 0.0381, thickness: 0.001, length: 0.6, children: [bulkhead],
      }] }],
    } as unknown as RocketTree, bulkhead);
    const titles = [...host.querySelectorAll('button')].map((b) => b.title)
      .filter((t) => t.includes('bulkheads'));
    expect(titles).toHaveLength(2);
    for (const t of titles) {
      expect(t).not.toContain('from the parent tube');
      expect(t).toContain('their own stated diameter, else the bore of the tube, coupler, nose or transition');
    }
    // The DXF's ring-bore clause: the ring's own stated ID comes first too.
    const dxfTitle = titles.find((t) => t.includes('DXF'))!;
    expect(dxfTitle).toContain("a centering ring's bore from its own stated ID, else the motor mount");
  });
});

describe('PropertyPanel — a fin tab cuts no deeper than the body', () => {
  // A 30 mm tab on a 38 mm minimum-diameter airframe, 39.0 mm across with a
  // 38.0 mm bore (audit 2026-09-30): the kernel and the side view clamp it to
  // the 19.5 mm body radius, and so must both files these buttons hand over —
  // the 📐 template took no context at all.
  const fins = {
    id: 'fins', type: 'trapezoidfinset', name: 'Fins', finCount: 3, rootChord: 0.1, tipChord: 0.05,
    sweep: 0.05, height: 0.06, thickness: 0.003, tabHeight: 0.03, tabLength: 0.06,
    position: { method: 'bottom', offset: 0 },
  } as unknown as ComponentNode;
  const tree = {
    name: 'Rocket',
    components: [{ id: 's1', type: 'stage', children: [{
      id: 'b1', type: 'bodytube', outerRadius: 0.0195, thickness: 0.0005, length: 0.6, children: [fins],
    }] }],
  } as unknown as RocketTree;

  it('the 📐 template and the ✂ DXF both cut the clamped 19.5 mm tab', async () => {
    mount(tree, fins);
    expect(await downloadText('📐')).toContain('tab 19.5 mm deep');
    vi.restoreAllMocks();
    expect(await dxfText()).toContain('TTW tab 19.5 mm deep');
  });
});
