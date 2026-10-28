// @vitest-environment happy-dom
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { digestCurveNote } from './digestCurveNote.js';
import { MOTOR_DB } from './motorDb.js';
import { matchImportedMotor } from './motorMatch.js';
import type { OrkMotorRef } from './orkFile.js';
import { simulateFile } from './simulateFile.js';
import {
  bundledSimFiles, fileImpulseNs, flownCurve, pickSampleFile, type TcMotor, type TcSimFile,
} from './thrustcurve.js';

/**
 * A desktop .ork's motor `<digest>` that names none of the motor's bundled
 * files: the design flies the app's usual pick (fetchMotorSpec), and the open
 * says so instead of falling back silently.
 */
const NOT_BUNDLED = 'is not among the app’s bundled curves';
const NAMED_DIFFERENT = 'flown with the thrust curve this design was saved with in desktop OR';

const fetchSpy = vi.fn(async () => { throw new TypeError('the network was used'); });
beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

const flownNs = (f: TcSimFile): string => fileImpulseNs({ samples: flownCurve(f.samples!).samples }).toFixed(1);
const impulse = (spec: MotorSpec): number => spec.times.reduce((sum, t, i) => i === 0 ? sum
  : sum + (t - spec.times[i - 1]!) * (spec.thrusts[i]! + spec.thrusts[i - 1]!) / 2, 0);
const hex = (c: string) => c.repeat(32);

/** Every digest any bundled file carries, so a test can prove its digest names none of them. */
async function bundledDigests(): Promise<Set<string>> {
  const { default: doc } = await import('../data/motorCurves.json');
  const files = Object.values((doc as unknown as { curves: Record<string, { digests?: string[] }[]> }).curves).flat();
  return new Set(files.flatMap((f) => f.digests ?? []));
}
async function unbundledDigest(): Promise<string> {
  const taken = await bundledDigests();
  const digest = [...'0123456789abcdef'].map(hex).find((d) => !taken.has(d))!;
  expect(digest).toMatch(/^[0-9a-f]{32}$/);
  return digest;
}

describe('digestCurveNote with injected files', () => {
  const motor: TcMotor = {
    motorId: 'synthetic', manufacturerAbbrev: 'Maker', designation: 'G10', commonName: 'G10', impulseClass: 'G',
    diameter: 29, length: 100, avgThrustN: 10, maxThrustN: 20, totImpulseNs: 100, burnTimeS: 10,
    totalWeightG: 100, propWeightG: 50, availability: 'regular',
  };
  const curve = (peak: number) => [{ time: 0, thrust: 0 }, { time: 1, thrust: peak }, { time: 10, thrust: 0 }];
  const file = (simfileId: string, peak: number, digest: string): TcSimFile => ({
    simfileId, source: 'cert', format: 'RASP', samples: curve(peak), digests: [digest],
  });
  const a = file('aaa111', 20, hex('a'));
  const b = file('bbb222', 25, hex('b'));
  const files = [a, b];
  const ref = (digest?: string): OrkMotorRef => ({
    designation: 'G10', manufacturer: 'Maker', diameter: 0.029, length: 0.1, delay: 0, ...(digest ? { digest } : {}),
  });

  it('names the curve it flies when the digest names no file', async () => {
    const usual = pickSampleFile(files, motor)!;
    const other = files.find((f) => f !== usual)!;
    const note = await digestCurveNote(ref(hex('c')), motor, async () => files);
    expect(note).toBeDefined();
    expect(note!.startsWith('Motor “G10”: ')).toBe(true);
    expect(note).toContain(`saved with in desktop OR ${NOT_BUNDLED} for the Maker G10`);
    expect(note).toContain(`/simfiles/${usual.simfileId}/`);
    expect(note).toContain(`${flownNs(usual)} N·s`);
    expect(note).not.toContain(`/simfiles/${other.simfileId}/`);
    expect(note).not.toContain(NAMED_DIFFERENT);
    expect(note).not.toMatch(/\bwe\b|!|removed|withdrawn|superseded|out of production|no longer/i);
  });

  it('keeps the named-and-different sentence', async () => {
    const usual = pickSampleFile(files, motor)!;
    const named = files.find((f) => f !== usual)!;
    const describe = (f: TcSimFile) => `cert RASP, ${flownNs(f)} N·s, https://www.thrustcurve.org/simfiles/${f.simfileId}/`;
    expect(await digestCurveNote(ref(named.digests![0]), motor, async () => files)).toBe(
      `Motor “G10”: flown with the thrust curve this design was saved with in desktop OR (${describe(named)}), `
      + `not the curve the app picks for the Maker G10 (${describe(usual)}). `
      + 'Picking the motor again in “Browse motor database” flies the app’s pick.');
  });

  it('is silent with no digest', async () => {
    expect(await digestCurveNote(ref(), motor, async () => files)).toBeUndefined();
  });

  it.each(['gen-c6', 'abc', hex('A'), hex('c') + '0', hex('c').slice(1)])(
    'is silent on a digest desktop does not write (%s), even with files to fly', async (digest) => {
      expect(pickSampleFile(files, motor)).not.toBeNull();
      expect(await digestCurveNote(ref(digest), motor, async () => files)).toBeUndefined();
    });

  it('is silent when the motor has no bundled files, or they do not load', async () => {
    expect(await digestCurveNote(ref(hex('c')), motor, async () => [])).toBeUndefined();
    expect(await digestCurveNote(ref(hex('c')), motor, () => Promise.reject(new Error('no bundle')))).toBeUndefined();
  });

  it('is silent when no file is flyable', async () => {
    const broken = [{ ...a, samples: [{ time: 0, thrust: 0 }] }];
    expect(pickSampleFile(broken, motor)).toBeNull();
    expect(await digestCurveNote(ref(hex('c')), motor, async () => broken)).toBeUndefined();
  });

  it('is silent when the digest names the usual pick, or a file that flies the same', async () => {
    const usual = pickSampleFile(files, motor)!;
    expect(await digestCurveNote(ref(usual.digests![0]), motor, async () => files)).toBeUndefined();
    const twin = { ...usual, simfileId: 'twin', format: 'RockSim', digests: [hex('d')] };
    expect(await digestCurveNote(ref(hex('d')), motor, async () => [usual, twin])).toBeUndefined();
  });
});

describe('opening a desktop design whose digest names no bundled file', () => {
  /** A catalogue motor, picked at run time, with bundled files and a ref that matches it back. */
  async function bundledMotor() {
    for (const m of MOTOR_DB.filter((x) => x.manufacturerAbbrev === 'AeroTech')) {
      const files = await bundledSimFiles(m.motorId);
      const usual = pickSampleFile(files, m);
      if (!usual) continue;
      const ref: OrkMotorRef = { designation: m.designation, manufacturer: 'AeroTech',
        diameter: m.diameter / 1000, length: m.length / 1000, delay: 0 };
      const plain = await matchImportedMotor(ref);
      if (plain.motor?.meta.motorId === m.motorId && plain.openNote === undefined) return { m, files, usual, ref };
    }
    throw new Error('no AeroTech motor with bundled files matches itself');
  }

  it('matchImportedMotor flies the usual pick and says so', async () => {
    const { m, files, usual, ref } = await bundledMotor();
    expect(files.length).toBeGreaterThan(0);
    const digest = await unbundledDigest();
    const got = await matchImportedMotor({ ...ref, digest });
    const sentence = await digestCurveNote({ ...ref, digest }, m);
    expect(sentence).toContain(NOT_BUNDLED);
    expect(sentence).toContain(`/simfiles/${usual.simfileId}/`);
    expect(got.openNote).toContain(sentence);
    expect(got.motor?.openNote).toBe(got.openNote);
    expect(got.motor?.meta.orkDigest).toBe(digest);
    expect(impulse(got.motor!.spec)).toBeCloseTo(fileImpulseNs({ samples: flownCurve(usual.samples!).samples }), 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the headless open carries the same sentence', async () => {
    const digest = await unbundledDigest();
    let root = process.cwd();
    while (!existsSync(join(root, 'version.json')) && dirname(root) !== root) root = dirname(root);
    const raw = new Uint8Array(readFileSync(join(root, 'packages', 'app', 'src', 'services', '__fixtures__', 'reference.ork')));
    const xml = strFromU8(unzipSync(raw)['rocket.ork']!);
    expect(xml).toContain('<digest>gen-c6</digest>');
    const body = zipSync({ 'rocket.ork': strToU8(xml.replace('<digest>gen-c6</digest>', `<digest>${digest}</digest>`)) });
    const out = await simulateFile(body, 'reference.ork');
    const [mm] = Object.values(out.state.mountMotors);
    const matched = MOTOR_DB.find((x) => x.motorId === mm?.meta.motorId)!;
    expect(matched).toBeDefined();
    expect((await bundledSimFiles(matched.motorId)).length).toBeGreaterThan(0);
    const sentence = await digestCurveNote({ designation: 'C6', manufacturer: 'custom', diameter: 0.018, length: 0.07,
      delay: 0, digest }, matched);
    expect(sentence).toContain(NOT_BUNDLED);
    expect(out.importNote.text).toContain(sentence);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);
});
