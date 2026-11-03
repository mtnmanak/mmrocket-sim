import type { MotorSpec } from '@online-openrocket/engine';
import type { UnitSelection } from '../prefs/units.js';
import { isHighPower, motorLabel } from './motorDb.js';
import type { MotorMeta } from './simReport.js';
import { delayOptions, fetchMotorSpec, type TcMotor } from './thrustcurve.js';

/** Shared curve choice and metadata for the Motors tab and motor links. */
export async function loadMotorForMount(motor: TcMotor, delay: number, opts: {
  units: UnitSelection; signal?: AbortSignal; autoDelay?: boolean;
}): Promise<{ label: string; spec: MotorSpec; meta: MotorMeta }> {
  const spec = await fetchMotorSpec(motor, delay, opts.signal, { units: opts.units });
  const label = motorLabel(motor, delay, { autoDelay: opts.autoDelay === true });
  return { label, spec, meta: {
    label, manufacturer: motor.manufacturerAbbrev,
    ...(motor.motorId.startsWith('ex:') ? { exMotorId: motor.motorId } : { motorId: motor.motorId }),
    availableDelays: delayOptions(motor), autoDelay: opts.autoDelay === true,
    type: 'type' in motor && typeof motor.type === 'string' ? motor.type : undefined,
    propellant: motor.propInfo, motorCase: motor.caseInfo, highPower: isHighPower(motor),
  } };
}
