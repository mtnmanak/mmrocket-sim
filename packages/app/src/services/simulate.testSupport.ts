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
