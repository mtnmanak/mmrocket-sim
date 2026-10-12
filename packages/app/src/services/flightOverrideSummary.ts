import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, FlightTree, IgnitionTuple, MountMotor, SeparationTuple } from '../model/design.js';
import { motorMounts, stages } from '../tree/treeModel.js';
import { flownDeployEvent } from '../tree/deployEvent.js';
import { deploymentTuple } from './foreignConfigLayers.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { overrideFor, sparsify } from './flightState.js';
import { describeComponentFlightTuple, describeIgnitionTuple, separationTuple } from './flightOverrideText.js';

export type OverrideFamily = 'recovery' | 'separation' | 'ignition';
/** A historical record: SI tuples and names only, never session-local component ids. */
export type RecordedFlightOverride = { partName: string } & (
  | { family: 'recovery'; kind: 'parachute' | 'streamer'; flies: DeploymentTuple; own: DeploymentTuple }
  | { family: 'separation'; kind: 'stage'; flies: SeparationTuple; own: SeparationTuple }
  | { family: 'ignition'; kind: 'motor mount'; flies: IgnitionTuple; own: IgnitionTuple }
);
export interface FlightOverrideSummary {
  records: RecordedFlightOverride[];
  text: string;
  shortText: string;
  first: { id: string; family: OverrideFamily };
}
interface Group {
  family: OverrideFamily; kind: string; names: string[]; flown: string; own: string;
}

/** Normalize only equivalence that holds on every flight path; preserve stored tuples. */
function flownDeployment(tuple: DeploymentTuple): DeploymentTuple {
  const deployEvent = flownDeployEvent(tuple.deployEvent);
  // DeploymentConfiguration.NEVER cannot activate, so no delay is scheduled.
  return { ...tuple, deployEvent, deployAltitude: deployEvent === 'altitude' ? tuple.deployAltitude : 0,
    deployDelay: deployEvent === 'never' ? 0 : tuple.deployDelay };
}

function flownSeparation(tuple: SeparationTuple): SeparationTuple {
  // OrkEngine.separationEventOf folds case/underscores; only the two altitude
  // handlers in StageSeparationConfiguration read altitude. NEVER returns false.
  const separationEvent = tuple.separationEvent.toLowerCase().replaceAll('_', '');
  return { ...tuple, separationEvent,
    separationAltitude: separationEvent === 'altitudeascending' || separationEvent === 'altitudedescending' ? tuple.separationAltitude : 0,
    separationDelay: separationEvent === 'never' ? 0 : tuple.separationDelay };
}

function flownIgnition(tuple: IgnitionTuple): IgnitionTuple {
  // flightRunner.writeMountMotor uses this parser before calling OrkEngine.
  const event = knownIgnitionEvent(tuple.event) ?? tuple.event;
  // Keep AUTOMATIC distinct: IgnitionEvent checks isLaunchStage at each event,
  // and separation can change which core stage is the bottom active one.
  // IgnitionEvent.NEVER uses the always-false default activation handler.
  return { event, delay: event === 'never' ? 0 : tuple.delay };
}

function describeFlownDeployment(tuple: DeploymentTuple, unit: string): string {
  const deployEvent = flownDeployEvent(tuple.deployEvent);
  const description = describeComponentFlightTuple(flownDeployment(tuple), unit, 'warning');
  if (deployEvent === tuple.deployEvent.toLowerCase()) return description;
  const stored = tuple.deployEvent.toLowerCase() === 'lowerstageseparation' ? 'lower stage separation' : tuple.deployEvent;
  return `${description} (the file's '${stored}' is not supported here)`;
}

/** Describe effective overrides on present components / loaded motors. */
export function describeFlightOverrides(
  tree: FlightTree, overrides: FlightOverrides, motors: Record<string, MountMotor>,
  configLabel: string | null, distanceUnit: string,
): FlightOverrideSummary | null {
  const records: RecordedFlightOverride[] = [];
  const groups = new Map<string, Group>();
  const mountIds = new Set(motorMounts(tree).map(node => node.id));
  const topStage = stages(tree)[0];
  let first: FlightOverrideSummary['first'] | undefined;
  const add = (node: ComponentNode, family: OverrideFamily, kind: string, flown: string, own: string) => {
    first ??= { id: node.id!, family };
    const key = JSON.stringify([family, kind, flown, own]);
    const group = groups.get(key) ?? { family, kind, names: [], flown, own };
    group.names.push(node.name || kind);
    groups.set(key, group);
  };
  const visit = (nodes: ComponentNode[]) => {
    for (const node of nodes) {
      const id = node.id;
      if (id && (node.type === 'parachute' || node.type === 'streamer')) {
        const tuple = overrideFor(overrides.deployments, id);
        const own = deploymentTuple(node);
        if (tuple && sparsify(flownDeployment(own), flownDeployment(tuple))) {
          records.push({ family: 'recovery', kind: node.type, partName: node.name || node.type,
            flies: { ...tuple }, own: { ...own } });
          add(node, 'recovery', node.type, describeFlownDeployment(tuple, distanceUnit), describeFlownDeployment(own, distanceUnit));
        }
      }
      // BasicEventSimulationEngine never separates axial stage 0 (the sustainer).
      if (id && node !== topStage && (node.type === 'stage' || node.type === 'parallelstage')) {
        const tuple = overrideFor(overrides.separations, id);
        const own = separationTuple(node);
        if (tuple && sparsify(flownSeparation(own), flownSeparation(tuple))) {
          records.push({ family: 'separation', kind: 'stage', partName: node.name || 'stage',
            flies: { ...tuple }, own: { ...own } });
          add(node, 'separation', 'stage', describeComponentFlightTuple(flownSeparation(tuple), distanceUnit, 'warning'), describeComponentFlightTuple(flownSeparation(own), distanceUnit, 'warning'));
        }
      }
      const motor = id ? overrideFor(motors, id) : undefined;
      if (id && motor && mountIds.has(id)) {
        const tuple = overrideFor(overrides.ignitions, id);
        const own = overrideFor(tree.ignitionDefaults, id) ?? motor.ignition;
        if (tuple && sparsify(flownIgnition(own), flownIgnition(tuple))) {
          records.push({ family: 'ignition', kind: 'motor mount', partName: node.name || 'motor mount',
            flies: { ...tuple }, own: { ...own } });
          add(node, 'ignition', 'motor mount', describeIgnitionTuple(flownIgnition(tuple), 'warning'), describeIgnitionTuple(flownIgnition(own), 'warning'));
        }
      }
      if (node.children) visit(node.children);
    }
  };
  visit(tree.components);
  if (!first) return null;
  const subject = configLabel ? `Flight configuration “${configLabel}”` : 'The detached working settings';
  const count = (g: Group) => g.names.length === 1 ? g.kind : `${g.names.length} ${g.kind}s`;
  const name = (g: Group) => {
    const meaningful = g.names.some(n => n.trim().toLowerCase() !== g.kind);
    if (g.names.length === 1) return meaningful ? `${g.kind} “${g.names[0]!}”` : g.kind;
    return `${count(g)}${g.names.length === 2 && new Set(g.names).size === 2 && meaningful ? ` (${g.names.join(' and ')})` : ''}`;
  };
  const sentences = (short: boolean) => (['recovery', 'separation', 'ignition'] as const).flatMap(family => {
    const members = [...groups.values()].filter(g => g.family === family);
    if (!members.length) return [];
    const verb = family === 'recovery' ? 'deploy' : family === 'separation' ? 'separate' : 'ignite';
    return [`${subject} ${configLabel ? 'overrides' : 'override'} ${members.map(g => `${name(g)}${short ? ' —' : ':'} ${g.names.length === 1 ? `it ${verb}s` : `they ${verb}`} at ${g.flown}${short ? '' : `, not at ${g.names.length === 1 ? 'its' : 'their'} own setting (${g.own})`}`).join('; ')}.`];
  });
  return { text: sentences(false).join(' '), shortText: sentences(true).join(' '), first, records };
}

export function describeRecordedOverride(record: RecordedFlightOverride, side: 'flies' | 'own', unit: string): string {
  if (record.family === 'recovery') return describeFlownDeployment(record[side], unit);
  if (record.family === 'separation') return describeComponentFlightTuple(flownSeparation(record[side]), unit, 'warning');
  return describeIgnitionTuple(flownIgnition(record[side]), 'warning');
}

/** Batch changes the swept mount's ignition; every other effective override stays. */
export function recordFlightOverrides(tree: FlightTree, overrides: FlightOverrides,
  motors: Record<string, MountMotor>, sweptMountId?: string): RecordedFlightOverride[] {
  const selected = sweptMountId === undefined ? overrides : { ...overrides,
    ignitions: Object.fromEntries(Object.entries(overrides.ignitions ?? {}).filter(([id]) => id !== sweptMountId)),
  };
  return describeFlightOverrides(tree, selected, motors, null, 'm')?.records ?? [];
}
