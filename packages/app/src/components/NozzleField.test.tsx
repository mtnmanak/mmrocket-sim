// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NozzleField } from './NozzleField.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { nozzleForMotorId } from '../services/nozzleDb.js';
import { addExMotors } from '../services/exMotors.js';

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
  motors?: { motorId: string; count: number }[];
  motorIds?: string[];
  motorLabel?: string | null;
  clearedFor?: { previousLabel: string; previousM: number } | null;
} = {}) => {
  // `motorIds` is kept as a convenience for the single-motor cases: the field
  // takes cluster counts now (the stage's equivalent nozzle sums exit AREAS),
  // and spelling `{ motorId, count: 1 }` out in twenty call sites would bury
  // the two tests where the count is the point.
  const motors = over.motors
    ?? (over.motorIds ?? [D13]).map((motorId) => ({ motorId, count: 1 }));
  act(() => {
    root.render(
      <PrefsProvider>
        <NozzleField
          stageName="Sustainer"
          exitDiameterM={over.exitDiameterM ?? null}
          motors={motors}
          motorLabel={over.motorLabel ?? 'D13-10'}
          clearedFor={over.clearedFor ?? null}
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

describe('NozzleField — its label', () => {
  it('names the typed box, not the unit chip inside it', async () => {
    // Audit 2026-09-22: with no htmlFor the label's control was its first
    // labelable descendant, the unit chip's <select>.
    await render({ exitDiameterM: D13_EXIT_M });
    const label = host.querySelector('label')!;
    expect(label.control).toBe(host.querySelector('input'));
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

describe('NozzleField — a cluster is ONE EQUIVALENT nozzle, areas summed', () => {
  // The defect this pins (2026-09-13). `schema.ts` defines the field as the
  // single equivalent nozzle with the exit AREAS added, and `nozzleCheck.ts`
  // bounds it the same way — but the v0.122 auto-fill wrote ONE motor's
  // diameter in whatever the cluster count, so a four-motor cluster flew a
  // quarter of the exit area it really has, and therefore a quarter of the
  // pressure-thrust term. Four D13s is 2x the diameter of one, not 1x.
  it('fills four identical motors with twice one motor’s diameter', async () => {
    await render({ exitDiameterM: null, motors: [{ motorId: D13, count: 4 }] });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toBeCloseTo(D13_EXIT_M * 2, 9);
  });

  it('sums across two mounts as well as within one', async () => {
    await render({
      exitDiameterM: null,
      motors: [{ motorId: D13, count: 1 }, { motorId: D13, count: 1 }],
    });
    expect(committed[0]).toBeCloseTo(D13_EXIT_M * Math.SQRT2, 9);
  });

  it('says out loud that the number covers more than one motor', async () => {
    await render({ exitDiameterM: D13_EXIT_M * 2, motors: [{ motorId: D13, count: 4 }] });
    expect(text()).toMatch(/Exit areas summed over the 4 motors/);
  });

  it('fills nothing when one motor in the stage has no published figure', async () => {
    // A partial sum is short by exactly what it could not see, and a number
    // quietly too small is worse than a blank field: the blank is visible.
    await render({
      exitDiameterM: null,
      motors: [{ motorId: D13, count: 1 }, { motorId: 'no-such-motor', count: 1 }],
    });
    expect(committed).toEqual([]);
  });
});

describe('NozzleField — whose figure it is', () => {
  // Loki J525-LW: instruction sheet "54mm White 1200.pdf" names nozzle #24,
  // and Loki's own exit table gives 54 mm #24-#28 a 1.000 in exit. Added
  // 2026-09-13; before that the panel credited AeroTech unconditionally, which
  // would have put AeroTech's name on Loki's number.
  const J525 = '5f4294d20002310000000122';
  const J525_EXIT_M = 0.0254;

  it('credits Loki, not AeroTech, for a Loki motor', async () => {
    await render({ exitDiameterM: J525_EXIT_M, motorIds: [J525], motorLabel: 'J525' });
    expect(text()).toMatch(/Loki’s published figure for J525/);
    expect(text()).not.toMatch(/AeroTech/);
    expect(text()).toMatch(/nozzle #24/);
  });

  it('credits Loki in the disagreement notice and its accept button too', async () => {
    await render({ exitDiameterM: 0.04, motorIds: [J525], motorLabel: 'J525' });
    expect(text()).toMatch(/Loki publish/);
    const btn = [...host.querySelectorAll('button')].find((b) => /Use Loki/.test(b.textContent ?? ''));
    expect(btn, 'the accept button names the manufacturer').toBeTruthy();
  });
});

describe('NozzleField — rule 4: a value cleared because the motor changed', () => {
  // Eric, 2026-09-13: "unloading the motor keeps the old exit diameter value —
  // there is no motor loaded, how can there be an exit diameter?" App clears
  // it; the user has to be TOLD, because a number that vanishes silently is
  // the same class of surprise as one that changes silently.
  it('says what the cleared value belonged to when the motor was removed', async () => {
    await render({ exitDiameterM: null, motors: [], clearedFor: { previousLabel: 'K1127', previousM: 0.02286 } });
    expect(text()).toMatch(/Cleared/);
    expect(text()).toMatch(/was for K1127/);
    expect(text()).toMatch(/No motor is loaded/);
  });

  it('says what to do when the new motor simply has no published figure', async () => {
    await render({
      exitDiameterM: null,
      motors: [{ motorId: 'no-such-motor', count: 1 }],
      motorLabel: 'K185W',
      clearedFor: { previousLabel: 'K1127', previousM: 0.02286 },
    });
    expect(text()).toMatch(/No published exit diameter for K185W/);
    expect(committed).toEqual([]);
  });

  it('drops the notice as soon as the field has a value again', async () => {
    await render({
      exitDiameterM: D13_EXIT_M,
      clearedFor: { previousLabel: 'K1127', previousM: 0.02286 },
    });
    expect(text()).not.toMatch(/Cleared/);
  });
});

describe('NozzleField — the manufacturer’s own caution about its own figure', () => {
  // Eric's ruling (b), 2026-09-13, on `issues-2026-09-13b.md`. Loki publish:
  // "76mm nozzle exits up to 2.0" are available upon request for an additional
  // machining fee." So the 1.818 in this database carries is their STANDARD
  // part, and a flyer who asked for a custom exit holds a different one —
  // 21 % more area, on a term worth 5.5 % of apogee on a real tester file.
  const M900 = '5f4294d200023100000002f0';   // Loki, 76 mm, 1.818 in standard
  const M900_EXIT_M = 0.046177;
  const J525 = '5f4294d20002310000000122';   // Loki, 54 mm — NOT 76 mm

  it('tells a 76 mm Loki flyer the exit can be machined out, and by how much', async () => {
    await render({ exitDiameterM: M900_EXIT_M, motorIds: [M900], motorLabel: 'M900' });
    expect(text()).toMatch(/machine a 76 mm exit out to 2\.0 in on request/);
    expect(text()).toMatch(/21 % more exit AREA/);
  });

  it('says it on the row even before the field is filled', async () => {
    // The point of the caution is that the figure may not describe the part in
    // the case, which is as true of the number arriving as of the number sat
    // there. It must not wait for a `matches` state to appear.
    await render({ exitDiameterM: null, motorIds: [M900], motorLabel: 'M900' });
    expect(host.querySelector('[data-nozzle="custom-exit"]')).toBeTruthy();
  });

  it('says NOTHING on a Loki motor that is not 76 mm', async () => {
    // Loki's note names no other size, and a caution about an option you cannot
    // buy is the noise the say-nothing rule exists to prevent.
    await render({ exitDiameterM: 0.0254, motorIds: [J525], motorLabel: 'J525' });
    expect(host.querySelector('[data-nozzle="custom-exit"]')).toBeNull();
  });

  it('says nothing on an AeroTech motor', async () => {
    await render({ exitDiameterM: D13_EXIT_M });
    expect(host.querySelector('[data-nozzle="custom-exit"]')).toBeNull();
  });

  it('says nothing when the stage has no published figure at all', async () => {
    await render({ exitDiameterM: null, motorIds: ['no-such-motor'] });
    expect(host.querySelector('[data-nozzle="custom-exit"]')).toBeNull();
  });

  it('says nothing when the stage cannot be filled, even though a motor in it carries the note', async () => {
    // The case that actually exercises the `published !== null` guard: the
    // M900 HAS a note, but the stage also holds a motor with no figure, so the
    // equivalent nozzle is unknown and the field stays blank. A caution about
    // machining out a number the app is not offering has nothing to qualify.
    await render({
      exitDiameterM: null,
      motors: [{ motorId: M900, count: 1 }, { motorId: 'no-such-motor', count: 1 }],
      motorLabel: 'M900',
    });
    expect(committed).toEqual([]);
    expect(host.querySelector('[data-nozzle="custom-exit"]')).toBeNull();
  });
});

/**
 * An EX motor’s exit comes out of the .rse the USER imported. The panel must
 * never dress that as a manufacturer’s published figure — crediting "Klima’s
 * published figure" for a number somebody typed into their own motor file is
 * exactly the unfollowable provenance the manufacturer line exists to stop
 * (2026-09-21). Before this release an EX motor reached none of these paths at
 * all: it has no `motorId`, so the stage read as having no motor loaded.
 */
describe('NozzleField — a figure that came from an imported motor file', () => {
  const EX_ID = 'ex:klima-b2';
  const EX_EXIT_M = 0.005;

  beforeEach(() => {
    addExMotors([{
      motorId: EX_ID, designation: 'B2', realManufacturer: 'Klima',
      diameter: 18, length: 70, totalWeightG: 17, propWeightG: 6, delays: '0,4',
      samples: [{ time: 0, thrust: 0 }, { time: 2.5, thrust: 0 }],
      exitDiameterM: EX_EXIT_M, source: 'rse', addedAt: 0,
    }]);
  });

  it('fills an empty field from the file — the number the app used to throw away', async () => {
    // Rule 1. The component commits; it does not re-render itself, so the
    // provenance line is asserted in the next test, where the value is in.
    await render({ exitDiameterM: null, motorIds: [EX_ID], motorLabel: 'B2' });
    expect(committed[committed.length - 1]).toBeCloseTo(EX_EXIT_M, 9);
  });

  it('says the file is where it came from, and does NOT credit the manufacturer', async () => {
    await render({ exitDiameterM: EX_EXIT_M, motorIds: [EX_ID], motorLabel: 'B2' });
    expect(text()).toContain('from the motor file you imported');
    expect(text()).not.toMatch(/published figure/);
    expect(text()).not.toMatch(/Klima\u2019s published/);
  });

  it('names the file, not the maker, when your typed value disagrees', async () => {
    await render({ exitDiameterM: 0.009, motorIds: [EX_ID], motorLabel: 'B2' });
    expect(text()).toContain('the motor file you imported says');
    expect(text()).not.toMatch(/Klima publish/);
  });

  it('says nothing for an EX motor whose file carried no exit', async () => {
    addExMotors([{
      motorId: 'ex:no-exit', designation: 'M1234', realManufacturer: 'EX Labs',
      diameter: 75, length: 620, totalWeightG: 4200, propWeightG: 2400, delays: '',
      samples: [{ time: 0, thrust: 0 }, { time: 2, thrust: 0 }],
      source: 'rse', addedAt: 0,
    }]);
    await render({ exitDiameterM: null, motorIds: ['ex:no-exit'], motorLabel: 'M1234' });
    expect(committed).toHaveLength(0);
    expect(text()).not.toMatch(/published figure|motor file you imported/);
  });
});
