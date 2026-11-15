import type { ComponentNode, EngineWarning, FlightResult, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { aftLayout } from '../tree/aftLayout.js';
import { findNode, motorMounts, mountName, stages } from '../tree/treeModel.js';
import { noteField } from './noteField.js';
import { fmtSig } from '../prefs/units.js';
import { knownIgnitionEvent } from './ignitionEvent.js';

export interface ThrustSite {
  mountId: string;
  name: string;
  y: number;
  z: number;
  spec: MotorSpec;
  /** null means an airstart whose time is not yet known. */
  ignition: number | null;
}

/** Linear interpolation of the loaded curve, with no thrust outside its burn. */
function thrust(site: ThrustSite, time: number, side = 0): number {
  if (site.ignition === null) return 0;
  const t = time - site.ignition, { times, thrusts } = site.spec;
  const start = site.ignition + times[0]!, end = site.ignition + times.at(-1)!;
  if (!times.length || time < start || time > end
    || (time === start && side < 0) || (time === end && side > 0)) return 0;
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid; else hi = mid;
  }
  if (hi === lo) return thrusts[lo] ?? 0;
  const span = times[hi]! - times[lo]!;
  return span > 0 ? thrusts[lo]! + (thrusts[hi]! - thrusts[lo]!) * (t - times[lo]!) / span : 0;
}

/** The moment is linear between samples; its norm reaches its maximum at an endpoint. */
export function thrustImbalance(sites: readonly ThrustSite[], peakFloor = 0, radiusFloor = 0) {
  const lit = sites.filter(s => s.ignition !== null && s.spec.times.length);
  const grid = [...new Set(lit.flatMap(s => s.spec.times.map(t => t + s.ignition!)))].sort((a, b) => a - b);
  const radius = lit.reduce((r, s) => Math.max(r, Math.hypot(s.y, s.z)), radiusFloor);
  let peak = peakFloor, moment = 0, time = 0, worstSide = 0;
  for (const t of grid) {
    // A nonzero first/last sample is a jump: evaluate both limits, not an epsilon step.
    // A cutoff and an ignition at the same instant do not overlap. The two
    // one-sided limits include every physical endpoint without summing jumps.
    for (const side of [-1, 1]) {
      let total = 0, y = 0, z = 0;
      for (const site of lit) {
        const f = thrust(site, t, side);
        total += f; y += f * site.y; z += f * site.z;
      }
      peak = Math.max(peak, total);
      const m = Math.hypot(y, z);
      if (m > moment) { moment = m; time = t; worstSide = side; }
    }
  }
  const raw = peak > 0 && radius > 0 ? moment / (peak * radius) : 0;
  // Trigonometric roundoff in a symmetric ring is not a physical imbalance.
  const fraction = raw < 1e-12 ? 0 : raw;
  const firing = [...new Set(lit.filter(s => thrust(s, time, worstSide) > 0).map(s => s.name))];
  return { fraction, time, firing, peak, offset: peak > 0 ? moment / peak : 0 };
}

// Normalizing by radius makes even a lone motor 0.5 mm off-axis read 100%.
const MIN_THRUST_OFFSET_M = 0.001;

/** Only absorb arithmetic roundoff at the defined inclusive thresholds. */
const reaches = (fraction: number, threshold: number) => fraction >= threshold * (1 - 1e-12);

/** Advice only: never changes the engine inputs or a run's acceptance criteria. */
export function asymmetricThrustWarnings(
  tree: RocketTree, motors: readonly (readonly [string, MountMotor])[], result?: FlightResult,
): EngineWarning[] {
  const mounts = new Set(motorMounts(tree).map(m => m.id));
  const installed = new Map(motors.filter(([id, m]) => {
    const event = knownIgnitionEvent(m.ignition.event);
    return mounts.has(id) && event !== null && event !== 'never';
  }));
  const dimensions = Object.fromEntries([...installed].map(([id, m]) => [id, m.spec]));
  const allSites: ThrustSite[] = [];
  const events = [...(result?.events ?? []), ...(result?.branches ?? []).flatMap(b => b.events)];
  const serial = stages(tree);
  // ParallelStage.isLaunchStage is true even when attached to an upper core stage.
  const stageOf = new Map<string, ComponentNode | undefined>();
  const groupOf = new Map<string, ComponentNode | undefined>();
  const parent = new Map<ComponentNode, ComponentNode | undefined>();
  for (const [i, stage] of serial.entries()) parent.set(stage, serial[i - 1]);
  const walk = (nodes: ComponentNode[], stage?: ComponentNode, group?: ComponentNode) => {
    for (const node of nodes) {
      const owner = node.type === 'stage' || node.type === 'parallelstage' ? node : stage;
      const serialOwner = node.type === 'stage' ? node : group;
      if (node.type === 'parallelstage') parent.set(node, stage);
      if (node.id) { stageOf.set(node.id, owner); groupOf.set(node.id, serialOwner); }
      walk(node.children ?? [], owner, serialOwner);
    }
  };
  walk(tree.components);
  const trigger = (id: string) => {
    const event = knownIgnitionEvent(installed.get(id)!.ignition.event);
    const stage = stageOf.get(id);
    const launchStage = !serial.length || stage?.type === 'parallelstage' || stage === serial.at(-1);
    return event === 'automatic' ? launchStage ? 'launch' : 'ejectioncharge' : event;
  };
  const recordedIgnition = (id: string) => events.filter(e => e.type === 'IGNITION'
    && e.motorMountId === id && Number.isFinite(e.time)).map(e => e.time);
  const flightEnd = (id: string) => {
    const probe = result?.delayProbe?.branches.find(b => b.mountIds.includes(id));
    const named = result?.branches?.filter(b => b.name === stageOf.get(id)?.name) ?? [];
    const branch = probe ?? (named.length === 1 ? named[0] : undefined);
    const data = branch ?? result;
    return [...(data?.series?.time ?? []), ...(data?.events ?? []).map(e => e.time)]
      .reduce((end, t) => Number.isFinite(t) ? Math.max(end, t) : end, branch ? 0 : result?.summary?.flightTime ?? 0);
  };
  const aborted = events.some(e => e.type === 'SIM_ABORT');
  const endedBeforeIgnition = (id: string): boolean => {
    const motor = installed.get(id)!, event = trigger(id);
    const end = flightEnd(id);
    if (event === 'launch') return motor.ignition.delay > end;
    // Burnout/ejection in the stage immediately below can trigger this stage.
    // A recorded trigger is authoritative; otherwise use a lit motor's curve
    // to tell whether the flight stopped before that trigger was possible.
    const owner = stageOf.get(id), times: number[] = [];
    for (const [source, lower] of installed) {
      const lowerStage = stageOf.get(source);
      if (!lowerStage || parent.get(lowerStage) !== owner) continue;
      const eventType = event === 'burnout' ? 'BURNOUT' : 'EJECTION_CHARGE';
      const recorded = events.filter(e => e.type === eventType && e.motorMountId === source
        && Number.isFinite(e.time)).map(e => e.time);
      if (recorded.length) { times.push(...recorded); continue; }
      const burn = lower.spec.times.at(-1);
      const delay = event === 'burnout' ? 0 : lower.spec.ejectionDelay;
      if (burn === undefined || !Number.isFinite(delay)) continue;
      const ignition = recordedIgnition(source);
      if (!ignition.length && trigger(source) === 'launch') ignition.push(lower.ignition.delay);
      if (ignition.length) times.push(Math.min(...ignition) + burn + delay);
      // A pending middle-stage ignition leaves its own burnout/ejection
      // pending too. Infinity marks an unchecked future trigger, not a
      // predicted absolute time; an earlier known trigger still takes priority.
      else if (endedBeforeIgnition(source)) times.push(Infinity);
    }
    return times.length > 0 && Math.min(...times) + motor.ignition.delay > end;
  };
  aftLayout(tree, 0, dimensions, undefined, (id, y, z) => {
    const motor = installed.get(id)!;
    const recorded = recordedIgnition(id);
    if (result && !recorded.length && !aborted && !endedBeforeIgnition(id)) return;
    const ignition = recorded.length ? Math.min(...recorded)
      : trigger(id) === 'launch' ? motor.ignition.delay : null;
    allSites.push({ mountId: id, name: mountName(findNode(tree, id)), y, z, spec: motor.spec, ignition });
  });
  // One serial stage and all of its parallel stages share a whole-burn grid,
  // peak and radius. Separation never starts another measurement.
  const groups = new Map<ComponentNode | undefined, ThrustSite[]>();
  for (const site of allSites) {
    const owner = groupOf.get(site.mountId), sites = groups.get(owner) ?? [];
    sites.push(site);
    groups.set(owner, sites);
  }
  const warnings: EngineWarning[] = [];
  const unknownText = result
    ? ' The flight ended before every motor\'s ignition could be checked. Check the ignition settings and fly again.'
    : ' Includes an airstart whose time the app cannot tell before you fly; it is checked again on the launch report.';
  for (const [stage, sites] of groups) {
    const prefix = serial.length > 1 ? `${noteField(stage?.name || 'Stage')}: ` : '';
    const sets = new Map<string, ThrustSite[]>();
    for (const site of sites.filter(s => s.ignition === null)) {
      const key = trigger(site.mountId) ?? 'automatic';
      const copies = sets.get(key) ?? [];
      copies.push(site);
      sets.set(key, copies);
    }
    // A common unknown trigger shifts the whole group without changing its
    // balance. This inference is pre-flight only: unrecorded motors after an
    // early-ended flight remain uncertain even when they had one trigger.
    const relative = !result && stage !== serial.at(-1) && sets.size === 1 && sites.every(s => s.ignition === null);
    const withDelay = (s: ThrustSite) => ({ ...s, ignition: installed.get(s.mountId)!.ignition.delay });
    const timedSets = [...sets.values()].map(copies => copies.map(withDelay));
    const measured = relative ? sites.map(withDelay) : sites;
    // An unknown set still contributes to the group's possible peak and
    // radius. Use the same denominator for known and unknown-time advice.
    const peakFloor = Math.max(thrustImbalance(measured).peak, ...timedSets.map(copies => thrustImbalance(copies).peak));
    const radius = sites.reduce((r, s) => Math.max(r, Math.hypot(s.y, s.z)), 0);
    const unknown = !relative && timedSets.some(copies => {
      const worst = thrustImbalance(copies, peakFloor, radius);
      return reaches(worst.fraction, 0.05) && reaches(worst.offset, MIN_THRUST_OFFSET_M);
    });
    const { fraction, time, firing, offset } = thrustImbalance(measured, peakFloor, radius);
    if (reaches(fraction, 0.05) && reaches(offset, MIN_THRUST_OFFSET_M)) {
      const danger = reaches(fraction, 0.20);
      // Round down within Caution rather than displaying Danger's 20% boundary.
      const percent = danger ? Math.max(20, fraction * 100) : Math.min(19.9, fraction * 100);
      warnings.push({ key: danger ? 'ASYMMETRIC_THRUST_DANGER' : 'ASYMMETRIC_THRUST_CAUTION',
        priority: danger ? 'HIGH' : 'NORMAL',
        message: `${prefix}At its worst, ${fmtSig(time, 3, 2)} s after ${relative ? 'ignition' : 'launch'}, `
          + `the net thrust moment reaches ${fmtSig(percent, 3, 1)} % of peak total thrust times mount radius. Firing then: ${firing.map(name => noteField(name)).join(', ')}.`
          + (danger ? ' A real rocket turns toward the weaker side and can fly far off course or cartwheel.'
            : ' A real rocket can turn off course; check that the motors are matched.')
          + ' The simulation does not show this turn: it treats all thrust as acting along the centreline, so its flight path and apogee assume a straight climb.'
          + (unknown ? ` This timing comparison covers only motors with known ignition times.${unknownText}` : ''),
      });
    } else if (unknown) {
      warnings.push({ key: 'ASYMMETRIC_THRUST_UNKNOWN', priority: 'NORMAL',
        message: `${prefix}Thrust balance cannot be fully checked.${unknownText} A real rocket with unbalanced thrust can turn off course or cartwheel. The simulation does not show this turn: it treats all thrust as acting along the centreline.`,
      });
    }
  }
  return warnings;
}
