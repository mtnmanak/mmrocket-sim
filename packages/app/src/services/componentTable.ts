import type { ComponentInfo, ComponentNode, RocketTree } from '@online-openrocket/engine';
import { clusterCount } from '../tree/cluster.js';
import { numOpt } from '../tree/nodeNum.js';
import { DISPLAY_NAME, FIELDS, type FieldDef } from '../tree/schema.js';
import { asStageNodes, flownInstanceCount, kernelStageIdByNode } from '../tree/treeModel.js';
import { siToUi, type Quantity, type UnitSelection } from '../prefs/units.js';
import { csvCell } from './csvUtil.js';
import type { Cell } from './xlsx.js';

/**
 * Component data export (issue 2026-08-11a): every component and its
 * attributes as a flat table, for sharing measurement data with people who
 * don't run a simulator. Values are in the USER'S units (headers say which),
 * numbers stay numbers (typed xlsx cells), and the engine's computed
 * mass/CG/position ride along where available — those are the numbers a
 * cert package actually wants.
 *
 * WHAT THE KERNEL CARRIES, NOT ONE COPY OF IT (audit 2026-09-22, row 361).
 * `ComponentInfo.mass` and `.sectionMass` are the kernel's per-COMPONENT
 * getters — one pod's worth for a part inside a pod set, one tube's children
 * for a clustered mount — while the flight carries every copy
 * (`MassCalculation.calculateStructure` recurses once per instance). So the
 * table listed a two-pod set at 10.53 g where the kernel flies 21.05 g, and
 * filed a strap-on's parts under the core stage they separate from. Each row
 * now says how many copies fly (`Copies flown`: every enclosing pod set's and
 * strap-on's count, and a clustered mount's pattern for what is inside it),
 * both mass columns count all of them, and the Stage column is the kernel's
 * own (`kernelStageIdByNode`: a strap-on's parts belong to the strap-on).
 */

export interface ComponentTablePrefs {
  units: UnitSelection;
  radiusMode: 'radius' | 'diameter';
}

/** Field units (schema "legacy" authoring units) → preference quantity. */
const QUANTITY: Partial<Record<FieldDef['unit'], Quantity>> = {
  mm: 'length',
  m: 'distance',
  deg: 'angle',
  g: 'mass',
  'kg/m3': 'density',
};

const round = (v: number): number => Number(v.toPrecision(6));

export interface ComponentTable {
  headers: string[];
  rows: Cell[][];
}

export function componentTable(
  tree: RocketTree,
  prefs: ComponentTablePrefs,
  infoFor?: (id: string) => ComponentInfo | null,
): ComponentTable {
  const asDia = prefs.radiusMode === 'diameter';
  const lenSym = prefs.units.length;
  const massSym = prefs.units.mass;

  const toUi = (f: FieldDef, si: number): number => {
    const q = QUANTITY[f.unit];
    const geom = f.radius === true && asDia ? 2 : 1;
    return round(q ? siToUi(q, prefs.units[q], si * geom) : si * geom);
  };
  const fieldHeader = (f: FieldDef): string => {
    const label = f.radius === true && asDia
      ? f.label.replace(/radius/gi, (m) => (m[0] === 'R' ? 'Diameter' : 'diameter'))
      : f.label;
    const q = QUANTITY[f.unit];
    const suffix = q ? ` (${prefs.units[q]})` : f.unit === 's' ? ' (s)' : '';
    return `${label}${suffix}`;
  };

  // Column union across the component types present, in schema (FIELDS)
  // order so the layout is stable run to run. The fixed Length column
  // already covers the 'length' param.
  const present = new Set<string>();
  const walkTypes = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      present.add(n.type);
      walkTypes(n.children ?? []);
    }
  };
  walkTypes(tree.components);
  const fieldCols: FieldDef[] = [];
  const seen = new Set<string>();
  for (const [type, fields] of Object.entries(FIELDS)) {
    // Stage rows aren't emitted (stages are the grouping column), so stage
    // fields (separation etc.) would be permanently-empty columns.
    if (!present.has(type) || type === 'stage') continue;
    for (const f of fields) {
      if (f.key === 'length' || seen.has(f.key)) continue;
      seen.add(f.key);
      fieldCols.push(f);
    }
  }

  const headers = [
    'Component', 'Type', 'Stage', 'Parent', 'Material',
    `Starts at (${lenSym} from nose tip)`, `Length (${lenSym})`,
    'Copies flown', `Mass (${massSym})`, `Mass with children (${massSym})`,
    `CG (${lenSym} from component front)`,
    ...fieldCols.map(fieldHeader),
  ];

  const rows: Cell[][] = [];
  const uiLen = (si: number): number => round(siToUi('length', lenSym, si));
  const uiMass = (si: number): number => round(siToUi('mass', massSym, si));

  // The KERNEL's stage for every node: a strap-on's parts are the strap-on's.
  // A legacy flat tree has no stage ids, so it keeps the grouping below.
  const stageNames = new Map<string, string>();
  const nameStages = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if ((n.type === 'stage' || n.type === 'parallelstage') && n.id) {
        stageNames.set(n.id, n.name ?? DISPLAY_NAME[n.type] ?? n.type);
      }
      nameStages(n.children ?? []);
    }
  };
  nameStages(tree.components);
  const kernelStage = kernelStageIdByNode(tree);
  const infoOf = (n: ComponentNode): ComponentInfo | null => (n.id && infoFor ? infoFor(n.id) : null);

  /**
   * The mass the kernel flies for this node and everything under it, `mult`
   * copies of it — or null when any part of it has no kernel figure, because
   * a sum short by a part is worse than a blank. A node whose own override
   * stands for its subtree (`getSectionMass`'s rule) is that override alone.
   */
  const flownSection = (n: ComponentNode, mult: number): number | null => {
    const info = infoOf(n);
    if (!info) return null;
    let total = info.mass * mult;
    // A finite override, as the kernel reads one (audit row 522).
    if (n['overrideSubcomponentsMass'] === true && numOpt(n, 'overrideMass') !== undefined) return total;
    const inner = mult * copiesInside(n);
    for (const c of n.children ?? []) {
      const sub = flownSection(c, inner);
      if (sub == null) return null;
      total += sub;
    }
    return total;
  };

  const walk = (nodes: ComponentNode[], stageName: string, parentName: string, mult: number) => {
    for (const n of nodes) {
      const info = infoOf(n);
      const section = info && (n.children ?? []).length > 0 ? flownSection(n, mult) : null;
      const fieldCells = fieldCols.map((f): Cell => {
        const raw = n[f.key];
        if (f.bool) return raw === true ? 'yes' : raw === false ? 'no' : '';
        if (f.options) {
          if (typeof raw !== 'string') return '';
          return f.options.find(([v]) => v === raw)?.[1] ?? raw;
        }
        // A non-finite value is a blank cell, not "NaN" (audit row 522).
        const si = numOpt(n, f.key);
        return si !== undefined ? toUi(f, si) : '';
      });
      const ownLength = numOpt(n, 'length');
      const kStage = n.id ? kernelStage.get(n.id) : undefined;
      rows.push([
        n.name ?? DISPLAY_NAME[n.type] ?? n.type,
        DISPLAY_NAME[n.type] ?? n.type,
        (kStage !== undefined ? stageNames.get(kStage) : undefined) ?? stageName,
        parentName,
        typeof n['materialName'] === 'string' ? (n['materialName'] as string) : '',
        info ? uiLen(info.positionX) : '',
        info ? uiLen(info.length) : ownLength !== undefined ? uiLen(ownLength) : '',
        mult,
        info ? uiMass(info.mass * mult) : '',
        info && section != null && section > info.mass * mult + 1e-9 ? uiMass(section) : '',
        info ? uiLen(info.cgX) : '',
        ...fieldCells,
      ]);
      walk(n.children ?? [], stageName, n.name ?? DISPLAY_NAME[n.type] ?? n.type, mult * copiesInside(n));
    }
  };

  for (const stage of asStageNodes(tree)) {
    const stageName = stage.name ?? 'Stage';
    walk(stage.children ?? [], stageName, stageName, 1);
  }

  return { headers, rows };
}

/**
 * How many copies of each child the kernel builds inside `n`: a pod set's or
 * strap-on's instance count (read as the kernel reads it), a clustered mount's
 * pattern — `MassCalculation.calculateStructure` builds the children once per
 * `getInstanceCount()` — and one for everything else that can hold children.
 */
function copiesInside(n: ComponentNode): number {
  if (n.type === 'podset' || n.type === 'parallelstage') return flownInstanceCount(n);
  if (n.type === 'innertube') return clusterCount(n['cluster'] as string | undefined);
  return 1;
}

/** RFC-4180 CSV of the component table. */
export function componentCsv(table: ComponentTable): string {
  const lines = [table.headers.map(csvCell).join(',')];
  for (const row of table.rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
