import type { MotorSpec } from '@online-openrocket/engine';

/**
 * thrustcurve.org API v1 client (CORS-enabled; verified reflective
 * Access-Control-Allow-Origin). API units: mm, grams — converted to the
 * engine's SI here at the boundary.
 */
/** thrustcurve.org API v1 root — shared with the in-app catalogue check (catalogueOverlay.ts). */
export const API = 'https://www.thrustcurve.org/api/v1';

export interface TcMotor {
  motorId: string;
  manufacturerAbbrev: string;
  designation: string;
  commonName: string;
  impulseClass: string;
  /** mm */
  diameter: number;
  /** mm */
  length: number;
  avgThrustN: number;
  maxThrustN: number;
  totImpulseNs: number;
  burnTimeS: number;
  totalWeightG: number;
  propWeightG: number;
  /** e.g. "0,3,5" */
  delays?: string;
  availability: string;
  /** Propellant name (e.g. "Classic", "White Lightning"). */
  propInfo?: string;
  /** Reload case (e.g. "Pro29-6GXL"); absent for single-use. */
  caseInfo?: string;
}

export interface TcSample {
  time: number;
  thrust: number;
}

/** One simulator file as thrustcurve.org's download.json returns it. */
export interface TcSimFile {
  format?: string;
  source?: string;
  samples?: TcSample[];
  /** The raw .eng/.rse, base64, as download.json returns it for data:"both". */
  data?: string;
  /**
   * The header masses already parsed — set only on a file that came out of the
   * shipped bundle (src/data/motorCurves.json), which stores the two numbers
   * rather than the raw text they were read from. headerMasses() honours it.
   */
  bundledMasses?: TcHeaderMasses;
}

/** Loaded and propellant mass as a motor's own data file states them. */
export interface TcHeaderMasses {
  totalWeightG: number;
  propWeightG: number;
}

/**
 * Loaded/propellant masses that could describe a real motor: both finite, both
 * positive, and no more propellant than the motor weighs loaded.
 *
 * ONE definition, applied on every path a mass pair can arrive by — the data
 * file's own header and the localStorage cache — because they were allowed to
 * differ and the cache read won. A cached `{totalWeightG:52, propWeightG:104}`
 * is the Cesaroni 25E75-17A shape samplesToMotorSpec refuses outright for
 * CATALOG masses, but those checks never look at the file masses that override
 * them, so it flew a rocket whose mass crosses zero part-way through the burn:
 * no throw, just a wrong apogee and wrong recovery numbers.
 */
export function isHeaderMasses(m: unknown): m is TcHeaderMasses {
  if (typeof m !== 'object' || m === null) return false;
  const { totalWeightG: t, propWeightG: p } = m as Record<string, unknown>;
  return typeof t === 'number' && typeof p === 'number'
    // Number.isFinite, not just typeof: JSON.parse('1e999') yields Infinity.
    && Number.isFinite(t) && Number.isFinite(p)
    && t > 0 && p > 0 && p <= t;
}

/**
 * Every element is a usable {time, thrust} pair.
 *
 * `Number.isFinite` rather than `typeof === 'number'`: `JSON.parse('1e999')`
 * yields Infinity, and either that or a missing field turns into a NaN `dt` in
 * samplesToMotorSpec — so every time, thrust and mass in the MotorSpec is NaN
 * and nothing on the way throws. That is the condition the comment in
 * samplesToMotorSpec describes reaching the kernel, where TeaVM threw a raw
 * "cannot be converted to a BigInt" and the whole design blanked.
 */
export function isSampleList(arr: unknown): arr is TcSample[] {
  return Array.isArray(arr) && arr.length > 0 && arr.every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const { time, thrust } = s as Record<string, unknown>;
    return typeof time === 'number' && typeof thrust === 'number'
      && Number.isFinite(time) && Number.isFinite(thrust);
  });
}

/**
 * The masses out of the DATA FILE's own header, which is what desktop
 * OpenRocket reads. thrustcurve.org publishes two different claims about the
 * same motor — the catalog metadata and the file the curve came from — and
 * taking the curve from one document while taking the masses from the other is
 * not defensible: on the AeroTech K480W it is 2078/1292 g against the file's
 * 2059/1232 g, and it put a tester's apogee 0.84 % under desktop's on his own
 * design. Returns null when the file is absent or unparseable, and the caller
 * falls back to the catalog rather than refusing the motor.
 */
export function headerMasses(file: TcSimFile): TcHeaderMasses | null {
  // A bundled file carries its masses pre-parsed (the build script mirrors the
  // parsing below); they still take the same validity test on the way out.
  if (file.bundledMasses) return isHeaderMasses(file.bundledMasses) ? file.bundledMasses : null;
  if (!file.data) return null;
  let text: string;
  try {
    text = atob(file.data);
  } catch {
    return null;
  }
  // RockSim .rse: grams, as attributes on <engine>.
  const init = /initWt\s*=\s*"([\d.eE+-]+)"/.exec(text);
  const prop = /propWt\s*=\s*"([\d.eE+-]+)"/.exec(text);
  if (init && prop) {
    const masses = { totalWeightG: Number(init[1]), propWeightG: Number(prop[1]) };
    if (isHeaderMasses(masses)) return masses;
  }
  // RASP .eng: the first non-comment, non-blank line is
  //   designation diameter(mm) length(mm) delays propWeight(kg) totalWeight(kg) mfr
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const f = line.split(/\s+/);
    if (f.length < 7) return null;
    // kg -> g. Scaling is sign- and finiteness-preserving, so the shared test
    // means the same thing before and after it.
    const masses = { totalWeightG: Number(f[5]) * 1000, propWeightG: Number(f[4]) * 1000 };
    return isHeaderMasses(masses) ? masses : null;
  }
  return null;
}

/** The kernel's MathUtil.EPSILON — what counts as "the same instant". */
const TIME_EPSILON = 1e-8;

/**
 * How far apart coincident samples are pushed. A microsecond is four orders
 * below the finest real sampling interval on thrustcurve.org (10 ms), so the
 * curve keeps its shape, and the impulse it adds is epsilon x delta-thrust —
 * unmeasurable.
 */
const COINCIDENT_NUDGE = 1e-6;

const sameTime = (a: number, b: number): boolean => Math.abs(a - b) < TIME_EPSILON;

export interface RepairedCurve {
  samples: TcSample[];
  /** Plain-English repairs applied; empty when the curve was already sound. */
  repairs: string[];
  /**
   * Index into the INPUT array for each surviving sample, so a caller holding
   * a parallel array (.rse files carry a measured mass per sample) can realign
   * it without re-deriving anything.
   */
  keptIndices: number[];
}

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
export function repairSamples(samples: readonly TcSample[]): RepairedCurve {
  const repairs: string[] = [];
  if (samples.length === 0) return { samples: [], repairs, keptIndices: [] };

  // Carry the source index alongside each point so parallel arrays survive.
  let pts = samples.map((s, i) => ({ ...s, i }));

  // 1. Time order. Nearly always already sorted; a few files are not.
  if (!pts.every((p, i) => i === 0 || p.time >= pts[i - 1]!.time)) {
    pts.sort((a, b) => a.time - b.time);
    repairs.push('put samples back into time order');
  }

  // 2. Genuine duplicates — same instant AND same thrust. Desktop's rule, for
  //    files like the KBA K1750 its own comment names.
  const deduped: typeof pts = [];
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
  if (pts.length > 2 && sameTime(pts[0]!.time, pts[1]!.time)) {
    const zeroFirst = Math.abs(pts[0]!.thrust) < TIME_EPSILON;
    const zeroSecond = Math.abs(pts[1]!.thrust) < TIME_EPSILON;
    if (zeroFirst || zeroSecond) {
      pts.splice(zeroFirst ? 0 : 1, 1);
      repairs.push(`dropped a zero-thrust sample sharing t=${pts[0]!.time} s`);
    }
  }

  // 4. Two FINAL points at the same time, one of them zero — drop the zero.
  const n = pts.length - 1;
  if (pts.length > 2 && sameTime(pts[n - 1]!.time, pts[n]!.time)) {
    const zeroAt = Math.abs(pts[n - 1]!.thrust) < TIME_EPSILON ? n - 1
      : Math.abs(pts[n]!.thrust) < TIME_EPSILON ? n : -1;
    if (zeroAt >= 0) {
      const t = pts[n]!.time;
      pts.splice(zeroAt, 1);
      repairs.push(`dropped a zero-thrust sample sharing the final time t=${t} s`);
    }
  }

  // 5. Whatever coincident points remain disagree on thrust, so neither
  //    reading can be called wrong. Separate them instead of choosing.
  const collisions = new Map<string, number>();
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.time > pts[i - 1]!.time) continue;
    const at = pts[i]!.time;
    pts[i] = { ...pts[i]!, time: pts[i - 1]!.time + COINCIDENT_NUDGE };
    const key = String(at);
    collisions.set(key, (collisions.get(key) ?? 0) + 1);
  }
  for (const [at, count] of collisions) {
    repairs.push(
      `separated ${count} sample${count === 1 ? '' : 's'} sharing t=${at} s`,
    );
  }

  return {
    samples: pts.map(({ time, thrust }) => ({ time, thrust })),
    repairs,
    keptIndices: pts.map((p) => p.i),
  };
}

/**
 * Chooses which of thrustcurve.org's simulator files to fly.
 *
 * The app used to take the first RASP file unconditionally. For L1115-P that
 * picked a manufacturer RASP file with three samples stamped 0.01 s over the
 * clean 26-point RockSim file returned in the SAME response — and the damaged
 * file was not merely unusable, its whole early time base was wrong (peak
 * thrust at 0.08 s against 0.18 s in the good file). Desktop OpenRocket does
 * the equivalent when it builds its bundled database: SerializeThrustcurveMotors
 * catches the builder's exception per file and moves on to the next one.
 *
 * Order of preference: a curve whose times already increase, then the richer
 * curve, then RASP — the original tie-break, which still decides between files
 * of equal quality.
 */
/**
 * A file whose burn time is this far from the catalogue's certified figure is
 * describing a DIFFERENT LOADING of the motor, not a different digitisation of
 * the same one. Found on the Estes A8 (2026-09-05): thrustcurve.org files the
 * A8-0 booster's curve (0.534 s, 2.14 Ns, no delay) under the same motor record
 * as the A8-3/5 (0.73 s, 2.31 Ns), and on point count alone the booster won —
 * so every Estes A8 flew ~7 % low. Two digitisations of one certification
 * differ by a few percent at most; a different loading differs by a third.
 */
const BURN_AGREEMENT = 0.15;

export function pickSampleFile(files: readonly TcSimFile[], motor?: TcMotor): TcSimFile | null {
  const usable = files
    .map((file, index) => ({ file, index }))
    // isSampleList as well as the count. A file whose times or thrusts are not
    // finite numbers — a schema change, a partial record in a volunteer
    // archive, a middlebox rewriting the body — is not a candidate at all, so
    // a sound sibling in the SAME response still wins rather than the response
    // being flown as NaN. It also makes `sound()` below mean something: on
    // undefined times `p.time > s[i-1].time` is simply false, which scored a
    // damaged file identically to a merely out-of-order one.
    .filter(({ file }) => (file.samples?.length ?? 0) >= 2 && isSampleList(file.samples));
  if (usable.length === 0) return null;

  const sound = ({ file }: { file: TcSimFile }): number => {
    const s = file.samples!;
    return s.every((p, i) => i === 0 || p.time > s[i - 1]!.time) ? 1 : 0;
  };
  // Does the file describe the motor the catalogue describes? Gated on burn
  // time only: peak thrust is the one figure a coarse RASP digitisation is
  // allowed to miss, but a burn that ends a third early is another motor.
  const agrees = ({ file }: { file: TcSimFile }): number => {
    const ref = motor?.burnTimeS;
    if (!(typeof ref === 'number' && ref > 0)) return 1;
    const s = file.samples!;
    return Math.abs(s[s.length - 1]!.time / ref - 1) <= BURN_AGREEMENT ? 1 : 0;
  };
  // thrustcurve.org's own provenance flag: "cert" is the certification body's
  // data, everything else was uploaded by a user or a manufacturer.
  const cert = ({ file }: { file: TcSimFile }): number => (file.source === 'cert' ? 1 : 0);

  usable.sort((a, b) =>
    sound(b) - sound(a)
    || agrees(b) - agrees(a)
    || cert(b) - cert(a)
    || b.file.samples!.length - a.file.samples!.length
    || (b.file.format === 'RASP' ? 1 : 0) - (a.file.format === 'RASP' ? 1 : 0)
    || a.index - b.index);

  return usable[0]!.file;
}

// ------------------------------------------------------------ bundled curves

/**
 * One motor's simulator files as src/data/motorCurves.json stores them —
 * samples as [t, F] pairs to keep the bundle small, plus the two header masses
 * the raw file carried. Expanded to TcSimFile on read so the SAME pickSampleFile
 * and the same mass handling apply whether the files came from here or from a
 * live download.
 */
interface BundledSimFile {
  simfileId?: string;
  source?: string;
  format?: string;
  samples: [number, number][];
  masses?: TcHeaderMasses;
}

let bundledCurves: Promise<Record<string, BundledSimFile[]>> | null = null;

/**
 * Every thrust curve thrustcurve.org publishes for every catalogued motor,
 * shipped with the app so any motor in Browse motor database flies with no
 * network at all. ~870 KB, loaded lazily on the first motor that needs it.
 * See scripts/fetch-motor-curves.mjs for what is in it and why all of it.
 *
 * Provenance note, because this file replaced something: until 2026-09-05 the
 * only motors that flew offline were three thrust curves WRITTEN BY HAND on the
 * project's first day (an A8-3, B6-4, C6-5 — invented approximations with real
 * masses, the C6-5 17.5 % high on impulse), and an import bug preferred them
 * over the database for two months. There is no hand-written motor data in the
 * app any more; this bundle is the offline path.
 */
async function loadBundledCurves(): Promise<Record<string, BundledSimFile[]>> {
  if (!bundledCurves) {
    // Through `unknown`: resolveJsonModule types the literal's samples as
    // number[][], which is not comparable to the [t, F] pair type the runtime
    // relies on. The build script is what guarantees the pairs.
    bundledCurves = import('../data/motorCurves.json')
      .then((mod) => (mod.default as unknown as { curves: Record<string, BundledSimFile[]> }).curves)
      .catch((err) => {
        bundledCurves = null; // a failed chunk load is not permanent
        throw err;
      });
  }
  return bundledCurves;
}

/**
 * The bundled files for one motor as TcSimFile, or [] when it has none —
 * exported for the picker's tests and for callers that want to know whether a
 * motor CAN fly offline before offering it.
 */
export async function bundledSimFiles(motorId: string): Promise<TcSimFile[]> {
  let curves: Record<string, BundledSimFile[]>;
  try {
    curves = await loadBundledCurves();
  } catch {
    return [];
  }
  return (curves[motorId] ?? []).map((f) => ({
    format: f.format,
    source: f.source,
    samples: f.samples.map(([time, thrust]) => ({ time, thrust })),
    // Carried as parsed masses rather than as the raw .eng text, and surfaced
    // through the same field a download's header would populate.
    ...(f.masses ? { bundledMasses: f.masses } : {}),
  }));
}

/**
 * Delay options parsed from the motor's delays string ("0,3,5" → [0,3,5]).
 * "P" (plugged — no ejection charge) becomes Infinity, always listed last;
 * 623 motors in the bundled DB carry it and it used to be silently dropped
 * (a "P"-only motor even showed a bogus 0 s delay).
 */
export function delayOptions(motor: TcMotor): number[] {
  if (!motor.delays) return [0];
  const opts: number[] = [];
  let plugged = false;
  for (const raw of motor.delays.split(',')) {
    const s = raw.trim().toUpperCase();
    if (s === 'P' || s === 'PLUGGED') { plugged = true; continue; }
    const n = Number(s);
    if (Number.isFinite(n)) opts.push(n);
  }
  if (plugged) opts.push(Infinity);
  return opts.length ? opts : [0];
}

/** Display tag for a delay value: "5" / "P" (plugged). */
export function delayTag(delay: number): string {
  return Number.isFinite(delay) ? String(delay) : 'P';
}

/**
 * Pure transform: thrust samples + catalog metadata → engine MotorSpec.
 * Mass at each sample time interpolates from total weight down to burnout
 * weight proportionally to CUMULATIVE IMPULSE (trapezoidal), matching how
 * OpenRocket treats .eng files. CG is fixed at half the motor length (the
 * same approximation OpenRocket applies to RASP data without CG info).
 */
export type RepairedMotorSpec = MotorSpec & {
  /**
   * Plain-English repairs applied to the published curve before it could be
   * simulated. Present only when the file needed them; the UI shows it so a
   * silent data fix never changes someone's numbers without saying so.
   */
  curveRepairs?: string[];
};

export function samplesToMotorSpec(
  motor: TcMotor,
  samples: TcSample[],
  ejectionDelay: number,
  /** The data file's own masses; they win over the catalog (see headerMasses). */
  fromFile?: TcHeaderMasses | null,
): RepairedMotorSpec {
  // Normalize: repaired (strictly increasing times), starting at t=0.
  if (samples.length === 0) {
    throw new Error(`No thrust samples for ${motor.designation}`);
  }
  const repaired = repairSamples(samples);
  const pts = repaired.samples;
  if (pts[0]!.time > 0) {
    pts.unshift({ time: 0, thrust: 0 });
  }

  // thrustcurve.org's catalog is not uniformly populated: 146 of the 1129
  // bundled entries publish no loaded weight and 14 no propellant weight, and
  // one (Cesaroni 25E75-17A) lists more propellant than loaded mass. Without
  // this guard those became NaN / negative masses that went straight into the
  // kernel, where TeaVM threw a raw "cannot be converted to a BigInt" and the
  // whole design blanked. Refuse with something a rocketeer can act on — never
  // substitute a made-up mass, which would trade a visible error for silently
  // wrong altitudes.
  if (!Number.isFinite(motor.totalWeightG) || !Number.isFinite(motor.propWeightG)) {
    throw new Error(
      `thrustcurve.org publishes no loaded/propellant weight for ${motor.designation}, ` +
        'so it cannot be simulated. Pick another motor, or import its .rse/.eng file.',
    );
  }
  if (motor.propWeightG > motor.totalWeightG) {
    throw new Error(
      `${motor.designation} is catalogued with more propellant (${motor.propWeightG} g) than ` +
        `loaded mass (${motor.totalWeightG} g), so its burn would end at a negative mass. ` +
        'Pick another motor, or import a corrected .rse/.eng file.',
    );
  }

  const totalMass = (fromFile?.totalWeightG ?? motor.totalWeightG) / 1000;
  const propMass = (fromFile?.propWeightG ?? motor.propWeightG) / 1000;

  // Cumulative impulse via trapezoid rule.
  const cumImpulse: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i]!.time - pts[i - 1]!.time;
    const area = (dt * (pts[i]!.thrust + pts[i - 1]!.thrust)) / 2;
    cumImpulse.push(cumImpulse[i - 1]! + area);
  }
  const totImpulse = cumImpulse[cumImpulse.length - 1]!;

  const times = pts.map((p) => p.time);
  const thrusts = pts.map((p) => p.thrust);
  const masses = cumImpulse.map((impulse) =>
    totImpulse > 0 ? totalMass - propMass * (impulse / totImpulse) : totalMass,
  );

  return {
    designation: motor.designation,
    diameter: motor.diameter / 1000,
    length: motor.length / 1000,
    times,
    thrusts,
    masses,
    cgX: motor.length / 2000,
    ejectionDelay,
    ...(repaired.repairs.length ? { curveRepairs: repaired.repairs } : {}),
  };
}

/**
 * v2: the v1 cache stored raw API samples, including the damaged curves that
 * used to crash the build. Bumping the prefix retires those entries rather
 * than leaving a poisoned cache no code path ever invalidates.
 *
 * Bumping made them UNREACHABLE; it never freed them. Three generations have
 * shipped — `tc:samples:` through v0.060, `tc:samples:v2:` in v0.061-v0.064,
 * `tc:samples:v3:` from v0.065 — and the beta invite went out 2026-08-22, so
 * day-one testers hold two dead generations that can never be read and, until
 * sweepDeadGenerations() below, could never be freed either. Whoever bumps
 * this next: change only the version segment, CACHE_ROOT is what sweeps.
 */
const CACHE_ROOT = 'tc:samples:';
const CACHE_PREFIX = `${CACHE_ROOT}v3:`;

/**
 * Cap on the live generation, and the mark eviction prunes back to.
 *
 * localStorage is ONE ~5 MB pool per origin, shared with the session autosave
 * and the 500-run history. An unbounded cache therefore does not degrade
 * itself, it breaks "your work saves itself": session.ts starts flagging the
 * autosave as failing and simStore.persist refuses run writes. One batch run
 * caches a curve per candidate (BatchSimulate's own example is 226 motors) and
 * the bundled database holds 1,129, so repeated batches walk toward the whole
 * catalogue. A cached curve is roughly 1-3 kB of JSON (~30 bytes a sample,
 * 30-100 samples), so 300 entries is well under a megabyte.
 *
 * The two marks are not decoration. Ordering by age has to read every live
 * entry's stamp, and a batch writes hundreds of keys back to back; pruning to
 * a low-water mark makes that scan happen once per 60 writes instead of once
 * per write.
 */
const MAX_CACHED_CURVES = 300;
const EVICT_TO = 240;

/**
 * Every key this cache owns, across generations. Snapshotted before anything
 * is deleted, because removeItem renumbers localStorage.key(i) underneath a
 * live loop. The prefix match is exact: this pool also holds the session
 * autosave, the run history and the preferences.
 */
function cachedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && k.startsWith(CACHE_ROOT)) keys.push(k);
  }
  return keys;
}

const liveKeys = (): string[] => cachedKeys().filter((k) => k.startsWith(CACHE_PREFIX));

/** The entry's write time; 0 for anything unstamped or unparseable, which
 *  sorts it oldest — entries written before stamping existed genuinely are. */
function stampOf(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const t = (JSON.parse(raw) as { t?: unknown }).t;
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

/** Drops the oldest live entries until at most `keep` remain. */
function evictOldest(keep: number): void {
  const live = liveKeys();
  if (live.length <= keep) return;
  const stamped = live.map((key) => ({ key, t: stampOf(key) }));
  stamped.sort((a, b) => a.t - b.t);
  for (const { key } of stamped.slice(0, live.length - keep)) localStorage.removeItem(key);
}

let sweptDeadGenerations = false;

/**
 * Deletes the entries of retired cache generations. Once per page load is
 * enough — a retired prefix can never come back — and it costs one enumeration
 * of localStorage, against one per motor if it ran on every download.
 */
function sweepDeadGenerations(): void {
  if (sweptDeadGenerations) return;
  // Set first: a localStorage that throws (private mode) must not re-attempt
  // this for every motor in a 226-motor batch.
  sweptDeadGenerations = true;
  for (const key of cachedKeys()) {
    if (!key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
  }
}

/**
 * How long one motor download may hang before it is abandoned.
 *
 * Not a bandwidth budget — a curve is a couple of kB and lands in well under a
 * second on anything usable. It is a floor under BatchSimulate, which awaits
 * one of these per candidate and only reads its Stop flag BETWEEN iterations:
 * a socket that opens and then stalls (a captive portal or a weak hotspot at a
 * launch site, which is the app's stated flight-day use) parked the loop
 * inside this await forever, with Stop dead and the progress bar frozen. The
 * only exit was reloading the tab, which discards every result the batch had
 * already accepted. Fifteen seconds turns that into the ordinary per-motor
 * error the batch loop already handles.
 */
const FETCH_TIMEOUT_MS = 15_000;

interface Deadline {
  /** undefined only where AbortController does not exist at all. */
  signal: AbortSignal | undefined;
  /** True when OUR timer fired, as opposed to the caller cancelling. */
  timedOut: () => boolean;
  /** Always call: clears the timer and unsubscribes from the caller's signal. */
  done: () => void;
}

/**
 * Combines the caller's cancellation with our own deadline.
 *
 * Hand-rolled rather than AbortSignal.any(), which is Chrome 116 / Safari 17.4
 * (2023-24) and would break an older iPad, and rather than a bare
 * AbortSignal.timeout(), whose abort is indistinguishable from the caller's
 * once the two are merged. Telling them apart is the point: a timeout has to
 * read as "the network stalled", a caller abort as "you pressed Stop".
 */
function deadline(caller: AbortSignal | undefined, ms: number): Deadline {
  if (typeof AbortController !== 'function') {
    return { signal: caller, timedOut: () => false, done: () => { /* nothing to undo */ } };
  }
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; ctrl.abort(); }, ms);
  const relay = (): void => ctrl.abort(caller?.reason);
  if (caller?.aborted) ctrl.abort(caller.reason);
  else caller?.addEventListener('abort', relay, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => expired,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', relay);
    },
  };
}

/**
 * Fetches thrust samples (localStorage-cached) and builds the MotorSpec.
 * Imported EX motors ("ex:" ids) build entirely from local data — .rse files
 * carry measured per-sample masses, which beat the impulse-proportional
 * approximation.
 */
export async function fetchMotorSpec(
  motor: TcMotor,
  ejectionDelay: number,
  /**
   * Cancels a download in flight — BatchSimulate's Stop, an unmounting dialog.
   * Optional on purpose: without one the request STILL gives up after
   * FETCH_TIMEOUT_MS, so a hung socket stops being permanent without any
   * caller having to change.
   */
  signal?: AbortSignal,
): Promise<RepairedMotorSpec> {
  if (motor.motorId.startsWith('ex:')) {
    const { getExMotor } = await import('./exMotors.js');
    const ex = getExMotor(motor.motorId);
    if (!ex) throw new Error(`Imported motor ${motor.designation} is no longer stored`);
    if (ex.sampleMassesKg && ex.sampleMassesKg.length === ex.samples.length) {
      // An imported .eng/.rse can carry the same damage as a downloaded curve,
      // and this branch never reaches samplesToMotorSpec. keptIndices realigns
      // the measured masses onto the repaired curve.
      const repaired = repairSamples(ex.samples);
      const samples = [...repaired.samples];
      const masses = repaired.keptIndices.map((i) => ex.sampleMassesKg![i]!);
      if (samples[0]!.time > 0) {
        samples.unshift({ time: 0, thrust: 0 });
        masses.unshift(ex.totalWeightG / 1000);
      }
      return {
        designation: ex.designation,
        diameter: ex.diameter / 1000,
        length: ex.length / 1000,
        times: samples.map((s) => s.time),
        thrusts: samples.map((s) => s.thrust),
        masses,
        cgX: ex.length / 2000,
        ejectionDelay,
        ...(repaired.repairs.length ? { curveRepairs: repaired.repairs } : {}),
      };
    }
    return samplesToMotorSpec(motor, ex.samples, ejectionDelay);
  }

  const cacheKey = CACHE_PREFIX + motor.motorId;
  let samples: TcSample[] | null = null;
  let fromFile: TcHeaderMasses | null = null;

  try {
    sweepDeadGenerations();
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      // Validate the shape — a corrupt entry parses fine but would break
      // samplesToMotorSpec forever (the cache is never invalidated otherwise).
      const entry = (parsed ?? {}) as { samples?: unknown; masses?: unknown };
      const arr = entry.samples;
      if (isSampleList(arr)) {
        samples = arr;
        // The masses get the SAME test headerMasses applies on the write path.
        // Taken verbatim they bypassed the sanity checks in samplesToMotorSpec
        // — those inspect the CATALOG pair, and a file pair overrides it — so
        // an impossible cached pair silently changed apogee and the recovery
        // numbers instead of throwing. null is not a made-up mass: it is
        // headerMasses' own documented answer for a file it cannot read, and
        // the caller then flies the catalog values, which ARE checked.
        const m = entry.masses;
        fromFile = isHeaderMasses(m) ? m : null;
      } else {
        localStorage.removeItem(cacheKey);
      }
    }
  } catch {
    // storage unavailable (private mode etc.) — just fetch
  }

  // The shipped bundle comes BEFORE the network: it holds every file
  // thrustcurve.org publishes for this motor, chosen by the same pickSampleFile
  // a live response goes through, so a motor flies the same curve offline as
  // on. It is not written to localStorage — it is already local.
  if (!samples) {
    const file = pickSampleFile(await bundledSimFiles(motor.motorId), motor);
    if (file?.samples) {
      samples = file.samples;
      fromFile = headerMasses(file);
    }
  }

  if (!samples) {
    const limit = deadline(signal, FETCH_TIMEOUT_MS);
    let body: { results?: TcSimFile[] };
    try {
      const res = await fetch(`${API}/download.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // "both" carries the raw .eng/.rse alongside the samples, so the masses
        // can come from the same document as the curve (see headerMasses).
        body: JSON.stringify({ motorIds: [motor.motorId], data: 'both' }),
        signal: limit.signal,
      });
      if (!res.ok) {
        throw new Error(`thrustcurve.org download failed: HTTP ${res.status}`);
      }
      // Reading the body is inside the deadline too: a connection that answers
      // its headers and then stalls hangs here, not in fetch().
      body = (await res.json()) as { results?: TcSimFile[] };
    } catch (err) {
      if (limit.timedOut()) {
        throw new Error(
          `thrustcurve.org did not answer within ${FETCH_TIMEOUT_MS / 1000} s for ` +
            `${motor.designation}. Check the connection and try again, or import ` +
            "the motor's .rse/.eng file.",
        );
      }
      throw err;
    } finally {
      limit.done();
    }

    // Array.isArray, not `?? []`: a body whose `results` is a string or an
    // object reached .map() as a TypeError with no motor name in it. Same
    // failure class as the sample guard below — trust nothing in this body.
    const results = Array.isArray(body?.results) ? body.results : [];
    const file = pickSampleFile(results, motor);
    if (!file?.samples) {
      // pickSampleFile rejects a file whose samples are not finite time/thrust
      // pairs, so "files came back, none of them usable" is its own case and
      // deserves its own message — silently flying it produced NaN masses.
      throw new Error(results.some((f) => (f.samples?.length ?? 0) >= 2)
        ? `thrustcurve.org returned a thrust curve for ${motor.designation} whose `
          + 'time or thrust values are not numbers, so it cannot be simulated. '
          + 'Pick another motor, or import its .rse/.eng file.'
        : `No sample data available for ${motor.designation}`);
    }
    samples = file.samples;
    fromFile = headerMasses(file);
    const entry = JSON.stringify({ samples, masses: fromFile, t: Date.now() });
    try {
      if (liveKeys().length > MAX_CACHED_CURVES) evictOldest(EVICT_TO);
      localStorage.setItem(cacheKey, entry);
    } catch {
      // Quota, or no storage at all. setItem writes NOTHING on quota, so retry
      // once after a hard prune: swallowing this is how a pure-convenience
      // cache came to fill the pool the session autosave shares.
      try {
        evictOldest(Math.floor(EVICT_TO / 2));
        localStorage.setItem(cacheKey, entry);
      } catch {
        // Still no room, or storage is unavailable — fly the motor uncached.
      }
    }
  }

  return samplesToMotorSpec(motor, samples, ejectionDelay, fromFile);
}
