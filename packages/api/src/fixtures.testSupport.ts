import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { expect } from 'vitest';
import { MOTOR_DB } from '../../app/src/services/motorDb.js';
import { bundleHasCurve, defaultDelay } from '../../app/src/services/thrustcurve.js';

export const bytesOf = (name: string) => new Uint8Array(readFileSync(new URL(`../../app/src/services/__fixtures__/${name}`, import.meta.url)));
export const rktWithMotor = (designation: string, manufacturer: string, delay: number) => new TextEncoder().encode(
  new TextDecoder().decode(bytesOf('rocksimTestRocket1.rkt'))
    .replace(/<EngineCode>[^<]*<\/EngineCode>/g, `<EngineCode>${designation}</EngineCode>`)
    .replace(/<EngineMfg>[^<]*<\/EngineMfg>/g, `<EngineMfg>${manufacturer}</EngineMfg>`)
    .replace(/<EjectionDelay>[^<]*<\/EjectionDelay>/g, `<EjectionDelay>${delay}</EjectionDelay>`));
export async function autoBody() {
  for (const motor of MOTOR_DB) {
    if (defaultDelay(motor) === null && await bundleHasCurve(motor.motorId)) {
      return rktWithMotor(motor.designation, motor.manufacturerAbbrev, -1);
    }
  }
  throw new Error('Auto-delay test requires a bundled motor with no prescribed delay.');
}
export async function missingCurveBody() {
  let missing: (typeof MOTOR_DB)[number] | undefined;
  for (const motor of MOTOR_DB) {
    if ((await bundleHasCurve(motor.motorId)) === false) { missing = motor; break; }
  }
  expect(missing, 'a catalogue motor with no bundled curve').toBeDefined();
  return rktWithMotor(missing!.designation, missing!.manufacturerAbbrev, 5);
}
const referenceXml = () => strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
export const orkOf = (xml: string) => zipSync({ 'rocket.ork': strToU8(xml) });
export const clusterBody = () => orkOf(referenceXml().replace('<clusterconfiguration>single', '<clusterconfiguration>4-ring'));
export function secondaryBody(kind: 'never' | 'refused') {
  let xml = referenceXml();
  let mount = xml.match(/<innertube>[\s\S]*?<\/innertube>/)![0]
    .replace('Inner Tube', 'Secondary mount').replace('cf2a3edb-ead5-4bbd-93b2-1b5631003347', 'secondary-mount');
  if (kind === 'never') mount = mount.replaceAll('<ignitionevent>automatic', '<ignitionevent>never');
  else {
    const definition = { motorId: 'ex:bad', designation: 'Bad-C6', realManufacturer: 'Test', diameter: 18, length: 70,
      totalWeightG: 25, propWeightG: 10, delays: '5', source: 'snapshot', addedAt: 0,
      samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 10 }, { time: 2, thrust: 0 }],
      flightSnapshot: { designation: 'Bad-C6', diameter: 0.018, length: 0.07, cgX: 1,
        times: [0, 1, 2], thrusts: [0, 10, 0], masses: [0.025, 0.02, 0.015] } };
    xml = xml.replace('<rocket>', `<rocket><mmrexmotors version="1">${JSON.stringify([definition])}</mmrexmotors>`);
    mount = mount.replace(/<designation>[^<]*<\/designation>/, '<designation>Bad-C6</designation><mmrexmotorid>ex:bad</mmrexmotorid>');
  }
  return orkOf(xml.replace('</innertube>', `</innertube>${mount}`));
}
