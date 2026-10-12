import type { ComponentNode } from '@online-openrocket/engine';
import type { DeploymentTuple, FlightOverrides, FlightTree, MountMotor } from '../model/design.js';
import { motorMounts, stages } from '../tree/treeModel.js';
import { flownDeployEvent } from '../tree/deployEvent.js';
import { deploymentTuple } from './foreignConfigLayers.js';
import { overrideFor, sparsify } from './flightState.js';
import { describeComponentFlightTuple, describeIgnitionTuple, separationTuple } from './flightOverrideText.js';

export type OverrideFamily = 'recovery' | 'separation' | 'ignition';
export interface FlightOverrideSummary {
  text: string;
  shortText: string;
  first: { id: string; family: OverrideFamily };
}
interface Group {
  family: OverrideFamily; kind: string; names: string[]; flown: string; own: string;
}

/** Warning equality follows flight behavior; storage equality still keeps the complete tuple. */
function flownDeployment(tuple: DeploymentTuple): DeploymentTuple {
  const deployEvent = flownDeployEvent(tuple.deployEvent);
  return { ...tuple, deployEvent, deployAltitude: deployEvent === 'altitude' ? tuple.deployAltitude : 0 };
}

function describeFlownDeployment(tuple: DeploymentTuple, unit: string): string {
  const deployEvent = flownDeployEvent(tuple.deployEvent);
  const description = describeComponentFlightTuple({ ...tuple, deployEvent }, unit);
  if (deployEvent === tuple.deployEvent.toLowerCase()) return description;
  const stored = tuple.deployEvent.toLowerCase() === 'lowerstageseparation' ? 'lower stage separation' : tuple.deployEvent;
  return `${description} (the file's '${stored}' is not supported here)`;
}

/** Describe effective overrides on present components / loaded motors. */
export function describeFlightOverrides(
  tree: FlightTree, overrides: FlightOverrides, motors: Record<string, MountMotor>,
  configLabel: string | null, distanceUnit: string,
): FlightOverrideSummary | null {
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
        if (tuple && sparsify(flownDeployment(own), flownDeployment(tuple))) add(node, 'recovery', node.type,
          describeFlownDeployment(tuple, distanceUnit), describeFlownDeployment(own, distanceUnit));
      }
      // BasicEventSimulationEngine never separates axial stage 0 (the sustainer).
      if (id && node !== topStage && (node.type === 'stage' || node.type === 'parallelstage')) {
        const tuple = overrideFor(overrides.separations, id);
        const own = separationTuple(node);
        if (tuple && sparsify(own, tuple)) add(node, 'separation', 'stage',
          describeComponentFlightTuple(tuple, distanceUnit), describeComponentFlightTuple(own, distanceUnit));
      }
      const motor = id ? overrideFor(motors, id) : undefined;
      if (id && motor && mountIds.has(id)) {
        const tuple = overrideFor(overrides.ignitions, id);
        const own = overrideFor(tree.ignitionDefaults, id) ?? motor.ignition;
        if (tuple && sparsify(own, tuple)) add(node, 'ignition', 'motor mount',
          describeIgnitionTuple(tuple), describeIgnitionTuple(own));
      }
      if (node.children) visit(node.children);
    }
  };
  visit(tree.components);
  if (!first) return null;
  const subject = configLabel ? `Flight configuration “${configLabel}”` : 'The detached working settings';
  const count = (g: Group) => g.names.length === 1 ? g.kind : `${g.names.length} ${g.kind}s`;
  const name = (g: Group) => g.names.length === 1 ? `${g.kind} “${g.names[0]!}”`
    : `${count(g)}${g.names.length === 2 ? ` (${g.names.join(' and ')})` : ''}`;
  const sentences = (['recovery', 'separation', 'ignition'] as const).flatMap(family => {
    const members = [...groups.values()].filter(g => g.family === family);
    if (!members.length) return [];
    const verb = family === 'recovery' ? 'deploy' : family === 'separation' ? 'separate' : 'ignite';
    return [`${subject} ${configLabel ? 'overrides' : 'override'} ${members.map(g => `${name(g)}: ${g.names.length === 1 ? `it ${verb}s` : `they ${verb}`} at ${g.flown}, not at ${g.names.length === 1 ? 'its' : 'their'} own setting (${g.own})`).join('; ')}.`];
  });
  return { text: sentences.join(' '), first,
    shortText: `${configLabel ? `Overrides in “${configLabel}”` : 'Overrides in the detached working settings'}: ${[...groups.values()].map(count).join(', ')}` };
}
