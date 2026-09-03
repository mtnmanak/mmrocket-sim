import { describe, expect, it } from 'vitest';
import { APP_VERSION, CHANGELOG } from './version.js';
import versionJson from '../../../version.json';

/**
 * The changelog is the user-facing record of what a refresh gives them, and it
 * has now missed its own release TWICE: v0.091's entry described one change out
 * of ten commits, and v0.095 + v0.096 shipped with no entry at all (found
 * 2026-09-03 — the in-app What's New stopped at v0.094 while the app read
 * 0.096, and the two silent releases included the parachute-Cd fix that moves
 * users' descent rates). The deploy gate runs `npm test`, so this is the guard.
 */
describe('APP_VERSION / CHANGELOG / version.json pairing', () => {
  it('the newest changelog entry IS the shipped version', () => {
    expect(CHANGELOG[0]?.version).toBe(APP_VERSION);
  });

  it('version.json agrees (the deploy workflow checks this too; here it fails in milliseconds)', () => {
    expect((versionJson as { version: string }).version).toBe(APP_VERSION);
  });

  it('entries run strictly downward with no duplicates', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const newer = Number(CHANGELOG[i - 1]!.version);
      const older = Number(CHANGELOG[i]!.version);
      expect(older, `${CHANGELOG[i]!.version} listed after ${CHANGELOG[i - 1]!.version}`).toBeLessThan(newer);
    }
  });

  it('every entry carries a date, a title and at least one item', () => {
    for (const e of CHANGELOG) {
      expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.length, e.version).toBeGreaterThan(0);
      expect(e.items.length, e.version).toBeGreaterThan(0);
    }
  });
});
