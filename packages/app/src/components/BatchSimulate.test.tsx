// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { splitClusterTree } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import { BatchSimulate, batchProbeCutoff, mixedComboCount, type BatchMountOption } from './BatchSimulate.js';

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

  function mount(launchOver: Partial<LaunchConditions> = {}) {
    act(() => root.render(
      <PrefsProvider>
        <BatchSimulate
          tree={TREE}
          info={{} as never}
          mounts={MOUNTS}
          initialMountId="mount"
          assignedMotors={{}}
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
