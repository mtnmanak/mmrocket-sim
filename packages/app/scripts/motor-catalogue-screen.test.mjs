import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { screenEntry } from '../src/services/catalogueOverlay.ts';

/**
 * The SHIPPED motor catalogue through the app's OWN plausibility screen — the one
 * "Check thrustcurve.org" applies to every live row it would add or change.
 *
 * Runs in `npm test`, so it gates the deploy AND the weekly catalogue refresh
 * (.github/workflows/motors-refresh.yml gates its pull request on `npm test`),
 * the way preset-density.test.mjs gates presets.json: a regeneration that brings
 * in an impossible row fails here instead of reaching a user.
 *
 * WHY IT EXISTS (board Tier 1 row 6, 2026-10-01). The screen was only ever
 * applied to LIVE rows, deliberately, and the catalogue it was compared against
 * shipped two rows it refuses: Contrail J234-BG at 9,122 mm long — a hybrid nine
 * metres long, whose centre of gravity the app put 4.56 m from its front — and
 * Cesaroni 25E75-17A with 104 g of propellant in a 52 g motor. Both are
 * thrustcurve.org's own figures, unchanged there since 2019, and both are now
 * corrected from the manufacturer's and the certifying body's published data
 * (scripts/motor-corrections.mjs). A row that fails here is fixed the same way —
 * a sourced entry in that table — or not at all: never by loosening the screen.
 */
const here = dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(readFileSync(join(here, '..', 'src', 'data', 'motors.json'), 'utf8'));

describe('the shipped motor catalogue', () => {
  it('passes the plausibility screen the live check applies, every row of it', () => {
    const refused = catalogue.motors
      .map((m) => [m, screenEntry(m)])
      .filter(([, reason]) => reason)
      .map(([m, reason]) => `${m.manufacturerAbbrev} ${m.designation} (${m.motorId}): ${reason}`);
    expect(refused, `rows the app's own screen refuses:\n${refused.join('\n')}`).toEqual([]);
  });

  it('is the whole catalogue, so a pass is not an empty file passing', () => {
    expect(catalogue.motors.length).toBe(catalogue.count);
    expect(catalogue.motors.length).toBeGreaterThan(1000);
  });
});
