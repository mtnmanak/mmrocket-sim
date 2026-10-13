// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');

let style: HTMLStyleElement;
let host: HTMLDivElement;

beforeEach(() => {
  style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => { host.remove(); style.remove(); });

it.each(['light', 'dark'])('N009 removes fixed decoration from the %s schematic for both grid states', (theme) => {
  host.className = 'viz-root';
  host.dataset.theme = theme;
  host.innerHTML = '<div class="rocket-stage"><div class="tree-schematic"><svg></svg></div></div>';
  const stage = host.querySelector<HTMLElement>('.rocket-stage')!;
  for (const grid of [true, false]) {
    host.querySelector('svg')!.innerHTML = grid ? '<g data-grid="view"><line /></g>' : '';
    const computed = getComputedStyle(stage);
    expect(computed.backgroundSize).toBe('100% 100%');
    expect(computed.backgroundImage).not.toContain('transparent');
    expect(computed.backgroundImage).toContain(theme === 'dark' ? '#14161d' : '#f2f4f8');
  }
});

it.each(['light', 'dark'])('N009 retains %s decoration for sibling 3D and aft stages', (theme) => {
  host.className = 'viz-root';
  host.dataset.theme = theme;
  host.innerHTML = '<div class="rocket-stage"><div class="rocket3d-wrap"></div></div><div class="rocket-stage"><svg></svg></div>';
  for (const stage of host.querySelectorAll<HTMLElement>('.rocket-stage')) {
    expect(getComputedStyle(stage).backgroundSize).toBe('22px 22px, 22px 22px, 100% 100%');
  }
});

it.each(['light', 'dark'])('N009 preserves the flat Daylight background in the %s schematic', (theme) => {
  host.className = 'viz-root';
  host.dataset.theme = theme;
  host.dataset.contrast = 'high';
  host.innerHTML = '<div class="rocket-stage"><div class="tree-schematic"></div></div>';
  // happy-dom spells the shorthand's reset as initial; browsers resolve it to none.
  expect(['none', 'initial']).toContain(getComputedStyle(host.querySelector<HTMLElement>('.rocket-stage')!).backgroundImage);
});
