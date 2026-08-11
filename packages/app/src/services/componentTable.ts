import type { ComponentInfo, ComponentNode, RocketTree } from '@online-openrocket/engine';
import { DISPLAY_NAME, FIELDS, type FieldDef } from '../tree/schema.js';
import { asStageNodes } from '../tree/treeModel.js';
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
    `Mass (${massSym})`, `Mass with children (${massSym})`,
    `CG (${lenSym} from component front)`,
    ...fieldCols.map(fieldHeader),
  ];

  const rows: Cell[][] = [];
  const uiLen = (si: number): number => round(siToUi('length', lenSym, si));
  const uiMass = (si: number): number => round(siToUi('mass', massSym, si));

  const walk = (nodes: ComponentNode[], stageName: string, parentName: string) => {
    for (const n of nodes) {
      const info = n.id && infoFor ? infoFor(n.id) : null;
      const fieldCells = fieldCols.map((f): Cell => {
        const raw = n[f.key];
        if (f.bool) return raw === true ? 'yes' : raw === false ? 'no' : '';
        if (f.options) {
          if (typeof raw !== 'string') return '';
          return f.options.find(([v]) => v === raw)?.[1] ?? raw;
        }
        return typeof raw === 'number' ? toUi(f, raw) : '';
      });
      rows.push([
        n.name ?? DISPLAY_NAME[n.type] ?? n.type,
        DISPLAY_NAME[n.type] ?? n.type,
        stageName,
        parentName,
        typeof n['materialName'] === 'string' ? (n['materialName'] as string) : '',
        info ? uiLen(info.positionX) : '',
        info ? uiLen(info.length) : typeof n['length'] === 'number' ? uiLen(n['length'] as number) : '',
        info ? uiMass(info.mass) : '',
        info && info.sectionMass > info.mass + 1e-9 ? uiMass(info.sectionMass) : '',
        info ? uiLen(info.cgX) : '',
        ...fieldCells,
      ]);
      walk(n.children ?? [], stageName, n.name ?? DISPLAY_NAME[n.type] ?? n.type);
    }
  };

  for (const stage of asStageNodes(tree)) {
    const stageName = stage.name ?? 'Stage';
    walk(stage.children ?? [], stageName, stageName);
  }

  return { headers, rows };
}

/** RFC-4180 CSV of the component table. */
export function componentCsv(table: ComponentTable): string {
  const lines = [table.headers.map(csvCell).join(',')];
  for (const row of table.rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
