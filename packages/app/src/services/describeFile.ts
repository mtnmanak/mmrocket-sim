import type { ComponentNode } from '@online-openrocket/engine';
import type { FlightOverrides, FlightTree, SavedConfig } from '../model/design.js';
import type { NoticeSeverity } from '../components/NoticeBar.js';
import { motorLengthLimit } from '../tree/motorLength.js';
import { mountBore } from '../tree/scaleRocket.js';
import { findNode, motorMounts, mountMotorCount, stageIndexOf, stages } from '../tree/treeModel.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { CD_REFERENCE_MACH, designCdOf } from './designCd.js';
import { currentSetKeyOf, designBuildInputOf, effectiveSupersonicOf, mountNamesOf } from './designDerivation.js';
import type { DesignFormat } from './designFile.js';
import { aeroModelFor, rogersKbfFor } from './flightPipeline.js';
import { resolveFlightState } from './flightState.js';
import type { LaunchConditions } from './launchConditions.js';
import { exportOrk } from './orkFile.js';
import { encodeShareFragment } from './shareLink.js';
import { hasAerodynamicForce, shownCp, shownStability } from './simReport.js';
import { APP_DEFAULT_AERO, SimulateDesignError, withKernel } from './simulateDesign.js';
import { openHeadlessDesign, planHeadlessImport } from './simulateFile.js';
import type { ImportPlan } from './importApply.js';

/**
 * S3 DRAFT: ONE UPLOAD → ITS DRY STATICS, ITS MOUNTS AND A MOTOR-INDEPENDENT
 * SHARE FRAGMENT (2026-10-27, for the owner's review before anything ships).
 *
 * The file opens through the SAME door a headless flight uses
 * (simulateFile.openHeadlessDesign + planHeadlessImport): bundled presets,
 * shipped motor rows and curves, the configuration App would open. Nothing is
 * flown, no auto delay is solved and no Mach probe runs.
 *
 * THE ANALYSIS is the Design tab's, with NO motor installed: the configuration
 * the open selected, projected for flight (flightState.resolveFlightState),
 * built once (buildDesign + KERNEL_HANDLES, through designBuildInputOf) with an
 * empty motor set, then StaticInfo's dry mass/CG, the forward CP and its margin
 * (simReport.shownCp/shownStability behind hasAerodynamicForce), and the
 * Design tab's one-point drag sweep at CD_REFERENCE_MACH. The build and every
 * handle read happen inside ONE withKernel turn and are microtask-only, so the
 * API's dead-holder watchdog stays sound; the import before it and the
 * fragment compression after it run outside the lock.
 *
 * THE FRAGMENT is the app's own share link (#d=1., shareLink.ts) of an .ork
 * written by exportOrk from a private, motor-free projection of the opened
 * design (motorFreeProjection below). It names no motor and no mount: a
 * caller appends its own motor reference later.
 */

/** What the Design tab's analysis reports, with no motor installed. */
export const DESCRIBE_BASIS = 'dry; no installed motors';
export const DESCRIBE_ATMOSPHERE = 'kernel default; no Mach-altitude table';

export interface DescribeFileOptions {
  /** Optional inflated XML cap; absent retains the browser default. */
  maxInflatedBytes?: number;
  /** API-only dead-holder detection while waiting for the kernel; see withKernel. */
  kernelDeadHolderMs?: number;
  signal?: AbortSignal;
}

export interface DescribedMount {
  /** Request-local traversal key ("m1", "m2", … in motorMounts order). Not a placement instruction. */
  key: string;
  name: string;
  stageIndex: number;
  stageName: string;
  /** The fit diameter (scaleRocket.mountBore): bore, or outside for a case airframe; 0 for a solid tube. */
  diameterM: number;
  /** The mount's stored maximum motor length; null = unset (0 is a real limit). */
  maxMotorLengthM: number | null;
  /** Motors one motor here becomes in flight: cluster × enclosing pods/strap-ons/inner clusters. */
  count: number;
}

export interface DescribeAnalysis {
  basis: typeof DESCRIBE_BASIS;
  aeroModel: string;
  mach: number;
  angleOfAttackRad: 0;
  lengthM: number;
  referenceDiameterM: number;
  dryMassKg: number;
  dryCgM: number | null;
  cpM: number | null;
  stabilityCalibers: number | null;
  cdEstimate: {
    value: number | null;
    mach: number;
    angleOfAttackRad: 0;
    powerState: 'off';
    atmosphere: typeof DESCRIBE_ATMOSPHERE;
    referenceAreaM2: number;
  };
}

export interface DescribeFileResult {
  name: string;
  sourceFormat: DesignFormat;
  analysis: DescribeAnalysis;
  mounts: DescribedMount[];
  /** `#d=1.…`, exactly what the app's share link carries after its origin. */
  fragment: string;
  notes: {
    import: { text: string; severity: NoticeSeverity };
    analysis: string[];
    export: string[];
  };
}

/** The finite value, else null — JSON has no NaN or Infinity. */
const finiteOrNull = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** The design state an open hands App, as the projection reads it. */
type OpenedDesign = Pick<ImportPlan['snapshot'], 'tree' | 'mountMotors' | 'savedConfigs' | 'activeConfigId' | 'launch' | 'measured' | 'detachedOverrides'>;

/** A saved configuration with no motor selection left in it. */
export type MotorFreeConfig = Omit<SavedConfig, 'motors' | 'unmatched' | 'unmatchedRefs' | 'motorLoadoutRefusal'> & { motors: Record<string, never> };

export interface MotorFreeProjection {
  tree: FlightTree;
  savedConfigs: MotorFreeConfig[];
  activeConfigId: string | null;
  detachedOverrides: FlightOverrides;
  launch: LaunchConditions;
  measured: OpenedDesign['measured'];
  /** What the projection removed, said in notes.export. */
  removed: { configMotors: number; unmatched: number; refusals: number };
}

function remapKeys<T>(map: Readonly<Record<string, T>> | undefined, ids: ReadonlyMap<string, string>): Record<string, T> | undefined {
  if (!map) return undefined;
  const out: Record<string, T> = {};
  for (const [id, value] of Object.entries(map)) {
    const next = ids.get(id);
    // An entry for a part the tree no longer has is never written by the exporter; drop it.
    if (next !== undefined) out[next] = value;
  }
  return out;
}

function remapOverrides(o: FlightOverrides | undefined, ids: ReadonlyMap<string, string>): FlightOverrides {
  return {
    ...(o?.deployments ? { deployments: remapKeys(o.deployments, ids)! } : {}),
    ...(o?.separations ? { separations: remapKeys(o.separations, ids)! } : {}),
    ...(o?.ignitions ? { ignitions: remapKeys(o.ignitions, ids)! } : {}),
  };
}

/** Keys whose string value names a part by its node id. */
const REFERENCE_KEYS = new Set(['mountId', 'nodeId', 'stageId']);

/**
 * The opened design with every MOTOR SELECTION removed and every identity made
 * canonical, on a private clone (the input is never written).
 *
 * Removed: the working motor set (the caller exports with `motors: {}`) AND
 * every saved configuration's motors, its unresolved references and their
 * display text, and its motor-loadout refusal. A weighed pad mass travels on
 * the motor record, so it goes with it; there is no motor for an embedded EX
 * snapshot to archive. Kept: the tree (geometry, mount flags, fins, materials,
 * component and stage mass/CG overrides), each mount's ignition default and
 * each configuration's ignition, deployment, separation, stage activeness and
 * stage mass/CG layers, the launch conditions and the Measured mass & CG box.
 *
 * Canonical: node ids `c<n>` come from a module counter (treeModel.freshId), so
 * they depend on what this isolate opened before. Every node is renamed in
 * depth-first order (`n1`, `n2`, …) and every map keyed by node id follows,
 * as do records naming a part. Configuration ids already come from the bytes
 * (an .ork's own configid, `rocksim-sim-N`, `rasaero-sim-N`) and are kept, so
 * a desktop round trip keeps an .ork's; the exporter's own ids come from
 * motorFreeOrk's counter. The global counter is not touched.
 */
export function motorFreeProjection(opened: OpenedDesign): MotorFreeProjection {
  const clone = structuredClone({
    tree: opened.tree as FlightTree, savedConfigs: opened.savedConfigs, activeConfigId: opened.activeConfigId,
    detachedOverrides: opened.detachedOverrides ?? {}, launch: opened.launch, measured: opened.measured,
  });
  const ids = new Map<string, string>();
  const visit = (nodes: ComponentNode[]) => {
    for (const node of nodes) {
      if (node.id) {
        const next = `n${ids.size + 1}`;
        ids.set(node.id, next);
        node.id = next;
      }
      visit(node.children ?? []);
    }
  };
  visit(clone.tree.components);
  // Records inside the design that name a part by id (a RASAero stated-figures
  // record's `mountId`, say) follow the rename too. The clone is private.
  const follow = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(follow); return; }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(record)) {
      if (REFERENCE_KEYS.has(key) && typeof v === 'string' && ids.has(v)) record[key] = ids.get(v);
      else follow(v);
    }
  };
  follow(clone);
  const tree: FlightTree = { ...clone.tree };
  if (tree.ignitionDefaults) tree.ignitionDefaults = remapKeys(tree.ignitionDefaults, ids)!;
  const removed = { configMotors: 0, unmatched: 0, refusals: 0 };
  const savedConfigs = clone.savedConfigs.map((c): MotorFreeConfig => {
    removed.configMotors += Object.keys(c.motors).length;
    removed.unmatched += Object.keys(c.unmatchedRefs ?? {}).length;
    if (c.motorLoadoutRefusal) removed.refusals++;
    const {
      motors: _motors, unmatched: _unmatched, unmatchedRefs: _refs, motorLoadoutRefusal: _refusal,
      ignitions, deployments, separations, stageActiveness, stageMassOverrides, nozzles, ...rest
    } = c;
    return {
      ...rest,
      motors: {},
      ...(ignitions ? { ignitions: remapKeys(ignitions, ids)! } : {}),
      ...(deployments ? { deployments: remapKeys(deployments, ids)! } : {}),
      ...(separations ? { separations: remapKeys(separations, ids)! } : {}),
      ...(stageActiveness ? { stageActiveness: remapKeys(stageActiveness, ids)! } : {}),
      ...(stageMassOverrides ? { stageMassOverrides: remapKeys(stageMassOverrides, ids)! } : {}),
      ...(nozzles ? { nozzles: remapKeys(nozzles, ids)! } : {}),
    };
  });
  return {
    tree, savedConfigs,
    activeConfigId: clone.activeConfigId,
    detachedOverrides: remapOverrides(clone.detachedOverrides, ids),
    launch: clone.launch, measured: clone.measured, removed,
  };
}

/** The projection as an .ork, with every written id from a counter: the same input writes the same bytes. */
export function motorFreeOrk(p: MotorFreeProjection, notes: string[] = []): string {
  let n = 0;
  return exportOrk({
    name: p.tree.name ?? 'My Rocket', tree: p.tree, motors: {}, launch: p.launch,
    configs: p.savedConfigs, activeConfigId: p.activeConfigId, measured: p.measured,
    workingOverrides: p.detachedOverrides, notes,
    // No flightData: every <simulation> is written notsimulated, with its conditions.
    newId: () => `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`,
  });
}

function exportNotes(p: MotorFreeProjection, opened: OpenedDesign, workingUnmatched: number, writerNotes: string[]): string[] {
  const out: string[] = [];
  const working = Object.keys(opened.mountMotors).length;
  const configs = p.savedConfigs.length;
  if (working || workingUnmatched || p.removed.configMotors || p.removed.unmatched) {
    out.push(`Motor selections were removed from the link: ${working + workingUnmatched} on the opened motor set`
      + ` and ${p.removed.configMotors + p.removed.unmatched} across ${configs} saved configuration${configs === 1 ? '' : 's'}`
      + ' (unmatched references included). Each selected motor\'s ejection delay went with it; mount ignition settings are kept.');
  }
  if (p.removed.refusals) out.push(`${p.removed.refusals} motor-loadout refusal${p.removed.refusals === 1 ? ' was' : 's were'} removed with the motors.`);
  return [...out, ...writerNotes];
}

/** Any part whose mass override says it includes a motor the import could not back out. */
function includesMotorMass(nodes: readonly ComponentNode[]): boolean {
  return nodes.some(n => (typeof n['overrideIncludesMotor'] === 'string' && n['overrideIncludesMotor'] !== '')
    || includesMotorMass(n.children ?? []));
}

/** A file's bytes → its dry statics, mounts and motor-independent fragment. Never flies. */
export async function describeFile(
  data: ArrayBuffer | Uint8Array, fileName: string, opts: DescribeFileOptions = {},
): Promise<DescribeFileResult> {
  const aero = APP_DEFAULT_AERO;
  const imported = await openHeadlessDesign(data, fileName, {
    network: 'forbid', maxInflatedBytes: opts.maxInflatedBytes, signal: opts.signal, aero,
  });
  const plan = await planHeadlessImport(imported, { network: 'forbid', signal: opts.signal });
  const opened = plan.snapshot;
  // The configuration the open selected, projected as a flight would read it,
  // with NO motor set: the same deployments/separations/ignitions, the same mass.
  const state = resolveFlightState(opened.tree, opened.savedConfigs, opened.activeConfigId,
    opened.detachedOverrides ?? {}, {});
  const tree = state.tree;
  const effectiveSupersonic = effectiveSupersonicOf(aero.aeroMode, aero.autoSupersonic);
  const analysis = await withKernel(() => {
    const built = buildDesign(designBuildInputOf({
      tree, assigned: [], effectiveKbf: aero.effectiveKbf, effectiveSupersonic,
      hybrid: aero.aeroMode === 'hybrid', measuredDryMassKg: opened.measured.massKg,
      primaryMountId: null, currentSetKey: currentSetKeyOf(tree, []),
    }), KERNEL_HANDLES);
    if ('error' in built) throw new SimulateDesignError('build', built.error);
    // The Design tab's own figure (App's designCd memo), and its fallback: drag is a nicety.
    let cd: number | null = null;
    let cdError: string | null = null;
    try {
      cd = designCdOf(built.rocket);
    } catch (e) {
      cdError = e instanceof Error ? e.message : String(e);
    }
    // StaticInfo is parsed JSON; nothing below reads the handle.
    return { info: built.info, cd, cdError };
  }, opts.signal, { deadHolderMs: opts.kernelDeadHolderMs }).catch((e: unknown) => {
    // As a flight's refusal does, carry the import note: it often says why.
    if (e instanceof SimulateDesignError) throw new SimulateDesignError(e.kind, e.message, { cause: e.cause, importNote: plan.note });
    throw e;
  });
  const { info, cd, cdError } = analysis;
  const essential = (v: number, what: string) => {
    if (!Number.isFinite(v)) {
      throw new SimulateDesignError('build', `The design built, but its ${what} is not a finite number.`, { importNote: plan.note });
    }
    return v;
  };
  const lengthM = essential(info.length, 'length');
  const referenceDiameterM = essential(info.refDiameter, 'reference diameter');
  const dryMassKg = essential(info.massEmpty, 'dry mass');
  const notes: string[] = [];
  const force = hasAerodynamicForce(info);
  if (!force) notes.push('No part of the design produces aerodynamic normal force, so it has no centre of pressure and no stability margin to report.');
  const cpM = force ? finiteOrNull(shownCp(info)) : null;
  const stabilityCalibers = force && cpM !== null ? finiteOrNull(shownStability(info)) : null;
  if (force && cpM === null) notes.push('The kernel returned no finite centre of pressure.');
  if (force && cpM !== null && stabilityCalibers === null) notes.push('The kernel returned no finite stability margin.');
  const dryCgM = finiteOrNull(info.cgEmpty);
  if (dryCgM === null) notes.push('The kernel returned no finite dry CG (a massless design has none).');
  const cdValue = finiteOrNull(cd);
  if (cdError !== null) notes.push(`The drag estimate is unavailable: ${cdError}`);
  else if (cdValue === null) notes.push('The kernel returned no finite drag coefficient.');
  if (opened.measured.massKg !== null || opened.measured.cgM !== null) {
    notes.push('The file carries a Measured mass & CG figure. As on the Design tab, the analysis reports the computed airframe; the measured figures travel in the link.');
  }
  if (includesMotorMass(tree.components)) {
    notes.push('A mass override in this file states that it includes a motor the import could not back out, so the dry mass and CG include that motor.');
  }
  const stageList = stages(tree);
  const mountNodes = motorMounts(tree);
  const names = mountNamesOf(mountNodes);
  const mounts = mountNodes.map((m, i): DescribedMount => {
    const stageIndex = stageIndexOf(tree, m.id!);
    const node = findNode(tree, m.id!) ?? m;
    return {
      key: `m${i + 1}`,
      name: names[m.id!]!,
      stageIndex,
      stageName: stageList[stageIndex]?.name ?? (stageIndex === 0 ? 'Sustainer' : `Booster ${stageIndex}`),
      diameterM: mountBore(node),
      maxMotorLengthM: motorLengthLimit(node),
      count: mountMotorCount(tree, m.id!),
    };
  });
  // Outside the lock: compression awaits a stream.
  const projection = motorFreeProjection(opened);
  const writerNotes: string[] = [];
  const fragment = await encodeShareFragment(motorFreeOrk(projection, writerNotes));
  return {
    name: opened.tree.name ?? imported.name ?? 'Rocket',
    sourceFormat: imported.sourceFormat ?? 'ork',
    analysis: {
      basis: DESCRIBE_BASIS,
      aeroModel: `${aeroModelFor(aero.aeroMode, effectiveSupersonic)!}${rogersKbfFor(aero.effectiveKbf, effectiveSupersonic) ? '+kbf' : ''}`,
      mach: CD_REFERENCE_MACH,
      angleOfAttackRad: 0,
      lengthM, referenceDiameterM, dryMassKg, dryCgM, cpM, stabilityCalibers,
      cdEstimate: {
        value: cdValue, mach: CD_REFERENCE_MACH, angleOfAttackRad: 0, powerState: 'off',
        atmosphere: DESCRIBE_ATMOSPHERE, referenceAreaM2: Math.PI * referenceDiameterM ** 2 / 4,
      },
    },
    mounts,
    fragment,
    notes: {
      import: { text: plan.note.text, severity: plan.note.severity },
      analysis: notes,
      export: exportNotes(projection, opened, Object.keys(plan.unmatchedRefs).length, writerNotes),
    },
  };
}
