import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Keep these public claims consistent with the Worker's summary and flight options.
// Runtime route tests cover the behavior; these catch stale prose surviving a rewrite.
const readme = readFileSync(new URL('../../api/README.md', import.meta.url), 'utf8');

it('describes recorded ignition and its no-events fallback rather than installed motors', () => {
  expect(readme).not.toContain('installed motors with counts');
  expect(readme).not.toContain('The motor list uses post-projection ignition');
  expect(readme).toMatch(/recorded `IGNITION` event/);
  expect(readme).toContain('If no mount has recorded ignition');
  expect(readme).toContain('knownUnlitIgnition');
});

it('does not claim the Worker runs Mach probes', () => {
  expect(readme).not.toContain('including auto-delay and Mach probes');
  expect(readme).toContain('The Worker runs no Mach probes.');
});

it('discloses the summary-series recovery-opening ground-speed fallback', () => {
  expect(readme).toMatch(/Summary series omit local sound speed \(`Vs`\)[^.]*ground-speed fallback/);
  expect(readme).toContain('wind drift can therefore affect that opening advice');
});
