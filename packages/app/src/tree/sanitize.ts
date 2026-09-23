import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finOutlineProblem, type FinOutlinePoint } from './finOutline.js';
import {
  applyFieldLimit, canonicalEnum, DISPLAY_NAME, ENUM_LIMITS, FIELDS, fieldLimit, MAX_DIMENSION_M, SEPARATION_EVENT_VALUES,
  type EnumLimit, type FieldDef, type FieldLimit, type LimitKind,
} from './schema.js';

/**
 * THE UNTRUSTED-INPUT BOUNDARY for a design tree (audit 2026-09-22, Step 2).
 *
 * A tree reaches the app three ways — a file (.ork, .rkt, .CDX1), a share link
 * (a .ork in the URL, applied with no prompt on a first visit), and the
 * autosaved session — and all three go through `normalizeTree`, which runs
 * `sanitizeTree` below. Before this, every count and dimension a file carried
 * went onto the node unbounded, and three kinds of damage followed:
 *
 *  - COUNTS with no ceiling: a .rkt FinCount of 70,000 unmounted the whole app;
 *    TubeCount 100,000 held buildPieces for 19.3 s; a ShroudLineCount of
 *    1,000,000 made a 540 kg parachute; a lug instancecount of 20,000 made
 *    2.0 M vertices. The kernel clamps fins to 8 and the bridge line instances
 *    to 64, so the drawings also showed counts the kernel never flew.
 *  - DEGENERATE DIMENSIONS the kernel cannot build: a negative fin height,
 *    wall or density ("InertiaMatrix … negative"), a zero tube-fin length ("NaN
 *    … BigInt"), a zero shroud height ("Unknown format conversion: g").
 *  - ENUM STRINGS the bridge refuses ("Unknown separation event: …").
 *
 * The last two failed the WHOLE build — mass, CP, Launch and every export —
 * and autosave kept the bad value, so it failed on every load. The repair is
 * the smallest one that builds: a value is brought to the nearest limit in
 * the ONE table (`fieldLimit` in schema.ts, which the property panel's commit
 * enforces too) and an unknown enum falls back to desktop's default. Each
 * repair says so in one note, naming the part and the field: the three
 * importers run this pass on what they read and hand its notes to the import
 * banner with their own, so the second run inside `normalizeTree` finds nothing
 * left to do. A restored session has no banner of its own and is repaired
 * quietly — it can only hold an out-of-limit value an older build let through.
 *
 * NOT here, by design: freeform point lists (their own pass in the importers),
 * nesting depth (orkFile), the launch/atmosphere envelope (not tree values —
 * orkFile's readLaunchConditions ranges), and the enum values that live
 * outside the tree — a flight configuration's separation and a motor's
 * ignition — which orkFile repairs with the helpers at the end of this file.
 */

/**
 * A table lookup that cannot land on Object.prototype: `FIELDS` and
 * `DISPLAY_NAME` are plain literals, and a restored session's `type` is
 * whatever string it saved.
 */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  (Object.hasOwn(table, key) ? table[key] : undefined);

/** The part a note or a build error names: its own name, else its type's. */
function partName(n: ComponentNode): string {
  return `“${n.name ?? own<string>(DISPLAY_NAME, n.type) ?? n.type}”`;
}

/**
 * The field's label as the property panel shows it, in running text:
 * "Wall thickness" → "wall thickness", "Tab depth (0 = none)" → "tab depth".
 * A label that opens with an acronym ("CG override") keeps its capitals.
 */
function fieldLabel(type: string, key: string, fallback?: string): string {
  const def = own<FieldDef[]>(FIELDS, type)?.find((f) => f.key === key);
  const raw = (def?.label ?? fallback ?? key).replace(/\s*\([^)]*\)\s*$/, '');
  return /^[A-Z][a-z]/.test(raw) ? raw.charAt(0).toLowerCase() + raw.slice(1) : raw;
}

/** Six significant digits, float noise shed — how every other import note quotes a number. */
const sig = (v: number): string => String(Number(v.toPrecision(6)));

function fmt(kind: LimitKind, v: number): string {
  switch (kind) {
    case 'count': return sig(v);
    case 'length': return Math.abs(v) >= 1 ? `${sig(v)} m` : `${sig(v * 1000)} mm`;
    case 'mass': return Math.abs(v) >= 1 ? `${sig(v)} kg` : `${sig(v * 1000)} g`;
    case 'density': return `${sig(v)} kg/m³`;
  }
}

/** One out-of-limit value: what is wrong (validator) and what was done (repair). */
interface Finding {
  /** "“Fins”: fin count 70000 is over the limit of 8" — no full stop. */
  problem: string;
  /** "set to 8" — the tail of the import note. */
  repair: string;
}

function limitFinding(
  node: ComponentNode, key: string, limit: FieldLimit, raw: number, fixed: number,
): Finding {
  const what = `${partName(node)}: ${fieldLabel(node.type, key, limit.label)} ${fmt(limit.kind, raw)}`;
  const why = limit.why ? ` (${limit.why})` : '';
  let problem: string;
  if (limit.kind === 'count' && !Number.isInteger(raw) && Math.round(raw) === fixed) {
    problem = `${what} is not a whole number`;
  } else if (limit.hmax !== undefined && raw > limit.hmax) {
    problem = `${what} is over the limit of ${fmt(limit.kind, limit.hmax)}${why}`;
  } else if (limit.hmin === 0 && raw < 0) {
    problem = `${what} cannot be negative`;
  } else {
    problem = `${what} is below the minimum of ${fmt(limit.kind, limit.hmin)}`;
  }
  return { problem, repair: `set to ${fmt(limit.kind, fixed)}` };
}

function enumFinding(node: ComponentNode, label: string, raw: string, limit: EnumLimit): Finding {
  return {
    problem: `${partName(node)}: ${label} “${raw}” is not one the simulation knows`,
    repair: `it now uses ${limit.fallback}`,
  };
}

/** A position's offset: signed, and no part of a real rocket sits a kilometre away. */
const POSITION: FieldLimit = { kind: 'length', hmin: -MAX_DIMENSION_M, hmax: MAX_DIMENSION_M, label: 'position' };

/** The labels an enum field reads under in a note — the panel's are phrased as prompts. */
const ENUM_LABEL: Record<string, string> = {
  airfoilSection: 'supersonic airfoil section',
  separationEvent: 'separation event',
  cluster: 'cluster pattern',
};

/**
 * One node's repairs, and the repaired node (the same object when nothing
 * changed). Children are NOT visited here — `sanitizeTree` walks them.
 */
function sanitizeOwn(n: ComponentNode, found: Finding[]): ComponentNode {
  let next: ComponentNode | null = null;
  const edit = (): ComponentNode => (next ??= { ...n });
  for (const [key, raw] of Object.entries(n)) {
    if (typeof raw !== 'number') continue;
    const limit = fieldLimit(n.type, key);
    if (!limit) continue;
    const fixed = applyFieldLimit(limit, raw);
    if (fixed === raw) continue;
    edit()[key] = fixed;
    found.push(limitFinding(n, key, limit, raw, fixed));
  }
  const pos = n.position;
  if (pos && typeof pos.offset === 'number') {
    const fixed = applyFieldLimit(POSITION, pos.offset);
    if (fixed !== pos.offset) {
      edit().position = { ...pos, offset: fixed };
      found.push(limitFinding(n, 'position', POSITION, pos.offset, fixed));
    }
  }
  for (const [key, limit] of Object.entries(ENUM_LIMITS[n.type] ?? {})) {
    const raw = n[key];
    if (typeof raw !== 'string') continue;
    // The panel's "Classic (from cross section)" option IS the empty string —
    // it means "no section", which is what an absent key means. Not a repair.
    if (raw.trim() === '') { delete edit()[key]; continue; }
    const canon = canonicalEnum(limit.values, raw);
    if (canon === raw) continue;
    if (canon !== null) { edit()[key] = canon; continue; } // same value, canonical spelling — nothing to say
    delete edit()[key];
    found.push(enumFinding(n, ENUM_LABEL[key] ?? key, raw, limit));
  }
  return next ?? n;
}

function walk(nodes: ComponentNode[], found: Finding[]): ComponentNode[] | null {
  let out: ComponentNode[] | null = null;
  nodes.forEach((n, i) => {
    let fixed = sanitizeOwn(n, found);
    const kids = n.children ? walk(n.children, found) : null;
    if (kids) fixed = { ...fixed, children: kids };
    if (fixed !== n) (out ??= nodes.slice())[i] = fixed;
  });
  return out;
}

/**
 * The tree with every value brought inside its hard limit and every unknown
 * enum string dropped to its default — the SAME tree object when nothing
 * needed it, so `normalizeTree`'s identity is untouched for a clean design.
 * Each repair pushes one note onto `notes`, when given.
 */
export function sanitizeTree(tree: RocketTree, notes?: string[]): RocketTree {
  const found: Finding[] = [];
  const components = walk(tree.components, found);
  if (notes) for (const f of found) notes.push(`${f.problem} — ${f.repair}.`);
  return components ? { ...tree, components } : tree;
}

/**
 * A PATCH brought inside the limits table before it is written, one note per
 * repair in the wording the load boundary uses — for a write path that is
 * neither the property panel's typed commit nor a load: a pick from the preset
 * catalogue, which a user's own CSV rows feed too (seam review of audit
 * 2026-09-22). It wrote whatever the row said: the shipped SEMROC HTC-11
 * (inside diameter 49.99 mm over an outside 28.65) stored a -10.668 mm wall,
 * and a CSV canopy of 1,000,000 lines a 540 kg parachute — values a restored
 * session then repaired SILENTLY, which this file's header says only an older
 * build could have let through.
 *
 * Numeric keys only: a preset writes no position and none of ENUM_LIMITS'
 * fields. The note names the part as it will be after the patch, so a pick
 * reads '“SEMROC HTC-11”: wall thickness …' — the words a reopened file would
 * have given. The SAME patch object when nothing needed it.
 */
export function limitPatch(
  node: ComponentNode, patch: Partial<ComponentNode>, notes?: string[],
): Partial<ComponentNode> {
  const after = { ...node, ...patch } as ComponentNode;
  let out: Partial<ComponentNode> | null = null;
  for (const [key, raw] of Object.entries(patch)) {
    if (typeof raw !== 'number') continue;
    const limit = fieldLimit(after.type, key);
    if (!limit) continue;
    const fixed = applyFieldLimit(limit, raw);
    if (fixed === raw) continue;
    (out ??= { ...patch })[key] = fixed;
    if (notes) {
      const f = limitFinding(after, key, limit, raw, fixed);
      notes.push(`${f.problem} — ${f.repair}.`);
    }
  }
  return out ?? patch;
}

/**
 * A stage separation trigger in the kernel's spelling, or null when it names
 * none of the kernel's nine — `OrkEngine.separationEventOf` throws on anything
 * else. For the per-configuration separations, which live outside the tree
 * (a file's flight configurations, a session's saved ones) and so never pass
 * through `sanitizeTree`.
 */
export function separationEventOf(raw: string): string | null {
  return canonicalEnum(SEPARATION_EVENT_VALUES, raw);
}

/** `separationEventOf`, with desktop's default ("ejection") for an unknown value. */
export function separationEventOrDefault(raw: string): string {
  return separationEventOf(raw) ?? 'ejection';
}

/**
 * The import note for an unknown separation event in a flight configuration
 * other than the one opened — worded like the tree pass's own notes, so the
 * banner reads as one list. The opened configuration's value is on the stage
 * node, where `sanitizeTree` reports it.
 */
export function configSeparationNote(stage: ComponentNode, raw: string): string {
  const { fallback } = ENUM_LIMITS['stage']!['separationEvent']!;
  return `${partName(stage)}: separation event “${raw}”, in a flight configuration other than the one `
    + `opened, is not one the simulation knows — that configuration now uses ${fallback}.`;
}

/**
 * Everything in `tree` the kernel is known to refuse or that is outside a hard
 * limit, one sentence per problem, naming the part and the field — the
 * sanitize table read as a validator, plus the freeform outline check the fin
 * editor and the importers already use. Pure: nothing is repaired.
 */
export function treeProblems(tree: RocketTree): string[] {
  const found: Finding[] = [];
  const outlines: string[] = [];
  const visit = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      sanitizeOwn(n, found);
      // Only a STATED outline: a freeform set with no points flies the
      // kernel's own default planform, which is not a problem.
      if (n.type === 'freeformfinset' && Array.isArray(n['points'])) {
        const why = finOutlineProblem(n['points'] as FinOutlinePoint[]);
        if (why) outlines.push(`${partName(n)}: ${why.replace(/\.$/, '')}`);
      }
      visit(n.children ?? []);
    }
  };
  visit(tree.components);
  return [...found.map((f) => f.problem), ...outlines];
}

/** `nodes` with `gone` (and everything under it) left out, by identity. */
const without = (nodes: ComponentNode[], gone: ComponentNode): ComponentNode[] =>
  nodes.filter((n) => n !== gone)
    .map((n) => (n.children ? { ...n, children: without(n.children, gone) } : n));

/**
 * Trial builds `partBlockingBuild` makes at most, after the one of the whole
 * tree: past a hundred parts it gives up and the kernel's text stands.
 */
const MAX_OMISSION_TRIALS = 100;

/**
 * The one part the design builds without, when it does not build whole — the
 * audit's fallback (2026-09-22) for a failure the limits table cannot name: a
 * restored session carrying a component type this build does not know
 * ("Unknown component type: 'widget'"), or anything else the table has no row
 * for. Each part is left out in turn, its children before it, so a bad part is
 * named rather than the tube it sits on.
 *
 * `builds` should be the kernel's `buildTree` ALONE. Measured 2026-09-22 on
 * the 18-part kitchensink.ork fixture (vitest, shipped kernel): 1.8 ms a build,
 * but 73–79 ms with `staticInfo()`, which would be 1.3–1.4 s on every edit while a
 * design stays broken. The failures that only `staticInfo` meets ("NaN …
 * BigInt", "InertiaMatrix … negative") are the out-of-limit values the table
 * already names.
 *
 * Null when the whole tree builds — the failure lay elsewhere (a later stage
 * of the build, a motor), so no part is to blame — when no single omission
 * clears it, or after MAX_OMISSION_TRIALS.
 */
export function partBlockingBuild(
  tree: RocketTree, builds: (t: RocketTree) => boolean, maxTrials = MAX_OMISSION_TRIALS,
): ComponentNode | null {
  if (builds(tree)) return null;
  const order: ComponentNode[] = [];
  const visit = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      visit(n.children ?? []);
      order.push(n);
    }
  };
  visit(tree.components);
  for (const n of order.slice(0, maxTrials)) {
    if (builds({ ...tree, components: without(tree.components, n) })) return n;
  }
  return null;
}

/**
 * The build error the user reads (audit 2026-09-22). The kernel's own text —
 * "The number NaN cannot be converted to a BigInt", "Unknown format
 * conversion: g", "attempted to initialize an InertiaMatrix with a negative
 * inertia value" — names nothing on screen, and the design it describes has
 * lost its mass, stability, Launch and every export. When the validator finds
 * something, the message leads with the part and the field; the kernel's words
 * stay in brackets at the end, because they are what a bug report needs. It
 * says "likely", because the validator knows what is out of limits, not which
 * of those the kernel tripped on. When it finds nothing and `builds` is given,
 * the part the design builds without is named instead (`partBlockingBuild`).
 * Failing both, the kernel's text is returned unchanged — and so it is if
 * either throws on a tree malformed enough to have failed the build: this runs
 * inside App's build catch, where a throw would take the whole app down with
 * the design.
 */
export function explainBuildFailure(
  tree: RocketTree, kernelMessage: string, builds?: (t: RocketTree) => boolean,
): string {
  let problems: string[];
  try {
    problems = treeProblems(tree);
    if (problems.length === 0 && builds) {
      const part = partBlockingBuild(tree, builds);
      if (part) {
        problems = [`${partName(part)}${part.children?.length ? ' or a part inside it' : ''}`
          + ' — the rest of the design builds without it'];
      }
    }
  } catch {
    return kernelMessage;
  }
  if (problems.length === 0) return kernelMessage;
  const shown = problems.slice(0, 3);
  const more = problems.length - shown.length;
  return `This design could not be built. The likely cause${problems.length === 1 ? '' : 's'}: `
    + `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}. `
    + `(The simulation reported: ${kernelMessage})`;
}
