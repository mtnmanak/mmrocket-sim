import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The launch conditions are domain logic, and loading them loads no React
 * (audit 2026-09-30, Step 8 item 22).
 *
 * They lived in components/LaunchPanel.tsx, so every service that read one
 * value from them — the .ork and .CDX1 readers, the flight report, the batch
 * runner, the import planner — loaded React, PrefsContext, NumField,
 * WeatherStrip, GustEstimate and WindProfile at runtime as well, and the node
 * corpus sweep (packages/app/scripts/matcher-sweep.worker.mjs) transpiled TSX
 * with a React JSX emit just to open a file.
 *
 * HOW IT IS MEASURED. Each test imports one module into a fresh registry with
 * every React entry point mocked by a recorder that passes the real module
 * through, then reads what was recorded. Both JSX runtimes are listed because a
 * compiled .tsx with no hook in it imports only one of them (Icon.tsx loads
 * `react/jsx-dev-runtime` alone: vitest compiles JSX in development mode). The
 * mocks are registered again before every test: vitest keeps a mocked module's
 * factory result across `vi.resetModules()`, so registered once, only the first
 * test in the file would ever see React load and every later one would pass
 * whatever it imported (probed). The control test is what proves the recorder
 * still sees React.
 */
const REACT = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'];
const loaded: string[] = [];

beforeEach(() => {
  vi.resetModules();
  for (const id of REACT) {
    vi.doUnmock(id);
    vi.doMock(id, async (importOriginal) => {
      loaded.push(id);
      return await importOriginal();
    });
  }
  loaded.length = 0;
});

describe('the launch conditions load no React', () => {
  it('records React when a module does load it (the control)', async () => {
    await import('../components/LaunchPanel.js');
    expect(loaded).toContain('react');
    expect(loaded.some((id) => id.includes('jsx'))).toBe(true);
  });

  /**
   * React-free outright: the module itself; the services whose only way to
   * React was the Launch panel (the .ork and .CDX1 readers and the flight
   * report value-imported it; dirtyState, recoverySizing and session imported
   * only its type, and reached it through simReport); weatherSnapshot, the
   * fourth type-only importer, which never did; and the corpus sweep's other
   * modules.
   */
  it.each<[string, () => Promise<unknown>]>([
    ['launchConditions', () => import('./launchConditions.js')],
    ['orkFile', () => import('./orkFile.js')],
    ['rasaeroFile', () => import('./rasaeroFile.js')],
    ['simReport', () => import('./simReport.js')],
    ['dirtyState', () => import('./dirtyState.js')],
    ['recoverySizing', () => import('./recoverySizing.js')],
    ['session', () => import('./session.js')],
    ['weatherSnapshot', () => import('./weatherSnapshot.js')],
    ['motorDb', () => import('./motorDb.js')],
    ['zipMember', () => import('./zipMember.js')],
    ['xmlUtil', () => import('./xmlUtil.js')],
  ])('%s', async (_, load) => {
    await load();
    expect(loaded).toEqual([]);
  });

  /**
   * No component, though React itself still arrives: each of these reaches
   * services/net.ts (through thrustcurve.ts or openMeteo.ts), whose `useOnline`
   * hook sits beside the network helpers — a hook, not a component, and not the
   * Launch panel's doing. What must not come back is a component module: the
   * corpus sweep's loader refuses a .tsx from the working tree, and loads the
   * `react` package as it would any package.
   */
  it.each<[string, () => Promise<unknown>]>([
    ['batchSweep', () => import('./batchSweep.js')],
    ['importApply', () => import('./importApply.js')],
    ['weatherProposal', () => import('./weatherProposal.js')],
    ['rocksimFile', () => import('./rocksimFile.js')],
    ['motorMatch', () => import('./motorMatch.js')],
  ])('%s loads no React component', async (_, load) => {
    await load();
    expect(loaded.filter((id) => id !== 'react')).toEqual([]);
  });
});

/**
 * Re-exported, never copied: a second `kernelSimOptions` would be a second
 * chokepoint, and the Launch button and the batch runner would fly whichever
 * copy their import named. Every importer that still names the panel gets the
 * module's own bindings.
 */
it('LaunchPanel re-exports every binding of the module', async () => {
  const conditions = await import('./launchConditions.js');
  const panel = (await import('../components/LaunchPanel.js')) as Record<string, unknown>;
  for (const [name, value] of Object.entries(conditions)) expect(panel[name], name).toBe(value);
});
