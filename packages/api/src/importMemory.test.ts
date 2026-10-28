import { describe, expect, it } from 'vitest';
import { classifyRun, smallestOldSpace, type MemoryRun } from '../scripts/import-memory.mjs';

/**
 * The measurement script's bisection, with a stub runner and no child process
 * (audit S1-4). `passesFrom` is the smallest old space that passes; below it a
 * run fails as `below` says. After `limit` calls the stub throws, so a loop that
 * never ends fails the test instead of hanging it.
 */
function stub(passesFrom: number, below: MemoryRun, at?: (mib: number, call: number) => MemoryRun | undefined, limit = 5_000) {
  const calls: number[] = [];
  const run = (_probe: string, _mode: string, _file: string, mib?: number): MemoryRun => {
    calls.push(mib!);
    if (calls.length > limit) throw new Error(`runaway bisection: ${limit} runs`);
    return at?.(mib!, calls.length) ?? (mib! >= passesFrom ? { ok: true, status: 200, kind: 'ok' } : below);
  };
  return { run, calls };
}
const OOM: MemoryRun = { ok: false, status: 'crashed', kind: 'oom' };
const TIMEOUT: MemoryRun = { ok: false, status: 'crashed', kind: 'failed', error: 'timed out after 600 s' };
const REFUSED: MemoryRun = { ok: false, status: 413, kind: 'refused', error: 'XML element limit is 20,000.' };

describe('import-memory bisection', () => {
  it('finds the smallest passing old space when every failure is out of memory', async () => {
    const { run } = stub(37, OOM);
    expect(await smallestOldSpace(run, 'p', 'fly', 'f', 3)).toEqual({ mib: 37, failedAt: 36 });
  });

  it('stops, with the reason, when a run near the boundary fails for another reason', async () => {
    // Every boundary rerun times out: the uncapped loop raised `high` without end.
    const { run, calls } = stub(37, OOM, (mib, call) => (call > 12 && mib >= 37 ? TIMEOUT : undefined));
    expect(await smallestOldSpace(run, 'p', 'fly', 'f', 3)).toEqual({ mib: null, stopped: 'failed: timed out after 600 s' });
    expect(calls.length).toBeLessThan(20);
  });

  it('stops on a refusal: a 413 or 400 is not out of memory', async () => {
    const { run } = stub(37, REFUSED);
    expect(await smallestOldSpace(run, 'p', 'fly', 'f', 3)).toEqual({ mib: null, stopped: 'refused: 413 XML element limit is 20,000.' });
  });

  it('caps the search at 1,024 MiB and reports no passing cap', async () => {
    const { run, calls } = stub(Infinity, OOM);
    expect(await smallestOldSpace(run, 'p', 'fly', 'f', 3)).toEqual({ mib: null, stopped: 'no passing cap up to 1,024 MiB' });
    expect(Math.max(...calls)).toBe(1_024);
  });

  it('caps the boundary reruns too: a pass that never repeats stops at 1,024 MiB', async () => {
    const seen = new Set<number>();
    const { run, calls } = stub(37, OOM, (mib, call) => {
      if (mib < 37) return undefined;
      // One 512 check and nine bisection steps; every boundary rerun after them runs out of memory.
      if (call > 10 || seen.has(mib)) return OOM;
      seen.add(mib);
      return { ok: true, status: 200, kind: 'ok' };
    });
    expect(await smallestOldSpace(run, 'p', 'fly', 'f', 3)).toEqual({ mib: null, stopped: 'no passing cap up to 1,024 MiB' });
    expect(Math.max(...calls)).toBe(1_024);
  });
});

describe('import-memory run classification', () => {
  const line = (json: object) => JSON.stringify(json);
  it.each([
    ['a passing run', { status: 0, signal: null }, line({ ok: true, status: 200 }), 'ok'],
    ['V8\'s fatal heap message', { status: null, signal: 'SIGABRT', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }, undefined, 'oom'],
    ['an abort with no output', { status: null, signal: 'SIGABRT', stderr: '' }, undefined, 'oom'],
    ['a 413 refusal', { status: 0, signal: null }, line({ ok: false, status: 413, error: 'XML element limit is 20,000.' }), 'refused'],
    ['a 400 refusal', { status: 0, signal: null }, line({ ok: false, status: 400, error: 'Not a valid .ork file' }), 'refused'],
    ['a timeout', { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }, undefined, 'failed'],
    ['another crash', { status: 1, signal: null, stderr: 'TypeError: x is not a function' }, undefined, 'failed'],
    ['a 500', { status: 0, signal: null }, line({ ok: false, status: 500, error: 'The design could not be simulated.' }), 'failed'],
  ] as const)('classifies %s', (_label, child, out, kind) => {
    expect(classifyRun(child, out).kind).toBe(kind);
  });
});
