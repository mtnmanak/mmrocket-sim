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
import { linkedPreset, loadBundledPresets } from '../services/presets.js';

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

it.each(EXAMPLE_DESIGNS)('shows recovery canopy material consistent with linked stock in $id', async example => {
  const data = readFileSync(resolve('src/data/examples', example.fileName));
  const presets = await loadBundledPresets();
  const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), example.fileName, { presets });
  const devices = flatten(imported.tree.components).filter(n => n.type === 'parachute');
  expect(devices).toHaveLength(['dual-deploy', 'two-stage'].includes(example.id) ? 2 : 1);
  for (const node of devices) {
    const stock = linkedPreset(node, presets)!;
    expect(stock, `${example.id}: recovery has bundled stock`).toBeDefined();
    expect(node['surfaceMaterialName'], `${example.id}: canopy matches linked stock`).toBe(stock.material?.name);
    expect(node['overrideMass'], `${example.id}: retains catalogue device mass in kg`).toBe(stock.mass);
    const html = renderToStaticMarkup(
      <PrefsProvider><PropertyPanel tree={imported.tree} node={node} onPatch={() => {}} /></PrefsProvider>,
    );
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const option = doc.querySelector('select[aria-label="Canopy material"] option[selected]')!;
    expect(option, `${example.id}: selected canopy material`).not.toBeNull();
    expect(option.getAttribute('value')).toBe(stock.material?.name);
    expect(option.textContent).toContain(`${stock.material?.name} (${node['surfaceDensity']} kg/m²)`);
    if (stock.material?.name === 'Polyethylene LDPE') {
      // Stock omits density; the file explicitly assumes OpenRocket's thin film.
      expect(stock.material.density).toBeUndefined();
      expect(node['surfaceDensity']).toBe(0.015);
      expect(node['comment']).toContain('0.015 kg/m^2');
      expect(node['comment']).toContain('assumed');
      const canopyMass = Math.PI * (Number(node['diameter']) / 2) ** 2 * Number(node['surfaceDensity']);
      const lineMass = Number(node['lineCount']) * Number(node['lineLength']) * Number(node['lineDensity']);
      expect(canopyMass + lineMass, `${example.id}: modeled canopy and lines fit the stated mass`).toBeLessThanOrEqual(Number(stock.mass));
    } else {
      expect(node['surfaceDensity']).toBe(stock.material?.density);
    }
  }
});
