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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
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
