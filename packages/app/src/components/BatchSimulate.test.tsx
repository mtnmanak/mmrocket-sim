// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { splitClusterTree } from '../tree/treeModel.js';
import { MOTOR_DB, filterMotors, sortMotors } from '../services/motorDb.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import {
  BatchSimulate, batchFlownSpec, batchProbeCutoff, batchSummary, batchUnavailableReason, candidateIdentity,
  isWeighedCandidate, mixedComboCount, type BatchMountOption, type BatchWeighed,
} from './BatchSimulate.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A motor that burns for `burn` seconds and carries a 5 s ejection delay. */
const motor = (burn: number): MotorSpec => ({
  designation: `X${burn}`, diameter: 0.024, length: 0.07,
  times: [0, burn / 2, burn], thrusts: [0, 100, 0], masses: [0.1, 0.05, 0.02],
  cgX: 0.035, ejectionDelay: 5,
});

/** Single-stage design with a 4-ring cluster mount — the combo-mode shape. */
const TREE: RocketTree = {
  name: 'Cluster bird',
  components: [{
    type: 'stage', id: 'st0', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'bt', length: 0.6,
      children: [{ type: 'innertube', id: 'mount', cluster: '4-ring', length: 0.07 }],
    }],
  }],
};

describe('batchProbeCutoff', () => {
  // The combination passes fly a SPLIT tree whose group mounts carry freshly
  // minted ids. Resolved against the ORIGINAL tree those ids read as
  // off-stage (chained ignition), so every combo probe ran to the full chain
  // bound — a near-full extra flight per combination, on exactly the cluster
  // designs combo mode serves.
  it("keeps a combo candidate's probe short — burn plus margin, not the chain sum", () => {
    const split = splitClusterTree(TREE, 'mount')!;
    const targets = Object.fromEntries(split.mountIds.map((id) => [id, motor(9)]));
    // Both group mounts sit on the split tree's only (= launch) stage, so
    // both fire off the clock: 9 s burn + 3 s margin. Read as chained, the
    // bound would be 2·(9 burn + 5 ejection) = 28 → a 40 s probe.
    expect(batchProbeCutoff(split.tree, {}, targets)).toBe(12);
  });

  it("drops the replaced cluster mount's motor — the split tree does not fly it", () => {
    const split = splitClusterTree(TREE, 'mount')!;
    const targets = Object.fromEntries(split.mountIds.map((id) => [id, motor(9)]));
    // The original mount keeps its assigned motor in `assignedMotors`, but
    // the split tree never flies it. Leaked into the probe set it reads as a
    // chained 30 s burn on an id the split tree cannot place — a 96 s probe.
    expect(batchProbeCutoff(split.tree, { mount: motor(30) }, targets, 'mount')).toBe(12);
  });

  it('still waits out the whole stack for a single candidate on a staged design', () => {
    const staged: RocketTree = {
      components: [
        { type: 'stage', id: 'su', children: [{ type: 'innertube', id: 'upper' }] },
        { type: 'stage', id: 'bo', children: [{ type: 'innertube', id: 'lower' }] },
      ],
    };
    // Candidate in the sustainer, booster assigned: the sustainer chains off
    // the booster's ejection charge, so the probe must cover both burns and
    // both delays — (4+5) + (3+5) = 17, upper done by 20, +3 s margin.
    expect(batchProbeCutoff(staged, { lower: motor(4) }, { upper: motor(3) })).toBe(23);
  });
});

describe('mixedComboCount', () => {
  // The one definition of "how many mixed rows a split adds" — it must agree
  // with what the comboAssignments odometer in start() actually yields:
  // multisets of group assignments minus the all-same ones.
  it('matches a brute-force multiset enumeration for both split shapes', () => {
    const brute = (n: number, groups: number): number => {
      let count = 0;
      const walk = (depth: number, min: number, allSame: boolean, first: number) => {
        if (depth === groups) { if (!allSame) count++; return; }
        for (let v = min; v < n; v++) {
          walk(depth + 1, v, depth === 0 ? true : allSame && v === first, depth === 0 ? v : first);
        }
      };
      walk(0, 0, true, -1);
      return count;
    };
    for (const n of [1, 2, 3, 5, 8]) {
      expect(mixedComboCount(n, 2)).toBe(brute(n, 2));
      expect(mixedComboCount(n, 3)).toBe(brute(n, 3));
    }
  });
});

/**
 * v0.118: the weighed pad mass is carried on the ONE motor it was weighed
 * with. The batch has to recognise that motor among its candidates by the
 * same identity App's records use — EX library id when pinned, else
 * manufacturer/designation — and shift only that row, on that mount.
 */
describe('the weighed motor in a batch', () => {
  const catalogue = { motorId: '5f4294d20002310000000031', manufacturerAbbrev: 'AeroTech', designation: 'E18W' };
  const ex = { motorId: 'ex:e18w-1', manufacturerAbbrev: 'EX', designation: 'E18W' };
  const weighed: BatchWeighed = {
    mountId: 'mount', identity: 'AeroTech/E18W', pinned: false, name: 'E18W',
    perMotorShiftKg: 0.0455, deltaKg: 0.182,
  };

  it('candidateIdentity spells an EX entry by its ex: id and a catalogue entry manufacturer/designation', () => {
    expect(candidateIdentity(ex)).toBe('ex:e18w-1');
    expect(candidateIdentity(catalogue)).toBe('AeroTech/E18W');
  });

  it('isWeighedCandidate matches an unpinned EX record by EX/designation and a pinned one only by its ex: id', () => {
    // A record from before exMotorId existed, or a quick-pick reuse, spells
    // an EX motor 'EX/<designation>' — the EX candidate must still match it.
    const unpinned: BatchWeighed = { ...weighed, identity: 'EX/E18W', pinned: false };
    expect(isWeighedCandidate(ex, unpinned)).toBe(true);
    expect(isWeighedCandidate(catalogue, unpinned)).toBe(false);
    // Pinned to a library id: that id and nothing else, not even another EX
    // entry with the same designation.
    const pinned: BatchWeighed = { ...weighed, identity: 'ex:e18w-1', pinned: true };
    expect(isWeighedCandidate(ex, pinned)).toBe(true);
    expect(isWeighedCandidate({ ...ex, motorId: 'ex:e18w-2' }, pinned)).toBe(false);
    expect(isWeighedCandidate(catalogue, pinned)).toBe(false);
    // And a catalogue record matches its catalogue candidate, not the EX one.
    expect(isWeighedCandidate(catalogue, weighed)).toBe(true);
    expect(isWeighedCandidate(ex, weighed)).toBe(false);
  });

  it('batchFlownSpec shifts only the weighed identity on the weighed mount: same motor on another mount and a different motor on the weighed mount stay catalogue; a different delay of the weighed motor is still shifted', () => {
    const spec = motor(2);
    const shifted = batchFlownSpec(catalogue, spec, 'mount', weighed);
    expect(shifted).not.toBe(spec);
    expect(shifted.masses).toEqual(spec.masses.map((m) => m + 0.0455));
    // The catalogue spec is handed back BY IDENTITY when nothing applies.
    expect(batchFlownSpec(catalogue, spec, 'other', weighed)).toBe(spec);
    expect(batchFlownSpec({ ...catalogue, motorId: 'x', designation: 'E28T' }, spec, 'mount', weighed)).toBe(spec);
    expect(batchFlownSpec(catalogue, spec, 'mount', undefined)).toBe(spec);
    // Delay is not part of the identity: the weighed motor at another delay
    // is still the weighed motor.
    const other = { ...spec, ejectionDelay: 7 };
    const shiftedOther = batchFlownSpec(catalogue, other, 'mount', weighed);
    expect(shiftedOther.masses).toEqual(other.masses.map((m) => m + 0.0455));
    expect(shiftedOther.ejectionDelay).toBe(7);
  });
});

describe('the batch dialog', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const MOUNTS: BatchMountOption[] = [
    { id: 'mount', label: '24 mm cluster', diameterMm: 24, motorCount: 4, maxMotorLengthM: null },
  ];

  function mount(launchOver: Partial<LaunchConditions> = {},
    extra: { weighed?: BatchWeighed; mounts?: BatchMountOption[]; tree?: RocketTree } = {}) {
    act(() => root.render(
      <PrefsProvider>
        <BatchSimulate
          tree={extra.tree ?? TREE}
          info={{} as never}
          mounts={extra.mounts ?? MOUNTS}
          initialMountId="mount"
          assignedMotors={{}}
          weighed={extra.weighed}
          launch={{ ...DEFAULT_CONDITIONS, ...launchOver }}
          rocketName="Cluster bird"
          onRunsChange={() => {}}
          onClose={() => {}}
        />
      </PrefsProvider>,
    ));
  }

  it('says nothing about the time step at the default', () => {
    mount();
    expect(host.querySelector('.field-caution')).toBeNull();
  });

  // v0.118: the weighed pad mass rides on the one motor it was weighed with,
  // and the note under the candidates row says which row that is. The weighed
  // motor is taken from the SHIPPED catalogue through the dialog's own default
  // filter (every manufacturer, in-production, 24 mm bore, no length cap), so
  // a weekly motors refresh that drops one motor cannot fail this gate — only
  // an empty 24 mm catalogue could, and then the dialog itself is broken. The
  // J540R is 54 mm and never fits a 24 mm mount. App hands `name` over already
  // delay-stripped (its baseLabel), so the note must never grow a "-7" of its own.
  const first = sortMotors(filterMotors({
    manufacturers: new Set(), classes: new Set(), boreMm: 24, includeOOP: false, text: '',
  }, MOTOR_DB), 'totImpulseNs', -1)[0]!;
  const WEIGHED: BatchWeighed = {
    mountId: 'mount', identity: candidateIdentity(first), pinned: false, name: first.commonName,
    perMotorShiftKg: 0.0455, deltaKg: 0.182,
  };

  it('the note names the weighed motor without its delay suffix and its hardware when the target is the weighed mount and a candidate matches', () => {
    expect(first).toBeDefined();
    mount();
    expect(host.querySelector('.batch-weighed')).toBeNull();
    mount({}, { weighed: WEIGHED });
    const text = host.querySelector('.batch-weighed')?.textContent ?? '';
    expect(text).toBe(`Weighed pad mass: ${first.commonName} flies with 182 g of hardware (adapter, retainer, closure), as on the design page — expect its apogee to read a little lower than another candidate of the same impulse. Every other candidate flies at its catalogue weight; only that motor was weighed.`);
    expect(text).not.toMatch(new RegExp(`${first.commonName}-\\d`));
  });

  it('the note says the weighed motor is not among the candidates when none matches', () => {
    mount({}, { weighed: { ...WEIGHED, identity: 'AeroTech/J540R', name: 'J540R' } });
    expect(host.querySelector('.batch-weighed')?.textContent).toBe(
      'Weighed pad mass: J540R, the motor it was weighed with, is not among these candidates, so every row flies at its catalogue weight.');
  });

  it('the note says the weighed mount keeps its hardware when another mount is the target', () => {
    const mounts: BatchMountOption[] = [
      ...MOUNTS,
      { id: 'centre', label: 'Centre 29 mm', diameterMm: 29, motorCount: 1, maxMotorLengthM: null },
    ];
    mount({}, { mounts, weighed: { ...WEIGHED, mountId: 'centre' } });
    expect(host.querySelector('.batch-weighed')?.textContent).toBe(
      `Weighed pad mass: ${first.commonName} on Centre 29 mm keeps its 182 g of hardware in every flight; the candidates on this mount fly at their catalogue weight.`);
  });

  /**
   * THE SWEEP FLIES PUBLISHED CURVES (2026-09-08). The design's nozzle exit
   * diameter now buys thrust as well as trimming base drag, and the batch
   * builds ONE rocket and swaps candidates onto it - so the design's nozzle
   * would be credited to every motor in the list (about +18 % of thrust on a
   * 100 N H at a 10 kPa mean deficit with a 1.875 in exit). It is stripped,
   * and the note says so, because it means the design's own motor reads a
   * little lower here than on the design page.
   */
  const NOZZLE_TREE: RocketTree = {
    ...TREE,
    components: [{ ...TREE.components[0]!, nozzleExitDiameter: 0.0215 }],
  };

  it('says nothing about a nozzle when the design has none', () => {
    mount();
    expect(host.querySelector('.batch-nozzle')).toBeNull();
  });

  it('names the stage and says the sweep flies published curves without it', () => {
    mount({}, { tree: NOZZLE_TREE });
    const text = host.querySelector('.batch-nozzle')?.textContent ?? '';
    expect(text).toContain("does not apply this design's nozzle (Sustainer)");
    expect(text).toContain('published sea-level curve');
    expect(text).toContain('reads LOWER here');
    // The base-drag half goes with it - the note owes the reader that too.
    expect(text).toContain('base-drag credit');
    // AND THE SIZE OF IT, measured (2026-09-08, review). "a little lower" was
    // wrong by an order of magnitude on exactly the designs it matters for:
    // measured across the 20 nozzle-bearing corpus designs the strip costs
    // 0.08 % of apogee at the low end and 45.8 % on OR vs RAS Test 1, a
    // minimum-diameter airframe with a 2.737 in exit.
    expect(text).toContain('8 to 46 %');
  });

  it('is silent under Classic EB, where neither half of the nozzle is live', () => {
    mount({}, { tree: NOZZLE_TREE });
    expect(host.querySelector('.batch-nozzle')).not.toBeNull();
    const select = [...host.querySelectorAll('select')]
      .find((el) => [...el.options].some((o) => o.value === 'eb'))!;
    act(() => {
      select.value = 'eb';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('.batch-nozzle')).toBeNull();
  });

  // The weighed-mass note and the nozzle note are separate facts about the
  // same sweep; either can be present without the other.
  it('shows both notes at once without one swallowing the other', () => {
    mount({}, { tree: NOZZLE_TREE, weighed: WEIGHED });
    expect(host.querySelector('.batch-weighed')).not.toBeNull();
    expect(host.querySelector('.batch-nozzle')).not.toBeNull();
  });

  // The launch panel's caution is per flight; a batch pays that cost once per
  // CANDIDATE, so the dialog must state the total the user actually faces.
  it('cautions on a fine step, scaled to the whole candidate list', () => {
    mount({ timeStepS: 0.01 });
    const el = host.querySelector('.field-caution');
    expect(el).not.toBeNull();
    const text = el!.textContent ?? '';
    expect(text).toMatch(/finer than the 0\.05 s default/);
    // Batch wording, not the launch panel's per-flight wording.
    expect(text).toMatch(/whole batch — \d+ flights/);
    expect(text).not.toMatch(/per flight/);
  });
});

/**
 * Owner report, 2026-09-01b: *"'batch simulate motors' appears to be broken,
 * when I click the button, nothing happens."*
 *
 * It was not broken. The button was DISABLED — his design is staged, and batch
 * across stages is his own 2026-07-03 ruling because the combinations explode.
 * A disabled button gives no feedback when clicked, and the tooltip named only
 * ONE of the three reasons the button can be off, so the other two showed the
 * button's ENABLED description and then did nothing.
 */
describe('batchUnavailableReason', () => {
  const ok = { built: true, hasMount: true, isStaged: false };

  it('is null when batch simulation is available', () => {
    expect(batchUnavailableReason(ok)).toBeNull();
  });

  it('explains a staged rocket', () => {
    expect(batchUnavailableReason({ ...ok, isStaged: true }))
      .toBe('the motor combinations explode on a staged rocket');
  });

  it('explains a rocket with no motor mount', () => {
    // This case used to show the ENABLED tooltip and then do nothing at all.
    expect(batchUnavailableReason({ ...ok, hasMount: false }))
      .toBe('this rocket has no motor mount');
  });

  it('explains a design that will not build', () => {
    expect(batchUnavailableReason({ ...ok, built: false }))
      .toBe('the design cannot be built, so there is nothing to fly');
  });

  it('gives a reason for EVERY state that disables the button', () => {
    // The property that matters: the button's disabled condition and the
    // explanation are the same expression, so one cannot gain a case the other
    // does not cover. Enumerate all eight combinations.
    for (const built of [true, false]) {
      for (const hasMount of [true, false]) {
        for (const isStaged of [true, false]) {
          const reason = batchUnavailableReason({ built, hasMount, isStaged });
          const shouldBeBlocked = !built || !hasMount || isStaged;
          expect(reason === null, `built=${built} hasMount=${hasMount} isStaged=${isStaged}`)
            .toBe(!shouldBeBlocked);
          if (reason !== null) expect(reason.length).toBeGreaterThan(10);
        }
      }
    }
  });
});


/**
 * Owner report, 2026-09-01b, after a 226-motor run: *"how does the user know
 * the batch is complete? Once the sims are done, there is no indication to the
 * user that all the simulations have been completed and they can now download
 * the file."*
 *
 * He was right. On completion the progress bar and its "simulating 173/226"
 * line were simply removed and the Stop button turned back into Simulate.
 * A disappearing progress bar is not an announcement.
 */
describe('batchSummary', () => {
  const base = { total: 226, stopped: false, accepted: 41, errors: 0, downloadable: true };

  it('says the run finished, how many flew, and how many passed', () => {
    expect(batchSummary(base)).toBe(
      'Finished — simulated 226 motors; 41 met your criteria. '
      + 'Download the results as CSV or XLSX above.');
  });

  it('distinguishes a run the user stopped from one that ran out', () => {
    expect(batchSummary({ ...base, stopped: true })).toMatch(/^Stopped early —/);
    expect(batchSummary(base)).toMatch(/^Finished —/);
  });

  it('counts motors the kernel refused, and stays silent when there are none', () => {
    expect(batchSummary({ ...base, errors: 3 })).toContain('3 could not be flown');
    expect(batchSummary(base)).not.toContain('could not be flown');
  });

  it('only points at the download buttons when there is something to download', () => {
    expect(batchSummary({ ...base, downloadable: false })).not.toContain('CSV');
    expect(batchSummary({ ...base, downloadable: false })).toMatch(/criteria\.$/);
  });

  it('says "motor", singular, for one', () => {
    expect(batchSummary({ ...base, total: 1, accepted: 1 })).toContain('simulated 1 motor;');
  });

  it('is honest when nothing met the criteria', () => {
    // The case where a user most needs to be told the run is OVER: an empty
    // result table looks exactly like a run that has not started.
    const s = batchSummary({ ...base, accepted: 0 });
    expect(s).toContain('0 met your criteria');
    expect(s).toMatch(/^Finished/);
  });
});

describe('the completion signal is actually wired up', () => {
  // batchSummary is a pure function and easy to test; the thing that broke was
  // that NOTHING told the user the run had ended. Pinning the wording without
  // pinning the wiring would leave that exact hole open, and a mutation that
  // deleted the setFinished call survived the wording tests untouched.
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), './BatchSimulate.tsx'), 'utf8');

  it('raises the signal when the run ends', () => {
    expect(src).toContain('setFinished({ total: out.length, stopped: cancelled.current });');
  });

  it('clears it when the next run starts, so it cannot go stale', () => {
    expect(src).toContain('setFinished(null);');
  });

  it('renders it once the run is over, through batchSummary', () => {
    expect(src).toContain('{finished && !running && (');
    expect(src).toContain('batchSummary({');
    // Announced to assistive tech too, not just painted on screen.
    expect(src).toContain('role="status"');
  });
});

/**
 * The nozzle strip itself, pinned at the two call sites that build a kernel
 * handle. Exercising a whole sweep here would need the thrustcurve fetch; what
 * has to be true is narrower and exact — NEITHER handle may be built from a
 * tree that still carries the design's nozzle. `clearStageNozzles` is proven
 * to remove it (and to survive `engineTree`) in tree/treeModel.test.ts.
 */
describe('the sweep builds its handles from a nozzle-free tree', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), './BatchSimulate.tsx'), 'utf8');

  it('the single-motor pass strips it', () => {
    expect(src).toContain('const sweepTree = clearStageNozzles(tree);');
    expect(src).toContain('OrkRocket.buildTree(engineTree(sweepTree))');
  });

  it('the combination passes strip it too — split.tree comes from the design tree', () => {
    expect(src).toContain('OrkRocket.buildTree(engineTree(clearStageNozzles(split.tree)))');
  });

  it('no handle is built from a raw tree', () => {
    expect(src).not.toContain('engineTree(tree)');
    expect(src).not.toContain('engineTree(split.tree)');
  });
});
