// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { NoticeBar } from './NoticeBar.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { exportOrk, importOrk } from '../services/orkFile.js';
import { tierLines } from '../services/importNotes.js';

/**
 * D7 §5, P11: what the fin STL holds is read WITH the export choice, not only
 * from the 🖨 button's tooltip. Since N062 a rounded or airfoil fin (Eric's own
 * designs) PRINTS its section — the hint names it, the printable minimum edge
 * and the flat tab; a square fin is still the flat prism; and a shaped fin the
 * print path cannot follow says it is the flat prism, and why. Cant is never
 * baked in and root fillets are never printed on the lone fin.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const TRAP = { id: 'f1', type: 'trapezoidfinset', name: 'Fins', fins: 3, rootChord: 0.06, tipChord: 0.03,
  height: 0.05, sweepLength: 0.02, thickness: 0.003 };
/** A W outline: a horizontal line crosses it four times, so no single chord at that height. */
const W = { id: 'f1', type: 'freeformfinset', name: 'Fins', fins: 3, thickness: 0.003,
  points: [[0, 0], [0.02, 0.03], [0.04, -0.01], [0.06, 0.03], [0.08, 0]] };

const render = (fields: Record<string, unknown>) => {
  const fin = fields as unknown as ComponentNode;
  const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [
    { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [fin] },
  ] }] } as unknown as RocketTree;
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={fin} onPatch={() => {}} /></PrefsProvider>));
  return host.querySelector('.fin-print-scope');
};
const show = (crossSection?: string, extra: Record<string, unknown> = {}) =>
  render({ ...TRAP, ...(crossSection ? { crossSection } : {}), ...extra });
const words = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ');
/** Let any pending render settle (the Cross section notes are synchronous since the N062 review). */
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const TAB = { tabHeight: 0.008, tabLength: 0.04 };
it.each(['rounded', 'airfoil'])('does not claim nonfinite %s root fillets exist', section => {
  expect(words(show(section, { filletRadius: Infinity }))).not.toContain('root fillets');
});

// S3a-1 (audit 2026-10-17): inherited label-table keys must never become React children.
it.each(['__proto__', 'constructor', 'toString'])('repairs an imported inherited cross-section %s to Square with a note and safe re-save', cross => {
  const { tree, notes, noteTiers } = importOrk(`<openrocket version="1.10"><rocket><name>Untrusted section</name><subcomponents>
    <stage><subcomponents><bodytube><length>0.3</length><radius>0.02</radius><thickness>0.001</thickness><subcomponents>
    <freeformfinset><name>Fins</name><fincount>3</fincount><thickness>0.003</thickness>
      <crosssection>${cross}</crosssection><airfoilsection>naca</airfoilsection>
      <finpoints><point x="0" y="0"/><point x="0.02" y="0.03"/><point x="0.06" y="0"/></finpoints>
    </freeformfinset></subcomponents></bodytube></subcomponents></stage>
    </subcomponents></rocket></openrocket>`);
  const fin = tree.components[0]!.children![0]!.children![0]!;
  expect(fin).not.toHaveProperty('crossSection');
  const repair = `“Fins”: Cross section “${cross}” is not one the simulation knows — it now uses`
    + ' a square cross-section, which is what the simulation was already using.';
  expect(notes.filter(n => n.includes('Cross section'))).toEqual([repair]);
  expect(noteTiers).toContainEqual({ kind: 'I04.limits', tier: 'caution', text: repair });
  const before = structuredClone(tree);
  const patches: unknown[] = [];
  act(() => root.render(<PrefsProvider>
    <PropertyPanel tree={tree} node={fin} onPatch={p => patches.push(p)} />
    <NoticeBar notices={[{ id: 'file-note', severity: 'info', text: notes.join('\n'),
      group: { lines: tierLines(notes, noteTiers) } }]} />
  </PrefsProvider>));
  expect(words(host.querySelector('.notice-bar .message-caution'))).toContain(repair);
  expect(words(host.querySelector('.fin-section-named'))).toMatch(/named NACA \(round LE\) section.*draw the Square cross-section/);
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Cross section"]')!;
  expect(select.value).toBe('square');
  expect(select.selectedOptions[0]!.textContent).toBe('Square');
  expect(tree).toEqual(before);
  expect(patches).toEqual([]);
  const saved = exportOrk({ name: tree.name ?? 'Rocket', tree });
  expect(saved).toContain('<crosssection>square</crosssection>');
  expect(saved).not.toContain(`<crosssection>${cross}</crosssection>`);
});

it.each(['__proto__', 'constructor', 'toString'])('safely labels an unsanitized inherited cross-section %s', cross => {
  show(cross, { airfoilSection: 'naca' });
  expect(words(host.querySelector('.fin-section-named'))).toMatch(/draw the Square cross-section/);
});

const stlButton = () => [...host.querySelectorAll('button')].find(b => /STL/.test(b.textContent ?? ''))!;

it.each([
  ['rounded', 'rounded cross-section'],
  ['airfoil', 'airfoil cross-section, as a symmetric NACA 4-digit section thickest at 30% of the chord'],
])('says a %s fin prints its section, the printable edge and the flat tab, beside the export button', (section, named) => {
  const scope = show(section, TAB)!;
  const text = words(scope);
  expect(text).toContain('The STL is ONE fin with its tab.');
  expect(text).toContain(named);
  expect(text).toContain('sharp edges thickened to a printable 0.4 mm');
  expect(text).toContain('the tab stays flat at full thickness');
  expect(text).toMatch(/Cant is not baked in\./);
  expect(text).not.toMatch(/flat prism|sanding|not in it/);
  expect(stlButton().compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('names a supersonic section by its own shape, and NACA when the section is named', () => {
  expect(words(show('airfoil', { airfoilSection: 'hexagonal' }))).toContain('hexagonal section');
  expect(words(show('airfoil', { airfoilSection: 'singlewedge' }))).toContain('single-wedge section');
  expect(words(show('airfoil', { airfoilSection: 'naca' }))).toContain('NACA section');
});

it('says root fillets are not printed, on every kind of fin, only when the set has them', () => {
  expect(words(show('airfoil', { filletRadius: 0.004 })))
    .toContain('the root fillets are not printed (they are formed on the assembled rocket)');
  expect(words(show('square', { filletRadius: 0.004 })))
    .toContain('cant is not baked in, and the root fillets are not printed');
  expect(words(show('airfoil'))).not.toMatch(/fillet/);
  expect(words(show('square'))).not.toMatch(/fillet/);
});

it('says edge shaping is left to sanding for a square fin, and says nothing for a tube fin set (a ring, not a prism)', () => {
  expect(words(show('square'))).toMatch(/flat prism.*any edge shaping is left to sanding, and cant is not baked in/);
  expect(words(show())).toMatch(/any edge shaping is left to sanding/);
  const tubeFins = { id: 't1', type: 'tubefinset', name: 'Tube fins', fins: 6, length: 0.05 } as unknown as ComponentNode;
  const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [
    { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [tubeFins] },
  ] }] } as unknown as RocketTree;
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={tubeFins} onPatch={() => {}} /></PrefsProvider>));
  expect([...host.querySelectorAll('button')].some(b => /STL/.test(b.textContent ?? ''))).toBe(true);
  expect(host.querySelector('.fin-print-scope')).toBeNull();
  expect(host.querySelector('.fin-section-flat')).toBeNull();
});

it('a shaped outline the print path cannot follow says it is the flat prism, and why — never silently', () => {
  const text = words(render({ ...W, crossSection: 'rounded' }));
  expect(text).toMatch(/flat prism: this fin.s rounded cross-section is not in it, because its outline has more than one chord at some height/);
  expect(text).toMatch(/cant is not baked in/);
});

it('says beside the Cross section that the 3D view draws that outline as flat prisms', async () => {
  render({ ...W, crossSection: 'airfoil' });
  await settle();
  expect(words(host.querySelector('.fin-section-flat')))
    .toMatch(/3D view and the OBJ, GLB and shell STL draw these fins as flat prisms, without their airfoil section/);
});

it('says nothing beside the Cross section for an outline the 3D view shapes, or for a square one', async () => {
  for (const fields of [
    { ...W, crossSection: 'square' },
    { ...W, id: 'f2', points: [[0, 0], [0.02, 0.04], [0.05, 0.04], [0.06, 0]], crossSection: 'airfoil' },
    { ...TRAP, crossSection: 'rounded' },
  ]) {
    render(fields);
    await settle();
    expect(host.querySelector('.fin-section-flat')).toBeNull();
  }
});

it('names no tab for a fin that has none (N062 review)', () => {
  const text = words(show('airfoil'));
  expect(text).toContain('The STL is ONE fin. The fin carries');
  expect(text).not.toMatch(/\btab\b/);
  expect(words(show('square'))).toMatch(/ONE fin as a flat prism; any edge shaping/);
  expect(words(show('square', TAB))).toMatch(/ONE fin as a flat prism with its tab; any edge shaping/);
});

it('says stock no thicker than the printable edge prints flat, not that the section is in it (N062 review)', () => {
  const text = words(show('airfoil', { ...TAB, thickness: 0.0003 }));
  expect(text).toMatch(/flat prism with its tab: this fin.s airfoil cross-section is not in it, because the stock is no thicker than the printable minimum edge/);
  expect(text).not.toMatch(/thickened to a printable/);
});

it('says an outline the STL path refuses cannot be exported — not that it prints as a flat prism (N062 review)', () => {
  for (const crossSection of ['airfoil', 'rounded', 'square']) {
    for (const points of [[[0, 0], [0.1, 0.04], [0.02, 0.02], [0.08, 0]], [[0, 0], [0.02, 0], [0.05, 0]]]) {
      const text = words(render({ ...W, points, crossSection }));
      expect(text).toContain('This fin cannot be exported as an STL');
      expect(text).not.toMatch(/flat prism|carries/);
    }
  }
});

/** A freeform fin the body makes hook-shaped AS SEATED on a rising 15 -> 27 mm transition (the reviewer's fixture). */
const renderHook = (crossSection: string) => {
  const fin = { id: 'f9', type: 'freeformfinset', name: 'Fins', fins: 3, finCount: 3, thickness: 0.003, crossSection,
    position: { method: 'top', offset: 0.0056 },
    points: [[0, 0], [0.0345, 0.0343], [0.0672, 0.0298], [0.0244, 0.0095], [0.0892, 0]] } as unknown as ComponentNode;
  const tree = { name: 'R', components: [{ id: 's1', type: 'stage', children: [
    { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.015 },
    { id: 't1', type: 'transition', shape: 'conical', length: 0.1, foreRadius: 0.015, aftRadius: 0.027, children: [fin] },
  ] }] } as unknown as RocketTree;
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={fin} onPatch={() => {}} /></PrefsProvider>));
};

it('says beside the Cross section, and under the STL button, when the SEAT makes the outline hook-shaped (N062 review)', async () => {
  renderHook('airfoil');
  await settle();
  expect(words(host.querySelector('.fin-section-flat')))
    .toMatch(/^As seated on the body, this outline crosses some horizontal line more than twice, so the 3D view and the OBJ, GLB and shell STL draw these fins as flat prisms/);
  expect(words(host.querySelector('.fin-print-scope')))
    .toMatch(/airfoil cross-section is not in it, because as seated on the body, its outline has more than one chord at some height/);
  renderHook('square');
  await settle();
  expect(host.querySelector('.fin-section-flat')).toBeNull();
});

it('says when a named Supersonic airfoil is flown but not drawn: on a Rounded or Square fin (N062 review)', () => {
  show('rounded', { airfoilSection: 'hexagonal' });
  expect(words(host.querySelector('.fin-section-named')))
    .toMatch(/Under Rogers Modified Barrowman \(Kbf\), Auto, Supersonic and Hybrid \(experimental\) the flight uses the named Hexagonal section, but the 3D view, its exports and the 🖨 STL draw the Rounded cross-section you picked: a named section is drawn only on an Airfoil \(pointed\) fin/);
  // The model by the name Preferences shows (prefs/aeroChoice.ts AERO_NAME), never the retired "Rogers Kbf".
  expect(words(host.querySelector('.fin-section-named'))).not.toContain('Rogers Kbf');
  show('square', { airfoilSection: 'biconvex' });
  expect(words(host.querySelector('.fin-section-named'))).toMatch(/named Biconvex section.*draw the Square cross-section/);
  show(undefined, { airfoilSection: 'singlewedge' });
  expect(words(host.querySelector('.fin-section-named'))).toMatch(/named Single wedge \(blunt base\) section.*draw the Square cross-section/);
  for (const [section, extra] of [['airfoil', { airfoilSection: 'hexagonal' }], ['rounded', {}], ['rounded', { airfoilSection: '' }]] as const) {
    show(section, extra);
    expect(host.querySelector('.fin-section-named')).toBeNull();
  }
});

it("the 🖨 STL button's tooltip names every flat-print fallback for a shaped fin (N062 review, round 3)", () => {
  show('rounded', TAB);
  const title = stlButton().getAttribute('title') ?? '';
  expect(title).toContain('a rounded or airfoil fin carries its cross-section with sharp edges thickened to a printable 0.4 mm and a flat tab');
  expect(title).toContain('except that an outline with more than one chord at some height (a W or hook, as drawn or as seated on the body), a step in its leading or trailing edge, or stock no thicker than 0.4 mm prints as the flat prism, as the note under this button says');
  expect(title).not.toContain('0.4 mm and a flat tab, a square fin');
});
