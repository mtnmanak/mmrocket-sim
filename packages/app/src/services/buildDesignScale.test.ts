import { describe, expect, it } from 'vitest';
import { takeKernelWorkCounters, type ComponentNode, type KernelWorkCounters, type RocketTree } from '@online-openrocket/engine';
import { defaultTree, makeNode, normalizeTree } from '../tree/treeModel.js';
import type { EditorComponentType } from '../tree/schema.js';
import { buildDesign, KERNEL_HANDLES, type DesignBuildInput } from './buildDesign.js';
import { componentsIterated } from './componentsIterated.testSupport.js';

/**
 * THE DESIGN BUILD STAYS LINEAR IN THE PARTS UNDER ONE PARENT (2026-10-11;
 * register, 1 October, v0.147: "the design build's near-square growth with
 * parts under one parent, about 3 s at 8,000").
 *
 * The kernel checked its own tree on every child accessor: the parent's whole
 * child list for "am I in it", by a scan, then the child's own list. One walk
 * over N children under one parent cost N²/2 steps, and a build walks the tree
 * dozens of times. A body tube positioned after the one ahead of it looked its
 * own index up with a linear indexOf on every update. And the static analysis
 * ran the airframe geometry check, which formats two lengths as text per pair
 * of airframe parts, on each of the 360 roll angles of the forward-CP search,
 * into a warning set it then threw away.
 *
 * Then, per kind of part: every fin set placed every sibling fin set to count
 * the fins beside it (N² placements); every centering ring walked a copy of
 * its parent's whole child list for inner tubes, several times per mass
 * calculation; every booster's stage number was searched for from 0, and each
 * stage looked its flags up by a scan of all the old ones; and the warnings the
 * 360-plane sweep discards were still stored, each after a search of all the
 * others, which is N²/2 per plane when every part raises its own warning (a
 * camera shroud does). engine-java/patches/LEDGER.md has the timings.
 *
 * Counted, not timed, so the bounds hold on a slow CI runner: the kernel's own
 * counters (takeKernelWorkCounters), and componentsIterated for the app's half
 * of the build. At 2,000 parts the old kernel took thousands of steps a part;
 * now it takes a handful, so the bound of 25 a part sits far from both.
 */

const N = 2000;

function input(tree: RocketTree): DesignBuildInput {
  return {
    tree, assigned: [], kbf: false, supersonic: false, measuredDryMassKg: null,
    primaryMountId: null, currentSetKey: '',
  };
}

/** n parts of one kind in one body tube, behind a nose cone. */
function inOneTube(type: EditorComponentType, n = N): RocketTree {
  const kids = Array.from({ length: n }, (_, i) => ({ ...makeNode(type), name: `P${i}` }) as ComponentNode);
  const tube = { ...makeNode('bodytube'), length: 0.3, children: kids } as ComponentNode;
  return normalizeTree({ name: 'Many parts', components: [makeNode('nosecone'), tube] });
}

/** N body tubes in one stage, each placed after the one ahead of it. */
function tubesInOneStage(): RocketTree {
  const tubes = Array.from({ length: N }, (_, i) => ({ ...makeNode('bodytube'), length: 0.01, name: `T${i}` }) as ComponentNode);
  return normalizeTree({ name: 'Many tubes', components: [makeNode('nosecone'), ...tubes] });
}

/** Builds the design, returning the kernel's counters and the app's part reads. */
function measure(tree: RocketTree): { kernel: KernelWorkCounters; appReads: number } {
  takeKernelWorkCounters();
  let built: ReturnType<typeof buildDesign> | undefined;
  const appReads = componentsIterated(() => { built = buildDesign(input(tree), KERNEL_HANDLES); });
  const kernel = takeKernelWorkCounters();
  if (!built || 'error' in built) throw new Error(built?.error ?? 'no build');
  // …and it built the design it was given: every part has mass.
  expect(built.info.massEmpty).toBeGreaterThan(0);
  return { kernel, appReads };
}

describe('the design build is linear in the parts under one parent', () => {
  it.each([
    ['2,000 mass components in one body tube', () => inOneTube('masscomponent')],
    ['2,000 body tubes in one stage', tubesInOneStage],
    ['2,000 trapezoidal fin sets in one body tube', () => inOneTube('trapezoidfinset')],
    ['2,000 centering rings in one body tube', () => inOneTube('centeringring')],
    ['2,000 boosters in one body tube', () => inOneTube('parallelstage')],
  ])('%s: the kernel and the app each read a part a bounded number of times', (_, make) => {
    const { kernel, appReads } = measure(make());
    // The counter is live: a build verifies each part's place at least once.
    expect(kernel.structureScanSteps).toBeGreaterThan(0);
    expect(kernel.structureScanSteps / N).toBeLessThan(25);
    expect(kernel.siblingScanSteps / N).toBeLessThan(25);
    expect(appReads / N).toBeLessThan(25);
    // The stage bookkeeping re-files every stage once per structure change, and
    // a build makes a fixed number of those (19 a booster, measured); it was
    // about N/2 probes per stage per change.
    expect(kernel.stageScanSteps / N).toBeLessThan(100);
  }, 30_000);

  it('fin sets count the fins beside them once per parent, not once per fin set', () => {
    const { kernel } = measure(inOneTube('trapezoidfinset'));
    // One pass over the tube's children for all of its fin sets.
    expect(kernel.siblingScanSteps).toBeGreaterThanOrEqual(N);
    expect(kernel.siblingScanSteps).toBeLessThan(2 * N);
  }, 30_000);

  it("a centering ring reads its parent's inner tubes from a list kept between changes", () => {
    const { kernel } = measure(inOneTube('centeringring'));
    expect(kernel.siblingScanSteps).toBeGreaterThanOrEqual(N);
    expect(kernel.siblingScanSteps).toBeLessThan(2 * N);
  }, 30_000);

  it('warnings the forward-CP search discards are not stored', () => {
    // A camera shroud raises a warning of its own, so the set the design shows
    // holds one per shroud, and filling it is one pass of n²/2 comparisons
    // (the set's own duplicate check: still quadratic, and left as it is).
    // Each of the 360 roll angles added another such pass, into a set nobody
    // read.
    const n = 500;
    const { kernel } = measure(inOneTube('fairing', n));
    expect(kernel.messageScanSteps).toBeGreaterThan(0);
    expect(kernel.messageScanSteps).toBeLessThan(n * n);
  }, 30_000);
});

describe('a static analysis checks the airframe geometry once', () => {
  it('not once per roll angle of the forward-CP search', () => {
    takeKernelWorkCounters();
    const built = buildDesign(input(defaultTree()), KERNEL_HANDLES);
    if ('error' in built) throw new Error(built.error);
    // One staticInfo (no pad mass): the theta = 0 CP, whose warnings the
    // design shows. The 360-plane sweep discards its warnings, so it does not
    // produce them (it ran the check 360 more times before 2026-10-11).
    expect(takeKernelWorkCounters().geometryChecks).toBe(1);
  }, 30_000);
});
