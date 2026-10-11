// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { autosaveToOrk } from './autosaveBackup.js';
import { digestCurveNote } from './digestCurveNote.js';
import { findDbMotor } from './motorDb.js';
import { matchImportedMotor } from './motorMatch.js';
import type { OrkMotorRef } from './orkFile.js';
import type { SessionState } from './session.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { simulateFile } from './simulateFile.js';
import {
  bundledSimFiles, fetchMotorSpec, fileImpulseNs, flownCurve, pickDigestFile, pickSampleFile, type TcMotor,
} from './thrustcurve.js';

/**
 * A desktop design flies the thrust curve its motor `<digest>` names (board
 * Tier 3, the thrust-curve picker's first step; measured 2026-10-11 with
 * scripts/digest-census.mjs). The AeroTech M1780NT is the measured case:
 * thrustcurve.org holds a cert RASP file (5,623 N·s as flown, the app's own
 * pick) and the manufacturer's (5,341 N·s), and desktop OR flew the
 * manufacturer's in atestani's LEM-IV.ork and a TAP candidate's L3 design.
 */
const M1780NT_ID = '5f4294d2000231000000030b';
const MFR_FILE = '5f4294d20002e90000000789';
const CERT_FILE = '5f4294d20002e9000000071d';
/** Desktop's digest of MFR_FILE, as LEM-IV.ork carries it (scripts/motor-digest.test.mjs pins it). */
const MFR_DIGEST = '975f52b1a968ace7dcb784d9329db969';

// The app's own curve load, watched: simulateFile's network: 'allow' path
// hands it the file's digest (its fourth argument's `digest`).
vi.mock('./thrustcurve.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./thrustcurve.js')>();
  return { ...real, fetchMotorSpec: vi.fn(real.fetchMotorSpec) };
});

const fetchSpy = vi.fn(async () => { throw new TypeError('the network was used'); });
beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

function motor(): TcMotor {
  const m = findDbMotor('M1780NT', 75, undefined, 'AeroTech');
  expect(m?.motorId).toBe(M1780NT_ID);
  return m!;
}
const impulse = (spec: MotorSpec): number => spec.times.reduce((sum, t, i) => i === 0 ? sum
  : sum + (t - spec.times[i - 1]!) * (spec.thrusts[i]! + spec.thrusts[i - 1]!) / 2, 0);
async function fileNs(simfileId: string): Promise<number> {
  const f = (await bundledSimFiles(M1780NT_ID)).find((x) => x.simfileId === simfileId)!;
  return fileImpulseNs({ samples: flownCurve(f.samples!).samples });
}

describe('the bundle names each file by desktop\'s digest', () => {
  it('every bundled file carries one', async () => {
    const { default: doc } = await import('../data/motorCurves.json');
    const files = Object.values((doc as unknown as { curves: Record<string, { digests?: string[] }[]> }).curves).flat();
    expect(files.length).toBeGreaterThan(1900);
    expect(files.filter((f) => !(f.digests?.length === 1 && /^[0-9a-f]{32}$/.test(f.digests[0]!)))).toEqual([]);
  });

  it('pickDigestFile finds the file a digest names; the app\'s own pick is another', async () => {
    const files = await bundledSimFiles(M1780NT_ID);
    expect(pickSampleFile(files, motor())?.simfileId).toBe(CERT_FILE);
    expect(pickDigestFile(files, MFR_DIGEST, motor())?.simfileId).toBe(MFR_FILE);
    expect(pickDigestFile(files, '0'.repeat(32), motor())).toBeNull();
    expect(pickDigestFile(files, '', motor())).toBeNull();
  });

  it('two files with one digest are decided by the usual pick, not by list order', async () => {
    // The Estes C11's RASP and RockSim files are one curve to desktop.
    const c11 = findDbMotor('C11', 24, undefined, 'Estes')!;
    const files = await bundledSimFiles(c11.motorId);
    const digest = '4f0059c416964ba2528c83551e6a6839';
    expect(files.filter((f) => f.digests?.includes(digest))).toHaveLength(2);
    expect(pickDigestFile(files, digest, c11)).toBe(pickSampleFile(files, c11));
    expect(pickDigestFile([...files].reverse(), digest, c11)?.simfileId).toBe(pickSampleFile(files, c11)?.simfileId);
  });
});

describe('fetchMotorSpec with a digest', () => {
  it('flies the named file, offline and bundle-only alike', async () => {
    const named = await fetchMotorSpec(motor(), 0, undefined, { digest: MFR_DIGEST });
    const only = await fetchMotorSpec(motor(), 0, undefined, { digest: MFR_DIGEST, bundleOnly: true });
    const usual = await fetchMotorSpec(motor(), 0);
    expect(impulse(named)).toBeCloseTo(await fileNs(MFR_FILE), 1);
    expect(impulse(only)).toBeCloseTo(await fileNs(MFR_FILE), 1);
    expect(impulse(usual)).toBeCloseTo(await fileNs(CERT_FILE), 1);
    expect(impulse(usual) / impulse(named)).toBeGreaterThan(1.04);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a digest no file has flies the usual pick', async () => {
    expect(await fetchMotorSpec(motor(), 0, undefined, { digest: '0'.repeat(32) }))
      .toEqual(await fetchMotorSpec(motor(), 0));
  });
});

describe('opening a desktop design', () => {
  const ref = (digest?: string): OrkMotorRef => ({
    designation: 'M1780NT', manufacturer: 'AeroTech', diameter: 0.075, length: 0.665, delay: 0,
    ...(digest ? { digest } : {}),
  });

  it('matchImportedMotor flies the file the reference names, keeps the digest, and says so', async () => {
    const named = await matchImportedMotor(ref(MFR_DIGEST));
    const plain = await matchImportedMotor(ref());
    expect(impulse(named.motor!.spec)).toBeCloseTo(await fileNs(MFR_FILE), 1);
    expect(impulse(plain.motor!.spec)).toBeCloseTo(await fileNs(CERT_FILE), 1);
    expect(named.motor!.meta.orkDigest).toBe(MFR_DIGEST);
    expect(named.openNote).toContain('saved with in desktop OR');
    expect(named.openNote).toContain(`/simfiles/${MFR_FILE}/`);
    expect(named.openNote).toContain(`/simfiles/${CERT_FILE}/`);
    expect(plain.openNote).toBeUndefined();
  });

  it('says nothing when the named file flies the same as the usual pick', async () => {
    // The AeroTech M1500G: desktop flew the manufacturer's RASP file, the app
    // picks the RockSim file made from it — another digest, the same flight.
    const m1500 = findDbMotor('M1500G', 75, undefined, 'AeroTech')!;
    const r: OrkMotorRef = { designation: 'M1500G', manufacturer: 'AeroTech', diameter: 0.075, length: 0.681, delay: 0,
      digest: '233f8744136b12e764b86fe4430e11e7' };
    const files = await bundledSimFiles(m1500.motorId);
    expect(pickDigestFile(files, r.digest!, m1500)).not.toBe(pickSampleFile(files, m1500));
    expect(await digestCurveNote(r, m1500)).toBeUndefined();
    expect(await digestCurveNote({ ...ref(), digest: undefined }, motor())).toBeUndefined();
  });

  /** lemiv-motors.ork with its M1500G configuration carrying an M1780NT, opened as the default. */
  function design(digest: string | null): Uint8Array {
    let root = process.cwd();
    while (!existsSync(join(root, 'version.json')) && dirname(root) !== root) root = dirname(root);
    const xml = readFileSync(join(root, 'packages', 'app', 'src', 'services', '__fixtures__', 'lemiv-motors.ork'), 'utf8')
      .replace('<designation>M1500G</designation>', '<designation>M1780NT</designation>')
      .replace('<length>0.681</length>', '<length>0.665</length>')
      .replace('<digest>233f8744136b12e764b86fe4430e11e7</digest>', digest ? `<digest>${digest}</digest>` : '')
      .replace('configid="18540642-ab60-447f-b1e0-a3fd99db9e29" default="true"', 'configid="18540642-ab60-447f-b1e0-a3fd99db9e29"')
      .replace('<motorconfiguration configid="91154772-767b-49ec-aefd-9bc1607a57f3">',
        '<motorconfiguration configid="91154772-767b-49ec-aefd-9bc1607a57f3" default="true">');
    expect(xml).toContain(`M1780NT`);
    return new TextEncoder().encode(xml);
  }
  const flownImpulse = (out: Awaited<ReturnType<typeof simulateFile>>): number =>
    impulse(Object.values(out.state.mountMotors).find((m) => m.label.startsWith('M1780NT'))!.spec);

  it('flies desktop\'s curve through the open, a Save and a share link', async () => {
    const named = await simulateFile(design(MFR_DIGEST), 'lemiv-m1780nt.ork');
    const plain = await simulateFile(design(null), 'lemiv-m1780nt.ork');
    expect(flownImpulse(named)).toBeCloseTo(await fileNs(MFR_FILE), 1);
    expect(flownImpulse(plain)).toBeCloseTo(await fileNs(CERT_FILE), 1);
    expect(named.importNote.text).toContain('saved with in desktop OR');
    expect(plain.importNote.text).not.toContain('saved with in desktop OR');
    // 5 % less impulse: the rocket flies lower on desktop's curve.
    expect(named.result.summary.maxAltitude).toBeLessThan(plain.result.summary.maxAltitude);

    // Save .ork (the autosave's recovery file is the same writer): the digest
    // goes back out unchanged, and the saved file flies the same curve.
    const session = { ...named.plan.snapshot, unmatchedRefs: named.plan.unmatchedRefs } as unknown as SessionState;
    const saved = autosaveToOrk(session);
    expect(saved).toContain(`<digest>${MFR_DIGEST}</digest>`);
    const reopened = await simulateFile(new TextEncoder().encode(saved), 'saved.ork');
    expect(flownImpulse(reopened)).toBeCloseTo(await fileNs(MFR_FILE), 1);

    // A share link carries the same document.
    const shared = await decodeShareFragment(await encodeShareFragment(saved));
    const fromLink = await simulateFile(new TextEncoder().encode(shared), 'shared.ork');
    expect(flownImpulse(fromLink)).toBeCloseTo(await fileNs(MFR_FILE), 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('network: allow hands the digest to the app’s own curve load', async () => {
    vi.mocked(fetchMotorSpec).mockClear();
    const out = await simulateFile(design(MFR_DIGEST), 'lemiv-m1780nt.ork', { network: 'allow' });
    const calls = vi.mocked(fetchMotorSpec).mock.calls.filter((c) => c[0].motorId === M1780NT_ID);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c[3]).toEqual({ digest: MFR_DIGEST });
    expect(flownImpulse(out)).toBeCloseTo(await fileNs(MFR_FILE), 1);
  }, 60_000);
});
