// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { EXAMPLE_DESIGNS } from './exampleDesigns.js';
import { PropertyPanel } from '../components/PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { openDesignFile } from '../services/designFile.js';
import { loadBundledPresets } from '../services/presets.js';

const flatten = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);

it.each(EXAMPLE_DESIGNS)('shows the actual assumed fin material density in $id', async example => {
  const data = readFileSync(resolve('src/data/examples', example.fileName));
  const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), example.fileName, { presets: await loadBundledPresets() });
  const fins = flatten(imported.tree.components).filter(n => ['trapezoidfinset', 'freeformfinset'].includes(n.type));
  expect(fins).toHaveLength(example.id === 'two-stage' ? 2 : 1);
  for (const node of fins) {
    const plywood = example.id === 'dual-deploy';
    const html = renderToStaticMarkup(
      <PrefsProvider><PropertyPanel tree={imported.tree} node={node} onPatch={() => {}} /></PrefsProvider>,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const select = doc.querySelector<HTMLSelectElement>('select[aria-label="Material"]')!;
    expect(select, `${example.id}: Material selector`).not.toBeNull();
    const option = select.querySelector('option[selected]')!;
    expect(option.getAttribute('value')).toBe(node['materialName']);
    expect(option.textContent).toContain(`(${node['density']} kg/m³)`);
    expect(node['materialName']).toBe(plywood ? 'Plywood (assumed)' : 'Balsa (assumed)');
    expect(node['density']).toBe(plywood ? 600 : 160.2);
  }
});
