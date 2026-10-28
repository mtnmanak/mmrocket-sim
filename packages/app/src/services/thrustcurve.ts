import { INITIAL_UNITS, fmtSig, noticeEqual, noticeNumber, noticeComparison, type UnitSelection } from '../prefs/units.js';
import { parseDecimal } from './xmlUtil.js';
import type { MotorSpec } from '@online-openrocket/engine';
import { deadline } from './net.js';
import { digestMotorFile, motorHeaderMasses } from './motorDigest.js';
import { MAX_MOTOR_THRUST_N, sampleListProblem, repairSamples, flownCurve } from '../../scripts/motor-samples.mjs';
import { MOTOR_DB, MOTOR_DB_DATE, getCatalogueOverlay } from './motorDb.js';
import {
  CatalogueError, CURVES_MAX_BYTES, NO_HASH_MESSAGE, canCheckCatalogueFiles, fetchCatalogueFile, isThrustcurvePull, validSnapshotRef,
  type CatalogueSnapshotRef,
} from './catalogueClient.js';
import { NetError } from './net.js';
import { assertThrustcurveAvailable, recordThrustcurveFailure, thrustcurveFetch, thrustcurveBackoffMessage, ThrustcurveBackoffError, withThrustcurveBackoff } from './thrustcurveTraffic.js';

/**
 * thrustcurve.org API v1 client (CORS-enabled; verified reflective
 * Access-Control-Allow-Origin). API units: mm, grams — converted to the
 * engine's SI here at the boundary.
 */
/**
 * thrustcurve.org API v1 root, for the per-motor download.json below. The
 * in-app catalogue check reads the curated catalogue instead (row 110,
 * catalogueClient.ts), and so do the curves of the motors it adds.
 */
export const API = 'https://www.thrustcurve.org/api/v1';
// ThrustCurveMotor.Builder's MAX_THRUST, in newtons (desktop OR 24.12).
export { MAX_MOTOR_THRUST_N, repairSamples, flownCurve };
export type { RepairedCurve } from '../../scripts/motor-samples.mjs';

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
  /**
   * thrustcurve.org's id for this data file, the same in every answer and
   * every refresh (the bundle stores it for every file). pickSampleFile's last
   * word between otherwise-equal files, in place of their position in a list.
   */
  simfileId?: string;
  format?: string;
  source?: string;
  samples?: TcSample[];
  /** The raw .eng/.rse, base64, as download.json returns it for data:"both". */
  data?: string;
  /**
   * The header masses already parsed — set on a file that came out of the
   * shipped bundle (src/data/motorCurves.json) or the curated snapshot's
   * curves file, which store the two numbers rather than the raw text they
   * were read from, and on the one file this browser's curve cache holds
   * (curveFiles). headerMasses() honours it.
   */
  bundledMasses?: TcHeaderMasses;
  /**
   * Desktop OpenRocket's digest(s) of this file (motorDigest.ts) — what a
   * desktop .ork's <digest> names it by. Set on a bundled file, which stores
   * them; a downloaded one's are computed from `data` (fileDigests).
   */
  digests?: string[];
}

/** Loaded and propellant mass as a motor's own data file states them. */
export interface TcHeaderMasses {
  totalWeightG: number;
  propWeightG: number;
}

/**
 * fetchMotorSpec's failure when the matching shipped catalogue's bundle, a
 * remembered empty answer, or thrustcurve.org lists no file with a curve to
 * fly — the one failure that means no curve exists.
 * Every other one (no connection, a timeout, an HTTP error, a bundle chunk
 * that would not load, an answer that cannot be read) means only that the
 * curve could not be had this time, and a caller must not say there is none:
 * the import note did, for every failure, until the 2026-09-30 audit, and a
 * user offline went looking for a file they did not need (motorMatch.ts).
 */
export class NoPublishedCurveError extends Error {
  constructor(designation: string) {
    super(`No sample data available for ${designation}`);
    this.name = 'NoPublishedCurveError';
  }
}

/**
 * A bundle-only read (`fetchMotorSpec`'s `bundleOnly`, 2026-10-01) asked for a
 * curve the shipped bundle cannot answer: one it does not hold, or an EX-library
 * motor, which lives in one browser's storage. Thrown where the app's own path
 * would go to the cache or the network instead.
 */
export class OfflineCurveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineCurveError';
  }
}

/**
 * Most bytes of a download.json body read. One motor's answer — its handful
 * of simulator files, samples and raw text both — is tens of kilobytes; the
 * origin is a pinned HTTPS service, so this is defence in depth against a
 * body that never ends, not a limit any real answer comes near (audit
 * 2026-09-22: the body was read whole with `res.json()`). It also bounds what
 * headerMasses hands to `atob`: the raw file text only ever arrives inside
 * this body.
 */
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;

/**
 * A response body as JSON, read as a stream and refused past
 * MAX_DOWNLOAD_BYTES — the shareLink `inflateCapped` pattern. `designation`
 * names the motor in both refusals, so neither reaches the user as a bare
 * parser error. A response with no body stream falls back to `json()`.
 */
async function readJsonCapped(res: Response, designation: string): Promise<unknown> {
  const tooBig = () => new Error(`thrustcurve.org's answer for ${designation} ran past `
    + `${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB, far beyond any real motor file, so it was not read.`);
  if (Number(res.headers?.get('content-length')) > MAX_DOWNLOAD_BYTES) throw tooBig();
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) throw tooBig();
      chunks.push(value);
    }
  } finally {
    // Stop the download the moment the loop exits early; a finished stream
    // makes this a resolved no-op.
    reader.cancel().catch(() => { /* already errored — nothing to release */ });
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`thrustcurve.org's answer for ${designation} was not readable, so no curve `
      + 'came with it. Try again, or import the motor\'s .rse/.eng file.');
  }
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
    && t > 0 && p > 0 && (p <= t || noticeEqual(p / 1000, t / 1000));
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
  return sampleListProblem(arr) === null;
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
  return motorHeaderMasses(text);
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
 * Order of preference: the sort at the end of pickSampleFile, one commented
 * term per key, best first. The user guide (Motors → The database and
 * browser) names every term in the same order. thrustcurve.test.ts checks the
 * guide against a hand-kept list of those phrases, NOT against the comparator:
 * a term added to the sort needs its clause added to the guide and to that
 * list by hand, or nothing will notice.
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

/**
 * A file whose integrated impulse is within this of the catalogue's certified
 * total is describing the certified motor; one further off is either a poor
 * digitisation or a different burn. 3 % is where the bundle's own distribution
 * turns: 935 of 1,075 picked files sit inside it (713 inside ±1 %), and two
 * digitisations of one certification differ by about that much at most. Wider
 * would let the J460T's +5.3 % cert file through; tighter would start
 * refusing honest files over quantisation noise.
 */
const IMPULSE_AGREEMENT = 0.03;

/**
 * Past this, the curve a motor actually flies is SAID to disagree with its
 * certification, in the same note channel as a curve repair. 5 % rather than
 * the picker's 3 %: the picker is choosing between siblings, this is warning
 * about the only file there is — 122 of the 140 off-by-≥3 % motors have no
 * closer sibling — and a note on every 3–5 % digitisation would be noise
 * against a certified figure that is itself a rounded average. 69 motors
 * tripped it in the 2026-09-07 census; measured on the curve flown (see
 * impulseNote), 66 of the 2026-09-30 bundle's do, the RATT K600TR-P at
 * −71.7 % the worst.
 */
const IMPULSE_FLAG = 0.05;

/**
 * How every impulse note has opened since v0.116 — and so how one is told
 * apart from a repair in `curveRepairs`, the list fetchMotorSpec appends it to
 * (see `isImpulseNote`). Stored sessions hold notes written with it, so a
 * rewording keeps this lead or teaches `isImpulseNote` the old one as well.
 */
const IMPULSE_NOTE_LEAD = 'The thrust curve flown for ';

/**
 * Is this `curveRepairs` entry the impulse note rather than a repair? The
 * notice bar shows a repair inside "its published thrust curve needed repair
 * (…)" and the note as the sentence it is (services/notices.ts). Matched on
 * the note's own opening rather than on the shape of the repairs, so a repair
 * worded some new way is still shown as a repair.
 */
export function isImpulseNote(entry: string): boolean {
  return entry.startsWith(IMPULSE_NOTE_LEAD);
}

/**
 * The sentence, or null when the flown curve agrees with the catalogue to
 * within IMPULSE_FLAG or the catalogue publishes no total to compare with.
 * Exported for the tests; the wording names both numbers because a reader
 * has to be able to decide which one to believe.
 *
 * `samples` is the curve FLOWN — the MotorSpec's, repaired and starting at
 * t = 0 — never a raw file. fetchMotorSpec passed the raw file until the
 * 2026-09-30 audit, and a file whose first sample comes after t = 0 flies a
 * ramp up from (0, 0) the raw integral leaves out: the AeroTech E16W said
 * "−5.6 % … expect apogee to read low" while flying exactly its certified
 * 37.67 N·s, and the J570W, flying +6.2 %, said nothing.
 */
export function impulseNote(motor: Pick<TcMotor, 'designation' | 'totImpulseNs'>, samples: readonly TcSample[]): string | null {
  const ref = motor.totImpulseNs;
  if (!(typeof ref === 'number' && ref > 0)) return null;
  const got = fileImpulseNs({ samples: [...samples] });
  const pct = (got / ref - 1) * 100;
  const threshold = IMPULSE_FLAG * 100;
  // The integral/division can leave a few ULPs above exactly five percent.
  if (Math.abs(pct) <= threshold || noticeEqual(Math.abs(pct), threshold)) return null;
  const rounded = Number(fmtSig(got, 3));
  const actual = String(Number((Math.sign(rounded - ref) === Math.sign(got - ref) ? rounded : got).toPrecision(6)));
  const delta = noticeNumber(pct, 1);
  const percent = Number.isInteger(Number(delta)) && Math.abs(Number(delta)) < 1e5 ? Number(delta).toFixed(1) : delta;
  return `${IMPULSE_NOTE_LEAD}${motor.designation} integrates to ${actual} N·s, `
    + `${pct > 0 ? '+' : ''}${percent} % against the ${String(Number(ref.toPrecision(6)))} N·s it is certified for — `
    + `expect apogee to read ${pct > 0 ? 'high' : 'low'} by roughly that much. `
    + 'thrustcurve.org publishes no closer file for it; import the motor\'s own .eng/.rse if you have one.';
}

/**
 * Trapezoidal integral of a thrust curve (N·s), as given. The picker's impulse
 * gate and the impulse note apply it to the curve a file FLIES (flownCurve),
 * never to the raw file; the tests use it to measure either.
 */
export function fileImpulseNs(file: TcSimFile): number {
  const s = file.samples ?? [];
  let a = 0;
  for (let i = 1; i < s.length; i++) {
    a += (s[i]!.time - s[i - 1]!.time) * (s[i]!.thrust + s[i - 1]!.thrust) / 2;
  }
  return a;
}

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
    .filter(({ file }) => (file.samples?.length ?? 0) >= 2 && isSampleList(file.samples))
    // Each file's impulse AS FLOWN, measured once rather than per comparison.
    .map((u) => ({ ...u, flownNs: fileImpulseNs({ samples: flownCurve(u.file.samples!).samples }) }));
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
  // Does the file deliver the impulse the motor is CERTIFIED for? The owner's
  // ruling 2026-09-07 ("yes on the curve picker"), from his own flight: the
  // AeroTech J460T's cert RASP file integrates to 848 Ns against the
  // catalogue's certified 805.5 (+5.3 %), its RockSim/user file to 813 (+0.9 %),
  // and the cert file was winning on provenance alone — so his WM 4" Extreme
  // was flown 5 % hotter than its motor is rated, and the sim read 24 % over
  // the altimeter where the same day's other flight closed to 1 %
  // (docs/research/metra-flights-2026-09-06.md §7). Censused over the whole
  // bundle: 140 of 1,075 picked files are ≥ 3 % off their certification, but
  // only 14 have a SOUND sibling that is inside 3 % and passes the burn-time
  // gate above — those 14 are what this term moves. The J460T itself is NOT
  // one: its 813 N·s sibling agrees on burn (1.9 s) and impulse (+0.9 %) but
  // carries a duplicated t=0 sample, so `sound` ranks it last and the cert
  // file wins on that alone, despite failing burn (2.16 s vs 1.81) AND
  // impulse. Whether a REPAIRABLE file that agrees should outrank a sound one
  // that does not is a further rule change, not made here; the impulse note in
  // fetchMotorSpec is what tells that user. Sits
  // BELOW burn-time agreement (a wrong loading is a different motor) and ABOVE
  // provenance (a cert file that misstates the total is still the wrong number
  // to fly). Neutral when the catalogue has no total to compare against.
  //
  // Measured on the curve the file FLIES (flownCurve), not its raw samples,
  // since the 2026-09-30 audit: a file whose first sample comes after t = 0
  // flies a ramp up from (0, 0) that the raw integral leaves out, and the gate
  // exists to compare what flies with the certification. The figures above are
  // raw, as the 2026-09-07 census took them; flown, the J460T's cert file is
  // 858 N·s (+6.5 %). The move changed 16 picks in the 2026-09-30 bundle.
  const impulseAgrees = ({ flownNs }: { flownNs: number }): number => {
    const ref = motor?.totImpulseNs;
    if (!(typeof ref === 'number' && ref > 0)) return 1;
    return Math.abs(flownNs / ref - 1) <= IMPULSE_AGREEMENT ? 1 : 0;
  };
  // thrustcurve.org's own provenance flag: "cert" is the certification body's
  // data, everything else was uploaded by a user or a manufacturer.
  const cert = ({ file }: { file: TcSimFile }): number => (file.source === 'cert' ? 1 : 0);
  // Between files equal on all of that, the masses each would FLY — its own
  // header pair, else the catalogue's (samplesToMotorSpec) — against the
  // catalogue row: the closer wins. Quantised to a part in 10^9, so float
  // noise in a stated mass (87.00000000000001 g against 87) decides nothing.
  // Neutral when the catalogue states no usable pair.
  const catalogue = motor && isHeaderMasses({ totalWeightG: motor.totalWeightG, propWeightG: motor.propWeightG })
    ? { totalWeightG: motor.totalWeightG, propWeightG: motor.propWeightG } : null;
  const massGap = (file: TcSimFile): number => {
    if (!catalogue) return 0;
    const m = headerMasses(file) ?? catalogue;
    return Math.round((Math.abs(m.totalWeightG / catalogue.totalWeightG - 1)
      + Math.abs(m.propWeightG / catalogue.propWeightG - 1)) * 1e9);
  };
  // And last, the FILE — never its place in the list. Position was the last
  // word until 2026-10-01: v0.143's refresh changed the Hypertek
  // 2800CCRGLFX-L625FX's loaded mass from 5,706.2 g to 5,116.2 g (-10.3 %)
  // only because thrustcurve.org listed the same two files the other way
  // round. Its data-file id is the same in every answer and every refresh; a
  // file without one is known by a hash of what it holds, after every id.
  const identity = (file: TcSimFile): string =>
    typeof file.simfileId === 'string' && file.simfileId !== '' ? file.simfileId : `~${contentHash(file)}`;
  const keyed = usable.map((u) => ({ ...u, massGap: massGap(u.file), identity: identity(u.file) }));

  keyed.sort((a, b) =>
    sound(b) - sound(a)
    || agrees(b) - agrees(a)
    || impulseAgrees(b) - impulseAgrees(a)
    || cert(b) - cert(a)
    || b.file.samples!.length - a.file.samples!.length
    || (b.file.format === 'RASP' ? 1 : 0) - (a.file.format === 'RASP' ? 1 : 0)
    || a.massGap - b.massGap
    || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)
    // Only two files holding exactly the same thing get this far, and either
    // flies the same; it keeps the order total.
    || a.index - b.index);

  return keyed[0]!.file;
}

/**
 * A short, stable hash of what a file holds — its samples, format, source and
 * the masses it would fly — for pickSampleFile's last word on a file with no
 * thrustcurve.org id. FNV-1a, 32 bits: two files only need telling apart.
 */
function contentHash(file: TcSimFile): string {
  const text = JSON.stringify([file.format ?? '', file.source ?? '', file.samples ?? [], headerMasses(file)]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------ desktop's digest

/** A file's desktop digests: stored on a bundled file, computed from a download's raw text. */
export function fileDigests(file: TcSimFile): string[] {
  if (file.digests) return file.digests;
  if (!file.data) return [];
  try {
    // atob's binary string is ISO-8859-1 — desktop's charset for both formats.
    return digestMotorFile(atob(file.data), file.format);
  } catch {
    return [];
  }
}

/**
 * The file a desktop .ork's motor `<digest>` names, among `files` — null when
 * none of them is it. Desktop writes the digest of the data file it LOADED, so
 * this is the curve the design flew there; pickSampleFile is the app's own
 * choice for a motor picked here, and the two differ for a motor with more
 * than one file (board Tier 3, the thrust-curve picker; measured 2026-10-11
 * by FILE, not by design — the census counts byte-identical copies once but
 * a renamed or re-saved copy of one design as another file: 49 of the 254
 * digest-carrying motor entries across the 49 .ork files carrying digests in
 * the tester uploads and the owner's designs, in 26 of those files, named
 * another file than the app's pick, 18 of them a curve or masses that fly
 * differently — the AeroTech M1780NT's manufacturer file, 5,341 N·s, against
 * the cert file's 5,623). Two files
 * with one digest are one curve to desktop; pickSampleFile decides between
 * them, so the answer never depends on list order.
 */
export function pickDigestFile(files: readonly TcSimFile[], digest: string, motor?: TcMotor): TcSimFile | null {
  if (!digest) return null;
  const named = files.filter((f) => fileDigests(f).includes(digest));
  return named.length ? pickSampleFile(named, motor) : null;
}

/**
 * Do two files fly the same here? The flight reads only the curve as flown and
 * the two header masses (the catalogue's when a file has none), so two files
 * desktop tells apart can be one flight — an .rse and the RASP file it was made
 * from. Masses to a part in 10^9, as pickSampleFile compares them.
 */
export function fliesTheSame(a: TcSimFile, b: TcSimFile): boolean {
  if (!a.samples || !b.samples) return false;
  const ca = flownCurve(a.samples).samples, cb = flownCurve(b.samples).samples;
  if (ca.length !== cb.length || ca.some((p, i) => p.time !== cb[i]!.time || p.thrust !== cb[i]!.thrust)) return false;
  const ma = headerMasses(a), mb = headerMasses(b);
  if (!ma || !mb) return ma === mb;
  const near = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(Math.abs(x), Math.abs(y));
  return near(ma.totalWeightG, mb.totalWeightG) && near(ma.propWeightG, mb.propWeightG);
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
  digests?: string[];
}

let bundledCurves: Promise<Record<string, BundledSimFile[]>> | null = null;
let bundledCatalogueGenerated: string | undefined;
let bundledComplete = false;
const shippedMotorIds = new Set(MOTOR_DB.map((m) => m.motorId));

/**
 * Every thrust curve thrustcurve.org publishes for every catalogued motor,
 * shipped with the app so any motor in Browse motor database flies with no
 * network at all. ~980 KB (each file's desktop digest added 90 KB, 2026-10-11),
 * loaded lazily on the first motor that needs it.
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
      .then((mod) => {
        const bundle = mod.default as unknown as { catalogueGenerated: string; complete?: boolean; curves: Record<string, BundledSimFile[]> };
        bundledCatalogueGenerated = bundle.catalogueGenerated;
        bundledComplete = bundle.complete === true;
        return bundle.curves;
      })
      .catch((err) => {
        bundledCurves = null; // a failed chunk load is not permanent
        throw err;
      });
  }
  return bundledCurves;
}

/** Batch must never turn a missing release chunk into a download per candidate. */
export async function requireCurveBundle(motors: readonly TcMotor[] = []): Promise<void> {
  try {
    await loadBundledCurves();
  } catch {
    // A missing chunk matters only if a candidate would need a download.
    // Use the same sample validation as fetchMotorSpec's cache read.
    if (motors.length && motors.every((motor) => {
      if (motor.motorId.startsWith('ex:')) return true;
      try {
        const entry: unknown = JSON.parse(localStorage.getItem(CACHE_PREFIX + motor.motorId) ?? 'null');
        return isCurrentCurveCache(entry);
      } catch { return false; }
    })) return;
    throw new Error('The thrust curves bundled with the app did not load — reload the app and run again.');
  }
}

const NO_CURVE_KEY = 'online-openrocket.no-curve.v1';
const MAX_NO_CURVES = 2000;
export function validCatalogueDate(date: unknown): date is string {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date.slice(0, 10);
}

/**
 * The active overlay's snapshot record, when it is a valid one and not older
 * than the shipped catalogue (2026-10-28, audit S5-2): an older snapshot is
 * one this build already knows better than, so its curves file answers for
 * nothing — whether a check stored it (v0.196 did, and its same-snapshot
 * shortcut kept putting it back) or it arrived some other way.
 */
function activeSnapshot(): CatalogueSnapshotRef | null {
  const snapshot = getCatalogueOverlay()?.snapshot;
  return validSnapshotRef(snapshot) && snapshot.generated >= MOTOR_DB_DATE ? snapshot : null;
}

/**
 * The date of the catalogue this browser has seen, which the no-curve memory
 * keys on: a newer catalogue allows another try for a motor's curve without
 * waiting for the next release.
 *
 * Under a curated snapshot it is the SNAPSHOT's date (D.7, owner 2026-10-27),
 * never the check's: the automatic check rewrites `fetchedAt` every six hours
 * for every user, and keyed on that, each rewrite allowed a new download try
 * for every motor with no curve. An overlay from a thrustcurve.org pull
 * (before row 110) keeps its check date, as before. One a curated check wrote
 * with no active snapshot — it found only a snapshot older than the build,
 * which it no longer records (2026-10-28, C) — is the shipped catalogue's
 * date: the build is the newest catalogue it has. isThrustcurvePull tells
 * the two apart.
 */
const catalogueDate = (): string => {
  const snapshot = activeSnapshot();
  if (snapshot) return snapshot.generated;
  const overlay = getCatalogueOverlay();
  const fetchedAt = overlay?.fetchedAt;
  return isThrustcurvePull(overlay) && validCatalogueDate(fetchedAt) ? fetchedAt : MOTOR_DB_DATE;
};

function noCurveEntries(): Map<string, string> {
  try {
    const raw = localStorage.getItem(NO_CURVE_KEY);
    if (raw === null) return new Map();
    if (raw.length > 1_000_000) throw new Error('oversize');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a map');
    const entries = Object.entries(parsed);
    if (entries.length > MAX_NO_CURVES || entries.some(([id, date]) => !id || id.length > 200
      || !validCatalogueDate(date))) {
      throw new Error('invalid entries');
    }
    return new Map(entries as [string, string][]);
  } catch {
    try { localStorage.removeItem(NO_CURVE_KEY); } catch { /* storage unavailable */ }
    return new Map();
  }
}

function rememberNoCurve(motorId: string): void {
  try {
    const date = catalogueDate();
    const entries = new Map([...noCurveEntries()].filter(([, learned]) => learned === date));
    entries.delete(motorId);
    entries.set(motorId, date);
    while (entries.size > MAX_NO_CURVES) entries.delete(entries.keys().next().value!);
    localStorage.setItem(NO_CURVE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* best-effort cache, never discard a user's EX files */ }
}

/**
 * The bundled files for one motor as TcSimFile, or [] when it has none —
 * exported for the picker's tests and for callers that want to know whether a
 * motor CAN fly offline before offering it. A bundle that did not load also
 * reads as [] here, which is the honest answer to that question right now;
 * fetchMotorSpec, which has to say WHY a curve could not be had, reads
 * bundledFiles instead and tells the two apart (audit 2026-09-30).
 */
export async function bundledSimFiles(motorId: string): Promise<TcSimFile[]> {
  try {
    return await bundledFiles(motorId);
  } catch {
    return [];
  }
}

/**
 * Does the bundle carry a curve for this motor? true or false once it has
 * loaded; null when it could not be loaded at all, which says nothing about
 * the motor. The bundle holds every file thrustcurve.org published for the
 * catalogue it was built from — scripts/motor-db-age.test.mjs holds it and
 * motors.json to one date — so `false` for a motor of THAT catalogue means it
 * had none when this version was built: an answer motorMatch can give with no
 * network, and one a chunk that failed must never give (audit 2026-09-30).
 */
export async function bundleHasCurve(motorId: string): Promise<boolean | null> {
  try {
    return (await bundledFiles(motorId)).length > 0;
  } catch {
    return null;
  }
}

/**
 * Only a complete, matching bundle and no newer check establish an absent
 * curve. Under a curated snapshot a shipped motor with no bundled curve is
 * answered by the snapshot's curves file instead (D.7): absent once that file
 * has been read and lacks it; unknown (false) until it has been read, which
 * happens only when the motor is flown, never here. A file refused for its
 * size, sha or shape was not read, and says nothing about the motor
 * (2026-10-28, audit S5-1): it said "absent" until then.
 */
export async function knownNoPublishedCurve(motorId: string): Promise<boolean> {
  const snapshot = activeSnapshot();
  if (snapshot) {
    if (!shippedMotorIds.has(motorId) || (await bundleHasCurve(motorId)) !== false) return false;
    const read = readSnapshotCurves.get(snapshot.curves.sha256);
    return read ? !read.has(motorId) : false;
  }
  if (Date.parse(catalogueDate()) > Date.parse(MOTOR_DB_DATE)) return false;
  return (await bundleHasCurve(motorId)) === false && bundledComplete
    && bundledCatalogueGenerated === MOTOR_DB_DATE && shippedMotorIds.has(motorId);
}

/** bundledSimFiles, but a bundle chunk that would not load THROWS rather than reading as "no files". */
export async function bundledFiles(motorId: string): Promise<TcSimFile[]> {
  const curves = await loadBundledCurves();
  return simFiles(Object.hasOwn(curves, motorId) ? curves[motorId]! : []);
}

/** The bundle's file shape as TcSimFile — also the shape the curated snapshot's curves file carries. */
function simFiles(files: readonly BundledSimFile[]): TcSimFile[] {
  return files.map((f) => ({
    // Carried so the picker can tell two files apart by what they are, not by
    // where the bundle happens to list them (pickSampleFile).
    ...(f.simfileId ? { simfileId: f.simfileId } : {}),
    format: f.format,
    source: f.source,
    samples: f.samples.map(([time, thrust]) => ({ time, thrust })),
    // Carried as parsed masses rather than as the raw .eng text, and surfaced
    // through the same field a download's header would populate.
    ...(f.masses ? { bundledMasses: f.masses } : {}),
    // Desktop's digest of the raw file, which the bundle does not keep.
    ...(f.digests ? { digests: f.digests } : {}),
  }));
}

// ------------------------------------------------- the curated snapshot's curves

/**
 * CURVES FOR MOTORS THE APP DID NOT SHIP A CURVE FOR (row 110 ruling 3, D.7).
 *
 * The curated catalogue's snapshot carries a curves file in the bundle's own
 * shape. fetchMotorSpec reads it — on first use, never on load — for two kinds
 * of motor only: one the overlay ADDED (not in the shipped catalogue), and a
 * SHIPPED motor the bundle has no curve for. A shipped motor that has a
 * bundled curve never reads it, so a curve the app ships is never replaced (row
 * 101: a changed curve waits for a release). The file is checked by
 * catalogueClient.ts (size, sha256) and then here, field by field: bundledFiles
 * trusts the bundle, which a human looked at; this file nobody did, and the
 * sha says only that it is the file the manifest names. One promise per curves
 * sha; a network failure clears it, so the next use asks again; a size, sha or
 * shape failure is remembered for the page session. A browser that cannot
 * hash (no `crypto.subtle`) is told so before any download, and that is not
 * a refusal of the file: nothing was read.
 */
const snapshotCurves = new Map<string, Promise<Map<string, BundledSimFile[]>>>();
/** The eligible subset of each curves file read so far, by its sha. */
const readSnapshotCurves = new Map<string, Map<string, BundledSimFile[]>>();
/** Curves files refused for their size, sha or shape, by sha: not asked for again this session. */
const refusedSnapshotCurves = new Set<string>();

const plainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One file from the snapshot's curves file, or null when any of it is the wrong type. */
function snapshotSimFile(f: unknown): BundledSimFile | null {
  if (!plainObject(f)) return null;
  const { simfileId, source, format, samples, masses, digests } = f;
  if (typeof format !== 'string' || typeof source !== 'string') return null;
  if (simfileId !== undefined && typeof simfileId !== 'string') return null;
  if (!Array.isArray(samples) || !samples.length || !samples.every((p) => Array.isArray(p) && p.length === 2
    && Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  if (masses !== undefined && !(plainObject(masses) && Object.values(masses).every(Number.isFinite))) return null;
  if (digests !== undefined && !(Array.isArray(digests) && digests.every((d) => typeof d === 'string'))) return null;
  const m = masses as Record<string, number> | undefined;
  return {
    ...(simfileId !== undefined ? { simfileId } : {}), source, format,
    samples: (samples as [number, number][]).map(([t, F]) => [t, F]),
    ...(m ? { masses: { totalWeightG: m['totalWeightG']!, propWeightG: m['propWeightG']! } } : {}),
    ...(digests ? { digests: [...(digests as string[])] } : {}),
  };
}

/**
 * The snapshot's curves file, reduced to the motors it may answer for: every
 * id not in the shipped catalogue, and every shipped id the loaded bundle has
 * no curve for. Looked up by own key only (`constructor`, `__proto__`).
 */
function loadSnapshotCurves(snapshot: CatalogueSnapshotRef): Promise<Map<string, BundledSimFile[]>> {
  const sha = snapshot.curves.sha256;
  if (refusedSnapshotCurves.has(sha)) {
    return Promise.reject(new CatalogueError('integrity', 'The catalogue\'s curves file was refused earlier.'));
  }
  // Not a CatalogueError, so not remembered as a refusal of this file.
  if (!canCheckCatalogueFiles()) return Promise.reject(new Error(NO_HASH_MESSAGE));
  let pending = snapshotCurves.get(sha);
  if (!pending) {
    pending = (async () => {
      const doc = await fetchCatalogueFile(snapshot.curves, CURVES_MAX_BYTES, 'curves file');
      // `complete`, as planPublication requires of every curves file it publishes.
      if (!plainObject(doc) || doc['catalogueGenerated'] !== snapshot.generated || doc['complete'] !== true
        || !plainObject(doc['curves'])) {
        throw new CatalogueError('shape', 'The catalogue\'s curves file is not the one its snapshot names, so it was not used.');
      }
      // A bundle that would not load cannot say which shipped motors lack a
      // curve, so none are taken this time, and the answer is not kept.
      const bundle = await loadBundledCurves().catch(() => null);
      const curves = doc['curves'];
      const subset = new Map<string, BundledSimFile[]>();
      for (const id of Object.keys(curves)) {
        if (shippedMotorIds.has(id) && (!bundle || Object.hasOwn(bundle, id))) continue;
        const listed = curves[id];
        const files = Array.isArray(listed) ? listed.map(snapshotSimFile).filter((f): f is BundledSimFile => f !== null) : [];
        if (files.length) subset.set(id, files);
      }
      if (bundle) readSnapshotCurves.set(sha, subset);
      else snapshotCurves.delete(sha);
      return subset;
    })();
    snapshotCurves.set(sha, pending);
    pending.catch((err: unknown) => {
      snapshotCurves.delete(sha);
      if (err instanceof CatalogueError || (err instanceof NetError && err.kind === 'too-large')) refusedSnapshotCurves.add(sha);
    });
  }
  return pending;
}

/** Waits for `p`, or rejects as an AbortError the moment `signal` aborts: one caller's Stop must not cancel a file others share. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException('The request was cancelled.', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Desktop's RockSimMotorLoader.DELAY_LIMIT: a listed delay this long means "no charge". */
const PLUGGED_DELAY_CODE = 90;

/**
 * Delay options parsed from the motor's delays string ("0,3,5" → [0,3,5]).
 * "P" (plugged — no ejection charge) becomes Infinity, always listed last;
 * 623 motors in the bundled DB carry it and it used to be silently dropped
 * (a "P"-only motor even showed a bogus 0 s delay).
 *
 * A number of 90 or more is ALSO plugged (audit 2026-09-22). RASP and RockSim
 * files write "no ejection charge" as 100 or 1000 — 125 of the 891 motors in a
 * tester's rasp.eng say 1000 and 26 say 100 — and read as seconds those were
 * the "longest" option: the browser picked them and the report printed
 * "Flown delay 1000s vs optimal 7.3s". 90 is desktop's own line for RockSim
 * files (RockSimMotorLoader.DELAY_LIMIT, "any delay longer than this will be
 * interpreted as a plugged motor"); no real motor is drilled that long.
 *
 * And a field with nothing usable in it — absent, or KBA's "S,M,L" — gives
 * `[]`, never `[0]`: 0 s is a real delay (a booster's charge at burnout), so
 * inventing it put a chute out at burnout on a motor whose delay is simply
 * unknown. Callers read "no options" as "no prescribed delay"; see defaultDelay.
 *
 * The prescribed delays come back SORTED, shortest first, once each —
 * desktop's RASPMotorLoader sorts them too (Collections.sort). Every caller that
 * wants "the longest" takes the last finite entry (defaultDelay, the un-plug
 * restore in App, the batch run's provisional flight), and a RASP file lists
 * them in whatever order its author typed: 70 of the 889 motors in a tester's
 * rasp.eng do not end on their longest, and five end on 0 — E6T "2-4-8-0",
 * I115W "6-10-14-0" — so those defaulted to a charge AT BURNOUT (review of the
 * audit 2026-09-22 fixes). The shipped catalogue is always ascending, which is
 * why nothing caught it.
 */
export function delayOptions(motor: TcMotor): number[] {
  if (!motor.delays) return [];
  const opts: number[] = [];
  let plugged = false;
  for (const raw of motor.delays.split(',')) {
    const s = raw.trim().toUpperCase();
    if (s === 'P' || s === 'PLUGGED') { plugged = true; continue; }
    if (s === '') continue; // Number('') is 0 — an empty item is not a 0 s delay
    const n = parseDecimal(s);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n >= PLUGGED_DELAY_CODE) { plugged = true; continue; }
    opts.push(n);
  }
  const sorted = [...new Set(opts)].sort((a, b) => a - b);
  if (plugged) sorted.push(Infinity);
  return sorted;
}

/**
 * The delay a fresh pick of this motor starts at: the longest PRESCRIBED
 * delay, and plugged only when that is the motor's sole option — nobody should
 * get a chute-less flight by default. null when the motor lists no delay at
 * all, which the motor browser answers with "Auto (optimal)" rather than with
 * a number it would have to make up. One rule for every place a delay is
 * chosen on the user's behalf: the browser's default, and RockSim's "every
 * delay" sentinel on import (rocksimFile.ts).
 */
export function defaultDelay(motor: TcMotor): number | null {
  const opts = delayOptions(motor); // sorted, so the last finite entry IS the longest
  const finite = opts.filter((d) => Number.isFinite(d));
  return finite[finite.length - 1] ?? opts[opts.length - 1] ?? null;
}

// Delay display belongs to motorLabel (audit 2026-10-11, S5-2).

/**
 * Pure transform: thrust samples + catalog metadata → engine MotorSpec.
 * Mass at each sample time interpolates from total weight down to burnout
 * weight proportionally to CUMULATIVE IMPULSE (trapezoidal), matching how
 * OpenRocket treats .eng files. CG is fixed at half the motor length (the
 * same approximation OpenRocket applies to RASP data without CG info).
 */
export type RepairedMotorSpec = MotorSpec & {
  /** Source metadata captured with an EX curve, independent of later library edits. */
  exDefinition?: import('./exMotors.js').ExMotor;
  /**
   * Plain-English repairs applied to the published curve before it could be
   * simulated. Present only when the file needed them; the UI shows it so a
   * silent data fix never changes someone's numbers without saying so. Since
   * v0.116 fetchMotorSpec also appends `impulseNote`'s sentence here, which is
   * not a repair: `isImpulseNote` tells it apart, and services/notices.ts shows
   * each as what it is.
   */
  curveRepairs?: string[];
};

export function samplesToMotorSpec(
  motor: TcMotor,
  samples: TcSample[],
  ejectionDelay: number,
  /** The data file's own masses; they win over the catalog (see headerMasses). */
  fromFile?: TcHeaderMasses | null,
  units: UnitSelection = INITIAL_UNITS,
): RepairedMotorSpec {
  // Normalize: repaired (strictly increasing times), starting at t=0 — the
  // curve the file flies, which the picker's impulse gate measures too.
  if (samples.length === 0) {
    throw new Error(`No thrust samples for ${motor.designation}`);
  }
  const repaired = flownCurve(samples);
  const pts = repaired.samples;

  // thrustcurve.org's catalog is not uniformly populated: 145 of the 1,156
  // bundled entries publish no loaded weight and 13 no propellant weight
  // (2026-09-30 snapshot), and thrustcurve.org lists Cesaroni 25E75-17A with
  // more propellant than loaded mass (corrected since 2026-10-01 in the bundled
  // catalogue and in a live overlay alike, scripts/motor-corrections.mjs, so
  // the guard below is for the next row that arrives that way). Without
  // this guard those became NaN / negative masses that went straight into the
  // kernel, where TeaVM threw a raw "cannot be converted to a BigInt" and the
  // whole design blanked. Refuse with something a rocketeer can act on — never
  // substitute a made-up mass, which would trade a visible error for silently
  // wrong altitudes.
  //
  // What is checked is the pair that will FLY (audit 2026-09-22): the data
  // file's own masses when it states a usable pair — they win below — and the
  // catalogue's only when it does not. Checking the catalogue regardless
  // refused motors whose file carries good masses: 116 of the 157 catalogue
  // rows with no usable weight, 14 of them in production (Estes 1/2A6,
  // Cesaroni 320H565-14A, Klima B2, ...), all of which desktop flies.
  const file = isHeaderMasses(fromFile) ? fromFile : null;
  if (!file && (!Number.isFinite(motor.totalWeightG) || !Number.isFinite(motor.propWeightG))) {
    throw new Error(
      `thrustcurve.org publishes no loaded/propellant weight for ${motor.designation}, ` +
        'so it cannot be simulated. Pick another motor, or import its .rse/.eng file.',
    );
  }
  if (!file && motor.propWeightG > motor.totalWeightG && !noticeEqual(motor.propWeightG / 1000, motor.totalWeightG / 1000)) {
    const [propellant, loaded] = noticeComparison('mass', motor.propWeightG / 1000, motor.totalWeightG / 1000, units, { parenthesized: true });
    throw new Error(
      (propellant.startsWith('just ') ? `${motor.designation} is catalogued with slightly more propellant than loaded mass (${loaded}), so its burn would end at a negative mass. ` :
      `${motor.designation} is catalogued with more propellant (${noticeComparison('mass', motor.propWeightG / 1000, motor.totalWeightG / 1000, units, { parenthesized: true })[0]}) than ` +
        `loaded mass (${noticeComparison('mass', motor.propWeightG / 1000, motor.totalWeightG / 1000, units, { parenthesized: true })[1]}), so its burn would end at a negative mass. `) +
        'Pick another motor, or import a corrected .rse/.eng file.',
    );
  }

  const totalMass = (file?.totalWeightG ?? motor.totalWeightG) / 1000;
  const propMass = Math.min(totalMass, (file?.propWeightG ?? motor.propWeightG) / 1000);

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
 * Bumping made them UNREACHABLE; it never freed them. The generations —
 * `tc:samples:` through v0.060, `tc:samples:v2:` in v0.061-v0.064,
 * `tc:samples:v3:` in v0.065-v0.110, `tc:samples:v4:` in v0.111-v0.115,
 * `tc:samples:v5:` from v0.116 to 2026-10-01, then `tc:samples:v6:` and
 * `tc:samples:v7:`, both 2026-10-01 (below; v6 may never have shipped) — and the
 * beta invite went out 2026-08-22, so day-one testers hold dead generations
 * that can never be read and, until sweepDeadGenerations() below, could never
 * be freed either. Whoever bumps this next: change only the version segment,
 * CACHE_ROOT is what sweeps.
 *
 * v4 (v0.111) is the one to learn from. THE ENTRY IS KEYED BY MOTOR, NOT BY
 * THE RULE THAT CHOSE IT: a hit is validated for shape and nothing else (see
 * the read below), so it outranks the bundle and the network for as long as it
 * survives. v0.107 rewrote pickSampleFile — burn-time agreement, then the
 * certification file, ahead of the old raw point count — and left this segment
 * alone, so every curve downloaded before v0.107 kept the pick the OLD rule
 * made. Replaying both orders over the shipped bundle: 158 of the 810 motors
 * with two or more published files change file, 14 of them by 3 % or more of
 * total impulse (Cesaroni 229H255-14A -27.6 %, AMW J230SK-P +22.8 %, Estes A8
 * +7.8 %). A tester who flew one of those before v0.107 kept flying the wrong
 * curve through v0.110, and re-picking the motor could not clear it.
 *
 * SO: ANY CHANGE TO pickSampleFile, OR TO WHAT IS STORED IN AN ENTRY, BUMPS
 * THIS SEGMENT IN THE SAME COMMIT. A chooser fix that does not is a fix that
 * reaches new users only.
 *
 * v5 (v0.116, 2026-09-07): pickSampleFile gained the impulse-agreement term
 * (see IMPULSE_AGREEMENT), which moves 14 motors to a different file. Same
 * rule as above, applied the same day it was written down: bumped in the same
 * commit, v4 becomes a dead generation, sweepDeadGenerations() frees it.
 *
 * v6 (2026-10-01, audit 2026-09-30): that term measures the curve a file
 * FLIES (flownCurve), not its raw samples, which moves 16 motors of the
 * 2026-09-30 bundle to a different file: 5 to a different flown curve (the
 * AeroTech I65W by -4.46 % of impulse), 5 to the same curve with different
 * masses, 6 to the same curve and masses. Same rule, so v5 is dead too.
 *
 * v7 (2026-10-01): the last word between otherwise-equal files is the file
 * itself — masses closer to the catalogue's, then thrustcurve.org's id —
 * never its position in the list, which moves 7 motors of the 2026-09-30
 * bundle (the Hypertek 2800CCRGLFX-L625FX back to 5,706.2 g loaded). Same
 * rule, so v6 is dead too.
 *
 * NOT bumped for the tags (2026-10-28, lane 18). An entry written since then
 * carries three OPTIONAL fields: `origin` ('snapshot' or 'download'), the
 * cached file's own desktop `digests`, and `motorDigests`, every digest of
 * the motor's flyable files when each of them has one. They change no pick
 * and nothing that flies — the samples and masses are what v7 always stored,
 * chosen by the same pickSampleFile — so no entry was written under an old
 * picking rule, which is what this rule exists for. An entry without them
 * (v0.196 and earlier) reads as "origin and digests unknown": with no digest
 * asked for it flies as it always did, and with one, the snapshot or the
 * download is asked first and the entry stands in when neither can be
 * reached (curveFiles). A bump would only throw away every cached curve —
 * for a motor with no bundled curve, the one copy it has offline.
 *
 * And since that day a loaded bundle that can fly the motor comes BEFORE the
 * entry (audit S5-3): an entry still outranks the snapshot and the network,
 * but no longer a curve the app ships, even one a later release added.
 */
const CACHE_ROOT = 'tc:samples:';
const CACHE_PREFIX = `${CACHE_ROOT}v7:`;
// Missing massParser marks an older parse, not an invalid offline curve.
const MASS_PARSER_VERSION = 1;

function isCurrentCurveCache(entry: unknown): entry is { samples: TcSample[]; masses?: unknown } {
  return !!entry && typeof entry === 'object'
    && 'samples' in entry && isSampleList(entry.samples);
}

/** Where a cached curve came from: the curated snapshot's curves file, or a thrustcurve.org download. */
export type CachedCurveOrigin = 'snapshot' | 'download';

/** A cache entry as read: the curve, its checked masses, and whichever tags it carries (see the comment above). */
interface CachedCurve {
  samples: TcSample[];
  masses: TcHeaderMasses | null;
  origin?: CachedCurveOrigin;
  digests?: string[];
  motorDigests?: string[];
}

const digestList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === 'string') ? v as string[] : undefined;

/**
 * Cap on the live generation, and the mark eviction prunes back to.
 *
 * localStorage is ONE ~5 MB pool per origin, shared with the session autosave
 * and the 500-run history. An unbounded cache therefore does not degrade
 * itself, it breaks "your work saves itself": session.ts starts flagging the
 * autosave as failing and simStore.persist refuses run writes. One batch run
 * caches a curve per candidate (BatchSimulate's own example is 226 motors) and
 * the bundled database holds 1,156, so repeated batches walk toward the whole
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

// `deadline` — the caller's cancel merged with this download's own timeout,
// told apart afterwards — lives in net.ts now (weather build, 2026-09-22),
// shared with the weather requests; moved there unchanged.

/**
 * Drops every downloaded-curve entry, of every generation, and says how many.
 *
 * For a write that matters more than this cache and has just hit the quota —
 * the imported EX-motor library (exMotors.ts persist, audit 2026-09-22). The
 * cache is a pure convenience: every catalogue curve is in the shipped bundle
 * and anything else downloads again on its next use, so emptying it loses
 * nothing a user made, where losing their imported motors does.
 */
export function clearCurveCache(): number {
  try {
    const keys = cachedKeys();
    for (const k of keys) localStorage.removeItem(k);
    return keys.length;
  } catch {
    return 0; // no storage at all
  }
}

/** Does the loaded bundle list this motor at all (even with no usable file)? Throws when the bundle will not load. */
async function bundleListsMotor(motorId: string): Promise<boolean> {
  return Object.hasOwn(await loadBundledCurves(), motorId);
}

/** The files pickSampleFile can choose among: the same test it applies first. */
const flyable = (files: readonly TcSimFile[]): TcSimFile[] =>
  files.filter((f) => (f.samples?.length ?? 0) >= 2 && isSampleList(f.samples));

/**
 * A curve the network or the curated snapshot gave, into this browser's curve
 * cache — the motor's USUAL pick, with the tags the comment above describes.
 * `motorDigests` only when every flyable file has a digest: without one, a
 * digest might name a file the list cannot show, and "not among them" would
 * be a guess.
 */
function writeCurveCache(cacheKey: string, file: TcSimFile, origin: CachedCurveOrigin, files: readonly TcSimFile[]): void {
  const digests = fileDigests(file);
  const all = flyable(files).map(fileDigests);
  const entry = JSON.stringify({
    samples: file.samples, masses: headerMasses(file), massParser: MASS_PARSER_VERSION, t: Date.now(), origin,
    ...(digests.length ? { digests } : {}),
    ...(all.length && all.every((d) => d.length) ? { motorDigests: [...new Set(all.flat())] } : {}),
  });
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

/** This browser's entry for a motor, checked, or null (none, corrupt — then dropped — or no storage). */
function readCurveCache(cacheKey: string): CachedCurve | null {
  try {
    const cached = localStorage.getItem(cacheKey);
    if (!cached) return null;
    const parsed = JSON.parse(cached) as unknown;
    // Validate the shape — a corrupt entry parses fine but would break
    // samplesToMotorSpec forever (the cache is never invalidated otherwise).
    if (!isCurrentCurveCache(parsed)) {
      localStorage.removeItem(cacheKey);
      return null;
    }
    // The masses get the SAME test headerMasses applies on the write path.
    // Taken verbatim they bypassed the sanity checks in samplesToMotorSpec
    // — those inspect the CATALOG pair, and a file pair overrides it — so
    // an impossible cached pair silently changed apogee and the recovery
    // numbers instead of throwing. null is not a made-up mass: it is
    // headerMasses' own documented answer for a file it cannot read, and
    // the caller then flies the catalog values, which ARE checked.
    const tags = parsed as Record<string, unknown>;
    const origin = tags['origin'] === 'snapshot' || tags['origin'] === 'download' ? tags['origin'] : undefined;
    const digests = digestList(tags['digests']);
    const motorDigests = digestList(tags['motorDigests']);
    return {
      samples: parsed.samples, masses: isHeaderMasses(parsed.masses) ? parsed.masses : null,
      ...(origin ? { origin } : {}), ...(digests ? { digests } : {}), ...(motorDigests ? { motorDigests } : {}),
    };
  } catch {
    return null; // storage unavailable (private mode etc.) — just fetch
  }
}

/** Desktop's digest: the MD5 of the file it loaded, lowercase hex (scripts/motor-digest.mjs md5Hex). */
const DESKTOP_DIGEST = /^[0-9a-f]{32}$/;

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

// ------------------------------------------------- the files a motor flies from

/** Where the files a motor flew from came from. */
export type CurveOrigin = 'bundle' | 'cache' | 'snapshot' | 'download';

/**
 * THE FILES A MOTOR FLIES FROM, AND WHERE THEY CAME FROM (2026-10-28, lane
 * 18): curveFiles' answer, which fetchMotorSpec flies and lastCurveFiles keeps.
 */
export interface CurveFiles {
  motorId: string;
  origin: CurveOrigin;
  /**
   * Every file that origin holds for the motor, as pickSampleFile and
   * pickDigestFile saw them. For the cache, the one file it holds, which
   * carries its stored digests when the entry has them.
   */
  files: TcSimFile[];
  /** The file flown: the one the digest names when `files` has it, else `usual`. */
  flown: TcSimFile;
  /** pickSampleFile's choice among `files` (for the cache, the file it holds: the cache keeps the usual pick). */
  usual: TcSimFile;
  /**
   * Present when a digest was asked for. `named`: 'flown', a file it names
   * flew; 'absent', the motor's files hold none it names, so the usual pick
   * flew; 'unknown', the cache stood in and cannot say.
   */
  digest?: { value: string; named: 'flown' | 'absent' | 'unknown' };
  /** For origin 'cache': what wrote the entry, when the entry says (v0.196 entries do not). */
  cachedFrom?: CachedCurveOrigin;
  /**
   * The cache flew IN PLACE of a file the digest may name, because the
   * snapshot's curves file or thrustcurve.org could not be asked ('offline':
   * navigator.onLine was false, and nothing was asked) or did not answer with
   * a curve ('failed').
   */
  cacheFallback?: 'offline' | 'failed';
}

/** How many motors' last reads lastCurveFiles keeps for the page session. */
const MAX_REMEMBERED_READS = 64;
const rememberedReads = new Map<string, CurveFiles>();

function remember(read: CurveFiles): CurveFiles {
  rememberedReads.delete(read.motorId);
  rememberedReads.set(read.motorId, read);
  if (rememberedReads.size > MAX_REMEMBERED_READS) rememberedReads.delete(rememberedReads.keys().next().value!);
  return read;
}

/**
 * The last curveFiles answer for this motor in this page session, or
 * undefined — with no read of its own, so a caller that reports on a curve
 * (digestCurveNote, lane 22) can say what flew without a second request. The
 * newest MAX_REMEMBERED_READS motors are kept.
 */
export function lastCurveFiles(motorId: string): CurveFiles | undefined {
  return rememberedReads.get(motorId);
}

/** E (audit S5-1): a curves file that was not read says nothing about the motor, and must not read as "none exists". */
function unreadableCurvesFile(designation: string, err: unknown): Error {
  const why = err instanceof CatalogueError || err instanceof NetError || (err instanceof Error && err.message === NO_HASH_MESSAGE)
    ? ` ${err.message}` : '';
  return new Error(`The curated catalogue's curves file, the only source of a curve for ${designation}, could not be read.${why}`,
    { cause: err });
}

/**
 * ONE SOURCE FOR THE FILES A MOTOR FLIES FROM (2026-10-28, lane 18). In order:
 *
 * 1. The shipped bundle. It holds every file thrustcurve.org publishes for
 *    the catalogue it was built from, chosen by the same pickSampleFile a
 *    live response goes through, so a motor flies the same curve offline as
 *    on. It comes before this browser's cache (audit S5-3, owner 113-9b): a
 *    curve cached from the snapshot or a download no longer outlives a
 *    release that ships the motor, and the file a digest names among the
 *    bundled ones flies, else the bundle's pick (113-16e). A bundle chunk
 *    that would not load (a tab left open across an update) is not "no
 *    files": the cache and then the download stand in.
 * 2. This browser's cache, the motor's USUAL pick from an earlier read. With
 *    no digest it answers. With one, it answers when its file carries that
 *    digest, or when the motor's files carry none that do (the usual pick is
 *    then what any read would fly); otherwise the snapshot or the download is
 *    asked for the named file first (113-16e: a warm cache flew the usual
 *    pick instead, and said nothing), and the cache stands in when they
 *    cannot answer — at once, with no request, when the browser says it is
 *    offline.
 * 3. The curated snapshot's curves file (row 110), for a motor the overlay
 *    added or a shipped motor the bundle has no curve for (D.7).
 * 4. thrustcurve.org's download.
 *
 * `bundleOnly` stops after step 1 (fetchMotorSpec's `opts`). Not for an EX
 * motor, whose curve lives in the EX library. Every answer is kept for
 * lastCurveFiles.
 */
export async function curveFiles(
  motor: TcMotor,
  opts: { bundleOnly?: boolean; digest?: string; signal?: AbortSignal } = {},
): Promise<CurveFiles> {
  const { motorId } = motor;
  if (motorId.startsWith('ex:')) throw new TypeError(`curveFiles reads catalogue curves; ${motorId} is an EX-library motor.`);
  const { bundleOnly = false, digest, signal } = opts;
  const cacheKey = CACHE_PREFIX + motorId;
  // Once per page load, on the app's path only (see fetchMotorSpec's `opts`),
  // whether or not this motor reaches the cache.
  if (!bundleOnly) {
    try { sweepDeadGenerations(); } catch { /* storage unavailable */ }
  }
  /** The usual pick among one origin's files, and the file the digest names among them; null when none can fly. */
  const chosen = (origin: CurveOrigin, files: TcSimFile[]): CurveFiles | null => {
    const usual = pickSampleFile(files, motor);
    if (!usual?.samples) return null;
    const named = digest ? pickDigestFile(files, digest, motor) : null;
    return { motorId, origin, files, flown: named ?? usual, usual,
      ...(digest ? { digest: { value: digest, named: named ? 'flown' : 'absent' } } : {}) };
  };

  // 1. The shipped bundle.
  let bundle: TcSimFile[] = [];
  let bundleFailed = false;
  try {
    bundle = await bundledFiles(motorId);
  } catch {
    bundleFailed = true;
  }
  const fromBundle = chosen('bundle', bundle);
  if (fromBundle) return remember(fromBundle);
  if (bundleOnly) {
    throw new OfflineCurveError(bundleFailed
      ? 'The thrust curves bundled with the app did not load, and this run does not use the network.'
      : `The thrust curve for ${motor.designation} is not among the curves bundled with the app,`
        + ' and this run does not use the network.');
  }

  // 2. This browser's cache.
  const cached = readCurveCache(cacheKey);
  const fromCache = (entry: CachedCurve, named: 'flown' | 'absent' | 'unknown', fallback?: 'offline' | 'failed'): CurveFiles => {
    const file: TcSimFile = { samples: entry.samples, ...(entry.masses ? { bundledMasses: entry.masses } : {}),
      ...(entry.digests ? { digests: entry.digests } : {}) };
    return remember({ motorId, origin: 'cache', files: [file], flown: file, usual: file,
      ...(digest ? { digest: { value: digest, named } } : {}),
      ...(entry.origin ? { cachedFrom: entry.origin } : {}), ...(fallback ? { cacheFallback: fallback } : {}) });
  };
  if (cached) {
    if (!digest) return fromCache(cached, 'unknown');
    if (cached.digests?.includes(digest)) return fromCache(cached, 'flown');
    // Not desktop's form (32 lowercase hex, its MD5; digestCurveNote holds
    // the same test): no published file has it, so nothing to ask for.
    if (!DESKTOP_DIGEST.test(digest)
      || (cached.motorDigests && !cached.motorDigests.includes(digest))) return fromCache(cached, 'absent');
    // The snapshot's curves file may take 120 s to give up (catalogueClient.ts).
    if (isOffline()) return fromCache(cached, 'unknown', 'offline');
  }
  try {
    return remember(await curveFilesFromNetwork(motor, { digest, signal, bundleFailed,
      bundleEmpty: !bundleFailed && bundle.length === 0, chosen }));
  } catch (err) {
    // A named file the network could not give: the usual pick, from the
    // cache, stands in — never for the caller's own Stop.
    if (!cached || signal?.aborted) throw err;
    return fromCache(cached, 'unknown', 'failed');
  }
}

/** curveFiles' steps 3 and 4: the curated snapshot's curves file, then thrustcurve.org. */
async function curveFilesFromNetwork(motor: TcMotor, ctx: {
  digest?: string; signal?: AbortSignal; bundleFailed: boolean; bundleEmpty: boolean;
  chosen: (origin: CurveOrigin, files: TcSimFile[]) => CurveFiles | null;
}): Promise<CurveFiles> {
  const { signal, bundleFailed, bundleEmpty, chosen } = ctx;
  const cacheKey = CACHE_PREFIX + motor.motorId;

  // The curated snapshot's curves file (row 110), for a motor the app shipped
  // no curve for: one the overlay ADDED, or a shipped motor the bundle lacks
  // (D.7). Never for a shipped motor the bundle has — that curve is never
  // replaced — and never bundle-only. A shipped motor the file, READ, gives no
  // curve for has no published curve, and thrustcurve.org is not asked; a file
  // that could not be read says only that (audit S5-1). An added motor falls
  // through to the download below either way.
  const snapshot = activeSnapshot();
  if (snapshot) {
    const shipped = shippedMotorIds.has(motor.motorId);
    const added = !shipped && (getCatalogueOverlay()?.added.some((m) => m.motorId === motor.motorId) ?? false);
    const curveless = shipped && !bundleFailed && !await bundleListsMotor(motor.motorId);
    if (added || curveless) {
      /** The motor's files in the file, or null when the file was not read and accepted. */
      let files: TcSimFile[] | null = null;
      let unread: unknown;
      try {
        files = simFiles((await untilAborted(loadSnapshotCurves(snapshot), signal)).get(motor.motorId) ?? []);
      } catch (err) {
        if (signal?.aborted) throw err;
        unread = err;
      }
      const read = files && chosen('snapshot', files);
      if (read) {
        // The cache holds the motor's USUAL curve, which every pick of it
        // reads; a file only one design names is flown, not cached.
        if (read.flown === read.usual) writeCurveCache(cacheKey, read.usual, 'snapshot', files!);
        return read;
      }
      if (curveless) throw files ? new NoPublishedCurveError(motor.designation) : unreadableCurvesFile(motor.designation, unread);
    }
  }

  // The builder downloads the entire shipped catalogue, not just the IDs
  // present in `curves`. Only a complete bundle and equal dates establish that set:
  // a newer overlay ID or mismatched bundle must retain its download path.
  if (!bundleFailed && bundleEmpty && await knownNoPublishedCurve(motor.motorId)) {
    throw new NoPublishedCurveError(motor.designation);
  }
  if (noCurveEntries().get(motor.motorId) === catalogueDate()) throw new NoPublishedCurveError(motor.designation);
  const limit = deadline(signal, FETCH_TIMEOUT_MS);
  let body: { results?: unknown } | null | undefined;
  try {
    assertThrustcurveAvailable();
    const res = await thrustcurveFetch()(`${API}/download.json`, {
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
    // its headers and then stalls hangs while reading the body. It is read
    // CAPPED, never whole (see readJsonCapped).
    body = (await readJsonCapped(res, motor.designation)) as { results?: unknown } | null;
  } catch (err) {
    const timedOut = limit.timedOut();
    recordThrustcurveFailure(timedOut, signal?.aborted === true, err instanceof TypeError);
    // An HTTP error, an unreadable answer and the caller's own cancel (Stop,
    // in BatchSimulate) go back as they came. What is left is a connection
    // that never opened — fetch's TypeError, worded differently by every
    // browser ("Failed to fetch", "Load failed") — or our deadline, and both
    // are said in words a note can repeat (motorMatch.ts).
    if (signal?.aborted) throw err;
    const backoff = thrustcurveBackoffMessage();
    if (bundleFailed && backoff && !timedOut && !(err instanceof TypeError)) {
      throw new Error(`The thrust curves bundled with the app did not load, and ${backoff} `
        + "Reload the app with a connection, or import the motor's .rse/.eng file.", { cause: err });
    }
    if (!timedOut && !(err instanceof TypeError)) {
      if (backoff && !(err instanceof ThrustcurveBackoffError)) {
        throw new Error(withThrustcurveBackoff(err instanceof Error ? err.message : String(err)), { cause: err });
      }
      throw err;
    }
    const miss = timedOut
      ? `thrustcurve.org did not answer within ${FETCH_TIMEOUT_MS / 1000} s for ${motor.designation}`
      : `thrustcurve.org could not be reached for ${motor.designation}`;
    throw new Error(
      bundleFailed
        ? `The thrust curves bundled with the app did not load, and ${miss}. ${backoff ? backoff + ' ' : ''}Reload the app with a `
          + "connection, or import the motor's .rse/.eng file."
        : backoff
          ? `${miss}. ${backoff} You can import the motor's .rse/.eng file.`
          : `${miss}${timedOut ? '.' : ' — are you offline?'} Check the connection and try again, or import `
            + "the motor's .rse/.eng file.",
      { cause: err },
    );
  } finally {
    limit.done();
  }

  // Array.isArray, not `?? []`: a body whose `results` is a string or an
  // object reached .map() as a TypeError with no motor name in it. Same
  // failure class as the sample guard below — trust nothing in this body,
  // its ELEMENTS included: `{"results":[null]}` threw "Cannot read
  // properties of null" from pickSampleFile (audit 2026-09-22).
  const listed = body?.results;
  const results = Array.isArray(listed)
    ? listed.filter((f): f is TcSimFile => typeof f === 'object' && f !== null)
    : [];
  const read = chosen('download', results);
  if (!read) {
    // Report the actual problem; numeric curves can exceed the thrust
    // limit or collapse to too few distinct points.
    const rejected = results.find(f => (f.samples?.length ?? 0) >= 2);
    if (rejected) {
      throw new Error(`thrustcurve.org returned a thrust curve for ${motor.designation} that cannot be simulated: `
        + `${sampleListProblem(rejected.samples) ?? 'its samples are unusable'}. `
        + 'Pick another motor, or import its .rse/.eng file.');
    }
    // thrustcurve.org answered, and lists nothing to fly: the one failure
    // that means no curve exists. An answer with no `results` list at all is
    // a broken answer, not that one.
    if (Array.isArray(listed)) rememberNoCurve(motor.motorId);
    throw Array.isArray(listed)
      ? new NoPublishedCurveError(motor.designation)
      : new Error(`No sample data available for ${motor.designation}`);
  }
  // The cache holds the motor's USUAL curve, which every pick of it reads;
  // a file only one design names is flown, not cached.
  if (read.flown === read.usual) writeCurveCache(cacheKey, read.usual, 'download', results);
  return read;
}

/**
 * Fetches thrust samples (through curveFiles: the bundle, this browser's
 * cache, the curated snapshot, thrustcurve.org) and builds the MotorSpec.
 * Imported EX motors ("ex:" ids) build entirely from local data — an .rse that
 * turns RockSim's own mass model off carries per-sample masses, which fly
 * instead of the impulse-proportional approximation (exMotors.rseSampleMassesKg).
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
  /**
   * `bundleOnly`: the curve the SHIPPED bundle holds, and nothing else — no
   * read of this browser's curve cache (nor its once-per-load sweep of
   * retired generations), no EX library, no network. A headless Launch reads
   * motors this way (simulateFile's default), so its answer does not depend on
   * which browser, with which history, ran it. Absent: the app's path, as it
   * always was.
   */
  opts: {
    bundleOnly?: boolean;
    units?: UnitSelection;
    /**
     * A desktop .ork's motor `<digest>` (motorMatch passes the file's own).
     * The file it names is flown instead of pickSampleFile's choice, when the
     * bundle, the curated snapshot's curves file or the download has it
     * (pickDigestFile has why; curveFiles has the order); otherwise the
     * usual pick, so a digest can only ever choose among the motor's own
     * published files.
     */
    digest?: string;
  } = {},
): Promise<RepairedMotorSpec> {
  const bundleOnly = opts.bundleOnly === true;
  const digest = opts.digest;
  if (bundleOnly && motor.motorId.startsWith('ex:')) {
    throw new OfflineCurveError(`${motor.designation} is an imported EX-library motor, stored in one browser;`
      + ' this run reads only the curves bundled with the app.');
  }
  if (motor.motorId.startsWith('ex:')) {
    // Must stay dynamic to break the exMotors <-> thrustcurve cycle (audit 2026-10-11, S5-7).
    const { getExMotor, exToMotorSpec } = await import('./exMotors.js');
    const ex = getExMotor(motor.motorId);
    if (!ex) throw new Error(`Imported motor ${motor.designation} is no longer stored`);
    return exToMotorSpec(ex, ejectionDelay);
  }

  // The files it flies from, and which one: curveFiles has the order and why.
  const { flown } = await curveFiles(motor, { bundleOnly, digest, signal });
  const spec = samplesToMotorSpec(motor, flown.samples!, ejectionDelay, headerMasses(flown), opts.units);
  // Say when the curve flown disagrees with the motor's certification, in the
  // list the app already shows curve repairs from (services/notices.ts, which
  // tells this sentence apart from a repair and shows it as written). Found
  // on the owner's own WM 4" Extreme / J460T flight: the cert file flies
  // +6.5 % (its raw samples read +5.3 %) and the sim read 24 % over the
  // altimeter while the same day's other flight closed to 1 %
  // (docs/research/metra-flights-2026-09-06.md). Measured on the spec, the
  // curve that flies, not on `samples` (audit 2026-09-30; see impulseNote).
  const note = impulseNote(motor, spec.times.map((time, i) => ({ time, thrust: spec.thrusts[i]! })));
  return note ? { ...spec, curveRepairs: [...(spec.curveRepairs ?? []), note] } : spec;
}

/**
 * `fetchMotorSpec` reading the shipped bundle only — motorMatch's `fetchSpec`
 * injection point takes it as it stands (simulateFile's `network: 'forbid'`).
 */
export function bundledOnlyFetchSpec(motor: TcMotor, ejectionDelay: number, digest?: string, units?: UnitSelection): Promise<RepairedMotorSpec> {
  return fetchMotorSpec(motor, ejectionDelay, undefined, { bundleOnly: true, digest, units });
}
