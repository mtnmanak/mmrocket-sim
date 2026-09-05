import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The backstop on the bundled motor catalogue's age, and the tie between the
 * catalogue and the curve bundle built from it. Runs against the SHIPPED files
 * in `npm test`, so a release cannot go out on a catalogue a season old or on a
 * curve bundle built from a different catalogue.
 *
 * Why two limits live in two places (2026-09-05): `scripts/check-upstream.mjs`
 * FLAGS a catalogue over 30 days old, and it runs before every release — that is
 * the reminder. This test FAILS at 120 days — that is the backstop for when the
 * reminder is skipped. The gap between them is deliberate: a failing test needs
 * the network to clear (`npm run motors:refresh`), and a hotfix pushed from a
 * launch site with no signal must not be blocked by a catalogue that is merely
 * a month old. Before this existed, motors.json sat unrefreshed for 63 days and
 * nothing in the repo said so.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'src', 'data');
const motors = JSON.parse(readFileSync(join(dataDir, 'motors.json'), 'utf8'));
const curves = JSON.parse(readFileSync(join(dataDir, 'motorCurves.json'), 'utf8'));

const MAX_AGE_DAYS = 120;

describe('the bundled motor catalogue', () => {
  it('carries a readable generated date', () => {
    expect(typeof motors.generated).toBe('string');
    expect(Number.isFinite(Date.parse(motors.generated))).toBe(true);
  });

  it(`is less than ${MAX_AGE_DAYS} days old — run \`npm run motors:refresh\` if this fails`, () => {
    const ageDays = (Date.now() - Date.parse(motors.generated)) / 86_400_000;
    expect(ageDays, `motors.json generated ${motors.generated}, ${Math.floor(ageDays)} days ago`)
      .toBeLessThan(MAX_AGE_DAYS);
  });

  it('is the catalogue the curve bundle was built from — never refresh one without the other', () => {
    expect(curves.catalogueGenerated, 'motorCurves.json catalogueGenerated vs motors.json generated')
      .toBe(motors.generated);
  });

  it('has a curve for nearly every motor, and the bundle knows which ones it lacks', () => {
    const ids = new Set(motors.motors.map((m) => m.motorId));
    const withCurve = Object.keys(curves.curves).filter((id) => ids.has(id));
    // 1,075 of 1,155 on 2026-09-05. Below 85 % something went wrong in the fetch.
    expect(withCurve.length / ids.size).toBeGreaterThan(0.85);
    // And no curve is bundled for a motor that is no longer in the catalogue.
    expect(Object.keys(curves.curves).filter((id) => !ids.has(id))).toEqual([]);
  });
});
