import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finOutlineProblem, type FinOutlinePoint } from './finOutline.js';
import {
  applyFieldLimit, canonicalEnum, DISPLAY_NAME, ENUM_LIMITS, FIELDS, fieldLimit, IGNITION_EVENT_LIMIT,
  IGNITION_EVENT_VALUES, MAX_DIMENSION_M, SEPARATION_EVENT_VALUES,
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
 * A motor's ignition event in the kernel's spelling, or null when it names
 * none of the kernel's five — `OrkEngine.ignitionEventOf` throws on anything
 * else, where desktop drops it with a warning and keeps AUTOMATIC
 * (MotorMountHandler, IgnitionConfigurationHandler). Ignition lives on the
 * motor, not the tree, so this is the .ork reader's to call.
 */
export function ignitionEventOf(raw: string): string | null {
  return canonicalEnum(IGNITION_EVENT_VALUES, raw);
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

/** The import note for a motor ignition event the kernel does not know. */
export function ignitionNote(mount: ComponentNode, raw: string): string {
  const f = enumFinding(mount, 'motor ignition event', raw, IGNITION_EVENT_LIMIT);
  return `${f.problem} — ${f.repair}.`;
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

/**
 * The build error the user reads (audit 2026-09-22). The kernel's own text —
 * "The number NaN cannot be converted to a BigInt", "Unknown format
 * conversion: g", "attempted to initialize an InertiaMatrix with a negative
 * inertia value" — names nothing on screen, and the design it describes has
 * lost its mass, stability, Launch and every export. When the validator finds
 * something, the message leads with the part and the field; the kernel's words
 * stay in brackets at the end, because they are what a bug report needs. It
 * says "likely", because the validator knows what is out of limits, not which
 * of those the kernel tripped on. When it finds nothing, the kernel's text is
 * returned unchanged — and so it is if the validator itself throws on a tree
 * malformed enough to have failed the build: this runs inside App's build
 * catch, where a throw would take the whole app down with the design.
 */
export function explainBuildFailure(tree: RocketTree, kernelMessage: string): string {
  let problems: string[];
  try {
    problems = treeProblems(tree);
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
