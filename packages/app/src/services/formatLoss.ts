import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { resolveTransitionRadii } from '../tree/transitionRadii.js';
import { tubeFinRadius } from '../tree/tubefins.js';
import { kernelNum } from '../tree/kernelDefaults.js';
import { getCatalogue, matchDbMotor, manufacturerMatches } from './motorDb.js';
import { asStageNodes } from '../tree/treeModel.js';
import { num, numOpt } from '../tree/nodeNum.js';
import { motorLengthLossNotes } from '../tree/motorLength.js';
import { savedConfigLabel, type SavedConfig } from '../model/design.js';
import { DEFAULT_CONDITIONS, DEFAULT_TIME_STEP_S, type LaunchConditions } from './launchConditions.js';
import type { MeasuredFigures, OrkExportFlightData, OrkExportMotor } from './orkFile.js';
import { exportRkt } from './rocksimFile.js';
import { cdx1RecoveryDelayNote, cdx1RodAimNote, exportCdx1, rasaeroManufacturerAbbrev } from './rasaeroFile.js';
import { nozzleExportNotes } from './nozzleExport.js';
import { windProfileSaveNotes } from './windProfile.js';

export type LossyFormat = 'rkt' | 'cdx1';
export interface FormatLossReport {
  format: LossyFormat;
  /** The real exporter's refusal, without translating or duplicating its rules. */
  refused: string | null;
  losses: string[];
}
export interface FormatLossInput {
  tree: RocketTree;
  motors: Record<string, OrkExportMotor>;
  launch: LaunchConditions;
  configs: SavedConfig[];
  activeConfigId: string | null;
  measured: MeasuredFigures;
  /** Only summaries eligible for the .ork, not the whole Saved runs library. */
  flightData: Record<string, OrkExportFlightData>;
}
export const formatExtension = (format: LossyFormat): '.rkt' | '.CDX1' => format === 'rkt' ? '.rkt' : '.CDX1';

/** The panel labels, also used to explain which previous-site settings an open kept. */
export const launchFieldLabels: Partial<Record<keyof LaunchConditions, string>> = {
  launchRodLengthM: 'Rod length', launchRodAngleDeg: 'Rod angle', launchRodAimDeg: 'Rod aim',
  launchGuideAllowance: 'Allow for lug and rail-button positions', windAverage: 'Wind avg', windStdDev: 'Wind gusts σ',
  launchAltitudeM: 'Site altitude', temperatureC: 'Temperature', pressureHPa: 'Station pressure',
  latitudeDeg: 'Latitude', longitudeDeg: 'Longitude', geodeticMethod: 'Geodetic calculations', timeStepS: 'Time step',
};
function lostLaunchFields(format: LossyFormat, launch: LaunchConditions): string[] {
  const carried = new Set<keyof LaunchConditions>(format === 'cdx1'
    ? ['launchRodLengthM', 'launchRodAngleDeg', 'windAverage', 'launchAltitudeM', 'temperatureC', 'pressureHPa'] : []);
  const defaults: Partial<LaunchConditions> = { ...DEFAULT_CONDITIONS, launchRodAimDeg: 0,
    launchGuideAllowance: true, longitudeDeg: null, geodeticMethod: 'spherical', timeStepS: DEFAULT_TIME_STEP_S };
  return (Object.keys(launchFieldLabels) as (keyof LaunchConditions)[]).filter(key => {
    if (carried.has(key)) return false;
    // The existing rod-aim note already names an effective tilted aim.
    if (format === 'cdx1' && key === 'launchRodAimDeg' && cdx1RodAimNote(launch)) return false;
    return (launch[key] ?? defaults[key]) !== defaults[key];
  }).map(key => launchFieldLabels[key]!);
}

const planar = (n: ComponentNode) => ['trapezoidfinset', 'freeformfinset', 'ellipticalfinset'].includes(n.type);
const has = (n: ComponentNode, ...keys: string[]) => keys.some(k => n[k] !== undefined && n[k] !== null);
const nonzero = (n: ComponentNode, ...keys: string[]) => keys.some(k => num(n, k, 0) !== 0);
const named = (n: ComponentNode) => `“${n.name ?? n.type}”`;
function losesTrailingEdge(n: ComponentNode): boolean {
  const te = num(n, 'airfoilTeDiamond', 0);
  if (te === 0 || n['airfoilSection'] === 'hexagonal') return false;
  if (n['airfoilSection'] !== 'doublewedge') return true;
  const pts = n['points'] as [number, number][] | undefined;
  const root = n.type === 'freeformfinset' && pts?.length ? pts.at(-1)![0] - pts[0]![0] : num(n, 'rootChord', 0.05);
  const tip = n.type === 'freeformfinset' && pts?.length ? (pts.length === 4 ? pts[2]![0] - pts[1]![0] : 0) : num(n, 'tipChord', 0.03);
  // Compare the editable geometric inputs, not kernel floats. Four decimal
  // inches are the writer's precision; this tolerance only removes arithmetic noise.
  return Math.abs(te - ((root + tip) / 2 - num(n, 'airfoilLeDiamond', 0))) > 1e-9;
}
function nodesOf(tree: RocketTree): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (nodes: ComponentNode[]) => { for (const n of nodes) { out.push(n); walk(n.children ?? []); } };
  walk(asStageNodes(tree));
  return out;
}

/** Shared assembly for preview, header and post-save notice; never reads the engine or storage. */
export function checkFormatLoss(format: LossyFormat, input: FormatLossInput): FormatLossReport {
  const losses: string[] = [];
  let refused: string | null = null;
  try {
    // Geometry/motor refusals and the writer's existing notes stay owned by the writer.
    if (format === 'rkt') exportRkt({ name: input.tree.name ?? 'My Rocket', tree: input.tree,
      motors: input.motors, measured: input.measured, compInfo: {}, notes: losses });
    else exportCdx1({ name: input.tree.name ?? 'My Rocket', tree: input.tree,
      motors: input.motors, launch: input.launch, notes: losses });
  } catch (e) { refused = e instanceof Error ? e.message : String(e); }
  const ext = formatExtension(format);
  losses.push(...windProfileSaveNotes(input.launch, ext), ...motorLengthLossNotes(input.tree, ext));
  if (format === 'cdx1') {
    losses.push(...nozzleExportNotes(input.tree, ext));
    for (const note of [cdx1RodAimNote(input.launch), cdx1RecoveryDelayNote(input.tree)]) if (note) losses.push(note);
  }
  const nodes = nodesOf(input.tree);
  const stages = asStageNodes(input.tree);
  const add = (condition: boolean, text: string) => { if (condition) losses.push(text); };
  const parts = (predicate: (n: ComponentNode) => boolean, text: string) => {
    const found = nodes.filter(predicate);
    if (found.length) losses.push(`${text}: ${found.map(named).join(', ')}.`);
  };
  const launchFields = lostLaunchFields(format, input.launch);
  add(launchFields.length > 0, `Launch settings (${launchFields.join(', ')}) are not saved; another reader opens with its own defaults.`);
  const active = input.configs.find(c => c.id === input.activeConfigId);
  const otherConfigs = input.configs.filter(c => c.id !== input.activeConfigId);
  add(otherConfigs.length > 0, `Flight configurations: only ${active ? `“${savedConfigLabel(active)}”` : 'the current working setup'} is written. Other configurations' motors, deployment, ignition, separation, stage on/off and stage mass settings are not kept.`);
  add(input.configs.some(c => c.motorLoadoutRefusal || Object.keys(c.stageActiveness ?? {}).length > 0),
    'Which stages each flight configuration switches off, and the record of configuration motors that could not be loaded, are not kept.');
  add(Object.keys(input.flightData).length > 0, 'Flight summaries, their warnings and simulation provenance are not kept.');
  const motors = Object.values(input.motors);
  for (const m of motors) {
    add(Boolean(m.exMotorId || m.exMotorSpec || m.exDefinition), `EX motor “${m.designation}”: its curve, definition and available delays are not embedded; only a motor reference can travel.`);
  }
  add(motors.some(m => m.padMassKg != null), 'Weighed pad mass is not kept as an editable measurement tied to its motor loadout.');
  add(motors.some(m => {
    if (m.exMotorId || m.exMotorSpec || m.exDefinition) return false;
    const match = matchDbMotor(m.designation, undefined, undefined, m.manufacturer);
    const other = match && matchDbMotor(m.designation, undefined, getCatalogue().filter(row => row !== match.motor), m.manufacturer);
    return !match || match.rivals.length > 0 || (Boolean(m.manufacturer)
      && !manufacturerMatches(m.manufacturer!, match.motor.manufacturerAbbrev))
      || Boolean(other && other.tier === match.tier && manufacturerMatches(other.motor.manufacturerAbbrev, match.motor.manufacturerAbbrev));
  }),
    'Motor identity: exact motor dimensions, type and digest are not kept; the reader must match the motor name in its own database.');
  parts(n => numOpt(n, 'overrideCD') !== undefined || n['overrideSubcomponentsCD'] === true || n['mmrBaseDragDeclaration'] === true,
    'Drag overrides and base-drag declarations are not kept');
  parts(n => planar(n) && typeof n['filletMaterialGroup'] === 'string', 'Fillet material group is not kept');
  parts(n => ['bodytube', 'innertube'].includes(n.type) && n['motorMount'] !== true
    && numOpt(n, 'maxMotorLength') !== undefined && num(n, 'maxMotorLength', -1) >= 0,
  'Dormant maximum motor length settings are not kept');

  if (format === 'rkt') {
    parts(n => n.type === 'stage' && Boolean(n.name) && n.name !== (stages.indexOf(n) === 0 ? 'Sustainer'
      : stages.indexOf(n) === 1 ? 'Booster' : `Booster ${stages.indexOf(n)}`), 'Axial stage names are not kept');
    const resolved = nodesOf(resolveTransitionRadii(input.tree));
    const bulk = new Set(['nosecone', 'bodytube', 'transition', 'innertube', 'tubecoupler', 'centeringring',
      'bulkhead', 'engineblock', 'trapezoidfinset', 'freeformfinset', 'ellipticalfinset', 'tubefinset', 'launchlug']);
    for (const [i, n] of nodes.entries()) {
      if (['tubecoupler', 'engineblock'].includes(n.type) && numOpt(n, 'length') === undefined)
        losses.push(`${named(n)}: length is written as 2 mm instead of ${kernelNum(n, 'length') * 1000} mm.`);
      if (n.type === 'trapezoidfinset' && numOpt(n, 'sweep') === undefined)
        losses.push(`${named(n)}: sweep is written as 0 mm instead of 20 mm.`);
      // The kernel builds an unset body-tube wall at 0.3 mm (ComponentFactory
      // "bodytube"); the writer's own fallback is 0.5 mm.
      if (n.type === 'bodytube' && n['filled'] !== true && numOpt(n, 'thickness') === undefined)
        losses.push(`${named(n)}: wall is written as 0.5 mm instead of 0.3 mm.`);
      if (['podset', 'parallelstage'].includes(n.type) && numOpt(n, 'instanceCount') === undefined)
        losses.push(`${named(n)}: one instance is written instead of two.`);
      if (bulk.has(n.type) && numOpt(n, 'density') === undefined)
        losses.push(`${named(n)}: bulk density is written as 0 kg/m³ instead of 680 kg/m³.`);
      if (n.type === 'transition') for (const [side, fallback] of [['fore', 0.012], ['aft', 0.009]] as const) {
        const actual = numOpt(resolved[i]!, `${side}Radius`);
        if (numOpt(n, `${side}Radius`) === undefined && actual !== undefined && Math.abs(actual - fallback) > 1e-9)
          losses.push(`${named(n)}: automatic ${side} radius is written as ${fallback * 1000} mm instead of the resolved ${(actual * 1000).toFixed(3)} mm.`);
      }
      if (n.type === 'tubefinset' && numOpt(n, 'outerRadius') === undefined) {
        const parent = nodes.find(p => p.children?.includes(n));
        const actual = tubeFinRadius(n, parent?.type === 'bodytube' ? kernelNum(parent, 'outerRadius') : 0);
        if (Math.abs(actual - 0.012) > 1e-9)
          losses.push(`${named(n)}: automatic radius is written as 12 mm instead of the resolved ${(actual * 1000).toFixed(3)} mm.`);
      }
    }
    parts(n => n.type === 'railbutton', 'Rail buttons, including their mass and drag, are omitted');
    parts(n => (n.type as string) === 'protuberance', 'Protuberances, including their mass and drag, are omitted');
    parts(n => n.type === 'fairing', 'Camera shrouds become mass objects; shape, aerodynamics and any separate mass override are not kept');
    parts(n => n.type === 'nosecone' && has(n, 'shoulderThickness', 'shoulderCapped'), 'Nose shoulder walls and caps are not kept');
    parts(n => ['nosecone', 'transition'].includes(n.type) && String(n['shape'] ?? (n.type === 'nosecone' ? 'ogive' : 'conical')) === 'ogive'
      && has(n, 'shapeParameter'), 'Ogive shape parameters are not kept');
    parts(n => n.type === 'transition' && (has(n, 'clipped') || ['fore', 'aft'].some(side =>
      num(n, `${side}ShoulderLength`, 0) === 0 && has(n, `${side}ShoulderThickness`, `${side}ShoulderCapped`))),
    'Transition clipping and stored zero-length shoulder construction are not kept');
    parts(n => planar(n) && (Boolean(n['airfoilSection']) || nonzero(n, 'airfoilLeDiamond', 'airfoilTeDiamond', 'finLeRadius')),
      'Supersonic fin sections and edge dimensions are not kept; the basic rounded/airfoil cross-section is kept');
    parts(n => n.type === 'bodytube' && n['caseAirframe'] === true, 'Motor case-as-airframe settings are not kept');
    parts(n => ['centeringring', 'bulkhead'].includes(n.type) && (num(n, 'instanceCount', 1) > 1 || nonzero(n, 'instanceSeparation')),
      'Multiple ring or bulkhead instances and spacing are not kept; only one is written');
    parts(n => ['centeringring', 'bulkhead', 'engineblock', 'tubecoupler'].includes(n.type) && nonzero(n, 'radialPosition'),
      'Ring radial offsets are not kept; these parts reopen on the centerline');
    parts(n => n.type === 'launchlug' && (num(n, 'instanceCount', 1) > 1 || nonzero(n, 'instanceSeparation')),
      'Multiple launch lug instances and spacing are not kept; only one is written');
    parts(n => ['parachute', 'streamer', 'shockcord'].includes(n.type) && has(n, 'packedLength', 'packedRadius'),
      'Packed recovery dimensions are not kept');
    parts(n => n.type === 'masscomponent' && (has(n, 'radius') || Boolean(n['massComponentType'])),
      'Mass-object size and type (such as electronics) are not kept');
    parts(n => n.type === 'parachute' && numOpt(n, 'lineDensity') === 0,
      'Zero-density parachute lines and their material are not kept; the reader supplies its own defaults');
    parts(n => ['parachute', 'streamer'].includes(n.type) && numOpt(n, 'cd') === 0.75,
      'Fixed recovery Cd of 0.75 reopens on Auto');
    parts(n => n.type === 'shockcord' && numOpt(n, 'overrideCGX') !== undefined, 'Shock-cord CG overrides are discarded when reopened here');
    parts(n => ['rough', 'finishpolished', 'roughunfinished', 'optimum', 'mirror'].includes(String(n['finish'])),
      'Surface finish is reduced to RockSim’s nearest finish choice');
    parts(n => ['stage', 'parallelstage'].includes(n.type) && has(n, 'separationEvent', 'separationDelay', 'separationAltitude'),
      'Separation settings are not kept; the reader supplies its own separation defaults');
    parts(n => ['stage', 'parallelstage'].includes(n.type) && typeof n['overrideIncludesMotor'] === 'string' && n['overrideIncludesMotor'] !== '',
      'Stage mass includes-motor bookkeeping is not kept; the reader cannot recover the original weighing');
    const measured = input.measured;
    const stage = stages[0];
    const occupied = stage && (has(stage, 'overrideMass') || (has(stage, 'overrideCGX') && stage['overrideSubcomponentsCG'] === true));
    add((measured.massKg != null || measured.cgM != null) && (stages.length !== 1 || Boolean(occupied)
      || !(Number.isFinite(measured.massKg) && measured.massKg! > 0) || (measured.cgM != null && measured.cgM <= 0)),
    'Measured mass & CG have no separate fields in .rkt: only a positive one-stage known mass and positive CG can reopen, and a stage override takes that slot when it supplies a known mass.');
  } else {
    add(Boolean(input.tree.name?.includes('\n')), 'Rocket name text after the first line is not restored when this file is reopened.');
    // The writer is external-only. A successful dry run does not mean it
    // visited geometry hidden below an internal part or a nose cone.
    const external = new Set(stages.flatMap(s => (s.children ?? []).filter(n => ['nosecone', 'bodytube', 'transition'].includes(n.type))));
    const canShoulders = new Set<ComponentNode>();
    for (const tube of stages[0]?.children ?? []) {
      if (tube.type !== 'bodytube') continue;
      for (const pod of tube.children ?? []) if (pod.type === 'podset') {
        for (const child of pod.children ?? []) if (['bodytube', 'transition'].includes(child.type)) external.add(child);
        const kids = pod.children ?? [];
        if (kids[0]?.type === 'transition' && kids.some(n => n.type === 'bodytube')) {
          const shoulder = kids[0]; canShoulders.add(shoulder);
          add((shoulder.children ?? []).some(n => n.type.endsWith('finset')), `fins on ${named(shoulder)}: not in the file.`);
          add(String(shoulder['shape'] ?? 'conical') !== 'conical', `${named(shoulder)}'s ${String(shoulder['shape'])} shape is written as conical.`);
        }
      }
    }
    const writtenFins = new Set([...external].filter(n => n.type !== 'nosecone' && !canShoulders.has(n)).flatMap(n => n.children ?? []));
    // finPlanform writes an unset sweep as 0; the kernel flies 20 mm.
    for (const n of writtenFins) if (n.type === 'trapezoidfinset' && numOpt(n, 'sweep') === undefined)
      losses.push(`${named(n)}: sweep is written as 0 mm instead of 20 mm.`);
    parts(n => (['nosecone', 'bodytube', 'transition'].includes(n.type) && !external.has(n))
      || (n.type.endsWith('finset') && !writtenFins.has(n)),
    'Exterior parts outside the written body/fin-can chain lose their geometry and drag; their mass is kept only in the total');
    const innerKinds: Record<string, string> = { innertube: 'inner tubes', tubecoupler: 'couplers', centeringring: 'centering rings',
      bulkhead: 'bulkheads', engineblock: 'engine blocks', shockcord: 'shock cords', masscomponent: 'mass objects', fairing: 'camera shrouds' };
    const kinds = [...new Set(nodes.map(n => innerKinds[n.type]).filter(Boolean))];
    add(kinds.length > 0, `Inner parts (${kinds.join(', ')}) are kept only in the total mass and CG; their geometry, placement and individual settings are not kept.`);
    add(input.measured.massKg != null || input.measured.cgM != null, 'Measured mass & CG entries are not kept as editable measurements.');
    parts(n => has(n, 'overrideMass', 'overrideCGX'), 'Individual mass and CG overrides, including stage distribution and included-motor settings, are kept only as part of the rocket’s total mass and CG');
    const recreatedNames = new Map<ComponentNode, string>();
    for (const [i, stage] of stages.entries()) {
      const stageName = i === 0 ? 'Sustainer' : i === 1 ? 'Booster' : `Booster ${i}`;
      recreatedNames.set(stage, stageName);
      for (const n of stage.children ?? []) {
        if (n.type === 'bodytube') recreatedNames.set(n, i === 0 ? 'Body tube' : `${stageName} body tube`);
        if (n.type === 'nosecone' && i === 0) recreatedNames.set(n, 'Nose cone');
        if (n.type === 'transition') recreatedNames.set(n, i === 0 ? 'Transition'
          : `${stageName} ${num(n, 'foreRadius', 0) > num(n, 'aftRadius', 0) ? 'boat tail' : 'shoulder'}`);
      }
    }
    for (const n of nodes) {
      if (writtenFins.has(n) && planar(n)) recreatedNames.set(n, 'Fins');
      if (external.has(n) && n.type === 'bodytube' && !stages.slice(1).some(s => s.children?.includes(n))) {
        const lug = n.children?.find(c => c.type === 'launchlug');
        if (lug) recreatedNames.set(lug, 'Launch lug');
      }
      if (canShoulders.has(n)) recreatedNames.set(n, 'Fin can shoulder');
      if (n.type === 'podset') {
        const can = n.children?.find(c => c.type === 'bodytube');
        recreatedNames.set(n, can ? 'Fin can' : 'Boat tail pod');
        if (can) recreatedNames.set(can, 'Fin can tube');
        else if (n.children?.[0]) recreatedNames.set(n.children[0], 'Boat tail');
      }
    }
    const writtenChutes = nodes.filter(n => n.type === 'parachute').slice(0, 2);
    const chuteRank = (n: ComponentNode) => n['deployEvent'] == null || n['deployEvent'] === 'apogee' ? 0 : n['deployEvent'] === 'altitude' ? 1 : 2;
    writtenChutes.sort((a, b) => chuteRank(a) - chuteRank(b)
      || (chuteRank(a) === 1 ? num(b, 'deployAltitude', 200) - num(a, 'deployAltitude', 200) : 0));
    writtenChutes.forEach((c, i) => { if (chuteRank(c) < 2) recreatedNames.set(c, i === 0 ? 'Drogue' : 'Main'); });
    parts(n => Boolean(n.name) && n.name !== recreatedNames.get(n), 'Component and stage names are replaced with the reader’s names');
    parts(n => has(n, 'materialName', 'density', 'surfaceMaterialName', 'surfaceDensity', 'lineMaterialName', 'lineDensity', 'filled')
      || (!planar(n) && has(n, 'thickness')),
      'Materials and walls (except fin thickness) are not kept; the reader supplies its own construction defaults');
    parts(n => ['nosecone', 'transition'].includes(n.type) && has(n, 'shoulderRadius', 'shoulderLength', 'shoulderThickness', 'shoulderCapped',
      'foreShoulderRadius', 'foreShoulderLength', 'foreShoulderThickness', 'foreShoulderCapped', 'aftShoulderRadius', 'aftShoulderLength', 'aftShoulderThickness', 'aftShoulderCapped', 'clipped'),
    'Nose and transition shoulders and clipping are not kept');
    parts(n => n.type === 'nosecone' && numOpt(n, 'shapeParameter') !== undefined
      && ((String(n['shape'] ?? 'ogive') === 'ogive' && n['shapeParameter'] !== 1)
        || (n['shape'] === 'haack' && n['shapeParameter'] !== 0 && n['shapeParameter'] !== 0.33)),
      'Nose shape parameter detail is reduced to RASAero’s tangent-ogive or Haack choices');
    for (const stage of stages.slice(1)) {
      const kids = stage.children ?? [];
      add(kids.some(n => n.type === 'nosecone') || kids.filter(n => n.type === 'bodytube').length > 1
        || kids.some(n => n.type === 'transition' && String(n['shape'] ?? 'conical') !== 'conical'),
      `Booster geometry ${named(stage)}: forward noses are omitted, tube boundaries and radii collapse to one tube, and shoulder/boat-tail shapes become conical.`);
      const stageNodes = nodesOf({ components: [stage] });
      const motor = stageNodes.map(n => input.motors[n.id ?? '']).find(Boolean);
      add(num(stage, 'nozzleExitDiameter', 0) > 0 && !rasaeroManufacturerAbbrev(motor?.manufacturer),
        `Booster nozzle ${named(stage)} is not kept because this stage has no exported engine.`);
    }
    parts(n => planar(n) && nonzero(n, 'cant', 'rotation'), 'Fin cant and rotation are not kept');
    parts(n => planar(n) && has(n, 'tabHeight', 'tabLength', 'tabOffset'), 'Fin tabs and their positions are not kept');
    parts(n => (planar(n) || n.type === 'podset') && (n['position'] as { method?: string } | undefined)?.method === 'absolute',
      'Absolute fin or pod positions are not kept; their exported offset becomes zero');
    parts(n => n.type === 'freeformfinset', 'Freeform fins reopen as trapezoids; the editable outline and its root origin are not kept');
    parts(n => planar(n) && ((!n['airfoilSection'] && nonzero(n, 'airfoilLeDiamond', 'airfoilTeDiamond', 'finLeRadius'))
      || (Boolean(n['airfoilSection']) && n['crossSection'] !== undefined && n['crossSection'] !== 'airfoil')
      || losesTrailingEdge(n)),
    'Fin section detail is not all kept: unselected edge dimensions and independent classic cross-sections are lost');
    parts(n => planar(n) && losesTrailingEdge(n) && n['airfoilSection'] === 'doublewedge', 'Doublewedge trailing edge is derived by the reader');
    parts(n => planar(n) && losesTrailingEdge(n) && n['airfoilSection'] !== 'doublewedge', 'Fin trailing edge is not kept');
    parts(n => n['motorMount'] === true || n['caseAirframe'] === true || nonzero(n, 'motorOverhang'),
      'Motor mounts lose their identity, location, overhang and case-as-airframe setting');
    for (const m of motors) {
      add(!rasaeroManufacturerAbbrev(m.manufacturer), `Motor “${m.designation}” is omitted: its manufacturer has no supported RASAero engine abbreviation.`);
      add(m.delay !== undefined || Boolean(m.autoDelay), `Motor “${m.designation}”: selected ejection delay (including plugged/Auto) is not kept; the reader chooses its own delay.`);
      add((m.ignitionEvent !== undefined && !['automatic', 'burnout'].includes(m.ignitionEvent)) || (m.ignitionEvent !== 'burnout' && (m.ignitionDelay ?? 0) !== 0),
        `Motor “${m.designation}”: ignition trigger/timing is not kept; only burnout-relative delays can be written for the upper two stages.`);
    }
    const stageMotors = stages.map(s => nodesOf({ components: [s] }).flatMap(n => input.motors[n.id ?? ''] ? [input.motors[n.id ?? '']!] : []));
    // Automatic is launch only on the bottom active core stage (AxialStage).
    const launchStage = stages.length - 1;
    for (let i = 0; i < launchStage; i++) for (const m of stageMotors[i]!) {
      if (!rasaeroManufacturerAbbrev(m.manufacturer) || (m.ignitionEvent !== undefined && m.ignitionEvent !== 'automatic')) continue;
      const below = stageMotors[i + 1] ?? [];
      if (!stageMotors.slice(i + 1).some(ms => ms.some(lower => rasaeroManufacturerAbbrev(lower.manufacturer)))) {
        losses.push(`Motor “${m.designation}” reopens at launch because there is no exported lower engine; its automatic ejection-charge trigger in the app is not kept.`);
        continue;
      }
      add(true, `Motor “${m.designation}” lights on the burnout of the stage below in the .CDX1, not on its ejection charge.`
        + (below.length > 0 && below.every(lower => lower.delay === Infinity)
          ? ' The lower motor is plugged, so it would not light in the app at all.' : ''));
    }
    if (stages[2]) {
      const bottom = nodesOf({ components: [stages[2]] });
      add(bottom.some(n => (input.motors[n.id ?? '']?.ignitionDelay ?? 0) !== 0), 'Bottom-stage ignition delay is not kept; Booster2 has no ignition-delay field.');
    }
    parts(n => n.type === 'launchlug', 'Launch lugs lose placement, spacing, walls and extra instances; only the first lug’s size on each supported sustainer tube is kept, and booster lugs are omitted');
    parts(n => n.type === 'railbutton', 'Rail buttons, including their geometry and drag, are omitted');
    parts(n => (n.type as string) === 'protuberance', 'Protuberances lose individual dimensions, placement, mass and Cd settings; only grouped frontal areas on sustainer body tubes and two plate angles are kept');
    parts(n => n.type === 'streamer', 'Streamers and their deployment settings are omitted');
    const chutes = nodes.filter(n => n.type === 'parachute');
    for (const c of chutes.slice(0, 2)) add(c['deployEvent'] == null,
      `${named(c)}: ejection deployment becomes apogee with no delay in the .CDX1.`);
    add(chutes.length > 2, `Additional parachutes are omitted, including their delays: ${chutes.slice(2).map(named).join(', ')}. Only the first two in the component tree are written.`);
    parts(n => n.type === 'parachute' && has(n, 'deployEvent') && !['apogee', 'altitude'].includes(String(n['deployEvent'])),
      'Unsupported parachute events and their delays become disabled; these parachutes do not reopen');
    add(chutes.length > 0, 'Parachute construction, names, attachment, packing, lines and materials are not kept. Spill holes are folded into Cd, Auto Cd becomes a number, and the reader recreates recovery on the sustainer.');
    for (const [i, stage] of stages.entries()) {
      if (i === 0) continue;
      const event = String(stage['separationEvent'] ?? 'ejection');
      const delay = num(stage, 'separationDelay', 0);
      const engine = stageMotors[i]!.some(m => rasaeroManufacturerAbbrev(m.manufacturer));
      if (event !== (engine ? 'burnout' : 'ejection') || (!engine && delay !== 0) || nonzero(stage, 'separationAltitude'))
        losses.push(`Separation ${named(stage)}: ${engine ? `${event} separation becomes burnout with ${event === 'burnout' ? delay : 0} s delay`
          : 'reopens on ejection with 0 s delay because this stage has no exported engine'}.`
          + (delay !== 0 && (event !== 'burnout' || !engine) ? ` The ${delay} s delay is not kept.` : ''));
    }
    const finishes = nodes.filter(n => ['nosecone', 'bodytube', 'transition', 'tubefinset', 'launchlug'].includes(n.type) || planar(n))
      .map(n => String(n['finish'] ?? 'normal'));
    add(new Set(finishes).size > 1 || finishes.some(f => ['polished', 'rough'].includes(f)),
      'Surface finish is one global nearest-choice finish; individual part finishes are not kept.');
  }
  // Editing dependencies and provenance are a single footnote, never a forest
  // of XML-field warnings. Show it only alongside a substantive loss.
  if (losses.length) losses.push('Some editing settings (how positions and automatic sizes were set, grouping and preset provenance) are saved as plain numbers or are not kept.');
  return { format, refused, losses: [...new Set(losses)] };
}
