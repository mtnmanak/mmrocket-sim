import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { clusterCount } from '../tree/cluster.js';
import { findNode } from '../tree/treeModel.js';

/**
 * WEIGHED PAD MASS → the motor hardware the catalogue weight leaves out.
 *
 * The catalogue's motor mass is the motor alone. What goes on the pad around
 * it is not in any catalogue: a motor adapter, the retainer, and whichever
 * forward closure happens to be fitted — and none of it is in the airframe
 * either, because it is only there when a motor is. Eric's two METRA flights
 * (2026-09-07) weighed the pad at 10,574 g (Monster Mamba, AeroTech J540R) and
 * 7,480 g (WM 4" Extreme, AeroTech J460T) against the app's 10,392 g and
 * 7,351 g: the catalogue weights (1,084 g and 801 g loaded) were 182 g and
 * 129 g light. His 54→75 mm adapter alone is 126 g, and AeroTech forward
 * closures move a motor ±50 g depending on which one is on it, with the
 * catalogue's assumption unknown. What that does to apogee was measured
 * through the kernel — see the v0.118 changelog (an earlier "~1.5 %" here
 * traced to no table, so no figure is quoted in this file).
 *
 * WHY A WEIGHT AND NOT A QUESTION. The first idea was to ask whether an
 * adapter is fitted and what it weighs. The user's answer to that is a
 * recollection; a pad weight is a measurement, and it covers the adapter, the
 * retainer and the closure in one number without the user having to know
 * which of them the catalogue already counted. So the field is the weighed
 * pad mass and the app derives the hardware itself:
 *
 *   hardware = pad − dry − Σ over mounts (catalogue loaded mass × cluster count)
 *
 * where `dry` is the measured airframe mass when the user typed one and the
 * kernel's `massEmpty` otherwise. The result says which.
 *
 * WHERE THE PAD MASS LIVES (v0.118). On the PRIMARY mount's `MountMotor`
 * record (App.tsx `padMassKg`), keyed by `padMassWeighedWith` — the identity
 * of the motor SET it was weighed with (`motorSetIdentity` below). v0.116 kept
 * it in the Measured mass & CG box beside the two airframe figures, which are
 * meant to survive a motor change; a pad weight cannot, because it is one
 * rocket with one motor and that motor's hardware in it. On the record, a
 * swap on the primary replaces the record and the value goes with the motor
 * it belonged to; a change anywhere else in the set is refused as
 * 'stale-set' below rather than silently re-derived against a set nobody
 * weighed.
 *
 * WHERE THE DELTA GOES. Every sample of the PRIMARY mount's motor mass curve
 * is shifted up by the hardware (see `shiftMotorMass`), never a mass
 * component in the tree. Three reasons, all of them physical:
 *
 *  - the pad mass comes out exact, because the kernel's loaded mass is
 *    `massEmpty + Σ motor masses[0] × count` (recoveryMass.ts:25-28);
 *  - the hardware stays in the BURNOUT mass — an adapter comes down with the
 *    rocket — so the recovery weight (services/recoveryMass.ts) picks it up
 *    through `info.mass − propellant` and `motorBurnoutMass` with no change
 *    there; and
 *  - it sits at the motor's CG, which is where a mount adapter is.
 *
 * With more than one mount carrying a motor the WHOLE delta goes to the
 * primary mount (App's `primaryMountId`, the topmost stage's), never split:
 * the sustainer's mount is where the adapter is, and a split would be a guess
 * dressed as arithmetic. The derived line names the mount.
 *
 * The delta is never stored. It is re-derived on every build from the
 * record's pad mass, the dry mass and the catalogue motor; the line under
 * the field names the motor it subtracted and the one it was weighed with,
 * which is the user's cue to re-weigh.
 *
 * Pure: no kernel, no React. App.tsx owns the handle and writes the shifted
 * spec through `flownSpec`, the ONE helper every handle-write site uses.
 */

/**
 * Below this a negative delta is rounding, not a lighter rocket. The same
 * 0.1 g as buildAllowance.ts's MASS_TOLERANCE_KG — finer than any hobby
 * scale, so a pad weight that lands a hair under dry + catalogue reads as
 * "no hardware" rather than as a refusal.
 */
export const HARDWARE_MASS_TOLERANCE_KG = 1e-4;

/**
 * Hardware above this fraction of the catalogue motor mass is CAUTIONED, not
 * refused: the delta still flies and the derived line says to check the
 * entry.
 *
 * Provenance. Eric's two flights carried 17 % (182 g on a 1,084 g J540R) and
 * 16 % (129 g on an 801 g J460T); a 126 g 54→75 mm adapter alone is 12 % of a
 * J540R, and closures are ±50 g. Half the motor's own weight is well clear of
 * all of that for a high-power motor — but a small motor in a big mount
 * legitimately exceeds it (a 29 mm G at ~120 g behind a 54→29 mm adapter
 * plus a retainer is easily 150 % of the motor), so exceeding it cannot be a
 * refusal. The hard refusal is the airframe ceiling in `hardwareMass`.
 */
export const LARGE_HARDWARE_FRACTION = 0.5;

/** Which dry mass the arithmetic subtracted. */
export type DrySource = 'measured' | 'computed';

export type HardwareMassResult =
  /** Nothing to carry, and why not. */
  | { state: 'none'; why: 'no-pad-mass' | 'no-motor' | 'no-mass-curve' }
  /**
   * The arithmetic ran and the answer cannot be hardware. NOTHING is applied
   * — a negative delta would make the rocket lighter than its own dry mass
   * plus the catalogue motor, and a delta heavier than the airframe is a typo
   * (10,574 typed as 105,740 gives 88 motors' worth) or the wrong motor.
   * The numbers are carried so the UI can quote them.
   */
  | {
    state: 'implausible';
    reason: 'negative' | 'heavier-than-airframe';
    deltaKg: number;
    motorMassKg: number;
    /** How many mounts `motorMassKg` sums — see the 'ok' field. */
    mountCount: number;
    dryMassKg: number;
    drySource: DrySource;
  }
  /** Carry `deltaKg` on mount `appliedTo` — see `perMotorShiftKg` for how. */
  | {
    state: 'ok';
    /** The whole hardware mass (kg), what the derived line quotes. */
    deltaKg: number;
    /** The mount whose motor spec is shifted: the primary. */
    appliedTo: string;
    /** That mount's cluster count. */
    motorCount: number;
    /**
     * What to add to EVERY sample of that mount's spec. The kernel multiplies
     * a mount's spec by its cluster count (recoveryMass.ts:25-28), so the
     * shift is `deltaKg / motorCount` — shifting a 3-ring's spec by the whole
     * delta would carry three adapters.
     */
    perMotorShiftKg: number;
    /** Σ catalogue loaded mass × cluster count, every accepted mount (kg). */
    motorMassKg: number;
    /**
     * How many mounts that sum covers. The derived line names the PRIMARY's
     * motor; with more than one mount it must not put the two-motor total
     * beside a one-motor name ("catalogue J540R 1,584 g" for a J540R plus a
     * booster motor), so it words the total as motors on N mounts instead.
     */
    mountCount: number;
    dryMassKg: number;
    drySource: DrySource;
    /** Above LARGE_HARDWARE_FRACTION of `motorMassKg` — caution, still applied. */
    large: boolean;
  }
  /**
   * The pad mass was weighed with a different motor SET from the one assigned
   * now (step 1b). NOTHING is applied — the measurement covers every motor in
   * the stack, so a booster swapped or emptied, a mount newly loaded or a
   * cluster count changed makes the catalogue sum a different number from the
   * one on the scale. `changes` says what differs, per mount, so the line can
   * name the motor it was weighed with and the one now there.
   */
  | { state: 'stale-set'; changes: MountChange[] };

export interface HardwareMassInput {
  /**
   * The rocket weighed WITH its motor(s) in, as it goes on the pad (kg) — the
   * primary mount's record (`MountMotor.padMassKg`), null when it has none.
   */
  padMassKg: number | null | undefined;
  /**
   * The user's measured airframe mass (kg), weighed with the motor out — the
   * Design tab's measured figure. It still wins over `computedDryMassKg`.
   */
  measuredDryMassKg: number | null | undefined;
  /**
   * `StaticInfo.massEmpty` — the dry mass the kernel FLIES, any Build
   * allowance included. NOT App's `bare`, which backs the allowance out for
   * the box's own re-solve: the pad the user weighed has the allowance in it.
   */
  computedDryMassKg: number;
  tree: RocketTree;
  /**
   * [mount node id, motor] for every mount whose motor the kernel ACCEPTED —
   * App filters `motorFailures` out, exactly as it does for recoveryInput
   * (App.tsx recoveryInput). A refused motor's mass is not on the handle, so
   * subtracting its catalogue weight would attribute it to hardware.
   */
  motors: ReadonlyArray<readonly [string, { spec: Pick<MotorSpec, 'masses'> }]>;
  /** App's `primaryMountId`: the topmost-stage mount with a motor. */
  primaryMountId: string | null;
  /**
   * `motorSetIdentity` of the set the pad mass was weighed with — the primary
   * record's `padMassWeighedWith`. Optional, with `currentSetKey`: a caller
   * that passes neither gets v0.116's behaviour byte for byte. App passes
   * `undefined` for the 'legacy' sentinel (a value carried in from
   * v0.116/v0.117 that App reconciles itself after the first build).
   */
  weighedWith?: string;
  /** `motorSetIdentity` of the set assigned now (App's `currentSetKey`). */
  currentSetKey?: string;
}

/**
 * The sentinel key of a value carried in from v0.116/v0.117 and not yet
 * checked against the loaded motor — never a set identity (those are JSON
 * arrays and start with '['). App owns the reconciliation; this module only
 * promises the two can never collide.
 */
export const LEGACY_PAD_MASS_KEY = 'legacy';

/**
 * ONE spelling of a motor's identity: the EX library id when it is one, else
 * manufacturer/designation. Byte-identical to the term App's `motorSetKeyOf`
 * has always used, so stored run keys do not move.
 */
export function motorIdentity(
  meta: { exMotorId?: string; manufacturer?: string }, designation: string,
): string {
  return meta.exMotorId ?? `${meta.manufacturer ?? ''}/${designation}`;
}

/** One mount's entry in a set identity. `count` is that mount's cluster count (tree/cluster.ts clusterCount). */
export type SetEntry = readonly [mountId: string, identity: string, count: number];

const byMountThenIdentity = (a: SetEntry, b: SetEntry): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

/**
 * The identity of a whole assigned SET: JSON of [mountId, identity, count]
 * triples sorted by mountId, then identity. Order-independent; delay, plugged
 * and ignition are NOT part of it — the hardware does not change with the
 * delay grain; cluster count IS, because `catalogueMotorMass` multiplies by
 * it (a 1→3 cluster edit after weighing would otherwise re-derive 250 g of
 * phantom hardware, or refuse as 'a typo'). Session-internal: never written
 * to a file — the .ork carries only kg and the key is rebuilt at open.
 */
export function motorSetIdentity(entries: ReadonlyArray<SetEntry>): string {
  return JSON.stringify([...entries].sort(byMountThenIdentity).map(([m, i, c]) => [m, i, c]));
}

/**
 * A set identity back into its entries, or null when the string is not one
 * (the 'legacy' sentinel, or anything this app never wrote). App reads the
 * entry for a mount through this before deciding whether `rekeyUnmatched`
 * applies.
 */
export function parseSetIdentity(key: string): SetEntry[] | null {
  if (!key.startsWith('[')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const out: SetEntry[] = [];
  for (const e of parsed) {
    if (!Array.isArray(e) || e.length !== 3
        || typeof e[0] !== 'string' || typeof e[1] !== 'string' || typeof e[2] !== 'number') return null;
    out.push([e[0], e[1], e[2]]);
  }
  return out;
}

export type MountChange =
  | { mountId: string; kind: 'changed'; was: string; now: string; wasCount: number; nowCount: number }
  | { mountId: string; kind: 'missing'; was: string; wasCount: number }
  | { mountId: string; kind: 'new'; now: string; nowCount: number }
  | { mountId: string; kind: 'count'; was: string; wasCount: number; nowCount: number };

/**
 * What differs between the set a value was weighed with and the current set,
 * one entry per mount, sorted by mountId. Identity differs → 'changed' (counts
 * carried too); only the count differs → 'count'; in `weighedWith` only →
 * 'missing'; in `current` only → 'new'. An unparsable `weighedWith` (never
 * written by this app; the 'legacy' sentinel is handled by App before this is
 * reached) counts as every current mount 'new'.
 */
export function changedMounts(weighedWith: string, current: string): MountChange[] {
  const was = new Map((parseSetIdentity(weighedWith) ?? []).map((e) => [e[0], e] as const));
  const now = new Map((parseSetIdentity(current) ?? []).map((e) => [e[0], e] as const));
  const out: MountChange[] = [];
  for (const [mountId, w] of was) {
    const n = now.get(mountId);
    if (!n) out.push({ mountId, kind: 'missing', was: w[1], wasCount: w[2] });
    else if (w[1] !== n[1]) {
      out.push({ mountId, kind: 'changed', was: w[1], now: n[1], wasCount: w[2], nowCount: n[2] });
    } else if (w[2] !== n[2]) {
      out.push({ mountId, kind: 'count', was: w[1], wasCount: w[2], nowCount: n[2] });
    }
  }
  for (const [mountId, n] of now) {
    if (!was.has(mountId)) out.push({ mountId, kind: 'new', now: n[1], nowCount: n[2] });
  }
  return out.sort((a, b) => (a.mountId < b.mountId ? -1 : a.mountId > b.mountId ? 1 : 0));
}

/**
 * `key` with the named mount's `unmatched:<designation>` entry rewritten to
 * `identity`, count kept — the file's own motor, loaded later, satisfying its
 * own weighing. The string work only: App decides that the loaded designation
 * equals the sentinel's (case-insensitively, the findDbMotor rank-0 rule)
 * before calling. Returned by identity when `key` is not a set identity or
 * the mount's entry is not a sentinel.
 */
export function rekeyUnmatched(key: string, mountId: string, identity: string): string {
  const entries = parseSetIdentity(key);
  if (!entries) return key;
  const at = entries.findIndex((e) => e[0] === mountId && e[1].startsWith('unmatched:'));
  if (at === -1) return key;
  entries[at] = [mountId, identity, entries[at]![2]];
  return motorSetIdentity(entries);
}

/**
 * The catalogue's LOADED motor mass (kg): the first sample of the mass curve
 * (cf. motorPropellantMass, recoveryMass.ts:66-73). Null when the curve has
 * no mass column, which a published file can lack.
 */
export function motorLoadedMass(spec: Pick<MotorSpec, 'masses'>): number | null {
  const m = spec.masses;
  if (!Array.isArray(m) || m.length === 0) return null;
  const first = m[0]!;
  return Number.isFinite(first) ? first : null;
}

/**
 * Σ catalogue loaded mass × cluster count over every mount given (kg), or
 * null when any motor carries no mass curve — one unknown makes the total
 * unknown, and a partial sum would attribute the missing motor to hardware.
 * Exported so App can build the pad field's placeholder (dry + this).
 */
export function catalogueMotorMass(
  tree: RocketTree,
  motors: ReadonlyArray<readonly [string, { spec: Pick<MotorSpec, 'masses'> }]>,
): number | null {
  let sum = 0;
  for (const [mountId, mm] of motors) {
    const loaded = motorLoadedMass(mm.spec);
    if (loaded === null) return null;
    sum += loaded * clusterCount(findNode(tree, mountId)?.['cluster'] as string | undefined);
  }
  return sum;
}

/** The hardware delta and where it goes — see the header. */
export function hardwareMass(input: HardwareMassInput): HardwareMassResult {
  const {
    padMassKg, measuredDryMassKg, computedDryMassKg, tree, motors, primaryMountId, weighedWith, currentSetKey,
  } = input;

  // 1. No pad mass typed. A zero or negative pad mass is the same as none —
  //    the .ork reader already refuses those (orkFile.ts measuredNum), and a
  //    field cleared to blank arrives here as null.
  if (typeof padMassKg !== 'number' || !Number.isFinite(padMassKg) || padMassKg <= 0) {
    return { state: 'none', why: 'no-pad-mass' };
  }
  // 1b. Weighed with a different motor set. The measurement is of the whole
  //     stack with every motor in (motorMassKg sums every mount and multiplies
  //     by cluster count), so a set that differs — a booster swapped or
  //     removed, a mount gaining a motor, a cluster count changed — cannot
  //     have this pad mass subtracted from it. Both inputs optional: callers
  //     that pass neither get v0.116's behaviour, byte for byte. App passes
  //     `weighedWith: undefined` for the 'legacy' sentinel (it decides that
  //     one itself, after the first build).
  if (typeof weighedWith === 'string' && typeof currentSetKey === 'string' && weighedWith !== currentSetKey) {
    return { state: 'stale-set', changes: changedMounts(weighedWith, currentSetKey) };
  }
  // 2. Nowhere to put it. The primary must be among the ACCEPTED motors: a
  //    primary the kernel refused has no mass on the handle to shift.
  if (primaryMountId === null || motors.length === 0
      || !motors.some(([id]) => id === primaryMountId)) {
    return { state: 'none', why: 'no-motor' };
  }
  // 3. Cannot separate hardware from a motor whose own weight is unknown.
  const motorMassKg = catalogueMotorMass(tree, motors);
  if (motorMassKg === null) return { state: 'none', why: 'no-mass-curve' };

  // 4. The dry mass: what the user weighed if they typed it, else what the
  //    kernel flies. Measured wins because the pad weight and the airframe
  //    weight came off the same scale, so their difference is the cleanest
  //    number available; the result says which was used.
  const measuredOk = typeof measuredDryMassKg === 'number'
    && Number.isFinite(measuredDryMassKg) && measuredDryMassKg > 0;
  const dryMassKg = measuredOk ? measuredDryMassKg : computedDryMassKg;
  const drySource: DrySource = measuredOk ? 'measured' : 'computed';

  // 5. The arithmetic.
  let deltaKg = padMassKg - dryMassKg - motorMassKg;

  // 6. Refusals, both carrying the numbers so the UI can quote them.
  const mountCount = motors.length;
  if (deltaKg < -HARDWARE_MASS_TOLERANCE_KG) {
    return {
      state: 'implausible', reason: 'negative', deltaKg, motorMassKg, mountCount, dryMassKg, drySource,
    };
  }
  if (deltaKg > dryMassKg) {
    return {
      state: 'implausible', reason: 'heavier-than-airframe', deltaKg, motorMassKg, mountCount, dryMassKg,
      drySource,
    };
  }

  // 7. Apply — the whole delta to the primary, divided by its cluster count.
  deltaKg = Math.max(0, deltaKg);
  const motorCount = clusterCount(findNode(tree, primaryMountId)?.['cluster'] as string | undefined);
  return {
    state: 'ok',
    deltaKg,
    appliedTo: primaryMountId,
    motorCount,
    perMotorShiftKg: deltaKg / motorCount,
    motorMassKg,
    mountCount,
    dryMassKg,
    drySource,
    large: deltaKg > LARGE_HARDWARE_FRACTION * motorMassKg,
  };
}

/**
 * The catalogue spec with EVERY mass sample raised by `perMotorShiftKg`.
 *
 * Every sample, not just the first: the hardware is bolted on for the whole
 * flight, so the pad mass is exact (first sample), the burnout mass keeps the
 * adapter (last sample — an adapter comes down with the rocket, and that is
 * what the recovery weight in services/recoveryMass.ts reads through
 * `info.mass − propellant` and `motorBurnoutMass`, with no change there), and
 * the propellant burned (first − last) is unchanged. Thrust, timing, CG
 * offset and delay are the same references they were.
 *
 * Identity on a zero shift, deliberately: an unchanged design hands the
 * kernel the very same spec object it always did, so nothing that compares
 * specs by identity sees a change.
 */
export function shiftMotorMass(spec: MotorSpec, perMotorShiftKg: number): MotorSpec {
  if (perMotorShiftKg === 0) return spec;
  return { ...spec, masses: spec.masses.map((m) => m + perMotorShiftKg) };
}

/**
 * The spec a mount FLIES: the catalogue spec shifted by the weighed hardware
 * when this is the mount the hardware is carried on, the catalogue spec
 * otherwise. The one helper every place that writes a motor onto the engine
 * handle goes through (the build loop, `applyAssignedMotors`, and the re-fly
 * paths in App.tsx) — so a Launch can never fly a different mass from the
 * design page.
 */
export function flownSpec(
  mountId: string, spec: MotorSpec, hardware: HardwareMassResult | undefined,
): MotorSpec {
  return hardware?.state === 'ok' && hardware.appliedTo === mountId
    ? shiftMotorMass(spec, hardware.perMotorShiftKg)
    : spec;
}
