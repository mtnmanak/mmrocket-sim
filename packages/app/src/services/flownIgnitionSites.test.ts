// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const batch = () => readFileSync(join(here, '../components/BatchSimulate.tsx'), 'utf8');

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
 * (AUTOMATIC).
 *
 * APP.TSX IS NO LONGER CHECKED HERE. Its three flight paths moved into
 * services/flightRunner.ts (audit 2026-09-22, extraction #1), and
 * flightRunner.test.ts FLIES them — against a handle that records every write,
 * and on the real kernel — instead of counting call sites in App's source. The
 * count stayed green while "Show charts" re-flew a stored run at the wrong
 * delay: it could see that a write happened, never what it wrote.
 *
 * What remains is Batch, which builds its own handles and has not been
 * extracted yet; replace these with a behavioural test when it is
 * (docs/AUDIT.md, `services/batchSweep.ts`).
 */
describe('a motor written onto a built handle keeps its ignition', () => {
  /**
   * The same bug survived in Batch until 2026-09-21: the dialog builds its own
   * handles (`OrkRocket.buildTree`), so nothing it does is a `built.rocket.`
   * write and the App guard never saw it. `applyOthers` wrote every non-target
   * mount's motor with no restore, so an imported single-stage design carrying
   * a `never` or delayed mount fired that motor through the whole sweep while
   * the Launch button honoured it.
   */
  it('Batch restores ignition after writing the other mounts motors', () => {
    const src = batch();
    const at = src.indexOf('const applyOthers');
    expect(at, 'applyOthers is gone — where do the non-target mounts get their motors now?')
      .toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n    };', at));
    expect(body).toContain('r.setMotorById(id, spec);');
    expect(body).toContain("ig.event !== 'automatic' || ig.delay !== 0");
    expect(body).toContain('r.setMotorIgnitionById(id, ig.event, ig.delay);');
  });

  it('no other site in Batch writes a motor without restoring ignition', () => {
    // Every per-candidate write below applyOthers targets the mount being
    // SWEPT, which carries the candidate and not a design ignition. If one
    // ever writes a NON-target mount it belongs in applyOthers instead.
    const src = batch();
    const writes = src.match(/\.setMotorById\(/g) ?? [];
    expect(writes.length,
      'a setMotorById was added to BatchSimulate — if it writes a mount the '
      + 'design configured, its ignition has to go back too')
      .toBe(5);
  });
});
