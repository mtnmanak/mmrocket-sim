// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Batch's flying moved out of its dialog into services/batchSweep.ts (audit 2026-09-22).
const batch = () => readFileSync(join(here, './batchSweep.ts'), 'utf8');

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
    const body = src.slice(at, src.indexOf('\n  };', at));
    // Through the design page's own write since the seam review of audit
    // 2026-09-22 — the ignition restore AND the refusal of an event the kernel
    // does not know, which a hand-kept copy here had lost (the row-283 gap).
    // batchSweep.test.ts flies both.
    expect(body).toContain('writeMountMotor(r, id, spec, assignedIgnitions[id]');
    expect(body).not.toContain('.setMotorById(');
  });

  it('no other site in Batch writes a motor without restoring ignition', () => {
    // Since the per-mount Auto solver (v0.144) Batch flies every candidate
    // through flightRunner.flyLaunch — the Launch button's own procedure — and
    // writes the other mounts through writeMountMotor in applyOthers. Both put
    // the ignition back. Batch itself therefore holds NO raw setMotorById: one
    // added here would bypass that restore.
    const src = batch();
    expect(src.match(/\.setMotorById\(/g) ?? [],
      'a raw setMotorById was added to the batch sweep — write through '
      + 'writeMountMotor (or fly through flyLaunch) so the ignition goes back too')
      .toEqual([]);
    expect(src, 'Batch no longer flies through flyLaunch — where do its motors get written now?')
      .toContain('await flyLaunch(');
  });

  it('the shared runner writes motors only through writeMountMotor', () => {
    // flyLaunch is now Batch's writer too, so its one raw write must be the
    // restore-carrying writeMountMotor body.
    const src = readFileSync(join(here, './flightRunner.ts'), 'utf8');
    const raw = src.match(/\.setMotorById\(/g) ?? [];
    expect(raw.length, 'a second raw setMotorById in flightRunner bypasses the ignition restore').toBe(1);
    const writer = src.slice(src.indexOf('export function writeMountMotor('));
    expect(writer.slice(0, writer.indexOf('\n}\n'))).toContain('rocket.setMotorById(id, spec);');
  });
});
