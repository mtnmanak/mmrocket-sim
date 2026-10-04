import { expect } from 'vitest';
import type { FreshSimRun } from './simReport.js';

/**
 * A run with its wall-clock and random fields set aside, for comparing two
 * Launches of one design (the headless Launch's tests, 2026-10-01). `id` and
 * `when` come from Date.now()/Math.random() (simReport's buildSimRun), and
 * `execMs` and the delay solve's `elapsedMs` are wall time
 * (autoDelaySolver). EVERYTHING ELSE must match exactly — floats included:
 * same process, same kernel, same inputs. Never compare a run against a
 * hard-coded kernel float (CI's Node 22 and a desktop's Node 24 can differ in
 * the last bits); compare two computed runs, as every caller of this does.
 */
export function comparable(run: FreshSimRun) {
  const { id: _id, when: _when, execMs: _ms, ...rest } = run;
  return {
    ...rest,
    ...(rest.delayResolution ? { delayResolution: { ...rest.delayResolution, elapsedMs: 0 } } : {}),
  };
}

/**
 * `comparable`, less the fields that carry a node id: the design, motor-set,
 * whole-set and per-mount motor-data keys, and each delay row's mount id.
 * Ids are minted per parse (treeModel's freshId, a module-level counter), so
 * two parses of the same bytes number the
 * same parts differently — this is how a run from `simulateFile` (its own
 * parse) is compared with one from another parse of the same file. Every other
 * field must still match exactly. (Moved here from simulateFile.test.ts,
 * 2026-10-01, when the agreement test began calling simulateFile too.)
 */
export function idFree(run: FreshSimRun) {
  expect(typeof run.motorDataKey).toBe('string');
  const {
    designKey: _d, motorSetKey: _m, motorDataKey: _md, motorDataKeys: _mds, delayResolution, ...rest
  } = comparable(run);
  return {
    ...rest,
    delayResolution: delayResolution
      && { ...delayResolution, mounts: delayResolution.mounts.map(({ mountId: _id, ...m }) => m) },
  };
}
