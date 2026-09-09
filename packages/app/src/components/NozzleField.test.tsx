// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NozzleField } from './NozzleField.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { nozzleForMotorId } from '../services/nozzleDb.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// D13-10W: nozzle 01000-1, exit 0.188 in = 4.775 mm. A real row from the
// shipped database, so the test moves if the data does.
const D13 = '5f4294d20002310000000021';
const D13_EXIT_M = 0.004775;
// I115W-M — one of the nine motors AeroTech publish two nozzles for.
const I115 = '5f4294d200023100000001e7';

let host: HTMLDivElement;
let root: Root;
let committed: (number | null)[];

/**
 * Warm the module cache ONCE, before any test renders.
 *
 * The lookup is a dynamic `import()` of a 237 kB JSON module. With the cache
 * cold, every render raced that import, and the negative cases — which are
 * waiting for something that never arrives — could only be settled by a
 * timeout. The first version of this file counted 50 `setTimeout(0)` ticks,
 * which was ample here and not on a CI runner: it failed the v0.122 deploy.
 * Warmed, the component's own lookup resolves on a microtask, so a fixed flush
 * is deterministic for the positive AND the negative cases alike.
 *
 * The cache is deliberately NOT reset between tests: it holds the parsed
 * shipped database, which is exactly what production shares too.
 */
beforeAll(async () => { await nozzleForMotorId(D13); });

beforeEach(() => {
  committed = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/**
 * The lookup is a dynamic `import()` of a 237 kB JSON module, so it settles on
 * a real task rather than a microtask — two `Promise.resolve()`s are not
 * enough, and a fixed count is a race whatever the number. Poll instead, inside
 * act(), until the component has rendered the result.
 */
/**
 * The lookup is a dynamic `import()` of a 237 kB JSON module, so it settles on a
 * real task rather than a microtask. Poll inside act() until the component has
 * rendered the result, against a WALL-CLOCK budget rather than a fixed number of
 * ticks: the first version counted 50 `setTimeout(0)`s, which was ample on this
 * machine and not on a CI runner, and it failed the v0.122 deploy. A test whose
 * pass depends on how fast the box is is not a test.
 */
const flush = async () => {
  // Enough ticks for: the lookup's already-resolved promise, the setState it
  // makes, the fill effect that setState triggers, and its own commit.
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

const render = async (over: {
  exitDiameterM?: number | null;
  motorIds?: string[];
  motorLabel?: string | null;
} = {}) => {
  act(() => {
    root.render(
      <PrefsProvider>
        <NozzleField
          stageName="Sustainer"
          exitDiameterM={over.exitDiameterM ?? null}
          motorIds={over.motorIds ?? [D13]}
          motorLabel={over.motorLabel ?? 'D13-10'}
          onCommit={(m) => { committed.push(m); }}
        />
      </PrefsProvider>,
    );
  });
  await flush();
};

const text = () => host.textContent ?? '';

describe('NozzleField — rule 1: an empty field fills itself in', () => {
  it('commits the published figure when the field is empty', async () => {
    await render({ exitDiameterM: null });
    expect(committed).toEqual([D13_EXIT_M]);
  });

  it('says where the number came from once it is there', async () => {
    await render({ exitDiameterM: D13_EXIT_M });
    // The provenance requirement in Eric's own words was "automatic WITH
    // provenance" — a filled field the user cannot trace is worse than an
    // empty one, because it looks like their own input.
    expect(text()).toMatch(/AeroTech’s published figure for D13-10/);
    expect(text()).toMatch(/nozzle 01000-1/);
    expect(text()).toMatch(/Source:.*Assembly\.pdf/);
  });

  it('does not fill, or say anything, when the motor has no published nozzle', async () => {
    await render({ exitDiameterM: null, motorIds: ['no-such-motor'] });
    expect(committed).toEqual([]);
    // Silence, not "no figure available": Loki and Cesaroni publish none, and a
    // line reporting an absence on every non-AeroTech motor is one users learn
    // to skip past.
    expect(text()).not.toMatch(/AeroTech/);
  });

  it('does not fill when no motor is mounted at all', async () => {
    await render({ exitDiameterM: null, motorIds: [] });
    expect(committed).toEqual([]);
  });
});

describe('NozzleField — rule 2: a value that disagrees is NOT overwritten', () => {
  // The N1000W case, which is where the database earns its keep: a tester's
  // RASAero file gave that motor a 2.737 in exit where AeroTech's drawing says
  // 1.750 — 2.4x the area, and most of why the file over-predicted by ~60 %.
  const WRONG = 0.0102; // 10.2 mm against the published 4.775

  it('keeps the design’s own value and commits nothing', async () => {
    await render({ exitDiameterM: WRONG });
    expect(committed).toEqual([]);
  });

  it('shows both numbers and says which is which', async () => {
    await render({ exitDiameterM: WRONG });
    expect(text()).toMatch(/This design says/);
    expect(text()).toMatch(/AeroTech publish/);
    expect(text()).toMatch(/Yours is kept/);
  });

  it('offers a one-click accept that commits the published figure', async () => {
    await render({ exitDiameterM: WRONG });
    const btn = [...host.querySelectorAll('button')]
      .find((b) => /Use AeroTech/.test(b.textContent ?? ''));
    expect(btn, 'the accept button').toBeTruthy();
    act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(committed).toEqual([D13_EXIT_M]);
  });

  it('treats a display round-trip as agreement, not disagreement', async () => {
    // 0.05 mm of slack: finer than any drawing states, coarse enough that a
    // value that went out to the box in mm and came back does not read as a
    // conflict with itself.
    await render({ exitDiameterM: D13_EXIT_M + 0.00002 });
    expect(text()).not.toMatch(/This design says/);
    expect(text()).toMatch(/published figure/);
    expect(committed).toEqual([]);
  });
});

describe('NozzleField — rule 3: the nine motors with two published nozzles', () => {
  it('names the alternative rather than choosing silently', async () => {
    await render({ exitDiameterM: null, motorIds: [I115], motorLabel: 'I115W' });
    // Eric's §6(b) ruling: default to the current motor, and note that other
    // versions exist. The default is picked from AeroTech's own dated revision
    // block; this is the note.
    expect(text()).toMatch(/two nozzles/i);
    expect(text()).toMatch(/check which nozzle is in your reload kit/i);
  });
});
