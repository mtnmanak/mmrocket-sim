// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NozzleField } from './NozzleField.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { resetNozzleDbCache } from '../services/nozzleDb.js';

/**
 * THE NOZZLE DATA COULD NOT BE DOWNLOADED (audit 2026-09-30). `nozzles.json` is
 * a lazy chunk of its own (services/nozzleDb.ts), so it can fail where the rest
 * of the page did not: offline before the service worker had cached it, or in a
 * tab older than the deploy that replaced it. The field's lookup had no catch,
 * so the rejection went nowhere — main.tsx's handler paints only into an EMPTY
 * root — and the field waited for an answer that never came: no fill, no
 * disagreement, no provenance line, and nothing to say why.
 *
 * The chunk fails here the way the network fails it, through nozzleDb's own
 * import and with Chrome's words, thrown where nozzleDb reads the module's
 * default export (vitest wraps a factory's own throw in a message of its own;
 * App.lazyDialogs.test.tsx does the same). `data.fail` lets a later look-up
 * succeed. In Chrome that look-up comes only after the reload the note offers:
 * the browser keeps a failed chunk for the life of the page (nozzleDb.ts says
 * what was measured), and this mock re-reads `default` where Chrome would not
 * fetch again. So the recovery case proves that nozzleDb keeps no failure of
 * its OWN, not that a page heals itself once the connection is back.
 */
const data = vi.hoisted(() => ({ fail: true }));
vi.mock('../data/nozzles.json', async (importOriginal) => {
  const real = await importOriginal<{ default: unknown }>();
  return {
    get default(): unknown {
      if (data.fail) {
        throw new TypeError('Failed to fetch dynamically imported module: '
          + 'https://example.test/assets/nozzles-x.js');
      }
      return real.default;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// D13-10W: nozzle 01000-1, exit 0.188 in = 4.775 mm (NozzleField.test.tsx's motor).
const D13 = '5f4294d20002310000000021';
const D13_EXIT_M = 0.004775;

let host: HTMLDivElement;
let root: Root;
let committed: (number | null)[];

// Load the real JSON behind the mock once, before any render, so every look-up
// below settles in a few ticks (NozzleField.test.tsx's beforeAll says why).
// Importing does not read `default`, so nothing fails here.
beforeAll(async () => { await import('../data/nozzles.json'); });

beforeEach(() => {
  // Every case starts with nothing loaded: a map an earlier case loaded would
  // answer this case's look-up without reading `data.fail` at all.
  resetNozzleDbCache();
  data.fail = true;
  committed = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // The field reports the failure on the console for a bug report; keep the run quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (over: {
  exitDiameterM?: number | null;
  motors?: { motorId: string; count: number }[];
  clearedFor?: { previousLabel: string; previousM: number } | null;
} = {}) => {
  act(() => {
    root.render(
      <PrefsProvider>
        <NozzleField
          stageName="Sustainer"
          exitDiameterM={over.exitDiameterM ?? null}
          motors={over.motors ?? [{ motorId: D13, count: 1 }]}
          motorLabel="D13-10"
          clearedFor={over.clearedFor ?? null}
          onCommit={(m) => { committed.push(m); }}
        />
      </PrefsProvider>,
    );
  });
};

/**
 * Poll inside act() against a WALL-CLOCK budget, not a tick count
 * (NozzleField.test.tsx's flush says why a fixed count is a race). Under the
 * test's own 5 s, so a miss names what it was waiting for.
 */
async function waitFor(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

const note = () => host.querySelector('[data-nozzle="unavailable"]');
const text = () => host.textContent ?? '';

describe('NozzleField — the nozzle data could not be loaded', () => {
  it('says so and offers the reload, instead of waiting for a figure that never comes', async () => {
    render({ exitDiameterM: null });
    await waitFor(() => note() !== null, 'the could-not-load note');
    expect(note()!.textContent).toMatch(/nozzle data could not be loaded/);
    expect(note()!.textContent).toMatch(/cannot fill itself in/);
    // Blank is not "automatic" while nothing can fill it: say what blank does.
    expect(note()!.textContent).toMatch(/pressure-thrust term and the power-on base-drag reduction are both off/);
    const reload = [...host.querySelectorAll('button')].find((b) => /Reload the page/.test(b.textContent ?? ''));
    expect(reload, 'the reload button').toBeTruthy();
    expect(committed).toEqual([]);
  });

  // SECOND ON PURPOSE. This is the one case that LOADS the data, and nozzleDb
  // keeps a loaded map for as long as its module lives, which is the whole
  // file. Every case after this one needs the look-up to fail, so they fail in
  // the default order if the map is ever carried from one case to the next —
  // the order dependence a shuffled run found (2026-10-01), when this case ran
  // last and hid it.
  it('fills the field once a later look-up can load the data — nozzleDb keeps no failure of its own', async () => {
    render({ exitDiameterM: null });
    await waitFor(() => note() !== null, 'the could-not-load note');
    data.fail = false;
    // A new loadout looks again (four of the same motor: twice one exit).
    render({ exitDiameterM: null, motors: [{ motorId: D13, count: 4 }] });
    await waitFor(() => committed.length > 0, 'the fill');
    expect(committed[0]).toBeCloseTo(2 * D13_EXIT_M, 9);
    expect(note()).toBeNull();
    expect(text()).not.toMatch(/could not be loaded/);
  });

  it('does not claim the blank switches anything off when the field holds a value', async () => {
    render({ exitDiameterM: 0.0102 });
    await waitFor(() => note() !== null, 'the could-not-load note');
    expect(note()!.textContent).not.toMatch(/both off/);
    // Nor is the value called a disagreement: there is nothing to disagree with.
    expect(host.querySelector('[data-nozzle="disagrees"]')).toBeNull();
  });

  it('says nothing about it on a stage switched off, where nothing is filled or checked', async () => {
    render({ exitDiameterM: 0 });
    // Let the look-up settle: a second render with a value proves it has.
    render({ exitDiameterM: 0.0102 });
    await waitFor(() => note() !== null, 'the look-up to settle');
    render({ exitDiameterM: 0 });
    expect(note()).toBeNull();
    expect(host.querySelector('[data-nozzle="off"]')).not.toBeNull();
  });

  it('does not tell a cleared stage its new motor publishes nothing when the data did not load', async () => {
    // useNozzleFollow clears the previous motor's exit when the new motor's
    // figure cannot be loaded. "No published exit diameter" would then be
    // false: the figure may exist, it could not be looked up.
    render({ exitDiameterM: null, clearedFor: { previousLabel: 'J350W', previousM: 0.012 } });
    await waitFor(() => note() !== null, 'the could-not-load note');
    expect(host.querySelector('[data-nozzle="cleared"]')?.textContent).toMatch(/was for J350W/);
    expect(text()).not.toMatch(/No published exit diameter/);
  });
});
