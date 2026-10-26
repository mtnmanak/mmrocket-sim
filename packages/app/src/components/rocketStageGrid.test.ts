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

it.each(['light', 'dark'])('N009 removes fixed decoration from the %s schematic for both grid states without :has support', (theme) => {
  style.textContent = css.replace(/[^{}]*:has\([^{}]*\)\s*\{[^{}]*\}/g, '');
  host.className = 'viz-root';
  host.dataset.theme = theme;
  host.innerHTML = '<div class="rocket-stage" data-view="2d"><div class="tree-schematic"><svg></svg></div></div>';
  const stage = host.querySelector<HTMLElement>('.rocket-stage')!;
  for (const grid of [true, false]) {
    host.querySelector('svg')!.innerHTML = grid ? '<g data-grid="view"><line /></g>' : '';
    // Brand v1: the stage is FLAT (SPEC §7.2, no gradients), so in 2D there is
    // no decoration left at all — no CSS grid lines and no sky gradient. The
    // ground is a plain background-color (checked below).
    const computed = getComputedStyle(stage);
    expect(['none', 'initial']).toContain(computed.backgroundImage);
  }
});

it('the stage ground is a flat brand colour in each theme, with no gradient fill anywhere', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (sel: string) => {
    const at = stripped.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThan(-1);
    return stripped.slice(at, stripped.indexOf('}', at));
  };
  expect(ruleOf('.rocket-stage')).toMatch(/background-color:\s*var\(--mmr-surface-2\);/);
  expect(ruleOf(".viz-root[data-theme='dark'] .rocket-stage")).toMatch(/background-color:\s*var\(--mmr-bg\);/);
  // The old dusk-sky gradients, light and dark.
  expect(stripped).not.toMatch(/linear-gradient\(180deg/);
});

it.each(['light', 'dark'])('N009 retains %s decoration for sibling 3D and aft stages', (theme) => {
  host.className = 'viz-root';
  host.dataset.theme = theme;
  host.innerHTML = '<div class="rocket-stage"><div class="rocket3d-wrap"></div></div><div class="rocket-stage"><svg></svg></div>';
  for (const stage of host.querySelectorAll<HTMLElement>('.rocket-stage')) {
    // The drafting grid's two line layers; the gradient sky layer is gone.
    expect(getComputedStyle(stage).backgroundSize).toBe('22px 22px, 22px 22px');
    expect(getComputedStyle(stage).backgroundImage).toContain('linear-gradient');
  }
});

it.each(['light', 'dark'])('N009 preserves the flat Daylight background in the %s schematic', (theme) => {
  host.className = 'viz-root';
  host.dataset.theme = theme;
  host.dataset.contrast = 'high';
  host.innerHTML = '<div class="rocket-stage" data-view="2d"><div class="tree-schematic"></div></div>';
  // happy-dom spells the shorthand's reset as initial; browsers resolve it to none.
  expect(['none', 'initial']).toContain(getComputedStyle(host.querySelector<HTMLElement>('.rocket-stage')!).backgroundImage);
});
