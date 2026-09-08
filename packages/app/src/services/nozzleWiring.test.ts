import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, '../App.tsx'), 'utf8');

/**
 * The two places App has to spend the nozzle exit diameter (2026-09-08), both
 * of which are absences that no other test in the suite can see.
 *
 * The check and the sentence are pure and tested in nozzleCheck.test.ts; the
 * report line is pure and tested in simReport.test.ts. What neither can prove
 * is that App still CALLS them — delete either call and every one of those
 * tests still passes while the user sees nothing. The pattern (and the
 * reasoning) is savedMarkSites.test.ts's.
 */
describe('App surfaces the nozzle plausibility warning', () => {
  it('runs the check against the design and the motors actually loaded', () => {
    expect(app()).toContain('for (const w of nozzleOversize(tree, assigned)) {');
  });

  it('renders it through the notice channel, keyed per stage, as a warning', () => {
    const src = app();
    const start = src.indexOf('id: `nozzle-oversize:');
    expect(start, 'the notice entry is gone').toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).toContain('id: `nozzle-oversize:${w.stageId}`');
    expect(block).toContain("severity: 'warn'");
    expect(block).toContain('text: nozzleOversizeText(w, (m) =>');
  });

  /**
   * NOT dismissible, for the reason a build error is not: it is a standing
   * fact about the design on screen, so a x would be a button that does
   * nothing — the warning comes straight back on the next render.
   */
  it('offers no dismiss on it', () => {
    const src = app();
    const start = src.indexOf('id: `nozzle-oversize:');
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).not.toContain('onDismiss');
  });

  it('re-runs when the design, the motors or the length unit change', () => {
    // The memo would otherwise hold a warning about a nozzle that has been
    // corrected, or print millimetres to someone who has switched to inches.
    expect(app()).toContain('tree, assigned, prefs.units.length]);');
  });
});

describe('App tells the launch report which stages flew a nozzle', () => {
  /**
   * MOTORISED, not merely nozzle-bearing (2026-09-08, review). The kernel's
   * own gate is `getThrust(t) > 0`, so a stage the flown configuration left
   * empty — a two-stage RASAero import whose booster motor is not in the
   * database is the common shape — bought exactly nothing, and the report
   * must not name it as corrected.
   */
  it('passes the names of the stages that flew a MOTOR into buildSimRun', () => {
    expect(app()).toContain('nozzleStages: motorisedStagesWithNozzle(tree, assigned).map((s) => s.name),');
  });

  /**
   * Names only. Whether the term was LIVE is decided inside the report from
   * the two model stamps, which are the kernel's own gate — App must not
   * second-guess it here, or the two answers can disagree.
   */
  it('does not gate the names on the aero model itself', () => {
    const src = app();
    const i = src.indexOf('nozzleStages: motorisedStagesWithNozzle(tree');
    const line = src.slice(i, src.indexOf('\n', i));
    expect(line).not.toContain('effectiveKbf');
    expect(line).not.toContain('usedSupersonic');
  });
});

/**
 * THE STORED-RUN GUARD (2026-09-08, review). `designKey`, `motorSetKey` and
 * `conditionsKey` all hash app-side state, so none of them can see a KERNEL
 * change: a run of a nozzle-bearing design flown before v0.119 certified as
 * "matches the design as it stands" while the new kernel re-flies it up to
 * +29.7 % higher, and an .ork export wrote its stale apogee as that
 * configuration's authoritative result. The predicate is pure and tested in
 * simReport.test.ts; what only this file can see is that App still FEEDS it.
 */
describe('App feeds the pressure-thrust provenance stamp', () => {
  it('tells both match keys whether the design spends the term', () => {
    // currentMatchKey (Show charts) and provenanceKey (the staleness banner).
    const src = app();
    const hits = src.split('hasNozzle: motorisedStagesWithNozzle(tree, assigned).length > 0,').length - 1;
    expect(hits).toBe(2);
  });

  it('refuses an unstamped run in the .ork <flightdata> export too', () => {
    expect(app()).toContain(
      'if (!runCarriesNozzleStamp(r, { hasNozzle, aeroMode, effectiveKbf, autoSupersonic })) continue;');
  });
});
