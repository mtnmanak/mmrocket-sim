import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('r2-3 disabled chips match file buttons in ordinary and Daylight themes without a hover fill', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (selector: string) => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1]!.trim().split(/,\s*\n/).some(s => s.trim() === selector));
    expect(rules.length, selector).toBeGreaterThan(0);
    return rules.map(m => m[2]!).join('\n');
  };
  expect(body('.series-chip:disabled')).toMatch(/opacity:\s*0\.5\s*;/);
  expect(body('.series-chip:disabled')).toMatch(/cursor:\s*default\s*;/);
  expect(body('.series-chip:not(.series-chip-on):hover:not(:disabled)')).toContain('background: var(--hover)');
  expect(css).not.toMatch(/\.series-chip:not\(\.series-chip-on\):hover\s*\{/);
  const daylight = ".viz-root[data-contrast='high'] ";
  expect(body(`${daylight}.series-chip:disabled`)).toBe(body(`${daylight}.file-btn:is(:disabled, [aria-disabled='true'])`));
  expect(body(`${daylight}.series-chip:disabled`)).toMatch(/opacity:\s*1\s*;/);
  expect(body(`${daylight}.series-chip:disabled`)).toContain('color: var(--text-muted)');
  expect(body(`${daylight}.series-chip:disabled`)).toContain('border-color: var(--chart-grid)');
  expect(css.lastIndexOf(`${daylight}.series-chip:disabled`)).toBeGreaterThan(css.indexOf('.series-chip:disabled'));
});

it('r3-3 Daylight mutes disabled selected chips and their impulse ring without losing the selected mark', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const daylight = ".viz-root[data-contrast='high'] ";
  expect(css).toContain(`${daylight}.series-chip-on:not(:disabled)`);
  expect(css).not.toMatch(/data-contrast='high'\] \.series-chip-on\s*\{/);
  expect(css).toMatch(/\.series-chip-on:disabled\s*\{\s*background: var\(--surface-3\)/);
  expect(css).toMatch(/\.series-chip:disabled \.impulse-badge\s*\{\s*box-shadow: none;/);
  expect(css.lastIndexOf(`${daylight}.series-chip:disabled .impulse-badge`)).toBeGreaterThan(css.indexOf('.series-chip-on .impulse-badge'));
});
