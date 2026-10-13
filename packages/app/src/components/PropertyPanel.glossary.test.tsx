// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { defaultTree, findNode } from '../tree/treeModel.js';
import { DISPLAY_NAME, FIELDS } from '../tree/schema.js';
import { componentTerm, fieldTerm } from '../tree/glossaryTerms.js';
import { GUIDE_SECTIONS } from '../data/userGuide.js';
import { FinPointsEditor } from './FinPointsEditor.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
host.className = 'viz-root';
host.dataset.contrast = 'high';
document.body.appendChild(host);
const root = createRoot(host);
afterEach(() => { act(() => root.render(null)); host.innerHTML = ''; });

it('links every schema field and every component type to a real entry in the existing glossary', () => {
  const glossary = GUIDE_SECTIONS.find(s => s.id === 'glossary')!.html;
  for (const [type, fields] of Object.entries(FIELDS)) {
    for (const f of fields) {
      expect(fieldTerm(type, f.key), `${type}.${f.key}`).toBeTruthy();
      expect(glossary.includes(`id="glossary-${fieldTerm(type, f.key)}"`), `${type}.${f.key}`).toBe(true);
    }
  }
  for (const type of Object.keys(DISPLAY_NAME)) {
    expect(glossary.includes(`id="glossary-${componentTerm(type)}"`), type).toBe(true);
  }
});

it('uses rail-button count help rather than the circumferential assembly instance definition', () => {
  expect(fieldTerm('railbutton', 'instanceCount')).toBe('rail-button');
  expect(fieldTerm('podset', 'instanceCount')).toBe('instance');
  expect(fieldTerm('parallelstage', 'instanceCount')).toBe('instance');
});

it.each(['nosecone', 'innertube'])('keeps %s checkbox help in the label row without making it the label control', type => {
  const tree = defaultTree();
  const node = type === 'nosecone' ? tree.components[0]!.children!.find(n => n.type === type)!
    : tree.components[0]!.children!.flatMap(n => n.children ?? []).find(n => n.type === type)!;
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={node} onPatch={() => {}} /></PrefsProvider>));
  const label = type === 'nosecone' ? 'Solid (filled)' : 'Acts as motor mount';
  const button = host.querySelector(`button[aria-label="Definition: ${label}"]`)!;
  const row = button.closest('.field-label-help');
  expect(row).not.toBeNull();
  expect(row?.querySelector('input[type="checkbox"]')).not.toBeNull();
  expect(button.closest('label')).toBeNull();
});

it.each(['heading', 'table header'])('opens help from a %s outside the styled container and inside the sun-theme root', async source => {
  const tree = defaultTree();
  const fins = tree.components[0]!.children!.flatMap(n => n.children ?? []).find(n => n.type === 'trapezoidfinset')!;
  act(() => root.render(<PrefsProvider>{source === 'heading'
    ? <PropertyPanel tree={tree} node={fins} onPatch={() => {}} />
    : <FinPointsEditor points={[[0, 0], [0.02, 0.03], [0.06, 0]]} onChange={() => {}} />}</PrefsProvider>));
  const button = host.querySelector<HTMLButtonElement>(source === 'heading'
    ? 'h2 button.glossary-help' : 'th button.glossary-help')!;
  expect(button).not.toBeNull();
  button.focus();
  await act(async () => { button.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.parentElement!.closest('h2, h3, th, p, .panel')).toBeNull();
  expect(dialog.closest('.viz-root')).toBe(host);
  expect(dialog.closest('[data-contrast="high"]')).toBe(host);
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button);
});

it('opens chord help from a focused button, preserves inputs, closes with Escape and restores focus', async () => {
  const tree = defaultTree();
  const fins = tree.components[0]!.children!.flatMap(n => n.children ?? []).find(n => n.type === 'trapezoidfinset')!;
  const before = structuredClone(tree);
  const patches: unknown[] = [];
  act(() => root.render(<PrefsProvider><PropertyPanel tree={tree} node={findNode(tree, fins.id!)!}
    onPatch={p => patches.push(p)} /></PrefsProvider>));
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="Definition: Root chord"]');
  expect(button).not.toBeNull();
  expect(button!.closest('label')).toBeNull();
  button!.focus();
  await act(async () => { button!.click(); });
  // Lazy Guide chunk can finish after the initial act.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  const target = host.querySelector('#glossary-chord-root-chord-tip-chord');
  expect(target).not.toBeNull();
  expect(document.activeElement).toBe(target);
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(tree).toEqual(before);
  expect(patches).toEqual([]);
});
