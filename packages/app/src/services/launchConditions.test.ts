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
   * React-free as well since the `useOnline` hook left services/net.ts for
   * hooks/useOnline.ts. Each of these reaches net.ts, through thrustcurve.ts or
   * openMeteo.ts, so with the hook beside the network helpers they still loaded
   * the `react` package (though no component) after the Launch panel stopped
   * being their way in. net.ts and its two importers are listed themselves, so
   * a failure names the module that brought React back.
   */
  it.each<[string, () => Promise<unknown>]>([
    ['net', () => import('./net.js')],
    ['thrustcurve', () => import('./thrustcurve.js')],
    ['openMeteo', () => import('./openMeteo.js')],
    ['batchSweep', () => import('./batchSweep.js')],
    ['importApply', () => import('./importApply.js')],
    ['weatherProposal', () => import('./weatherProposal.js')],
    ['rocksimFile', () => import('./rocksimFile.js')],
    ['motorMatch', () => import('./motorMatch.js')],
  ])('%s', async (_, load) => {
    await load();
    expect(loaded).toEqual([]);
  });

  /**
   * THE HEADLESS LAUNCH (2026-10-01): the path the Launch button flies, taken
   * out of App so a script, a test or a later API can fly a design or a file
   * with no React mounted. Each module on that path is listed, so the one that
   * brings React back is the one named — the preferences and the aero choice
   * moved out of prefs/PrefsContext.tsx for exactly this.
   */
  it.each<[string, () => Promise<unknown>]>([
    ['prefs/preferences', () => import('../prefs/preferences.js')],
    ['prefs/aeroChoice', () => import('../prefs/aeroChoice.js')],
    ['unitText', () => import('./unitText.js')],
    ['designDerivation', () => import('./designDerivation.js')],
    ['sessionRestore', () => import('./sessionRestore.js')],
    ['padMassReconcile', () => import('./padMassReconcile.js')],
    ['buildDesign', () => import('./buildDesign.js')],
    ['flightRunner', () => import('./flightRunner.js')],
  ])('%s', async (_, load) => {
    await load();
    expect(loaded).toEqual([]);
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
