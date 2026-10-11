import { describe, expect, it } from 'vitest';
import { takeKernelWorkCounters, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { defaultTree, makeNode, normalizeTree } from '../tree/treeModel.js';
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
 * into a warning set it then threw away. Measured on this machine before ->
 * after: 8,000 parts in one body tube 2.3 -> 0.7 s; 1,000 body tubes in one
 * stage 16 -> 0.5 s (engine-java/patches/LEDGER.md has the table).
 *
 * Counted, not timed, so the bounds hold on a slow CI runner: the kernel's own
 * scan counter (takeKernelWorkCounters), and componentsIterated for the app's
 * half of the build. At 2,000 parts the old kernel scanned thousands of entries
 * a part; now it scans about one, so the bound of 25 sits far from both.
 */

const N = 2000;

function input(tree: RocketTree): DesignBuildInput {
  return {
    tree, assigned: [], kbf: false, supersonic: false, measuredDryMassKg: null,
    primaryMountId: null, currentSetKey: '',
  };
}

/** N mass components in one body tube, behind a nose cone. */
function partsInOneTube(): RocketTree {
  const kids = Array.from({ length: N }, (_, i) => ({ ...makeNode('masscomponent'), name: `M${i}` }) as ComponentNode);
  const tube = { ...makeNode('bodytube'), length: 0.3, children: kids } as ComponentNode;
  return normalizeTree({ name: 'Many parts', components: [makeNode('nosecone'), tube] });
}

/** N body tubes in one stage, each placed after the one ahead of it. */
function tubesInOneStage(): RocketTree {
  const tubes = Array.from({ length: N }, (_, i) => ({ ...makeNode('bodytube'), length: 0.01, name: `T${i}` }) as ComponentNode);
  return normalizeTree({ name: 'Many tubes', components: [makeNode('nosecone'), ...tubes] });
}

describe('the design build is linear in the parts under one parent', () => {
  it.each([
    ['2,000 parts in one body tube', partsInOneTube],
    ['2,000 body tubes in one stage', tubesInOneStage],
  ])('%s: the kernel and the app each read a part a bounded number of times', (_, make) => {
    const tree = make();
    takeKernelWorkCounters();
    let built: ReturnType<typeof buildDesign> | undefined;
    const appReads = componentsIterated(() => { built = buildDesign(input(tree), KERNEL_HANDLES); });
    const kernel = takeKernelWorkCounters();
    if (!built || 'error' in built) throw new Error(built?.error ?? 'no build');
    // The counter is live: a build verifies each part's place at least once.
    expect(kernel.structureScanSteps).toBeGreaterThan(0);
    expect(kernel.structureScanSteps / N).toBeLessThan(25);
    expect(appReads / N).toBeLessThan(25);
    // …and it built the design it was given: every part has mass.
    expect(built.info.massEmpty).toBeGreaterThan(0);
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
