import type { EngineWarning, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { INITIAL_UNITS, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import { motorLengthLimit } from '../tree/motorLength.js';
import { estimateMotorRoom } from '../tree/motorRoom.js';
import { mountBore } from '../tree/scaleRocket.js';
import { findNode, motorMounts, mountName, updateNode } from '../tree/treeModel.js';
import { fitsMount } from './motorDb.js';
import { noteField, noteText } from './noteField.js';

/** Advice only: the kernel has no motor/airframe collision model. */
export function motorFitWarnings(tree: RocketTree, motors: readonly (readonly [string, MountMotor])[],
  units: UnitSelection = INITIAL_UNITS): EngineWarning[] {
  const warnings: EngineWarning[] = [];
  const dimension = (m: number, against?: number) => noticeQuantity('motorDimensions', m, units, { against });
  for (const [id, motor] of motors) {
    const mount = findNode(tree, id);
    if (!mount) continue;
    const name = `“${noteField(mountName(mount))}”: ${noteField(motor.label)}`;
    const limit = motorLengthLimit(mount);
    const room = limit ?? estimateMotorRoom(tree, id)?.lengthM;
    if (room !== undefined && motor.spec.length > room + 1e-9) warnings.push({
      key: 'MOTOR_TOO_LONG', priority: 'NORMAL',
      message: noteText(`${name}: Motor length ${dimension(motor.spec.length, room)} exceeds ${limit === null ? 'estimated room' : 'Max motor length'} ${dimension(room)}. `
        + (limit === null ? 'The modelled motor room is an estimate; check the real clearance. ' : 'Check the real clearance. ')
        + 'The motor may hit parts inside the rocket; the simulation does not model this collision.'),
    });
    const bore = mountBore(mount);
    const assumedBore = mount['boreAssumed'] === true && mount['filled'] !== true && mount['caseAirframe'] !== true;
    if (!assumedBore && !fitsMount(bore * 1000, { diameter: motor.spec.diameter * 1000 })) warnings.push({
      key: 'MOTOR_TOO_WIDE', priority: 'NORMAL',
      message: noteText(`${name}: motor diameter ${dimension(motor.spec.diameter, bore)} exceeds the mount bore ${dimension(bore)}. `
        + 'The real rocket could not be built this way. The simulation still flies this motor and does not model the interference.'),
    });
  }
  return warnings;
}

/** File choices span configurations; keep original choices after ordinary motor edits. */
export function refreshFileMotorIds(tree: RocketTree, motorSets: readonly Record<string, MountMotor>[],
  keepExisting = false, mountIds?: ReadonlySet<string>): RocketTree {
  for (const mount of motorMounts(tree)) {
    if (mountIds && !mountIds.has(mount.id!)) continue;
    const previous = mount['fileMotorIds'];
    const ids = [...new Set([
      ...(keepExisting && Array.isArray(previous) ? previous.filter((id): id is string => typeof id === 'string') : []),
      ...motorSets.flatMap(motors => {
        const motor = Object.hasOwn(motors, mount.id!) ? motors[mount.id!] : undefined;
        const id = motor?.meta.motorId ?? motor?.meta.exMotorId;
        return id && !fitsMount(mountBore(mount) * 1000, { diameter: motor!.spec.diameter * 1000 }) ? [id] : [];
      }),
    ])];
    if (ids.length || Array.isArray(previous)) tree = updateNode(tree, mount.id!, { fileMotorIds: ids });
  }
  return tree;
}
