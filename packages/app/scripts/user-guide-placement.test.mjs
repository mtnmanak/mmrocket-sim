import { expect, it } from 'vitest';
import { compileGuide } from '../../../scripts/build-user-guide.mjs';

// Check rendered paragraphs: a nearby unanchored paragraph is not part of an entry.
const html = () => [...compileGuide().ts.matchAll(/"html": (".*")/g)]
  .map((match) => JSON.parse(match[1])).join('\n');

it('R2-8 introduces the motor catalogue and browser before explaining its three dates', () => {
  const rendered = html();
  const explanation = rendered.indexOf('The catalogue line reads');
  expect(explanation).toBeGreaterThan(rendered.indexOf('The browser\'s header names the source'));
  expect(rendered.indexOf('The browser\'s header names the source')).toBeGreaterThan(-1);
  for (const phrase of ['Motor data last changed', 'This browser last looked', "since the app's built-in data of"]) {
    expect(rendered.slice(explanation)).toContain(phrase);
  }
  expect(rendered).not.toContain('whether the bundled catalogue is still fresh');
});

it('J4 r4 introduces recovery weight and sizing before their detailed limits', () => {
  const rendered = html();
  const intro = rendered.indexOf('Under the component properties on the right');
  for (const detail of ['Parachutes on the same trigger', 'Chutes set to <strong>Never</strong> are excluded']) {
    expect(rendered.indexOf(detail), detail).toBeGreaterThan(intro);
  }
});

it('J4 r2 keeps section introductions ahead of new limits and export details', () => {
  const rendered = html();
  for (const [intro, detail] of [
    ['Under the component tree on the Design workspace', 'is limited to 1,000 m'],
    ['An interactive 3D model of the rocket', 'Image and SVG export headers list refused'],
    ["The prescribed delays from the motor's label", 'keeps the existing 60 s limit'],
    ['The two CSV buttons at the top of the picker', 'A nonblank numeric cell must contain'],
  ]) {
    expect(rendered.indexOf(intro), intro).toBeGreaterThan(-1);
    expect(rendered.indexOf(detail), detail).toBeGreaterThan(-1);
    expect(rendered.indexOf(intro), intro).toBeLessThan(rendered.indexOf(detail));
  }
});

it('J4 r3 keeps the measured button antecedent and original section introductions', () => {
  const rendered = html();
  expect(rendered.indexOf('Press it and the app inserts')).toBeLessThan(rendered.indexOf('is limited to 1,000 m'));
  for (const [intro, detail] of [
    ['Solid and structural parts pick', 'The original flat 19 mm'],
    ['You can <strong>import experimental motors</strong>', 'Different maker/name pairs are kept separately'],
    ['The app reads and writes several formats.', 'When a desktop OpenRocket file requests'],
  ]) {
    expect(rendered.indexOf(intro), intro).toBeGreaterThan(-1);
    expect(rendered.indexOf(intro), intro).toBeLessThan(rendered.indexOf(detail));
  }
});

it('round 2 puts the RASAero save-note explanation before the Optimum round-trip detail', () => {
  const rendered = html();
  expect(rendered.indexOf('The save note names that choice and the parts whose finish changes.'))
    .toBeLessThan(rendered.indexOf("The app's Optimum paint"));
});

it('keeps the Mach-Alt import rule inside its anchored glossary entry', () => {
  const entry = html().match(/<p id="glossary-mach-alt-table"[^>]*>(.*?)<\/p>/s)?.[1];
  expect(entry).toContain('each nonblank row must contain exactly two period-decimal numbers');
  expect(entry).toContain('Unreadable or unsupported rows are dropped with a caution');
});

it('keeps flight angle preferences with the existing AoA glossary text', () => {
  const entry = html().match(/<p id="glossary-angle-of-attack-aoa-or"[^>]*>(.*?)<\/p>/s)?.[1];
  expect(entry).toContain('Angle of attack in Flight loads, the flight charts, custom plots and launch-guide-exit report follows');
  expect(entry).toContain('recorded flight data stays in radians');
});
