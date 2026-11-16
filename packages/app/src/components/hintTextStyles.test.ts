import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Two hints rendered at body size beside 11–12 px text (found in the 2026-11-16 browser check):
// MaximumFlightTimeField's `.field-help` had no rule, and LaunchCompass's no-bearing <p> none either.
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string): string | null => {
  const at = css.split('}').map(block => block.split('{')).find(([head]) => head?.trim() === selector);
  return at?.[1] ?? null;
};

it('styles the field help sentence at hint size', () => {
  expect(rule('.field-help')).toMatch(/font-size:\s*11px/);
});

it('styles the compass no-bearing message like the compass frames', () => {
  expect(rule('.launch-compass-frames > p')).toMatch(/font-size:\s*12px/);
});
