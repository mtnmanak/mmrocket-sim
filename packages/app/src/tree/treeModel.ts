import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { resolveAbsolutePositions } from './position.js';
import { defaultParams, DISPLAY_NAME, FIELDS, type EditorComponentType } from './schema.js';

/**
 * Immutable tree-editing helpers. Every node carries a unique editor id
 * (also used by the engine's setMotorById). All operations return new trees.
 */

let counter = 1;

export function freshId(): string {
  return `c${counter++}`;
}

/**
 * Bumps the id counter past every `c<N>` id already in the tree. Restored
 * sessions and opened files carry ids minted by a PREVIOUS page load; without
 * reseeding, the first freshId() after a reload collides with them (duplicate
 * ids break selection, updateNode and setMotorById).
 */
function reseedIds(tree: RocketTree): void {
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      const m = n.id ? /^c(\d+)$/.exec(n.id) : null;
      if (m) counter = Math.max(counter, Number(m[1]) + 1);
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
}

export function makeNode(type: EditorComponentType): ComponentNode {
  return {
    type,
    id: freshId(),
    name: DISPLAY_NAME[type],
    ...defaultParams(type),
  } as ComponentNode;
}

export function findNode(tree: RocketTree, id: string): ComponentNode | null {
  const walk = (nodes: ComponentNode[]): ComponentNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.components);
}

/**
 * Post-Release-C invariant: tree.components is ALWAYS a list of stage nodes
 * (the desktop model — stage 0 on top, boosters after). Legacy flat trees
 * (pre-v0.009 sessions/files) are wrapped by normalizeTree at every load
 * boundary. The engine accepts both shapes.
 */
export function normalizeTree(tree: RocketTree): RocketTree {
  reseedIds(tree);
  tree = resolveAbsolutePositions(tree);
  if (tree.components.length === 0) {
    return { ...tree, components: [makeStage('Sustainer')] };
  }
  if (tree.components.every((n) => n.type === 'stage')) {
    // Already staged — just guarantee ids (older data may lack them).
    let changed = false;
    const components = tree.components.map((s) => {
      if (s.id) return s;
      changed = true;
      return { ...s, id: freshId() } as ComponentNode;
    });
    return changed ? { ...tree, components } : tree;
  }
  if (tree.components.some((n) => n.type === 'stage')) {
    // Mixed list (no importer produces this, but defend the invariant):
    // fold each loose node into the nearest preceding stage.
    const components: ComponentNode[] = [];
    for (const n of tree.components) {
      if (n.type === 'stage') {
        components.push(n.id ? n : ({ ...n, id: freshId() } as ComponentNode));
      } else {
        if (components.length === 0) components.push(makeStage('Sustainer'));
        const last = components[components.length - 1]!;
        components[components.length - 1] = {
          ...last,
          children: [...(last.children ?? []), n],
        } as ComponentNode;
      }
    }
    return { ...tree, components };
  }
  return {
    ...tree,
    components: [{ ...makeStage('Sustainer'), children: tree.components } as ComponentNode],
  };
}

export function makeStage(name: string): ComponentNode {
  return { type: 'stage', id: freshId(), name, children: [] } as ComponentNode;
}

/** The stage nodes, top (sustainer) first. */
export function stages(tree: RocketTree): ComponentNode[] {
  return tree.components.filter((n) => n.type === 'stage');
}

/**
 * Tree components as a stage-node list for the file exporters — legacy flat
 * trees (pre-v0.009 tests/back-compat callers) wrap into one implicit
 * Sustainer. Normalized app trees pass through unchanged.
 */
export function asStageNodes(tree: RocketTree): ComponentNode[] {
  return tree.components.every((c) => c.type === 'stage')
    ? tree.components
    : [{ type: 'stage', name: 'Sustainer', children: tree.components } as ComponentNode];
}

/** Appends a booster stage below the existing ones. */
export function addStage(tree: RocketTree): { tree: RocketTree; newId: string } {
  const n = stages(tree).length;
  const stage = makeStage(n === 0 ? 'Sustainer' : n === 1 ? 'Booster' : `Booster ${n}`);
  return { tree: { ...tree, components: [...tree.components, stage] }, newId: stage.id! };
}

/** Index of the stage containing the node (0 = sustainer), or -1. */
export function stageIndexOf(tree: RocketTree, id: string): number {
  const contains = (n: ComponentNode): boolean =>
    n.id === id || (n.children ?? []).some(contains);
  return tree.components.findIndex((s) => s.id === id || (s.children ?? []).some(contains));
}

export function findParent(tree: RocketTree, id: string): ComponentNode | 'stage' | null {
  // 'stage' now means "the rocket root" — only stage nodes live there.
  if (tree.components.some((n) => n.id === id)) return 'stage';
  const walk = (nodes: ComponentNode[]): ComponentNode | null => {
    for (const n of nodes) {
      if ((n.children ?? []).some((c) => c.id === id)) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.components);
}

/**
 * The chain from a node's parent up to the stage it lives in, nearest first.
 *
 * Used to tell a user their override is being SUPPRESSED: OpenRocket's
 * "override for all subcomponents" flag makes an ancestor's figure stand for
 * its whole subtree, so anything set below it — geometry AND its own overrides
 * — stops contributing. Without a notice that is invisible: you type a mass,
 * nothing changes, and there is nothing on screen to say why.
 */
export function ancestorsOf(tree: RocketTree, id: string): ComponentNode[] {
  const chain: ComponentNode[] = [];
  const walk = (nodes: ComponentNode[], path: ComponentNode[]): boolean => {
    for (const n of nodes) {
      if (n.id === id) {
        chain.push(...[...path].reverse());
        return true;
      }
      if (walk(n.children ?? [], [...path, n])) return true;
    }
    return false;
  };
  walk(tree.components, []);
  return chain;
}

/**
 * The nearest ancestor whose "Use instead of everything inside" actually suppresses this
 * node's own value for the given quantity, or null when nothing does.
 *
 * BOTH conditions are required, exactly as the kernel requires them —
 * RocketComponent.isCDOverriddenByAncestor is
 * `parent.isCDOverridden() && parent.isSubcomponentsOverriddenCD()`. The flag
 * alone suppresses nothing, and it CAN stand alone: a .ork may carry
 * `<overridesubcomponentsmass>true</overridesubcomponentsmass>` with no
 * `<overridemass>`, and readOverrides preserves the flag either way. Testing
 * the flag on its own would tell a user their value is being covered when it
 * is doing exactly what they typed.
 */
export function suppressingAncestor(
  tree: RocketTree,
  id: string,
  flagKey: string,
  valueKey: string,
): ComponentNode | null {
  return ancestorsOf(tree, id)
    .find((a) => a[flagKey] === true && typeof a[valueKey] === 'number') ?? null;
}

export function updateNode(
  tree: RocketTree,
  id: string,
  patch: Partial<ComponentNode>,
): RocketTree {
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) =>
      n.id === id
        ? ({ ...n, ...patch } as ComponentNode)
        : n.children
          ? ({ ...n, children: walk(n.children) } as ComponentNode)
          : n,
    );
  return { ...tree, components: walk(tree.components) };
}

export function removeNode(tree: RocketTree, id: string): RocketTree {
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes
      .filter((n) => n.id !== id)
      .map((n) => (n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n));
  return { ...tree, components: walk(tree.components) };
}

/** Adds a child to the given parent id ('stage' = the FIRST stage, legacy). */
export function addChild(tree: RocketTree, parentId: string | 'stage', child: ComponentNode): RocketTree {
  if (parentId === 'stage') {
    const first = stages(tree)[0];
    if (!first) return { ...tree, components: [...tree.components, child] };
    parentId = first.id!;
  }
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) =>
      n.id === parentId
        ? ({ ...n, children: [...(n.children ?? []), child] } as ComponentNode)
        : n.children
          ? ({ ...n, children: walk(n.children) } as ComponentNode)
          : n,
    );
  return { ...tree, components: walk(tree.components) };
}

/** Moves a node up/down among its siblings. */
export function moveNode(tree: RocketTree, id: string, dir: -1 | 1): RocketTree {
  const shift = (nodes: ComponentNode[]): ComponentNode[] => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) {
      const to = idx + dir;
      if (to < 0 || to >= nodes.length) return nodes;
      const out = [...nodes];
      const [n] = out.splice(idx, 1);
      out.splice(to, 0, n!);
      return out;
    }
    return nodes.map((n) => (n.children ? ({ ...n, children: shift(n.children) } as ComponentNode) : n));
  };
  return { ...tree, components: shift(tree.components) };
}

/**
 * Hoerner protuberance drag coefficients referenced to FRONTAL area (W·H),
 * interference with the body boundary layer included (Fluid-Dynamic Drag,
 * ch. 5 & 8 — canonical surface-protuberance values, calibratable).
 */
const FAIRING_CD_FRONTAL: Record<string, number> = {
  streamlined: 0.25,
  halfround: 0.55,
  box: 1.05,
};

/**
 * Protuberance drag coefficients, referenced to the bump's FRONTAL area, built
 * from the two terms RASAero's own class names name (Users Manual pp. 24–29:
 * "streamlined front end and a streamlined or boattailed aft end" vs
 * "streamlined front end, but a blunt (flat) back end which has base drag").
 *
 * - fore 0.10 — Hoerner, *Fluid-Dynamic Drag*: a faired half-body sitting on a
 *   surface, frontal-area referenced, boundary-layer interference included
 *   (a free-stream streamline body of revolution is ~0.05; mounting roughly
 *   doubles it). Same family as FAIRING_CD_FRONTAL above.
 * - base 0.12 — a blunt aft face with attached approach flow. Deliberately the
 *   value OpenRocket's own body base-drag law (0.12 + 0.13·M²) takes at M = 0,
 *   so the app is not inventing a second base-drag constant.
 * - plate 1.17·sin²θ — modified-Newtonian ramp pressure (Cp = 2 sin²θ) scaled
 *   to the measured 3-D flat-plate normal value 1.17 at θ = 90°, referenced to
 *   the plate's PROJECTED (frontal) area, which is the area RASAero asks for.
 *
 * CROSS-CHECKS (measured 2026-08-25, ARCAS Long fixture, Re-matched machAlt):
 * 1. OpenRocket's own RailButtonCalc — NACA TN 2960 cylinder drag with a
 *    boundary-layer velocity average, the only protuberance model in the carved
 *    kernel — delivers an effective frontal-area Cd of 0.142 (M0.3) rising to
 *    0.465 (M2.95) for a default 9.7 mm button on this rocket. 0.22 sits inside
 *    that band.
 * 2. Chuck Rogers' own ARCAS write-up ("RASAero II Comparisons with ARCAS CP
 *    and CD Data", slide 2) enters the four fin-root anchors by dividing their
 *    frontal area by five because "typically a rail guide will have 5 times the
 *    drag of a typical rocket body" — i.e. Cd(anchor) = Cd(rail guide)/5. With
 *    a rail guide as a near-normal blunt bracket (1.17 here), that is 0.234,
 *    against the 0.22 this table gives them.
 *
 * KNOWN LIMITATION: these are Mach-FLAT. The kernel hook is a scalar
 * `overrideCD`, so the lowered contribution cannot vary with Mach the way
 * RASAero's protuberance column or the kernel's own rail-button model does.
 * For actual rail buttons prefer the `railbutton` component, which gets
 * OpenRocket's Mach- and boundary-layer-dependent treatment.
 */
const PROTUBERANCE_FORE_CD = 0.10;
const PROTUBERANCE_BASE_CD = 0.12;
const PROTUBERANCE_PLATE_CD = 1.17;

/** Frontal-area Cd for a protuberance node (explicit `cdFrontal` wins). */
export function protuberanceCd(node: ComponentNode): number {
  const explicit = node['cdFrontal'];
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const cls = typeof node['dragClass'] === 'string' ? (node['dragClass'] as string) : 'streamlinedbase';
  if (cls === 'streamlined') return PROTUBERANCE_FORE_CD;
  if (cls === 'plate') {
    const raw = typeof node['plateAngle'] === 'number' ? (node['plateAngle'] as number) : Math.PI / 4;
    const theta = Math.min(Math.PI / 2, Math.max(0, raw)); // radians, 0..90 deg
    return PROTUBERANCE_PLATE_CD * Math.sin(theta) ** 2;
  }
  return PROTUBERANCE_FORE_CD + PROTUBERANCE_BASE_CD;
}

/** Total frontal area (m²) a protuberance node presents: width × height × count. */
export function protuberanceFrontalArea(node: ComponentNode): number {
  const w = typeof node['width'] === 'number' ? (node['width'] as number) : 0.02;
  const h = typeof node['height'] === 'number' ? (node['height'] as number) : 0.01;
  const c = typeof node['count'] === 'number' ? Math.max(1, Math.round(node['count'] as number)) : 1;
  return Math.max(0, w) * Math.max(0, h) * c;
}

/**
 * The rocket's aerodynamic reference area (m²) — π·R² of the airframe's
 * greatest radius, which is the kernel's own reference (`referencetype
 * maximum`). Shared by engineTree and the property panel so the CD a user
 * reads is the CD that reaches the kernel.
 */
export function referenceArea(tree: RocketTree): number {
  let maxR = 0.001;
  const nnum = (n: ComponentNode, key: string): number =>
    typeof n[key] === 'number' ? (n[key] as number) : 0;
  const scan = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      maxR = Math.max(maxR, nnum(n, 'aftRadius'), nnum(n, 'outerRadius'), nnum(n, 'foreRadius'));
      scan(n.children ?? []);
    }
  };
  scan(tree.components);
  return Math.PI * maxR * maxR;
}

/**
 * What a protuberance actually adds to the rocket's CD: frontal area × Cd,
 * referenced to the rocket's own reference area — exactly the number handed to
 * the kernel as an override, and exactly what the kernel adds to total CD
 * (measured: asked 0.0134303, delivered 0.0134303 at every Mach).
 */
export function protuberanceDeliveredCd(tree: RocketTree, node: ComponentNode): number {
  return (protuberanceCd(node) * protuberanceFrontalArea(node))
    / Math.max(referenceArea(tree), 1e-9);
}

/**
 * Engine-boundary transform: app-level modeling the kernel doesn't carry.
 * Pure — the editing tree is untouched; node ids are preserved (setMotorById,
 * componentInfo and selection all keep working).
 *
 * 1. Parachute spill holes: the kernel Parachute knows only Cd, so a hole
 *    becomes the standard area-equivalent reduction
 *    cd_eff = cd · (1 − (d_hole/D)²) (RockSim's treatment).
 * 2. Camera shrouds ('fairing'): lowered to a kernel 1-fin freeform strake of
 *    the shroud's side profile — Barrowman's low-aspect-ratio fin lift IS the
 *    slender-strake (Jones) model, so the CP shift comes out of the real
 *    kernel — plus a component-CD override for the protuberance drag
 *    (frontal-area Hoerner value scaled to the rocket reference area) and the
 *    as-built mass as a mass override. Radial mounting angle not modeled.
 * 3. Protuberances ('protuberance'): lowered to a kernel RailButton carrying a
 *    CD override and a mass override, which is the CHEAPEST CORRECT carrier —
 *    MEASURED on the ARCAS Long fixture (2026-08-25):
 *      • the delivered CD is EXACTLY the override (0.0134303 asked, 0.0134303
 *        delivered at every Mach from 0.3 to 4.65),
 *      • friction, pressure and base CD all move by 0.0000000 — BarrowmanCalculator
 *        skips a CD-overridden component in all three loops,
 *      • mass, CG, CP and the warning set all move by exactly 0,
 *    and RailButtonCalc.calculateNonaxialForces is empty, so a protuberance
 *    contributes no normal force — which is what RASAero does too.
 *    A LAUNCH LUG was rejected as the carrier despite measuring identically:
 *    SimulationStatus (24.12, ll. 138–162) shortens the effective launch rod
 *    length to the aft-most LaunchLug, so a synthetic lug would quietly change
 *    guide-exit velocity. Nothing in the kernel's simulation reads RailButton.
 */
export function engineTree(tree: RocketTree): RocketTree {
  const KERNEL_DEFAULT_CD = 0.8;
  const nnum = (n: ComponentNode, key: string, fb: number): number =>
    typeof n[key] === 'number' ? (n[key] as number) : fb;

  // Rocket reference diameter = the airframe's max diameter (kernel rule).
  const aRef = referenceArea(tree);

  const walk = (nodes: ComponentNode[]): ComponentNode[] => nodes.map((n) => {
    if ((n.type as string) === 'protuberance') {
      const area = protuberanceFrontalArea(n);
      const cd = protuberanceCd(n);
      // The carrier's own geometry is inert (its friction/pressure/base are all
      // skipped under the override) — kept in a sane range purely so nothing
      // downstream sees a degenerate component.
      const od = Math.min(0.05, Math.max(0.001, Math.sqrt(Math.max(area, 1e-8))));
      return {
        type: 'railbutton',
        id: n.id,
        name: n.name ?? 'Protuberance',
        outerDiameter: od,
        position: n.position,
        overrideCD: (cd * area) / Math.max(aRef, 1e-9),
        overrideMass: Math.max(0, nnum(n, 'mass', 0)),
      } as ComponentNode;
    }
    if (n.type === 'fairing') {
      const L = nnum(n, 'length', 0.08);
      const W = nnum(n, 'width', 0.025);
      const H = nnum(n, 'height', 0.02);
      const shape = typeof n['fairingShape'] === 'string' ? (n['fairingShape'] as string) : 'halfround';
      const cdFrontal = FAIRING_CD_FRONTAL[shape] ?? FAIRING_CD_FRONTAL['halfround']!;
      const pts: [number, number][] = shape === 'streamlined'
        ? [[0, 0], [0.3 * L, H], [0.7 * L, H], [L, 0]]
        : [[0, 0], [0, H], [L, H], [L, 0]];
      return {
        type: 'freeformfinset',
        id: n.id,
        name: n.name ?? 'Camera shroud',
        finCount: 1,
        thickness: W,
        crossSection: 'rounded',
        points: pts,
        position: n.position,
        overrideMass: nnum(n, 'mass', 0.03),
        overrideCD: (cdFrontal * W * H) / Math.max(aRef, 1e-9),
        ...(typeof n['finish'] === 'string' ? { finish: n['finish'] } : {}),
      } as ComponentNode;
    }
    let next: ComponentNode = n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n;
    const dh = typeof n['spillHoleDiameter'] === 'number' ? (n['spillHoleDiameter'] as number) : 0;
    if (n.type === 'parachute' && dh > 0) {
      const D = typeof n['diameter'] === 'number' ? (n['diameter'] as number) : 0.3;
      const hole = Math.min(dh, D * 0.95);
      const base = typeof n['cd'] === 'number' ? (n['cd'] as number) : KERNEL_DEFAULT_CD;
      next = { ...next, cd: base * (1 - (hole / D) ** 2) } as ComponentNode;
    }
    return next;
  });
  return { ...tree, components: walk(tree.components) };
}

export interface ClusterSplit {
  tree: RocketTree;
  /** The symmetric group mounts replacing the original cluster mount. */
  mountIds: string[];
  /** Motors per group. */
  groupSize: number;
  pattern: '4-ring' | '6-ring';
}

/**
 * Combination batching (2026-08-05 chat): split a 4-ring / 6-ring cluster
 * mount into TWO symmetric group mounts occupying the SAME tube positions —
 * a 4-ring becomes two 'double' mounts on its diagonals (scale ×√2, ±45°),
 * a 6-ring two '3-ring' mounts on alternating tubes (scale ×√3, 0°/60°).
 * One motor type per kernel cluster mount is the engine's rule, so this is
 * exactly the two-group symmetric arrangement the owner described (2+2 / 3+3).
 * Pure; returns null for anything that isn't a 4-ring/6-ring inner tube.
 */
export function splitClusterTree(tree: RocketTree, mountId: string): ClusterSplit | null {
  const mount = findNode(tree, mountId);
  if (!mount || mount.type !== 'innertube') return null;
  const pattern = mount['cluster'];
  if (pattern !== '4-ring' && pattern !== '6-ring') return null;
  const s = typeof mount['clusterScale'] === 'number' ? (mount['clusterScale'] as number) : 1;
  const phi = typeof mount['clusterRotation'] === 'number' ? (mount['clusterRotation'] as number) : 0;
  const mk = (sub: string, scaleMul: number, rotAdd: number, suffix: string): ComponentNode => ({
    ...mount,
    id: freshId(),
    name: `${mount.name ?? 'Motor mount'} ${suffix}`,
    cluster: sub,
    clusterScale: s * scaleMul,
    clusterRotation: phi + rotAdd,
    children: mount.children?.map(cloneSubtree),
  } as ComponentNode);
  const groups = pattern === '4-ring'
    ? [mk('double', Math.SQRT2, Math.PI / 4, '(pair A)'), mk('double', Math.SQRT2, (3 * Math.PI) / 4, '(pair B)')]
    : [mk('3-ring', Math.sqrt(3), 0, '(trio A)'), mk('3-ring', Math.sqrt(3), Math.PI / 3, '(trio B)')];
  const walk = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap((n) => {
    if (n.id === mountId) return groups;
    return [n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n];
  });
  return {
    tree: { ...tree, components: walk(tree.components) },
    mountIds: groups.map((g) => g.id!),
    groupSize: pattern === '4-ring' ? 2 : 3,
    pattern,
  };
}

/**
 * PAIR-level split of a 6-ring: THREE 'double' mounts, one per opposite-tube
 * pair (hexagon diagonals at 90°/30°/−30° + the base rotation, scale ×2 so
 * each pair's tubes land on the original circumradius). Every pair is
 * individually thrust-balanced, so ANY per-pair motor assignment is
 * symmetric — the owner's real-world 2+2+2 (and 4+2) practice (2026-08-05d).
 * A 4-ring's pair split is already splitClusterTree. Null otherwise.
 */
export function splitClusterPairsTree(tree: RocketTree, mountId: string): ClusterSplit | null {
  const mount = findNode(tree, mountId);
  if (!mount || mount.type !== 'innertube' || mount['cluster'] !== '6-ring') return null;
  const s = typeof mount['clusterScale'] === 'number' ? (mount['clusterScale'] as number) : 1;
  const phi = typeof mount['clusterRotation'] === 'number' ? (mount['clusterRotation'] as number) : 0;
  const mk = (rotAdd: number, suffix: string): ComponentNode => ({
    ...mount,
    id: freshId(),
    name: `${mount.name ?? 'Motor mount'} ${suffix}`,
    cluster: 'double',
    clusterScale: s * 2,
    clusterRotation: phi + rotAdd,
    children: mount.children?.map(cloneSubtree),
  } as ComponentNode);
  const groups = [
    mk(Math.PI / 2, '(pair A)'),
    mk(Math.PI / 6, '(pair B)'),
    mk(-Math.PI / 6, '(pair C)'),
  ];
  const walk = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap((n) => {
    if (n.id === mountId) return groups;
    return [n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n];
  });
  return {
    tree: { ...tree, components: walk(tree.components) },
    mountIds: groups.map((g) => g.id!),
    groupSize: 2,
    pattern: '6-ring',
  };
}

/** Deep copy with fresh ids at every level (clipboard paste, duplicate). */
export function cloneSubtree(node: ComponentNode): ComponentNode {
  return {
    ...node,
    id: freshId(),
    children: node.children?.map(cloneSubtree),
  } as ComponentNode;
}

/**
 * Deep-copies a node (fresh ids throughout) and inserts the copy right after
 * the original among its siblings. Returns the new tree and the copy's id.
 */
export function duplicateNode(tree: RocketTree, id: string): { tree: RocketTree; newId: string | null } {
  let newId: string | null = null;
  const walk = (nodes: ComponentNode[]): ComponentNode[] => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) {
      const copy = cloneSubtree(nodes[idx]!);
      copy.name = nodes[idx]!.name ? `${nodes[idx]!.name} (copy)` : copy.name;
      newId = copy.id!;
      return [...nodes.slice(0, idx + 1), copy, ...nodes.slice(idx + 1)];
    }
    return nodes.map((n) => (n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n));
  };
  return { tree: { ...tree, components: walk(tree.components) }, newId };
}

/** Applies a patch to EVERY node that carries the patched fields. */
export function updateAllNodes(tree: RocketTree, patch: Partial<ComponentNode>): RocketTree {
  const keys = Object.keys(patch);
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) => {
      const applicable = keys.every((k) => FIELDS[n.type]?.some((f) => f.key === k));
      const next = applicable ? ({ ...n, ...patch } as ComponentNode) : n;
      return next.children ? ({ ...next, children: walk(next.children) } as ComponentNode) : next;
    });
  return { ...tree, components: walk(tree.components) };
}

/** The radius a component presents at its AFT end (for chain continuity). */
function aftRadiusOf(n: ComponentNode): number | null {
  if (typeof n['aftRadius'] === 'number') return n['aftRadius'] as number;
  if (typeof n['outerRadius'] === 'number') return n['outerRadius'] as number;
  return null;
}

/**
 * New components default to the specs of the component they follow: outer
 * diameter continues the airframe line, and material/finish carry over
 * (from the previous sibling, else the parent).
 */
export function inheritDefaults(
  node: ComponentNode,
  parent: ComponentNode | 'stage' | null,
  prevSibling: ComponentNode | null,
): ComponentNode {
  const src = prevSibling ?? (parent && parent !== 'stage' && parent.type !== 'stage' ? parent : null);
  if (!src) return node;
  const out: ComponentNode = { ...node };

  const fields = FIELDS[node.type] ?? [];
  for (const key of ['density', 'materialName', 'finish'] as const) {
    // materialName has no FIELDS entry; it travels with density — only copy
    // it onto types that can hold the matching density.
    const applies = key === 'materialName'
      ? fields.some((f) => f.key === 'density')
      : fields.some((f) => f.key === key);
    if (src[key] !== undefined && applies) {
      (out as Record<string, unknown>)[key] = src[key];
    }
  }

  // Airframe diameter continuity along the top-level chain.
  const srcAft = aftRadiusOf(src);
  if (srcAft !== null) {
    if (node.type === 'bodytube') out['outerRadius'] = srcAft;
    if (node.type === 'transition') out['foreRadius'] = srcAft;
  }
  // Tube walls: carry the previous tube's thickness.
  if (typeof src['thickness'] === 'number'
      && (node.type === 'bodytube' || node.type === 'innertube' || node.type === 'tubecoupler')
      && fields.some((f) => f.key === 'thickness')) {
    out['thickness'] = src['thickness'];
  }
  return out;
}

/** True if the tree contains a separating parallel stage (booster) anywhere. */
export function hasParallelStage(tree: RocketTree): boolean {
  const scan = (nodes: ComponentNode[]): boolean =>
    nodes.some((n) => n.type === 'parallelstage' || scan(n.children ?? []));
  return scan(tree.components);
}

/**
 * All tubes flagged as motor mounts (for the motor panel): inner tubes, plus
 * body tubes for minimum-diameter rockets where the motor loads directly in
 * the airframe (kernel BodyTube implements MotorMount, same as the desktop).
 */
export function motorMounts(tree: RocketTree): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if ((n.type === 'innertube' || n.type === 'bodytube') && n['motorMount'] === true) out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return out;
}

/** A blank design — one empty stage — for starting from scratch. */
export function emptyTree(): RocketTree {
  return { name: 'New Rocket', components: [makeStage('Sustainer')] };
}

/** The default (reference) rocket as a tree. */
export function defaultTree(): RocketTree {
  const nose = makeNode('nosecone');
  const body = { ...makeNode('bodytube'), length: 0.3, thickness: 0.0003, density: 950 } as ComponentNode;
  const fins = makeNode('trapezoidfinset');
  const mount = makeNode('innertube');
  const chute = makeNode('parachute');
  return normalizeTree({
    name: 'My Rocket',
    components: [nose, { ...body, children: [fins, mount, chute] } as ComponentNode],
  });
}
