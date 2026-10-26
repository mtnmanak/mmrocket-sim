// ThrustCurveMotor.Builder's MAX_THRUST, in newtons (desktop OR 24.12).
export const MAX_MOTOR_THRUST_N = 10e6;
/** The kernel's MathUtil.EPSILON — what counts as "the same instant". */
const TIME_EPSILON = 1e-8;
/**
 * How far apart coincident samples are pushed. A microsecond is four orders
 * below the finest real sampling interval on thrustcurve.org (10 ms), so the
 * curve keeps its shape, and the impulse it adds is epsilon x delta-thrust —
 * unmeasurable.
 */
const COINCIDENT_NUDGE = 1e-6;
const sameTime = (a, b) => Math.abs(a - b) < TIME_EPSILON;
/**
 * Makes a thrust curve satisfy the kernel's requirement that time points
 * strictly increase, WITHOUT discarding measurements.
 *
 * thrustcurve.org is a volunteer archive of manufacturer-supplied files and a
 * measurable fraction of them are malformed: in a 200-motor sample (2026-08-23)
 * 1.1% carried at least one non-increasing time point, which the carved
 * ThrustCurveMotor.Builder rejects outright ("Two thrust values for single time
 * point"). Cesaroni L1115-P is the reported case — three samples all stamped
 * 0.01 s.
 *
 * Desktop OpenRocket repairs three of these shapes in
 * AbstractMotorLoader.finalizeThrustCurve, and we do the same; but its
 * duplicate rule requires the thrust to match as well, so it does NOT fix
 * L1115-P. The last step here is ours: samples that share an instant but
 * disagree on thrust are separated by a microsecond, keeping every reading and
 * the file's own impulse. Dropping one of them instead would silently change
 * the motor.
 */
export function repairSamples(samples) {
  const repairs = [];
  if (samples.length === 0)
    return { samples: [], repairs, keptIndices: [] };
  // Carry the source index alongside each point so parallel arrays survive.
  let pts = samples.map((s, i) => ({ ...s, i }));
  // 1. Time order. Nearly always already sorted; a few files are not.
  if (!pts.every((p, i) => i === 0 || p.time >= pts[i - 1].time)) {
    pts.sort((a, b) => a.time - b.time);
    repairs.push('put samples back into time order');
  }
  // 2. Genuine duplicates — same instant AND same thrust. Desktop's rule, for
  //    files like the KBA K1750 its own comment names.
  const deduped = [];
  let duplicates = 0;
  for (const p of pts) {
    const last = deduped[deduped.length - 1];
    if (last && sameTime(last.time, p.time) && Math.abs(last.thrust - p.thrust) < TIME_EPSILON) {
      duplicates++;
      continue;
    }
    deduped.push(p);
  }
  if (duplicates > 0) {
    repairs.push(`dropped ${duplicates} duplicate data point${duplicates === 1 ? '' : 's'}`);
  }
  pts = deduped;
  // 3. Two points at t=0, one of them zero thrust — keep the real one.
  if (pts.length > 2 && sameTime(pts[0].time, pts[1].time)) {
    const zeroFirst = Math.abs(pts[0].thrust) < TIME_EPSILON;
    const zeroSecond = Math.abs(pts[1].thrust) < TIME_EPSILON;
    if (zeroFirst || zeroSecond) {
      pts.splice(zeroFirst ? 0 : 1, 1);
      repairs.push(`dropped a zero-thrust sample sharing t=${pts[0].time} s`);
    }
  }
  // 4. Two FINAL points at the same time, one of them zero — drop the zero.
  const n = pts.length - 1;
  if (pts.length > 2 && sameTime(pts[n - 1].time, pts[n].time)) {
    const zeroAt = Math.abs(pts[n - 1].thrust) < TIME_EPSILON ? n - 1
      : Math.abs(pts[n].thrust) < TIME_EPSILON ? n : -1;
    if (zeroAt >= 0) {
      const t = pts[n].time;
      pts.splice(zeroAt, 1);
      repairs.push(`dropped a zero-thrust sample sharing the final time t=${t} s`);
    }
  }
  // 5. Whatever coincident points remain disagree on thrust, so neither
  //    reading can be called wrong. Separate them instead of choosing.
  const collisions = new Map();
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].time > pts[i - 1].time)
      continue;
    const at = pts[i].time;
    const previous = pts[i - 1].time;
    pts[i] = { ...pts[i], time: previous + Math.max(COINCIDENT_NUDGE, previous * Number.EPSILON) };
    const key = String(at);
    collisions.set(key, (collisions.get(key) ?? 0) + 1);
  }
  for (const [at, count] of collisions) {
    repairs.push(`separated ${count} sample${count === 1 ? '' : 's'} sharing t=${at} s`);
  }
  return {
    samples: pts.map(({ time, thrust }) => ({ time, thrust })),
    repairs,
    keptIndices: pts.map((p) => p.i),
  };
}
/**
 * The curve a file FLIES: repaired (repairSamples), and starting at t = 0
 * with a zero-thrust point when the file starts later, which the kernel
 * requires. samplesToMotorSpec builds every catalogue MotorSpec from it, and
 * the picker's impulse gate measures it, so the curve compared with the
 * certification is the one the app flies (audit 2026-09-30).
 */
export function flownCurve(samples) {
  const repaired = repairSamples(samples);
  const pts = repaired.samples;
  if (pts.length > 0 && pts[0].time > 0)
    pts.unshift({ time: 0, thrust: 0 });
  return { samples: pts, repairs: repaired.repairs };
}
export function sampleListProblem(arr) {
  if (!Array.isArray(arr) || arr.length < 2)
    return 'it has fewer than two distinct time points';
  if (!arr.every((s) => {
    if (typeof s !== 'object' || s === null)
      return false;
    const { time, thrust } = s;
    return typeof time === 'number' && typeof thrust === 'number'
      && Number.isFinite(time) && Number.isFinite(thrust);
  }))
    return 'its time or thrust values are not numbers or are not finite';
  const samples = arr;
  if (samples.some(p => p.time < 0 || p.thrust < 0))
    return 'it has a negative time or thrust value';
  if (samples.some(p => p.thrust > MAX_MOTOR_THRUST_N))
    return 'its thrust exceeds the 10,000,000 N limit';
  const flown = flownCurve(samples).samples;
  return flown.length >= 2 && flown[flown.length - 1].time > 0
    && flown.every((p, i) => Number.isFinite(p.time) && (i === 0 || p.time > flown[i - 1].time))
    ? null : 'it needs at least two distinct, increasing time points and a positive duration';
}

