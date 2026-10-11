/**
 * motor-digest.mjs: desktop OpenRocket's motor digest, ported (board Tier 3,
 * the thrust-curve picker's first step).
 *
 *  1. THE PORT IS DESKTOP'S. MotorDigestTest.java is carried over as it is, and
 *     real data files are pinned to the `<digest>` desktop OpenRocket wrote for
 *     them into real designs — the only evidence that the loaders' steps are
 *     the ones desktop takes. The files under fixtures/motor-digest/ are
 *     thrustcurve.org's, byte for byte (named by their simfile id), and each
 *     digest below is copied from the .ork named beside it (docs/User files/,
 *     local-only).
 *  2. IT SHIPS TO BROWSERS (src/services/motorDigest.ts → thrustcurve.ts), so
 *     it imports nothing — manufacturers.browserSafe.test.mjs has why — and its
 *     .d.mts declares exactly what it exports.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mod from './motor-digest.mjs';
import { DIGEST_DATA_TYPE, MotorDigest, digestMotorFile, digestRasp, digestRse, md5Hex } from './motor-digest.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const fixture = (name) => readFileSync(here(`./fixtures/motor-digest/${name}`), 'latin1');
const md5 = (bytes) => createHash('md5').update(bytes).digest('hex');

describe('MotorDigestTest.java, carried over', () => {
  it('testMotorDigest: the ints it digests, big-endian, behind each block\'s order and length', () => {
    // The Java test's own arrays; Math.nextAfter(Math.nextAfter(1.4445, 0), 0)
    // is two ulps below 1.4445, which must still round UP to 1445 ms (the
    // EPSILON nudge is what makes it).
    const below = 1.4445 - 2 * Number.EPSILON;
    expect(below).toBeLessThan(1.4445);
    const intData = [0, 4, 0, 123, 412, 1445, 1, 2, 5432, 4321, 5, 4, 0, 235, 9999334, 0];
    const bytes = Buffer.alloc(intData.length * 4);
    intData.forEach((v, i) => bytes.writeInt32BE(v, i * 4));

    const d = new MotorDigest();
    d.update(DIGEST_DATA_TYPE.TIME_ARRAY, [0.0, 0.123456789, 0.4115, below]);
    d.update(DIGEST_DATA_TYPE.MASS_SPECIFIC, [0.54321, 0.43211]);
    d.update(DIGEST_DATA_TYPE.FORCE_PER_TIME, [0.0, 0.2345678, 9999.3335, 0.0]);
    expect(d.getDigest()).toBe(md5(bytes));
  });

  it('refuses a block out of order, and a second getDigest', () => {
    const d = new MotorDigest();
    d.update(DIGEST_DATA_TYPE.MASS_SPECIFIC, [1, 2]);
    expect(() => d.update(DIGEST_DATA_TYPE.TIME_ARRAY, [0])).toThrow(/order/);
    expect(() => d.update(DIGEST_DATA_TYPE.MASS_SPECIFIC, [0])).toThrow(/order/);
    d.getDigest();
    expect(() => d.getDigest()).toThrow(/already used/);
  });
});

describe('md5Hex is MD5', () => {
  it('on the RFC 1321 vectors', () => {
    const enc = (s) => new TextEncoder().encode(s);
    expect(md5Hex(enc(''))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex(enc('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex(enc('12345678901234567890123456789012345678901234567890123456789012345678901234567890')))
      .toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('on every length across the padding boundaries, against node:crypto', () => {
    let seed = 7;
    for (let n = 0; n <= 200; n++) {
      const bytes = Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
      expect(md5Hex(bytes), `length ${n}`).toBe(md5(bytes));
    }
  });
});

describe('real data files give the digest desktop OpenRocket wrote for them', () => {
  // [file, digest, the design desktop wrote it into]
  const pinned = [
    // RASP with no t = 0 point (desktop prepends one).
    ['5f4294d20002e900000004e8.eng', '4f0059c416964ba2528c83551e6a6839', 'Estes C11 — pringles 2 - baseconehack.ork'],
    // The RockSim file of the same motor: auto mass and CG, so the same blocks.
    ['5f4294d20002e9000000036e.rse', '4f0059c416964ba2528c83551e6a6839', 'Estes C11 — pringles 2 - baseconehack.ork'],
    ['5f4294d20002e90000000273.eng', '6b4aebccc355196a4e289ce84d517b0e', 'AeroTech I1299N — TRF RASAero Files/38-54 2-stage.ork'],
    // Two points at t = 0: desktop drops the first. Its auto-calc-mass and
    // auto-calc-cg are both "1", so no per-sample mass or CG list is digested
    // and this file does NOT pin the doubled-t = 0 quirk on those lists; only
    // the synthetic test below does (as Java's finalizeThrustCurve,
    // AbstractMotorLoader.java:195-198, behaves). A real desktop digest of a
    // file with auto-calc off and a doubled t = 0 would pin it.
    ['5f4294d20002e90000000274.rse', '6b4aebccc355196a4e289ce84d517b0e', 'AeroTech I1299N — TRF RASAero Files/38-54 2-stage.ork'],
    // The manufacturer's file, which desktop flew; the app's own pick for this
    // motor is the cert file below (5,623 N·s against this one's 5,341).
    ['5f4294d20002e90000000789.eng', '975f52b1a968ace7dcb784d9329db969', 'AeroTech M1780NT — atestani files/LEM-IV.ork'],
  ];
  it.each(pinned)('%s → %s (%s)', (file, digest) => {
    expect(digestMotorFile(fixture(file))).toEqual([digest]);
  });

  it('tells two files of one motor apart', () => {
    expect(digestMotorFile(fixture('5f4294d20002e9000000071d.eng'), 'RASP')[0])
      .not.toBe(digestMotorFile(fixture('5f4294d20002e90000000789.eng'), 'RASP')[0]);
  });

  it('does not depend on line ends', () => {
    for (const file of readdirSync(here('./fixtures/motor-digest'))) {
      const text = fixture(file);
      const lf = text.replace(/\r\n?/g, '\n');
      expect(digestMotorFile(lf), file).toEqual(digestMotorFile(text));
      expect(digestMotorFile(lf.replace(/\n/g, '\r\n')), file).toEqual(digestMotorFile(text));
    }
  });

  it('reads an .rse whose CDATA comment holds markup characters', () => {
    // thrustcurve.org's M1780NT RockSim file: `<![CDATA[... 1" Core ...]]>`.
    const text = fixture('5f924a171bca5800041717f2.rse');
    const withoutComment = text.replace(/<comments>[\s\S]*?<\/comments>/, '');
    expect(digestMotorFile(text)).toHaveLength(1);
    expect(digestMotorFile(text)).toEqual(digestMotorFile(withoutComment));
  });
});

describe('the loaders\' steps', () => {
  const rasp = (data, header = 'F10 24 70 5 0.0400 0.0800 Test') => `; c\n${header}\n${data}\n`;
  const digestOf = (blocks) => {
    const d = new MotorDigest();
    for (const [type, values] of blocks) d.update(type, values);
    return d.getDigest();
  };

  it('a RASP file: time with (0, 0) prepended, the two header masses, thrust', () => {
    expect(digestRasp(rasp('0.5 10\n1.0 0'))).toEqual([digestOf([
      [DIGEST_DATA_TYPE.TIME_ARRAY, [0, 0.5, 1.0]],
      [DIGEST_DATA_TYPE.MASS_SPECIFIC, [0.08, 0.04]],
      [DIGEST_DATA_TYPE.FORCE_PER_TIME, [0, 10, 0]],
    ])]);
  });

  it('sorts by time, drops an identical duplicate and a zero-thrust point doubling the last time', () => {
    const expected = digestOf([
      [DIGEST_DATA_TYPE.TIME_ARRAY, [0, 0.5, 1.0]],
      [DIGEST_DATA_TYPE.MASS_SPECIFIC, [0.08, 0.04]],
      [DIGEST_DATA_TYPE.FORCE_PER_TIME, [0, 10, 3]],
    ]);
    expect(digestRasp(rasp('1.0 3\n0.5 10'))).toEqual([expected]);
    expect(digestRasp(rasp('0.5 10\n0.5 10\n1.0 3'))).toEqual([expected]);
    expect(digestRasp(rasp('0.5 10\n1.0 0\n1.0 3'))).toEqual([expected]);
    expect(digestRasp(rasp('0 0\n0 0\n0.5 10\n1.0 3'))).toEqual([expected]);
  });

  it('a RASP file of two motors gives two digests; a refused file gives none', () => {
    expect(digestRasp(`${rasp('0.5 10\n1.0 0')};\n${rasp('0.5 11\n1.0 0').slice(4)}`)).toHaveLength(2);
    expect(digestMotorFile(rasp('0.5 10'))).toEqual([]); // one point: too short
    expect(digestMotorFile(rasp('0.5 10 7\n1 0'))).toEqual([]); // three fields
    expect(digestMotorFile(rasp('0.5 10\n1 0', 'F10 24 70 5 0.09 0.08 Test'))).toEqual([]); // propellant > total
    expect(digestMotorFile('anything', 'SimCenter')).toEqual([]); // a format desktop does not load
  });

  const rse = (engineAttrs, points) => `<engine-database><engine-list><engine code="F10" initWt="80" propWt="40" ${engineAttrs}>`
    + `<comments>x</comments><data>${points.map(([t, f, m, cg]) => `<eng-data t="${t}" f="${f}" m="${m}" cg="${cg}"/>`).join('')}</data>`
    + '</engine></engine-list></engine-database>';

  it('an .rse with RockSim\'s own mass and CG: the two header masses, as RASP', () => {
    expect(digestRse(rse('', [[0, 0, 40, 35], [0.5, 10, 20, 35], [1, 0, 0, 35]]))).toEqual([digestOf([
      [DIGEST_DATA_TYPE.TIME_ARRAY, [0, 0.5, 1]],
      [DIGEST_DATA_TYPE.MASS_SPECIFIC, [0.08, 0.04]],
      [DIGEST_DATA_TYPE.FORCE_PER_TIME, [0, 10, 0]],
    ])]);
  });

  it('an .rse that turns them off: its per-sample masses and CGs', () => {
    expect(digestRse(rse('auto-calc-mass="0" auto-calc-cg="false"', [[0, 0, 40, 35], [0.5, 10, 20, 36], [1, 0, 0, 37]])))
      .toEqual([digestOf([
        [DIGEST_DATA_TYPE.TIME_ARRAY, [0, 0.5, 1]],
        [DIGEST_DATA_TYPE.MASS_PER_TIME, [0.04, 0.02, 0]],
        [DIGEST_DATA_TYPE.CG_PER_TIME, [0.035, 0.036, 0.037]],
        [DIGEST_DATA_TYPE.FORCE_PER_TIME, [0, 10, 0]],
      ])]);
  });

  it('keeps desktop\'s quirk: a doubled t = 0 leaves the per-sample lists one longer', () => {
    // finalizeThrustCurve removes the first t = 0 point from time and thrust
    // only, so desktop digests four masses against three times. Synthetic: no
    // real desktop digest in the fixtures exercises it (see the I1299N .rse).
    expect(digestRse(rse('auto-calc-mass="0" auto-calc-cg="0"', [[0, 0, 41, 35], [0, 5, 40, 35], [0.5, 10, 20, 35], [1, 0, 0, 35]])))
      .toEqual([digestOf([
        [DIGEST_DATA_TYPE.TIME_ARRAY, [0, 0.5, 1]],
        [DIGEST_DATA_TYPE.MASS_PER_TIME, [0.041, 0.04, 0.02, 0]],
        [DIGEST_DATA_TYPE.CG_PER_TIME, [0.035, 0.035, 0.035, 0.035]],
        [DIGEST_DATA_TYPE.FORCE_PER_TIME, [5, 10, 0]],
      ])]);
  });

  it('a missing per-sample mass turns RockSim\'s own calculation back on', () => {
    const missing = rse('auto-calc-mass="0" auto-calc-cg="1"', [[0, 0, 40, 35], [0.5, 10, 'x', 35], [1, 0, 0, 35]]);
    expect(digestRse(missing)).toEqual(digestRse(rse('', [[0, 0, 40, 35], [0.5, 10, 20, 35], [1, 0, 0, 35]])));
  });

  it('skips what desktop\'s handlers skip, and refuses what they refuse', () => {
    const plain = rse('', [[0, 0, 40, 35], [1, 0, 0, 35]]);
    const decorated = plain.replace('<data>', '<!-- note --><unknown><engine code="no"/></unknown><data><other t="9" f="9"/>');
    expect(digestRse(decorated)).toEqual(digestRse(plain));
    expect(digestMotorFile(plain.replace('</data>', '</data><data></data>'))).toEqual([]); // two <data>
    expect(digestMotorFile(plain.replace(' initWt="80"', ''))).toEqual([]); // no loaded mass
    expect(digestMotorFile(plain.replace('<eng-data t="0"', '<eng-data t="?"'))).toEqual([]); // a bad point
  });
});

describe('motor-digest.mjs is browser-safe (src/services/motorDigest.ts bundles it)', () => {
  const IMPL = readFileSync(here('./motor-digest.mjs'), 'utf8');
  const DECL = readFileSync(here('./motor-digest.d.mts'), 'utf8');
  const code = IMPL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('imports nothing at all — static, dynamic or require', () => {
    expect([...code.matchAll(/^\s*import\b[^\n]*/gm)].map((m) => m[0].trim())).toEqual([]);
    expect([...code.matchAll(/\bimport\s*\(/g)]).toEqual([]);
    expect([...code.matchAll(/\brequire\s*\(/g)]).toEqual([]);
  });

  it('touches no Node-only global', () => {
    expect(/\bprocess\s*\./.test(code), 'process is undefined in the browser bundle').toBe(false);
    expect(/\b__dirname\b|\b__filename\b|\bBuffer\s*\./.test(code)).toBe(false);
  });

  it('has the app consumer it is documented as having', () => {
    expect(readFileSync(here('../src/services/motorDigest.ts'), 'utf8'))
      .toMatch(/from '\.\.\/\.\.\/scripts\/motor-digest\.mjs'/);
  });

  it('declares in motor-digest.d.mts exactly what it exports', () => {
    const declared = [...DECL.matchAll(/^export\s+(?:declare\s+)?(?:const|function|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1]).sort();
    expect(declared).toEqual(Object.keys(mod).sort());
  });
});
