import { MOTOR_DB, withoutLabelDelay, type MotorDbEntry } from './motorDb.js';

/** Naming fixtures own their data; a catalogue refresh cannot rename them. */
export const labelMotor = (designation: string, manufacturerAbbrev = 'Acme', motorId = designation): MotorDbEntry => ({
  motorId, manufacturerAbbrev, designation, commonName: designation, impulseClass: 'E', diameter: 24, length: 70,
  type: 'SU', avgThrustN: 20, maxThrustN: 48, totImpulseNs: 40, burnTimeS: 2, totalWeightG: 70, propWeightG: 40,
  delays: '5', availability: 'regular',
});

/** Integration evidence is optional: find any same-maker base/suffix pair. */
export const catalogueSuffixPair = (() => {
  for (const base of MOTOR_DB) {
    if (withoutLabelDelay(base.designation) !== base.designation) continue;
    const suffixed = MOTOR_DB.find(m => m.manufacturerAbbrev === base.manufacturerAbbrev
      && m.designation !== base.designation && withoutLabelDelay(m.designation) === base.designation);
    if (suffixed) return [base, suffixed] as const;
  }
  return undefined;
})();
