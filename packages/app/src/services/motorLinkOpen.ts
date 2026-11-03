import type { RocketTree } from '@online-openrocket/engine';
import type { NoteTier } from '../components/Note.js';
import { findNode, launchMountOf, stageIndexOf, stages } from '../tree/treeModel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { motorLengthLimit } from '../tree/motorLength.js';
import { fitsMount, motorLabel, type MotorDbEntry } from './motorDb.js';
import type { DelayHint, MotorLinkParams } from './motorLink.js';
import { noteField } from './noteField.js';
import { defaultDelay, delayOptions, type TcMotor } from './thrustcurve.js';

export interface LinkNote { tier: NoteTier; text: string }
export type MotorLinkPlan =
  | { kind: 'fly'; mountId: string; motor: TcMotor; delay: number; notes: LinkNote[] }
  | { kind: 'no-flight'; notes: LinkNote[] };

/** Same provisional delay as the Motors tab when no prescribed delays exist. */
export function chooseLinkDelay(motor: TcMotor, hint: DelayHint | null): number {
  const wanted = hint === 'plugged' ? Infinity : hint;
  return wanted !== null && delayOptions(motor).includes(wanted) ? wanted : defaultDelay(motor) ?? 0;
}

// Keep all motor-link user copy here so it can be reviewed together.
export const motorLinkLoadFailure = (motor: TcMotor, delay: number): string =>
  `The link's motor “${noteField(motorLabel(motor, delay))}” could not be loaded. The design is open; no flight was run.`;

const copy = {
  unknown: (id: string, date: string) => `The link asked for motor ID “${noteField(id)}”, which this app's motor list (dated ${noteField(date)}) does not have. The design is open with that mount empty — pick a motor on the Motors tab.`,
  noMount: 'This design has no motor mount, so the motor in the link could not be loaded.',
  diameter: (motor: string, diameter: number, bore: number) => `${motor} is ${diameter} mm across, but this mount takes ${bore} mm. It was loaded and flown anyway as the link asked — the real rocket could not be built this way.`,
  length: (motor: string, length: number, max: number) => `${motor} is ${length} mm long, longer than this mount's ${max} mm limit. It was loaded and flown anyway — it may hit parts inside the rocket.`,
  others: (stage: string, n: number) => `The link set only the ${stage} motor. ${n} other motor mount(s) are empty — add motors on the Motors tab.`,
};

export function planMotorLink(input: {
  tree: RocketTree; mountIds: string[]; params: MotorLinkParams;
  catalogue: readonly MotorDbEntry[]; catalogueDate: string;
}): MotorLinkPlan {
  const { tree, params } = input;
  const notes: LinkNote[] = params.problems.map(text => ({ tier: 'information', text }));
  const mountId = launchMountOf(tree, input.mountIds);
  if (mountId === null) return { kind: 'no-flight', notes: [...notes, { tier: 'information', text: copy.noMount }] };
  const motor = input.catalogue.find(m => m.motorId === params.motorId);
  if (!motor) return { kind: 'no-flight', notes: [...notes,
    { tier: 'information', text: copy.unknown(params.motorId ?? '', input.catalogueDate) }] };
  const delay = chooseLinkDelay(motor, params.delayHint);
  const label = noteField(motorLabel(motor, delay));
  const mount = findNode(tree, mountId)!;
  const boreMm = mountBore(mount) * 1000;
  if (!fitsMount(boreMm, motor)) notes.push({ tier: 'caution', text: copy.diameter(label, motor.diameter, boreMm) });
  const max = motorLengthLimit(mount);
  if (max !== null && motor.length / 1000 > max) notes.push({ tier: 'caution', text: copy.length(label, motor.length, max * 1000) });
  if (input.mountIds.length > 1) notes.push({ tier: 'information',
    text: copy.others(noteField(stages(tree)[stageIndexOf(tree, mountId)]?.name ?? 'launch-stage'), input.mountIds.length - 1) });
  return { kind: 'fly', mountId, motor, delay, notes };
}
