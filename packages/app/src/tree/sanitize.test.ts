import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import {
  explainBuildFailure, partBlockingBuild, sanitizeTree, separationEventOrDefault, treeProblems,
} from './sanitize.js';
import { defaultTree, engineTree, normalizeTree } from './treeModel.js';
import {
  FIELDS, fieldLimit, KERNEL_MAX_FINS, MAX_ASSEMBLY_INSTANCES, MAX_DIMENSION_M,
  MAX_SHROUD_LINES, MIN_POSITIVE_DIMENSION_M, type EditorComponentType,
} from './schema.js';

/**
 * The load boundary's sanitize pass (audit 2026-09-22, Step 2 item 12): one
 * limits table in schema.ts, applied in normalizeTree — the chokepoint for a
 * file, a share link and a restored session — with one note per repair.
 */

/** A body tube carrying `kids`, under one stage, plus any extra stages. */
const rocket = (kids: Record<string, unknown>[], extraStages: Record<string, unknown>[] = []): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage', name: 'Sustainer',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012, thickness: 0.002 },
      { id: 'b1', type: 'bodytube', name: 'Body tube', length: 0.3, outerRadius: 0.012, thickness: 0.0005, children: kids },
    ],
  }, ...extraStages],
}) as unknown as RocketTree;

const kid = (tree: RocketTree, i = 0): ComponentNode => tree.components[0]!.children![1]!.children![i]!;

/** Build the way App.tsx's buildResult does; the kernel's message, or null. */
function build(tree: RocketTree): string | null {
  try {
    resetEngine();
    OrkRocket.buildTree(engineTree(tree)).staticInfo();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('sanitizeTree — counts', () => {
  it('brings every count inside the kernel\'s (or the app\'s) ceiling, one note each', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket([
      { id: 'f1', type: 'trapezoidfinset', name: 'Fins', finCount: 70_000, rootChord: 0.05, height: 0.03 },
      { id: 't1', type: 'tubefinset', name: 'Tubes', finCount: 12, length: 0.1 },
      { id: 'c1', type: 'parachute', name: 'Chute', lineCount: 1_000_000, diameter: 0.3 },
      { id: 'l1', type: 'launchlug', name: 'Lug', instanceCount: 20_000 },
      { id: 'p1', type: 'podset', name: 'Pods', instanceCount: 1e8, children: [] },
      { id: 'x1', type: 'protuberance', name: 'Bump', count: 5000 },
    ]), notes);
    expect(kid(t, 0)['finCount']).toBe(KERNEL_MAX_FINS);
    expect(kid(t, 1)['finCount']).toBe(8);
    expect(kid(t, 2)['lineCount']).toBe(MAX_SHROUD_LINES);
    expect(kid(t, 3)['instanceCount']).toBe(64);
    expect(kid(t, 4)['instanceCount']).toBe(MAX_ASSEMBLY_INSTANCES);
    expect(kid(t, 5)['count']).toBe(1000);
    expect(notes).toHaveLength(6);
    expect(notes[0]).toMatch(/^“Fins”: fin count 70000 is over the limit of 8 \(.*\) — set to 8\.$/);
    expect(notes[2]).toBe('“Chute”: line count 1000000 is over the limit of 64 (more than any real parachute) — set to 64.');
  });

  it('rounds a fractional count, and raises a zero fin count to one', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket([
      { id: 'f1', type: 'ellipticalfinset', name: 'Fins', finCount: 3.6 },
      { id: 'f2', type: 'freeformfinset', name: 'Other fins', finCount: 0 },
    ]), notes);
    expect(kid(t, 0)['finCount']).toBe(4);
    expect(kid(t, 1)['finCount']).toBe(1);
    expect(notes).toEqual([
      '“Fins”: fin count 3.6 is not a whole number — set to 4.',
      '“Other fins”: fin count 0 is below the minimum of 1 — set to 1.',
    ]);
  });
});

describe('sanitizeTree — dimensions', () => {
  it('raises a negative dimension to zero and a kernel-fatal zero to the hard minimum', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket([
      { id: 'f1', type: 'trapezoidfinset', name: 'Fins', height: -0.03, rootChord: 0.05 },
      { id: 't1', type: 'tubefinset', name: 'Tubes', length: 0 },
      { id: 'sh', type: 'fairing', name: 'Shroud', height: 0, fairingForeShape: 'box', fairingAftShape: 'box' },
      { id: 'st', type: 'streamer', name: 'Streamer', stripLength: -0.5, surfaceDensity: -0.067 },
    ]), notes);
    expect(kid(t, 0)['height']).toBe(0);
    expect(kid(t, 1)['length']).toBe(MIN_POSITIVE_DIMENSION_M);
    expect(kid(t, 2)['height']).toBe(MIN_POSITIVE_DIMENSION_M);
    expect(kid(t, 3)['stripLength']).toBe(0);
    expect(kid(t, 3)['surfaceDensity']).toBe(0);
    expect(notes).toContain('“Fins”: height -30 mm cannot be negative — set to 0 mm.');
    expect(notes).toContain('“Tubes”: length 0 mm is below the minimum of 0.1 mm — set to 0.1 mm.');
    expect(notes).toContain('“Streamer”: canopy material density -0.067 kg/m³ cannot be negative — set to 0 kg/m³.');
    expect(notes).toHaveLength(5);
  });

  it('keeps a length whose sign means something, and caps anything past a kilometre', () => {
    const notes: string[] = [];
    const input = rocket([
      { id: 'f1', type: 'trapezoidfinset', name: 'Fins', sweep: -0.02, position: { method: 'bottom', offset: -0.01 } },
      { id: 'm1', type: 'masscomponent', name: 'Ballast', length: 1e6, position: { method: 'top', offset: 1e9 } },
    ]);
    const t = sanitizeTree(input, notes);
    expect(kid(t, 0)).toBe(kid(input, 0)); // nothing to repair: the very same node
    expect(kid(t, 0)['sweep']).toBe(-0.02);
    expect(kid(t, 1)['length']).toBe(MAX_DIMENSION_M);
    expect(kid(t, 1).position).toEqual({ method: 'top', offset: MAX_DIMENSION_M });
    expect(notes).toEqual([
      '“Ballast”: length 1000000 m is over the limit of 1000 m — set to 1000 m.',
      '“Ballast”: position 1000000000 m is over the limit of 1000 m — set to 1000 m.',
    ]);
  });
});

describe('sanitizeTree — enum strings', () => {
  it('drops a value the kernel refuses, with desktop\'s default and a note', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket(
      [
        { id: 'f1', type: 'trapezoidfinset', name: 'Fins', airfoilSection: 'wedgie' },
        { id: 'm1', type: 'innertube', name: 'Mount', cluster: 'ninefold' },
      ],
      [{ id: 's2', type: 'stage', name: 'Booster', separationEvent: 'sometime', children: [] }],
    ), notes);
    expect(kid(t, 0)).not.toHaveProperty('airfoilSection');
    expect(kid(t, 1)).not.toHaveProperty('cluster');
    expect(t.components[1]).not.toHaveProperty('separationEvent');
    expect(notes).toEqual([
      '“Fins”: supersonic airfoil section “wedgie” is not one the simulation knows — it now uses the classic cross-section drag.',
      '“Mount”: cluster pattern “ninefold” is not one the simulation knows — it now uses a single tube.',
      '“Booster”: separation event “sometime” is not one the simulation knows — it now uses this stage’s ejection charge, desktop OpenRocket’s default.',
    ]);
  });

  it('leaves a recovery device\'s deploy event exactly as it was written', () => {
    // Not one the pass repairs: the bridge never throws on a deploy event
    // (ComponentFactory.deployEventOf flies any value it does not name as the
    // ejection charge), and desktop 24.12 writes one the app's menu lacks —
    // "lowerstageseparation". Deleting it lost it on save, and an ABSENT key
    // does not mean one thing everywhere: the .ork writer reads it as
    // ejection, the .CDX1 writer as apogee.
    const notes: string[] = [];
    const input = rocket([
      { id: 'c1', type: 'parachute', name: 'Chute', deployEvent: 'lowerstageseparation' },
      { id: 'c2', type: 'streamer', name: 'Streamer', deployEvent: 'whenever' },
      { id: 'c3', type: 'parachute', name: 'Drogue', deployEvent: 'Apogee' },
    ]);
    const t = sanitizeTree(input, notes);
    expect(t).toBe(input);
    expect(notes).toEqual([]);
    expect(treeProblems(input)).toEqual([]);
  });

  it('respells a value the kernel reads case- and underscore-blind, silently', () => {
    const notes: string[] = [];
    const t = sanitizeTree(rocket(
      [
        { id: 'f1', type: 'trapezoidfinset', airfoilSection: 'HEX_BLUNT_BASE' },
        { id: 'f2', type: 'trapezoidfinset', airfoilSection: '' },
      ],
      [{ id: 's2', type: 'stage', separationEvent: 'ALTITUDE_ASCENDING', children: [] }],
    ), notes);
    expect(kid(t, 0)['airfoilSection']).toBe('hexbluntbase');
    expect(kid(t, 1)).not.toHaveProperty('airfoilSection'); // the panel's "Classic" option
    expect(t.components[1]!['separationEvent']).toBe('altitudeascending');
    expect(notes).toEqual([]);
  });

  it('gives a per-configuration separation the same answer', () => {
    expect(separationEventOrDefault('UPPER_IGNITION')).toBe('upperignition');
    expect(separationEventOrDefault('bogus')).toBe('ejection');
  });
});

describe('sanitizeTree — identity and the load boundary', () => {
  it('returns the same tree object for a clean design, and is idempotent', () => {
    const clean = defaultTree();
    expect(sanitizeTree(clean)).toBe(clean);
    const notes: string[] = [];
    const once = sanitizeTree(rocket([{ id: 'f1', type: 'trapezoidfinset', finCount: 12 }]), notes);
    expect(notes).toHaveLength(1);
    const again: string[] = [];
    expect(sanitizeTree(once, again)).toBe(once);
    expect(again).toEqual([]);
  });

  it('runs inside normalizeTree, so a restored session or share link is repaired too', () => {
    const t = normalizeTree(rocket([{ id: 'f1', type: 'trapezoidfinset', finCount: 70_000 }]));
    expect(kid(t)['finCount']).toBe(8);
  });
});

describe('the degenerate values that failed the whole build now build', () => {
  // Each of these threw from the kernel at a7756c5 (single-field fuzz, audit
  // 2026-09-22): InertiaMatrix for the negatives, NaN→BigInt for the zero
  // tube-fin length, `%g` for the zero-height blunt shroud.
  const cases: [string, Record<string, unknown>][] = [
    ['negative fin height', { id: 'k', type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: -0.03, thickness: 0.003 }],
    ['negative elliptical fin height', { id: 'k', type: 'ellipticalfinset', rootChord: 0.05, height: -0.03, thickness: 0.003 }],
    ['negative lug length', { id: 'k', type: 'launchlug', length: -0.05, outerRadius: 0.0022, thickness: 0.0003 }],
    ['zero tube-fin length', { id: 'k', type: 'tubefinset', finCount: 6, length: 0, thickness: 0.0005 }],
    ['negative tube-fin length', { id: 'k', type: 'tubefinset', finCount: 6, length: -0.1, thickness: 0.0005 }],
    ['zero-height blunt shroud', { id: 'k', type: 'fairing', length: 0.08, width: 0.025, height: 0, fairingForeShape: 'box', fairingAftShape: 'box' }],
    ['negative shroud length', { id: 'k', type: 'fairing', length: -0.08, width: 0.025, height: 0.02 }],
    ['negative streamer strip', { id: 'k', type: 'streamer', stripLength: -0.5, stripWidth: 0.05 }],
    ['negative chute line length', { id: 'k', type: 'parachute', diameter: 0.3, lineCount: 6, lineLength: -1 }],
    ['negative canopy density', { id: 'k', type: 'parachute', diameter: 0.3, surfaceDensity: -0.067 }],
    ['negative shock-cord density', { id: 'k', type: 'shockcord', cordLength: 0.5, lineDensity: -0.0018 }],
  ];
  for (const [what, node] of cases) {
    it(what, () => {
      const raw = rocket([node]);
      expect(build(raw), 'the unsanitised tree should still fail').not.toBeNull();
      expect(build(normalizeTree(raw))).toBeNull();
    });
  }

  it('a negative body-tube wall', () => {
    const raw = rocket([]);
    raw.components[0]!.children![1]!['thickness'] = -0.0005;
    expect(build(raw)).not.toBeNull();
    expect(build(normalizeTree(raw))).toBeNull();
  });

  it('the panel\'s "Classic" airfoil (the empty string) no longer fails the build', () => {
    // Pick a section, then Classic again: the select stores ''. setTree does
    // not normalise, so the engine boundary has to read '' as "none" itself.
    const t = rocket([{ id: 'f', type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, airfoilSection: '' }]);
    expect(build(t)).toBeNull();
  });
});

describe('explainBuildFailure — naming the part (audit 2026-09-22)', () => {
  it('leads with the part and the field, and keeps the kernel\'s words for a bug report', () => {
    const t = rocket([{ id: 't', type: 'tubefinset', name: 'Tube fins', length: 0 }]);
    const kernel = build(t)!;
    expect(kernel).toMatch(/BigInt/);
    const msg = explainBuildFailure(t, kernel);
    expect(msg).toBe('This design could not be built. The likely cause: “Tube fins”: length 0 mm is below'
      + ' the minimum of 0.1 mm. (The simulation reported: ' + kernel + ')');
  });

  it('names at most three, and counts the rest', () => {
    const t = rocket([
      { id: 'a', type: 'trapezoidfinset', name: 'A', height: -0.01 },
      { id: 'b', type: 'trapezoidfinset', name: 'B', height: -0.01 },
      { id: 'c', type: 'trapezoidfinset', name: 'C', height: -0.01 },
      { id: 'd', type: 'trapezoidfinset', name: 'D', height: -0.01 },
    ]);
    const msg = explainBuildFailure(t, 'kernel text');
    expect(msg).toMatch(/^This design could not be built\. The likely causes: “A”: .*; “B”: .*; “C”: .*; and 1 more\. \(The simulation reported: kernel text\)$/);
    expect(msg).not.toContain('“D”');
  });

  it('names a freeform outline the kernel refuses', () => {
    const t = rocket([{ id: 'f', type: 'freeformfinset', name: 'Canards', points: [[0, 0], [0.02, 0.03], [0.02, 0.03], [0.05, 0]] }]);
    expect(treeProblems(t)).toEqual(['“Canards”: Points 2 and 3 are in the same place — move one of them or delete it']);
  });

  it('returns the kernel text unchanged when nothing in the table explains it', () => {
    expect(explainBuildFailure(defaultTree(), 'Unknown component type: \'x\'')).toBe('Unknown component type: \'x\'');
  });

  it('never throws itself — it runs inside the app\'s build catch', () => {
    // A child list holding a null: malformed enough to fail any walk.
    const broken = { name: 'R', components: [{ id: 's', type: 'stage', children: [null] }] } as unknown as RocketTree;
    expect(() => treeProblems(broken)).toThrow();
    expect(explainBuildFailure(broken, 'kernel text')).toBe('kernel text');
    expect(explainBuildFailure(broken, 'kernel text', () => false)).toBe('kernel text');
  });
});

describe('explainBuildFailure — the omit-one-part fallback (audit 2026-09-22)', () => {
  /** The kernel's buildTree alone, the way App.tsx's build catch passes it. */
  let calls = 0;
  const buildsBare = (t: RocketTree): boolean => {
    calls++;
    try {
      resetEngine();
      OrkRocket.buildTree(engineTree(t));
      return true;
    } catch {
      return false;
    }
  };

  it('names the part the design builds without, when the table has nothing to say', () => {
    // A restored session can carry a component type this build does not know:
    // no limit covers it, and the kernel's words name nothing on screen.
    const t = rocket([{ id: 'w', type: 'widget', name: 'Widget' }]);
    const kernel = build(t)!;
    expect(kernel).toBe('Unknown component type: \'widget\'');
    expect(treeProblems(t)).toEqual([]);
    expect(explainBuildFailure(t, kernel)).toBe(kernel); // no builder: as before
    // Its body tube also builds once dropped (the widget goes with it), but a
    // part's children are tried before it, so the widget itself is named.
    expect(explainBuildFailure(t, kernel, buildsBare)).toBe('This design could not be built. The likely cause:'
      + ' “Widget” — the rest of the design builds without it. (The simulation reported: ' + kernel + ')');
  });

  it('says "or a part inside it" when only a whole assembly clears it', () => {
    // Two unknown parts on one tube: neither alone clears the build, the tube does.
    const t = rocket([{ id: 'w', type: 'widget', name: 'W1' }, { id: 'g', type: 'gizmo', name: 'W2' }]);
    expect(explainBuildFailure(t, 'k', buildsBare)).toBe('This design could not be built. The likely cause:'
      + ' “Body tube” or a part inside it — the rest of the design builds without it. (The simulation reported: k)');
  });

  it('blames no part when the rocket itself builds — the failure lay elsewhere, one build to find out', () => {
    calls = 0;
    expect(explainBuildFailure(defaultTree(), 'kernel text', buildsBare)).toBe('kernel text');
    expect(calls).toBe(1);
  });

  it('blames no part when no single omission clears it', () => {
    const t = rocket([{ id: 'w', type: 'widget', name: 'W1' }],
      [{ id: 's2', type: 'stage', name: 'Booster', children: [{ id: 'g', type: 'gizmo', name: 'W2' }] }]);
    expect(explainBuildFailure(t, 'kernel text', buildsBare)).toBe('kernel text');
  });

  it('stops after a bounded number of trial builds', () => {
    calls = 0;
    // Post-order: nose, widget — the widget is the second part tried.
    const t = rocket([{ id: 'w', type: 'widget', name: 'Widget' }]);
    expect(partBlockingBuild(t, buildsBare, 1)).toBeNull();
    expect(calls).toBe(2); // the whole tree, then one omission
    expect(partBlockingBuild(t, buildsBare, 2)?.name).toBe('Widget');
  });
});

describe('the limits table and the panel agree', () => {
  it('every count field has a hard limit, and no slider offers past it', () => {
    for (const [type, fields] of Object.entries(FIELDS)) {
      for (const f of fields) {
        if (f.unit !== 'count') continue;
        const lim = fieldLimit(type as EditorComponentType, f.key);
        expect(lim, `${type}.${f.key}`).toBeDefined();
        expect(f.smax!, `${type}.${f.key}`).toBeLessThanOrEqual(lim!.hmax!);
        expect(f.smin!, `${type}.${f.key}`).toBeGreaterThanOrEqual(lim!.hmin);
      }
    }
  });
});
