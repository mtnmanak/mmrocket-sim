import type { RocketTree } from '@online-openrocket/engine';
import type { NoteTier } from '../components/Note.js';
import { launchMountOf, stageIndexOf, stages } from '../tree/treeModel.js';
import { motorLabel, type MotorDbEntry } from './motorDb.js';
import type { DelayHint, MotorLinkParams } from './motorLink.js';
import { noteField } from './noteField.js';
import { defaultDelay, delayOptions, type TcMotor } from './thrustcurve.js';
import type { UnitSelection } from '../prefs/units.js';

export interface LinkNote { tier: NoteTier; text: string }
export type MotorLinkPlan =
  | { kind: 'fly'; mountId: string; motor: TcMotor; delay: number; autoDelay: boolean; notes: LinkNote[] }
  | { kind: 'no-flight'; notes: LinkNote[] };

/** Same provisional delay as the Motors tab when no prescribed delays exist. */
export function chooseLinkDelay(motor: TcMotor, hint: DelayHint | null): number {
  const wanted = hint === 'plugged' ? Infinity : hint;
  return wanted !== null && delayOptions(motor).includes(wanted) ? wanted : defaultDelay(motor) ?? 0;
}

// Keep all motor-link user copy here so it can be reviewed together.
export const motorLinkLoadFailure = (motor: TcMotor, delay: number, autoDelay = false): string =>
  `The link's motor “${noteField(motorLabel(motor, delay, { autoDelay }))}” could not be loaded. The design is open; no flight was run.`;

const copy = {
  unknown: (id: string, date: string) => `The link asked for motor ID “${noteField(id)}”, which this app's motor list (dated ${noteField(date)}) does not have. No motor was loaded from the link — pick one on Motors & Configuration.`,
  noMount: 'This design has no motor mount, so the motor in the link could not be loaded.',
  others: (stage: string, n: number) => `The link set only the ${stage} motor. ${n} other motor mount(s) are empty — add motors on the Motors tab.`,
};

export function planMotorLink(input: {
  tree: RocketTree; mountIds: string[]; params: MotorLinkParams;
  catalogue: readonly MotorDbEntry[]; catalogueDate: string;
  loadedMountIds?: string[];
  units?: UnitSelection;
}): MotorLinkPlan {
  const { tree, params } = input;
  const notes: LinkNote[] = params.problems.map(text => ({ tier: 'information', text }));
  if (params.motorId === null) return { kind: 'no-flight', notes };
  const mountId = launchMountOf(tree, input.mountIds);
  if (mountId === null) return { kind: 'no-flight', notes: [...notes, { tier: 'information', text: copy.noMount }] };
  const motor = input.catalogue.find(m => m.motorId === params.motorId);
  if (!motor) return { kind: 'no-flight', notes: [...notes,
    { tier: 'information', text: copy.unknown(params.motorId ?? '', input.catalogueDate) }] };
  const delay = chooseLinkDelay(motor, params.delayHint);
  const autoDelay = delayOptions(motor).length === 0;
  // The flight warning strip owns motor-fit advice on every entry path.
  const emptyOthers = input.mountIds.filter(id => id !== mountId && !input.loadedMountIds?.includes(id)).length;
  if (emptyOthers > 0) notes.push({ tier: 'information',
    text: copy.others(noteField(stages(tree)[stageIndexOf(tree, mountId)]?.name ?? 'launch-stage'), emptyOthers) });
  return { kind: 'fly', mountId, motor, delay, autoDelay, notes };
}

/** Only an untouched link design without a file or a paused autosave may be replaced. */
export function motorLinkMayReplace(s: {
  motorLinkMark: string | null; currentMark: string;
  designFile: import('./designFileName.js').DesignFileRef | null; autosavePaused: boolean;
}): boolean {
  return s.motorLinkMark === s.currentMark && s.designFile === null && !s.autosavePaused;
}
