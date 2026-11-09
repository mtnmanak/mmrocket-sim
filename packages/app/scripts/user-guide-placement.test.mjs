import { expect, it } from 'vitest';
import { compileGuide } from '../../../scripts/build-user-guide.mjs';

// Check rendered paragraphs: a nearby unanchored paragraph is not part of an entry.
const html = () => [...compileGuide().ts.matchAll(/"html": (".*")/g)]
  .map((match) => JSON.parse(match[1])).join('\n');

it('keeps the Mach-Alt import rule inside its anchored glossary entry', () => {
  const entry = html().match(/<p id="glossary-mach-alt-table"[^>]*>(.*?)<\/p>/s)?.[1];
  expect(entry).toContain('each nonblank row must contain exactly two period-decimal numbers');
  expect(entry).toContain('Unreadable or unsupported rows are dropped with a caution');
});

it('keeps flight angle preferences with the existing AoA glossary text', () => {
  const entry = html().match(/<p id="glossary-angle-of-attack-aoa-or"[^>]*>(.*?)<\/p>/s)?.[1];
  expect(entry).toContain('Angle of attack in the flight charts, custom plots and launch-guide-exit report follows');
  expect(entry).toContain('recorded flight data stays in radians');
});
