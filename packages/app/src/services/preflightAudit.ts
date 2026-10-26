import { OrkRocket, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { INITIAL_UNITS, noticeEqual, noticeComparison, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import type { NoteTier } from '../components/Note.js';
import { BULK_MATERIALS, LINE_MATERIALS, SURFACE_MATERIALS, type MaterialDef } from '../data/materials.js';
import { flownDeployEvent } from '../tree/deployEvent.js';
import { numOpt } from '../tree/nodeNum.js';
import { DISPLAY_NAME } from '../tree/schema.js';
import { engineTree, suppressingAncestor } from '../tree/treeModel.js';

// N028: tenfold differences catch likely unit/decimal slips without treating a
// normal measured/catalogue mass as an error. The 1 g floor avoids tiny parts.
const MASS_RATIO_LIMIT = 10;
const MASS_DIFFERENCE_FLOOR_KG = 0.001;
// A family's shipped min/max, widened tenfold on each side, is a screening
// range, not a physical limit. Separate tables prevent kg/m² or kg/m becoming kg/m³.
export const DENSITY_RANGE_FACTOR = 10;

export interface AuditPart { id: string; name: string }
export type AuditMasses = Readonly<Record<string, number | null | undefined>>;
export interface AuditFinding {
  id: string;
  kind: 'mass-ratio' | 'whole-mass-without-cg' | 'covered-mass' | 'nested-mass' | 'material-density'
    | 'no-recovery' | 'no-deployment' | 'existing-recovery-note';
  tier: NoteTier;
  part: AuditPart;
  reason: string;
  target?: 'mass-note' | 'deployment' | 'design-notes';
  mass?: { overrideKg: number; computedKg: number };
  density?: { field: string; unit: string; value: number; min: number; max: number };
}
export interface PreflightAuditResult {
  findings: AuditFinding[];
  uncheckedMassParts: AuditPart[];
  unknownMaterialCount: number;
}

const CONTAINERS = new Set(['stage', 'podset', 'parallelstage']);
// N028: engineTree replaces stored overrides on these carriers with their own mass fields.
const IGNORED_MASS_OVERRIDES = new Set(['fairing', 'protuberance']);
const recoveryDevice = (node: ComponentNode) => node.type === 'parachute' || node.type === 'streamer';
const namedPart = (node: ComponentNode): AuditPart => ({
  id: node.id!, name: node.name || DISPLAY_NAME[node.type] || node.type,
});
function allParts(tree: RocketTree): ComponentNode[] {
  const out: ComponentNode[] = [];
  const visit = (nodes: ComponentNode[]) => {
    for (const node of nodes) { out.push(node); visit(node.children ?? []); }
  };
  visit(tree.components);
  return out;
}
function comparableMass(tree: RocketTree, node: ComponentNode): boolean {
  return !!node.id && numOpt(node, 'overrideMass') !== undefined
    && !CONTAINERS.has(node.type) && !IGNORED_MASS_OVERRIDES.has(node.type)
    && !(node['overrideSubcomponentsMass'] === true && (node.children?.length ?? 0) > 0)
    && !suppressingAncestor(tree, node.id, 'overrideSubcomponentsMass', 'overrideMass');
}

/** Diagnostic handle only: no reset, motors, flag changes or writes to the flown
 * handle. One extra build when comparable overrides exist, reclaimed at the next
 * normal engine reset. Do not use componentInfo on the flown handle as a baseline:
 * its mass already includes the override (OrkEngine.getComponentInfo). */
export function readAuditMasses(tree: RocketTree, build: (tree: RocketTree) => {
  componentInfo(id: string): { mass: number };
} = OrkRocket.buildTree): AuditMasses {
  const candidates = allParts(tree).filter(node => comparableMass(tree, node));
  if (!candidates.length) return {};
  const masses: Record<string, number | null> = Object.fromEntries(candidates.map(n => [n.id!, null]));
  const copy = (nodes: ComponentNode[]): ComponentNode[] => nodes.map(node => ({
    ...node, overrideMass: undefined, overrideSubcomponentsMass: undefined,
    ...(node.children ? { children: copy(node.children) } : {}),
  }));
  try {
    // Clear app overrides BEFORE lowering: shrouds and drag bumps synthesize
    // their actual own weight during engineTree and must keep that weight.
    const diagnostic = build(engineTree({ ...tree, components: copy(tree.components) }));
    for (const node of candidates) {
      try {
        const mass = diagnostic.componentInfo(node.id!).mass;
        masses[node.id!] = Number.isFinite(mass) && mass > 0 ? mass : null;
      } catch { /* This part's baseline remains unknown. */ }
    }
  } catch { /* The comparison cannot be built; tree-only checks still run. */ }
  return masses;
}

interface DensityField { name: string; field: string; unit: string; list: MaterialDef[] }
const BULK: DensityField = { name: 'materialName', field: 'density', unit: 'kg/m³', list: BULK_MATERIALS };
const SURFACE: DensityField = { name: 'surfaceMaterialName', field: 'surfaceDensity', unit: 'kg/m²', list: SURFACE_MATERIALS };
const LINE: DensityField = { name: 'lineMaterialName', field: 'lineDensity', unit: 'kg/m', list: LINE_MATERIALS };
const FILLET: DensityField = { name: 'filletMaterialName', field: 'filletDensity', unit: 'kg/m³', list: BULK_MATERIALS };
// N028: ComponentFactory applies bulk materials to External/StructuralComponent,
// including guides without a density editor. App-only synthesized carriers are excluded.
const BULK_PARTS = new Set([
  'nosecone', 'transition', 'bodytube', 'trapezoidfinset', 'ellipticalfinset', 'freeformfinset',
  'tubefinset', 'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', 'launchlug', 'railbutton',
]);
function densityFields(node: ComponentNode): DensityField[] {
  const fields: DensityField[] = [];
  if (BULK_PARTS.has(node.type)) fields.push(BULK);
  if (recoveryDevice(node)) fields.push(SURFACE);
  if (node.type === 'parachute' || node.type === 'shockcord') fields.push(LINE);
  if (['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'].includes(node.type)
    && (numOpt(node, 'filletRadius') ?? 0) > 0) fields.push(FILLET);
  return fields;
}

/** Read the EFFECTIVE flight tree (resolveFlightState), never the own-setting
 * editor tree. Findings are advice; nothing here repairs, persists or flies. */
export function preflightAudit(
  tree: RocketTree, masses: AuditMasses, existingNotes: readonly string[] = [], units: UnitSelection = INITIAL_UNITS,
): PreflightAuditResult {
  const result: PreflightAuditResult = { findings: [], uncheckedMassParts: [], unknownMaterialCount: 0 };
  const parts = allParts(tree);
  const add = (node: ComponentNode, finding: Omit<AuditFinding, 'id' | 'part'>) => {
    if (!node.id) return;
    result.findings.push({ ...finding, id: `${finding.kind}:${node.id}:${finding.density?.field ?? ''}`, part: namedPart(node) });
  };
  for (const node of parts) {
    const mass = numOpt(node, 'overrideMass');
    if (mass !== undefined && node.id && !IGNORED_MASS_OVERRIDES.has(node.type)) {
      const ancestor = suppressingAncestor(tree, node.id, 'overrideSubcomponentsMass', 'overrideMass');
      if (ancestor) {
        add(node, { kind: 'covered-mass', tier: 'information', target: 'mass-note',
          reason: `A mass override is also set on ${namedPart(ancestor).name}. View the existing mass note in Overrides for this part.` });
      } else if (comparableMass(tree, node)) {
        const computed = masses[node.id];
        if (computed == null || !Number.isFinite(computed) || computed <= 0) {
          result.uncheckedMassParts.push(namedPart(node));
        } else if (Math.abs(mass - computed) >= MASS_DIFFERENCE_FLOOR_KG
          && (mass < computed / MASS_RATIO_LIMIT || mass > computed * MASS_RATIO_LIMIT)) {
          add(node, { kind: 'mass-ratio', tier: 'caution', mass: { overrideKg: mass, computedKg: computed },
            reason: 'The mass override is less than one tenth or more than ten times the computed part mass. '
              + 'Check the weight and units. A measured or catalogue weight can differ on purpose; '
              + 'a wrong weight changes the balance point and stability margin.' });
        }
      }
      if (!ancestor && !CONTAINERS.has(node.type)
        && node['overrideSubcomponentsMass'] !== true) {
        const overriddenChildren = allParts({ components: node.children ?? [] })
          .filter(child => !IGNORED_MASS_OVERRIDES.has(child.type) && numOpt(child, 'overrideMass') !== undefined);
        if (overriddenChildren.length) add(node, { kind: 'nested-mass', tier: 'information',
          reason: `This part and ${overriddenChildren.length} part${overriddenChildren.length === 1 ? '' : 's'} inside it carry mass overrides. `
            + 'This override replaces only this part’s own weight; the contents still count. '
            + 'If you entered the weight of the whole assembly, its contents are being counted again. Review Mass in Overrides.' });
      }
    }
    for (const field of densityFields(node)) {
      const value = numOpt(node, field.field);
      // N028: the bridge only applies positive bulk/fillet densities, but accepts
      // every finite recovery surface/line value, including explicit zero.
      if (value === undefined || ((field === BULK || field === FILLET) && value <= 0)) continue;
      const material = field.list.find(m => m.name === node[field.name]);
      if (!material) { result.unknownMaterialCount++; continue; }
      const family = field.list.filter(m => m.group === material.group);
      const min = Math.min(...family.map(m => m.density)) / DENSITY_RANGE_FACTOR;
      const max = Math.max(...family.map(m => m.density)) * DENSITY_RANGE_FACTOR;
      const quantity = field === SURFACE ? 'surfaceDensity' : field === LINE ? 'lineDensity' : 'density';
      const density = (n: number, against?: number) => against === undefined ? noticeQuantity(quantity, n, units) : noticeComparison(quantity, n, against, units)[0];
      // Eight relative ULPs cover arithmetic/serialization residue at a family
      // bound, not measurement error (e.g. 0.4000000000000001 vs 0.4 kg/m2).
      const bound = value < min ? min : max;
      if ((value < min || value > max) && !noticeEqual(value, bound)) add(node, {
        kind: 'material-density', tier: 'caution', density: { field: field.field, unit: field.unit, value, min, max },
        reason: `${field.field === 'filletDensity' ? 'Fillet material' : material.name}: density ${density(value, bound).startsWith('just ') ? 'is just outside' : `${density(value)} is outside`} `
          + `the screening range ${density(min)}–${density(max)} for its material family. `
          + 'Check the material and units. A wrong density changes computed weight and can change the stability margin.',
      });
    }
  }

  // A single root stage is the whole airframe. Multi-stage overrides describe
  // separate assemblies; do not label one of them a whole-rocket measurement.
  const whole = tree.components.length === 1 && tree.components[0]?.type === 'stage' ? tree.components[0] : null;
  // MassCalculation gives the replaced children zero weight: a stated CG
  // positions the entire replacement even without its separate subtree flag.
  if (whole && numOpt(whole, 'overrideMass') !== undefined && whole['overrideSubcomponentsMass'] === true
    && numOpt(whole, 'overrideCGX') === undefined) {
    add(whole, { kind: 'whole-mass-without-cg', tier: 'caution',
      reason: 'The whole airframe has a replacement mass without a replacement CG for everything inside. '
        + 'The app still uses a computed balance point; if the real rocket balances elsewhere, '
        + 'the app can show more stability margin than the rocket really has. Check its measured mass and CG.' });
  }
  const recovery = parts.filter(recoveryDevice);
  const existingRecovery = existingNotes.some(text => text.startsWith('[Warning.NO_RECOVERY_DEVICE]'));
  if (recovery.length === 0 && tree.components.length) {
    // Link to the existing design note rather than repeat the same warning.
    add(whole ?? tree.components[0]!, existingRecovery
      ? { kind: 'existing-recovery-note', tier: 'information', target: 'design-notes',
        reason: 'Review the existing recovery warning in Design notes.' }
      : { kind: 'no-recovery', tier: 'danger',
        reason: 'No parachute or streamer is in the design. The simulated rocket comes down without either. '
          + 'If the real rocket needs one, this design does not represent its recovery.' });
  }
  for (const device of recovery) {
    if (flownDeployEvent(device['deployEvent']) !== 'never') continue;
    add(device, { kind: 'no-deployment', tier: 'danger', target: 'deployment',
      reason: 'Deployment is Never in the active flight settings, so this recovery device will not open in the simulation. '
        + 'Check Deployment on this part and its settings on Motors & Configuration.' });
  }
  return result;
}
