import type { FlightResult } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { motorIdentity } from './hardwareMass.js';

export const DELAY_POLICY = 'carrier-ballistic-v1';
export const LATE_BURNOUT_CAUTION = "Burnout comes after this branch's ballistic apogee, so 0 s — the earliest possible charge — is used.";
export type StoredDelay = number | 'plugged';
export const storeDelay = (n: number): StoredDelay => n === Infinity ? 'plugged' : n;
export const readDelay = (n: StoredDelay): number => n === 'plugged' ? Infinity : n;

export interface DelayMount {
  mountId: string;
  mountName: string;
  motorIdentity: string;
  mode: 'auto' | 'manual' | 'plugged';
  delay: number;
}
export interface MountDelayRecord extends Omit<DelayMount, 'delay'> {
  flownDelay: StoredDelay;
  rawOptimum: number | null;
  recommendedDelay: number | null;
  burnoutTime: number | null;
  apogeeTime: number | null;
  branchId: string | null;
  branchName: string | null;
  status: 'resolved' | 'fixed';
  caution?: string;
  /** Batch's explicit charge-recovery exception, never applied to background mounts. */
  exception?: 'plugged-on-charge';
}
export interface DelayResolution {
  policy: typeof DELAY_POLICY;
  mounts: MountDelayRecord[];
  probes: number;
  elapsedMs: number;
}

export function delayMountsOf(assigned: readonly (readonly [string, MountMotor])[], names: Record<string, string> = {}): DelayMount[] {
  return assigned.map(([id, mm]) => ({
    mountId: id, mountName: Object.hasOwn(names, id) ? names[id]! : id,
    motorIdentity: mm.meta.motorId ?? motorIdentity(mm.meta, mm.spec.designation),
    mode: mm.meta.autoDelay ? 'auto' : mm.spec.ejectionDelay === Infinity ? 'plugged' : 'manual',
    delay: mm.spec.ejectionDelay,
  }));
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const validDelay = (n: unknown): n is StoredDelay => n === 'plugged' || (finite(n) && n >= 0);

/** Validate persisted evidence before replay/export. A partial vector is not a flight. */
export function validDelayResolution(value: unknown): value is DelayResolution {
  if (!value || typeof value !== 'object') return false;
  const r = value as DelayResolution;
  if (r.policy !== DELAY_POLICY || !Array.isArray(r.mounts) || r.mounts.length === 0
    || !Number.isInteger(r.probes) || r.probes < 0 || r.probes > 8 || !finite(r.elapsedMs) || r.elapsedMs < 0) return false;
  const seen = new Set<string>();
  return r.mounts.every((m) => {
    if (!m || typeof m !== 'object' || typeof m.mountId !== 'string' || !m.mountId
      || seen.has(m.mountId) || typeof m.mountName !== 'string' || typeof m.motorIdentity !== 'string'
      || !validDelay(m.flownDelay) || (m.caution !== undefined && typeof m.caution !== 'string')) return false;
    if (m.exception !== undefined && (m.exception !== 'plugged-on-charge' || m.mode !== 'auto')) return false;
    seen.add(m.mountId);
    if (m.mode === 'auto') return m.status === 'resolved' && r.probes > 0
      && finite(m.rawOptimum) && finite(m.burnoutTime) && m.burnoutTime >= 0
      && finite(m.apogeeTime) && m.apogeeTime >= 0
      && Math.abs(m.rawOptimum - (m.apogeeTime - m.burnoutTime)) < 1e-9
      && m.recommendedDelay === Math.max(0, Math.round(m.rawOptimum))
      && m.flownDelay === m.recommendedDelay
      && typeof m.branchId === 'string' && typeof m.branchName === 'string'
      && (m.rawOptimum >= 0 || m.caution === LATE_BURNOUT_CAUTION);
    return m.status === 'fixed' && (m.mode === 'manual' ? finite(m.flownDelay) : m.mode === 'plugged' && m.flownDelay === 'plugged')
      && m.rawOptimum === null && m.recommendedDelay === null
      && m.burnoutTime === null && m.apogeeTime === null && m.branchId === null && m.branchName === null;
  });
}

/** Saved identity evidence plus the current fingerprints used only as a guard. */
export interface DelayIdentityContext {
  motorSetKey?: string;
  motorDataKeys?: Record<string, string>;
  currentMotorDataKeys?: Record<string, string>;
}

/** Repair only the historical Batch manufacturer omission, without mutating history. */
export function normalizeDelayResolution(r: unknown, identity?: DelayIdentityContext): DelayResolution | undefined {
  if (!validDelayResolution(r)) return undefined;
  // Old Batch flyLegs omitted manufacturer on retained ID-less motors. Recover
  // only that identity omission from THIS run's mount entry, never today's motor.
  // Keep the recorded policy/delay intact and do not rewrite persisted evidence.
  const mounts = r.mounts.map((flown) => {
    if (!flown.motorIdentity.startsWith('/') || flown.motorIdentity.length === 1) return flown;
    const prefix = `${flown.mountId}:`;
    const entries = identity?.motorSetKey?.split('|').filter((entry) => entry.startsWith(prefix));
    if (entries?.length !== 1) return flown;
    const fields = entries[0]!.slice(prefix.length).split(':');
    // ID-less entries are identity:delay:event:ignitionDelay. Refuse ambiguous
    // delimiters and EX IDs rather than treating them as manufacturer names.
    if (fields.length !== 4) return flown;
    const savedIdentity = fields[0]!;
    const slash = savedIdentity.indexOf('/');
    if (slash <= 0 || savedIdentity.slice(slash) !== flown.motorIdentity) return flown;
    const fingerprint = identity?.motorDataKeys?.[flown.mountId];
    if (fingerprint !== undefined && fingerprint !== identity?.currentMotorDataKeys?.[flown.mountId]) return flown;
    return { ...flown, motorIdentity: savedIdentity };
  });
  return { ...r, mounts };
}

export function resolutionMatches(r: unknown, mounts: readonly DelayMount[]): r is DelayResolution {
  return validDelayResolution(r) && r.mounts.length === mounts.length && mounts.every((m) => {
    const flown = r.mounts.find((x) => x.mountId === m.mountId);
    return flown?.motorIdentity === m.motorIdentity && flown.mode === m.mode
      && (m.mode === 'auto' || readDelay(flown.flownDelay) === m.delay);
  });
}

/** Legacy scalar replay is unambiguous for one mount, or an unchanged fixed vector. */
export function canReplayDelays(
  resolution: unknown, assigned: readonly (readonly [string, MountMotor])[], primaryId: string, delayS: number,
  identity?: DelayIdentityContext,
): boolean {
  if (!(delayS === Infinity || (finite(delayS) && delayS >= 0))) return false;
  if (resolution !== undefined) {
    const normalized = normalizeDelayResolution(resolution, identity);
    return resolutionMatches(normalized, delayMountsOf(assigned))
      && normalized.mounts.some((m) => m.mountId === primaryId && readDelay(m.flownDelay) === delayS);
  }
  const primary = assigned.find(([id]) => id === primaryId)?.[1];
  return !!primary && (assigned.length === 1
    || (assigned.every(([, mm]) => !mm.meta.autoDelay) && delayS === primary.spec.ejectionDelay));
}

function refuse(mounts: readonly DelayMount[], reason: string): never {
  throw new Error(`Auto delay did not settle for ${mounts.map((m) => m.mountName).join(', ')}: ${reason}. Choose a fixed delay and Launch again.`);
}

/** Highest completed altitude peak in the carrier's trace, including inherited ascent. */
function targetFor(result: FlightResult, mount: DelayMount): Omit<MountDelayRecord, keyof DelayMount | 'flownDelay'> {
  const branches = result.delayProbe?.version === 1 ? result.delayProbe.branches : undefined;
  if (!branches?.length) return refuse([mount], 'recovery-free telemetry is unavailable');
  const carriers = branches.filter((b) => b.mountIds.includes(mount.mountId));
  if (carriers.length !== 1) return refuse([mount], 'the carrier branch is missing or ambiguous');
  const b = carriers[0]!;
  const ground = b.events.find((e) => e.type === 'GROUND_HIT')?.time;
  if (!finite(ground) || b.events.some((e) => e.type === 'SIM_ABORT' || e.type === 'EXCEPTION')) {
    return refuse([mount], 'the carrier flight aborted or ended before landing');
  }
  if (b.events.some((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')) return refuse([mount], 'recovery was active in the target probe');
  if ((branches.indexOf(b) > 0 && !b.parentId)
    || (b.parentId && !branches.some((p) => p.id === b.parentId && p !== b))) return refuse([mount], 'branch ancestry is unavailable');
  // Events inherited by a detached branch repeat the same absolute burnout.
  const burnouts = new Set(branches.flatMap((branch) => branch.events)
    .filter((e) => e.type === 'BURNOUT' && e.motorMountId === mount.mountId && finite(e.time))
    .map((e) => e.time));
  if (burnouts.size !== 1) return refuse([mount], 'actual motor burnout is missing or ambiguous');
  const burnout = [...burnouts][0]!;
  if (burnout > ground) return refuse([mount], 'motor burnout occurs after landing');
  const { time, altitude } = b.series;
  const vz = b.series['Vz'];
  if (!vz || time.length !== altitude.length || vz.length !== time.length) return refuse([mount], 'the vertical flight trace is incomplete');
  let apogee: number | null = null;
  let peak = -Infinity;
  for (let i = 1; i < time.length; i++) {
    const t0 = time[i - 1], t1 = time[i], h0 = altitude[i - 1], h1 = altitude[i], v0 = vz[i - 1], v1 = vz[i];
    if (![t0, t1, h0, h1, v0, v1].every(finite)) return refuse([mount], 'the vertical flight trace contains missing samples');
    if (t1! > ground || t1! <= t0!) continue;
    if (v0! > 0 && v1! <= 0) {
      const fraction = v0! / (v0! - v1!);
      const height = h0! + fraction * (h1! - h0!);
      if (height > peak) { peak = height; apogee = t0! + fraction * (t1! - t0!); }
    }
  }
  if (apogee === null) return refuse([mount], 'no completed ballistic apogee was recorded');
  const rawOptimum = apogee - burnout;
  return {
    rawOptimum, recommendedDelay: Math.max(0, Math.round(rawOptimum)), burnoutTime: burnout,
    apogeeTime: apogee, branchId: b.id, branchName: b.name, status: 'resolved',
    ...(rawOptimum < 0 ? { caution: LATE_BURNOUT_CAUTION } : {}),
  };
}

export interface DelayBudget { probes: number }

/** Simultaneous fixed-point iteration. The accepted vector is the one actually probed. */
export async function solveAutoDelays(input: {
  mounts: readonly DelayMount[];
  probe: (delays: ReadonlyMap<string, number>) => FlightResult;
  budget: DelayBudget;
  signal?: AbortSignal;
  yieldToUi?: () => Promise<void>;
}): Promise<DelayResolution> {
  const start = performance.now();
  const autos = input.mounts.filter((m) => m.mode === 'auto');
  let vector = new Map(input.mounts.map((m) => [m.mountId, m.delay]));
  const fixed = (): MountDelayRecord[] => input.mounts.map(({ delay, ...m }) => ({
    ...m, flownDelay: storeDelay(delay), rawOptimum: null, recommendedDelay: null,
    burnoutTime: null, apogeeTime: null, branchId: null, branchName: null, status: 'fixed',
  }));
  if (!autos.length) return { policy: DELAY_POLICY, mounts: fixed(), probes: input.budget.probes, elapsedMs: 0 };
  const seen = new Set<string>();
  while (input.budget.probes < 8) {
    input.signal?.throwIfAborted();
    const key = JSON.stringify([...vector].map(([id, d]) => [id, storeDelay(d)]));
    if (seen.has(key)) return refuse(autos, 'the delay vector repeats without settling');
    seen.add(key);
    const result = input.probe(vector);
    input.budget.probes++;
    const records = fixed();
    const next = new Map(vector);
    for (const m of autos) {
      const target = targetFor(result, m);
      next.set(m.mountId, target.recommendedDelay!);
      Object.assign(records.find((r) => r.mountId === m.mountId)!, target, { flownDelay: target.recommendedDelay });
    }
    await (input.yieldToUi ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0))))();
    input.signal?.throwIfAborted();
    if (autos.every((m) => next.get(m.mountId) === vector.get(m.mountId))) {
      return { policy: DELAY_POLICY, mounts: records, probes: input.budget.probes, elapsedMs: performance.now() - start };
    }
    vector = next;
  }
  return refuse(autos, 'eight target probes were exhausted');
}
