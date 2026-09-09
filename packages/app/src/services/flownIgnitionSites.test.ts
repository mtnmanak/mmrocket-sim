// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, '../App.tsx'), 'utf8');

/**
 * EVERY write of a motor onto a built handle must re-apply that mount's
 * ignition.
 *
 * The bridge's `setMotorById` (`OrkEngine.java` `applyMotor`) installs a fresh
 * `MotorConfiguration` on the mount:
 *
 *     MotorConfiguration mc = new MotorConfiguration(mount, ctx.fcid);
 *     mc.setMotor(motor);
 *     mc.setEjectionDelay(ejectionDelay);
 *     mount.setMotorConfig(mc, ctx.fcid);
 *
 * The ignition EVENT and its timer are not carried across, so a write that
 * does not re-apply them silently returns the mount to the kernel default
 * (AUTOMATIC). `buildResult`'s three writes have always re-applied and say so;
 * the three re-flight paths did not, from v0.119 until the 2026-09-08 audit.
 *
 * What that cost, and why it is worth a test rather than a comment:
 * `assignMotor` gives a high-power sustainer on a staged design
 * `{ event: 'burnout', delay: 1 }` automatically, and `primaryMountId` IS that
 * mount. So on exactly the designs the ignition override exists for, ticking
 * "auto (optimal)" re-flew the rocket lighting off the BOOSTER's ejection
 * charge — and `buildSimRun` stores the re-flown result, the report shows it,
 * and it is written into the `.ork` `<flightdata>` where desktop OpenRocket
 * renders it indistinguishably from a fresh result. The charts path re-flew
 * the same way beneath a comment promising it "reproduces this exact flight".
 *
 * This is an ABSENCE — a new `built.rocket.setMotorById(` anywhere would break
 * no other test in the suite and would quietly restore the bug — which is the
 * one case the source-text guard in `savedMarkSites.test.ts` argues for.
 */
describe('a motor written onto a built handle keeps its ignition', () => {
  it('no re-flight path calls setMotorById on the built handle directly', () => {
    // `buildResult` owns a local `rocket`; every path outside it reaches the
    // handle as `built.rocket`. That distinction is what makes this greppable.
    const direct = app().match(/built\.rocket\.setMotorById\(/g) ?? [];
    expect(
      direct.length,
      'a re-flight path writes a motor without re-applying ignition — route it '
      + 'through setFlownMotorOn, or the flight that gets STORED is not the '
      + 'flight the design describes',
    ).toBe(0);
  });

  it('the helper exists and re-applies ignition on the same condition as the build', () => {
    const src = app();
    const at = src.indexOf('const setFlownMotorOn');
    expect(at, 'the helper every re-flight path routes through is gone').toBeGreaterThan(-1);
    // Deliberately NOT pinned to the declaration's exact text — whether it is
    // a plain closure or a useCallback is a dependency-array question, not a
    // correctness one, and this test failed on that difference once already.
    // What must hold is the BODY: setMotorById followed by the same guard
    // `applyAssignedMotors` uses, so an AUTOMATIC mount is left exactly as the
    // kernel configured it rather than re-stated in different words.
    const body = src.slice(at, src.indexOf('\n  }', at));
    expect(body).toContain('rocket.setMotorById(id, spec);');
    expect(body).toContain("mm.ignition.event !== 'automatic' || mm.ignition.delay !== 0");
    expect(body).toContain('rocket.setMotorIgnitionById(id, mm.ignition.event, mm.ignition.delay);');
  });

  it('every re-flight site routes through the helper', () => {
    const calls = app().match(/setFlownMotorOn\(built\.rocket, /g) ?? [];
    // Five: the auto-delay re-fly, the charts re-fly and its restore, and the
    // full-series CSV re-fly and its restore. A restore counts — it is a write
    // like any other, and it was resetting ignition too.
    expect(calls.length, 'a re-flight site was added or removed — is its ignition kept?')
      .toBe(5);
  });
});
