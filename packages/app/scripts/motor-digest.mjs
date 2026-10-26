/**
 * Desktop OpenRocket's motor digest, ported byte for byte (24.12
 * core/motor/MotorDigest.java, and the digest steps of RASPMotorLoader and
 * RockSimMotorLoader that feed it).
 *
 * WHY (board Tier 3, the thrust-curve picker; Eric 2026-10-01: "the digest
 * measurement as the first step"). Every motor desktop writes into a .ork
 * carries a `<digest>`: an MD5 over the curve FILE desktop loaded — its time
 * points, masses and thrusts, quantised. Two data files for one motor have
 * different digests, so the digest names the curve the design was flown with
 * on desktop, and src/services/thrustcurve.ts flies that file when the
 * bundle holds it.
 *
 * BROWSER-SAFE, AND IT HAS TO STAY SO. Two consumers: fetch-motor-curves.mjs,
 * which stores each bundled file's digest (the bundle keeps samples rounded to
 * 0.01 N and no raw text, and the digest reads mN and an .rse's per-sample
 * masses, so it cannot be computed from the bundle afterwards), and the app
 * itself, through src/services/motorDigest.ts, for a curve downloaded live.
 * So: zero imports, no Node globals, and its own small reader for an .rse
 * instead of a DOM (motor-digest.test.mjs holds all three).
 *
 * The digest is a property of the LOADER as much as of the file: desktop
 * prepends a (0, 0) point a RASP file leaves out, drops duplicated points, and
 * digests a RASP file's two header masses but an .rse file's per-sample masses
 * when it carries them. Each step below is the loader's, in its order,
 * including two quirks that change the hash and are kept on purpose (see
 * finalizeThrustCurve).
 */

/** MotorDigest.DataType: the order each block must come in, and its quantum. */
export const DIGEST_DATA_TYPE = Object.freeze({
  /** Time points, in ms. */
  TIME_ARRAY: Object.freeze({ order: 0, multiplier: 1000 }),
  /** Mass at a few points (loaded and empty), in 0.1 g. */
  MASS_SPECIFIC: Object.freeze({ order: 1, multiplier: 10000 }),
  /** Mass per time point, in 0.1 g. */
  MASS_PER_TIME: Object.freeze({ order: 2, multiplier: 10000 }),
  /** CG at a few points, in mm. */
  CG_SPECIFIC: Object.freeze({ order: 3, multiplier: 1000 }),
  /** CG per time point, in mm. */
  CG_PER_TIME: Object.freeze({ order: 4, multiplier: 1000 }),
  /** Thrust per time point, in mN. */
  FORCE_PER_TIME: Object.freeze({ order: 5, multiplier: 1000 }),
});

/** MotorDigest.EPSILON — nudges a value away from zero before rounding. */
const EPSILON = 0.00000000001;
/** MathUtil.EPSILON, the tolerance finalizeThrustCurve compares points with. */
const MATH_EPSILON = 0.00000001;

/** Java's Math.signum. */
const signum = (v) => (v > 0 ? 1 : v < 0 ? -1 : v);
const next = (v) => v + signum(v) * EPSILON;

/**
 * Java's `(int) Math.round(v)`. Math.round is floor(v + 0.5) — JS's
 * Math.round is the same function — saturating at the long range, and the
 * int cast keeps the low 32 bits, which ToInt32 (`| 0`) does exactly for any
 * integer inside that range. Math.round(NaN) is 0 in Java.
 */
function javaIntRound(v) {
  const r = Math.round(v);
  if (Number.isNaN(r)) return 0;
  if (r >= 2 ** 63) return -1;
  if (r <= -(2 ** 63)) return 0;
  return r | 0;
}

/** The MotorDigest class: blocks in increasing order, then one MD5. */
export class MotorDigest {
  #bytes = [];
  #lastOrder = -1;
  #used = false;

  /** MotorDigest.update(DataType, double...). */
  update(type, values) {
    const ints = Array.from(values, (value) => {
      let v = next(value);
      v *= type.multiplier;
      v = next(v);
      return javaIntRound(v);
    });
    if (this.#lastOrder >= type.order) {
      throw new Error(`MotorDigest: order ${type.order} after ${this.#lastOrder}`);
    }
    this.#lastOrder = type.order;
    this.#int(type.order);
    this.#int(ints.length);
    for (const v of ints) this.#int(v);
  }

  /** MotorDigest.getDigest(): lower-case hex, once. */
  getDigest() {
    if (this.#used) throw new Error('MotorDigest already used');
    this.#used = true;
    return md5Hex(Uint8Array.from(this.#bytes));
  }

  /** Big-endian, four bytes — MotorDigest.bytes(int). */
  #int(value) {
    this.#bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
}

// ---------------------------------------------------------------- MD5 (RFC 1321)

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/**
 * MD5 of `data` (a Uint8Array) as lower-case hex — TextUtil.hexString's form.
 * Synchronous and dependency-free: the browser's SubtleCrypto has no MD5.
 */
export function md5Hex(data) {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 8) >>> 6) * 64 + 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + MD5_K[i] + m[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((w, i) => out.setUint32(i * 4, w >>> 0, true));
  return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------- loader helpers

/** MathUtil.equals(a, b) at MathUtil.EPSILON. */
function mathEquals(a, b) {
  const absb = Math.abs(b);
  if (absb < MATH_EPSILON / 2) return Math.abs(a) < MATH_EPSILON / 2;
  return Math.abs(a - b) < MATH_EPSILON * absb;
}

/** The same stable order as AbstractMotorLoader, without restarting after each swap. */
function sortLists(primary, ...lists) {
  const order = primary.map((_, i) => i).sort((a, b) => primary[a] - primary[b]);
  for (const list of [primary, ...lists]) {
    const sorted = order.map(i => list[i]);
    for (let i = 0; i < sorted.length; i++) list[i] = sorted[i];
  }
}

/**
 * AbstractMotorLoader.finalizeThrustCurve, step for step. Two of its quirks
 * change the digest and are kept, because desktop's digests carry them:
 *  - the "two points at t = 0" step removes the point from time and thrust
 *    ONLY, leaving the other lists one longer (an .rse's per-sample masses and
 *    CGs then digest one more value than there are time points);
 *  - the duplicate-point step removes index i, the FIRST of the pair.
 */
function finalizeThrustCurve(time, thrust, ...lists) {
  if (time.length === 0) return;
  if (!mathEquals(time[0], 0)) {
    time.unshift(0);
    thrust.unshift(0);
    for (const l of lists) l.unshift(l[0]);
  }
  if (time.length > 1 && mathEquals(time[0], 0) && mathEquals(time[1], 0)) {
    time.shift();
    thrust.shift();
  }
  const kept = [];
  const count = time.length;
  for (let i = 0; i < count; i++) {
    if (i + 1 < count && mathEquals(time[i], time[i + 1]) && mathEquals(thrust[i], thrust[i + 1])) continue;
    kept.push(i);
  }
  for (const list of [time, thrust, ...lists]) {
    let write = 0;
    for (const i of kept) list[write++] = list[i];
    // Preserve desktop's extra mass/CG entry after its two-zero-times quirk.
    for (let i = count; i < list.length; i++) list[write++] = list[i];
    list.length = write;
  }
  const n = time.length - 1;
  if (n >= 1 && mathEquals(time[n - 1], time[n])) {
    if (mathEquals(thrust[n - 1], 0)) {
      for (const l of [time, thrust, ...lists]) l.splice(n - 1, 1);
    } else if (mathEquals(thrust[n], 0)) {
      for (const l of [time, thrust, ...lists]) l.splice(n, 1);
    }
  }
}

/** AbstractMotorLoader.split(str): Java's split on \s+, less one leading empty piece. */
export function javaSplitWs(s) {
  const pieces = s.split(/[ \t\n\x0B\f\r]+/);
  // Java's String.split drops trailing empty strings ("" alone stays [""]).
  while (pieces.length > 1 && pieces[pieces.length - 1] === '') pieces.pop();
  if (pieces.length === 0 || pieces[0] !== '') return pieces;
  return pieces.slice(1);
}

/**
 * Double.parseDouble, NaN where it throws: optional sign, decimal digits,
 * exponent, a trailing type letter, or NaN / Infinity. Java trims only
 * characters up to U+0020. Not the hexadecimal form, which no motor file uses.
 */
const JAVA_DOUBLE = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[dDfF]?|NaN|Infinity)$/;
function parseJavaDouble(s) {
  if (s == null) return NaN;
  // Java's String.trim() set: every character up to U+0020.
  const t = s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  if (!JAVA_DOUBLE.test(t)) return NaN;
  return Number(t.replace(/[dDfF]$/, ''));
}

// ---------------------------------------------------------------- the loaders

/**
 * The digest of every motor in a RASP (.eng) file, in file order — what
 * RASPMotorLoader stores on each. Throws where desktop's loader refuses the
 * file (it then loads no motor from it, so there is no digest).
 */
export function digestRasp(text) {
  // BufferedReader.readLine: \n, \r or \r\n ends a line; a final terminator adds none.
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let at = 0;
  const readLine = () => (at < lines.length ? lines[at++] : null);
  const digests = [];

  let line = readLine();
  main: while (line !== null) {
    while (line.length === 0 || line.charAt(0) === ';') {
      line = readLine();
      if (line === null) break main;
    }
    const pieces = javaSplitWs(line);
    if (pieces.length !== 7) throw new Error('RASP: a motor header line must hold 7 fields');
    if (Number.isNaN(parseJavaDouble(pieces[1])) || Number.isNaN(parseJavaDouble(pieces[2]))) {
      throw new Error('RASP: number expected');
    }
    const propW = parseJavaDouble(pieces[4]);
    const totalW = parseJavaDouble(pieces[5]);
    if (Number.isNaN(propW) || Number.isNaN(totalW)) throw new Error('RASP: number expected');
    if (propW > totalW) throw new Error('RASP: propellant weight exceeds total weight');

    const time = [];
    const thrust = [];
    for (line = readLine(); line !== null && (line.length === 0 || line.charAt(0) !== ';'); line = readLine()) {
      const buf = javaSplitWs(line);
      // split("") is [""] in Java, and the leading-empty rule makes it [].
      if (buf.length === 0 || (buf.length === 1 && buf[0] === '')) continue;
      if (buf.length !== 2) throw new Error('RASP: a data line must hold a time and a thrust');
      const t = parseJavaDouble(buf[0]);
      const f = parseJavaDouble(buf[1]);
      if (Number.isNaN(t) || Number.isNaN(f)) throw new Error('RASP: number expected');
      time.push(t);
      thrust.push(f);
    }
    if (time.length < 2) throw new Error('RASP: too short a thrust curve');

    sortLists(time, thrust);
    finalizeThrustCurve(time, thrust);
    const d = new MotorDigest();
    d.update(DIGEST_DATA_TYPE.TIME_ARRAY, time);
    d.update(DIGEST_DATA_TYPE.MASS_SPECIFIC, [totalW, totalW - propW]);
    d.update(DIGEST_DATA_TYPE.FORCE_PER_TIME, thrust);
    digests.push(d.getDigest());
  }
  return digests;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, (_, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ENTITIES[name]);
}

/**
 * The elements of an .rse as desktop's handlers see them — no DOM, so this
 * runs in the build script and the browser alike. Comments, CDATA and
 * processing instructions are dropped; each start tag yields its name and
 * attributes, each end (or self-closing) tag a close.
 */
function* xmlEvents(text) {
  const pieces = [];
  const opener = /<!--|<!\[CDATA\[|<\?|<!DOCTYPE/g;
  let start = 0;
  for (let m; (m = opener.exec(text)) !== null;) {
    const close = m[0] === '<!--' ? '-->' : m[0] === '<![CDATA[' ? ']]>' : m[0] === '<?' ? '?>' : '>';
    const end = text.indexOf(close, opener.lastIndex);
    if (end < 0) throw new Error('RSE: unclosed XML comment, CDATA or processing instruction');
    pieces.push(text.slice(start, m.index));
    start = end + close.length;
    opener.lastIndex = start;
  }
  pieces.push(text.slice(start));
  const body = pieces.join('');
  const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of body.matchAll(TAG)) {
    const [, closing, name, attrText, selfClosing] = m;
    if (closing) { yield { close: name }; continue; }
    const attrs = new Map();
    for (const a of attrText.matchAll(ATTR)) attrs.set(a[1], unescapeXml(a[2] ?? a[3]));
    yield { open: name, attrs };
    if (selfClosing) yield { close: name };
  }
}

/** File-header masses in grams, shared by live downloads and the bundle builder. */
export function motorHeaderMasses(text) {
  text = text.replace(/^(?:\uFEFF|\xEF\xBB\xBF)/, '');
  const checked = (total, prop) => {
    const totalWeightG = parseJavaDouble(total), propWeightG = parseJavaDouble(prop);
    return Number.isFinite(totalWeightG) && Number.isFinite(propWeightG)
      && totalWeightG > 0 && propWeightG > 0 && propWeightG <= totalWeightG
      ? { totalWeightG, propWeightG } : null;
  };
  if (text.trimStart().startsWith('<')) {
    try {
      const stack = [];
      for (const ev of xmlEvents(text)) {
        if (ev.close) { stack.pop(); continue; }
        if (ev.open === 'engine' && stack.every(name => ['engine-database', 'engine-list'].includes(name))) {
          return checked(ev.attrs.get('initWt'), ev.attrs.get('propWt'));
        }
        stack.push(ev.open);
      }
    } catch { return null; }
    return null;
  }
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
    if (!line || line.startsWith(';')) continue;
    const f = javaSplitWs(line);
    if (f.length !== 7) return null;
    return checked(String(parseJavaDouble(f[5]) * 1000), String(parseJavaDouble(f[4]) * 1000));
  }
  return null;
}

/**
 * The digest of every `<engine>` in a RockSim (.rse) file, in file order —
 * what RockSimMotorLoader stores on each. The handler stack is desktop's:
 * `<engine-database>` and `<engine-list>` are walked through, an `<engine>`
 * is a motor, its first `<data>` holds the `<eng-data>` points, and any other
 * element is skipped with everything inside it (simplesax's ignore).
 * Per-sample masses and CGs are digested when the file carries usable ones
 * and does not leave RockSim's own calculation on ("auto-calc-mass" /
 * "auto-calc-cg", on unless "0" or "false"); otherwise the two header masses.
 */
export function digestRse(text) {
  const digests = [];
  const stack = []; // handler of each open element: root | engine | data | point | ignore
  let motor = null;
  for (const ev of xmlEvents(text)) {
    if (ev.open !== undefined) {
      const parent = stack.length ? stack[stack.length - 1] : 'root';
      let h = 'ignore';
      if (parent === 'root') {
        if (ev.open === 'engine-database' || ev.open === 'engine-list') h = 'root';
        else if (ev.open === 'engine') {
          h = 'engine';
          motor = { attrs: ev.attrs, time: null, force: null, mass: null, cg: null, sawData: false };
        }
      } else if (parent === 'engine') {
        if (ev.open === 'data') {
          if (motor.sawData) throw new Error('RSE: multiple data elements');
          motor.sawData = true;
          motor.time = []; motor.force = []; motor.mass = []; motor.cg = [];
          h = 'data';
        }
      } else if (parent === 'data') {
        if (ev.open === 'eng-data') {
          h = 'point';
          const a = ev.attrs;
          const t = parseJavaDouble(a.get('t'));
          const f = parseJavaDouble(a.get('f'));
          if (Number.isNaN(t) || Number.isNaN(f)) throw new Error('RSE: illegal motor data point');
          motor.time.push(t);
          motor.force.push(f);
          motor.mass.push(parseJavaDouble(a.get('m')) / 1000);
          motor.cg.push(parseJavaDouble(a.get('cg')) / 1000);
        }
      }
      stack.push(h);
    } else {
      if (stack.pop() === 'engine') digests.push(rseMotorDigest(motor));
    }
  }
  return digests;
}

/** RSEMotorHandler: the attributes it reads, then getMotor's digest. */
function rseMotorDigest(motor) {
  const a = motor.attrs;
  const initMass = parseJavaDouble(a.get('initWt')) / 1000;
  const propMass = parseJavaDouble(a.get('propWt')) / 1000;
  if (Number.isNaN(initMass) || Number.isNaN(propMass)) throw new Error('RSE: mass missing');
  if (propMass > initMass) throw new Error('RSE: propellant weight exceeds total weight');
  const off = (name) => {
    const s = a.get(name);
    return s === '0' || (s !== undefined && s.toLowerCase() === 'false');
  };
  let calculateMass = !off('auto-calc-mass');
  let calculateCG = !off('auto-calc-cg');
  const { time, force, mass, cg } = motor;
  if (!time || time.length === 0) throw new Error('RSE: illegal motor data');
  // closeElement("data"): sort, then a NaN anywhere turns the calculation on.
  sortLists(time, force, mass, cg);
  if (mass.some(Number.isNaN)) calculateMass = true;
  if (cg.some(Number.isNaN)) calculateCG = true;

  finalizeThrustCurve(time, force, mass, cg);
  const illegal = (l) => l.some((v) => !Number.isFinite(v));
  if (illegal(mass)) calculateMass = true;
  if (illegal(cg)) calculateCG = true;

  const d = new MotorDigest();
  d.update(DIGEST_DATA_TYPE.TIME_ARRAY, time);
  if (!calculateMass) d.update(DIGEST_DATA_TYPE.MASS_PER_TIME, mass);
  else d.update(DIGEST_DATA_TYPE.MASS_SPECIFIC, [initMass, initMass - propMass]);
  if (!calculateCG) d.update(DIGEST_DATA_TYPE.CG_PER_TIME, cg);
  d.update(DIGEST_DATA_TYPE.FORCE_PER_TIME, force);
  return d.getDigest();
}

/**
 * The digest(s) of one simulator data file's raw text — [] when desktop's
 * loader would refuse the file, which then names no motor. thrustcurve.org's
 * `format` says which loader ("RASP" or "RockSim"; any other format is one
 * desktop does not load); with none, an XML document is RockSim, anything
 * else RASP — GeneralMotorLoader decides by extension, which a download lacks.
 */
export function digestMotorFile(text, format) {
  let rse;
  if (format === undefined || format === null || format === '') rse = text.trimStart().startsWith('<');
  else if (/^rasp$/i.test(format)) rse = false;
  else if (/^rocksim$/i.test(format)) rse = true;
  else return [];
  try {
    return rse ? digestRse(text) : digestRasp(text);
  } catch {
    return [];
  }
}
