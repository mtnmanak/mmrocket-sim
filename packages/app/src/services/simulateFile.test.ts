// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import presetsJson from '../data/presets.json';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { APP_VERSION } from '../version.js';
import { applyDesignNameFallback, designFileOpenFailure, MAX_DESIGN_FILE_BYTES, parseDesignFile } from './designFile.js';
import type { ImportedDesign } from './importApply.js';
import { findDbMotor, MOTOR_DB } from './motorDb.js';
import { matchImportedMotor } from './motorMatch.js';
import { importOrk, type OrkMotorRef } from './orkFile.js';
import { loadBundledPresets, loadPresets, type Preset } from './presets.js';
import { comparable, idFree } from './simulate.testSupport.js';
import { SimulateDesignError } from './simulateDesign.js';
import { simulateFile, simulateImported } from './simulateFile.js';
import { bundledOnlyFetchSpec, bundleHasCurve } from './thrustcurve.js';

/**
 * THE HEADLESS OPEN (2026-10-01): a design file's bytes, flown as the app opens
 * and launches it, on the shipped data only. App.simulate.test.tsx holds it to
 * the mounted app; this is the door on its own — what it refuses and why, what
 * it reads (and does not), and that the two doors (bytes, and an
 * already-parsed design) are one path.
 */

// The importer, counted across a module boundary (a spy on designFile's own
// call would see nothing: an intra-module call does not go through the mock).
vi.mock('./orkFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./orkFile.js')>();
  return { ...real, importOrk: vi.fn(real.importOrk) };
});
vi.mock('./presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./presets.js')>();
  return { ...real, loadPresets: vi.fn(real.loadPresets), loadBundledPresets: vi.fn(real.loadBundledPresets) };
});

/** A fetch that fails the test if anything calls it. */
const fetchSpy = vi.fn(async () => { throw new TypeError('the network was used'); });
beforeEach(() => {
  localStorage.clear();
  fetchSpy.mockClear();
  vi.mocked(importOrk).mockClear();
  vi.mocked(loadPresets).mockClear();
  vi.mocked(loadBundledPresets).mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const bytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__', name)));
const buffer = (name: string): ArrayBuffer => {
  const b = bytes(name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('simulateFile flies a design file offline, on the shipped data', () => {
  it.each(['reference.ork', 'rocksimTestRocket1.rkt', 'Show-off.CDX1'])('%s, without the network', async (name) => {
    const out = await simulateFile(bytes(name), name);
    expect(out.result.summary.maxAltitude).toBeGreaterThan(0);
    expect(out.appVersion).toBe(APP_VERSION);
    expect(out.importNote).toBe(out.plan.note);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 30000);

  it('takes an ArrayBuffer as well as bytes', async () => {
    const a = await simulateFile(buffer('reference.ork'), 'reference.ork');
    expect(a.run.motor).toBe('C6');
  }, 30000);

  /**
   * A VIEW IS ITS OWN BYTES. A Node Buffer from the pool, or any `subarray`, is
   * a window onto a larger ArrayBuffer; reading `data.buffer` whole would hand
   * the importer the bytes on either side of the file as well.
   *
   * A .ork (zip), not a .rkt: the XML reader shrugs off a few stray bytes
   * around the document, so a .rkt flies the same either way and could not
   * tell the two reads apart (re-check of verify-step1 finding 8). A zip is
   * recognised by its first two bytes, so the buffer's leading filler makes the
   * wrong read fail outright — and the importer's own argument is checked too.
   */
  it('reads a Uint8Array view as the bytes it views, not the buffer behind it', async () => {
    const b = bytes('reference.ork');
    const big = new Uint8Array(b.length + 8).fill(0x55);
    big.set(b, 4);
    const view = big.subarray(4, 4 + b.length);
    expect(view.byteOffset).toBe(4);
    const viaView = await simulateFile(view, 'reference.ork');
    // The importer was handed exactly the viewed bytes: the file, from its zip signature on.
    const handed = vi.mocked(importOrk).mock.calls[0]![0] as ArrayBuffer;
    expect(handed.byteLength).toBe(b.length);
    expect(new Uint8Array(handed)).toStrictEqual(b);
    const whole = await simulateFile(b, 'reference.ork');
    expect(idFree(viaView.run)).toStrictEqual(idFree(whole.run));
    expect(viaView.result.summary).toStrictEqual(whole.result.summary);
  }, 60000);

  it('names a generically-named design after its file, as Open… does', async () => {
    const out = await simulateFile(bytes('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1');
    expect(out.run.rocket).toBe('My Test Rocket');
    expect(out.state.tree.name).toBe('My Test Rocket');
  }, 30000);

  it('is openDesignFile + simulateImported: the same flight from bytes and from the parse', async () => {
    const fromBytes = await simulateFile(bytes('reference.ork'), 'reference.ork');
    const parsed = parseDesignFile(buffer('reference.ork'), 'reference.ork', { presets: await loadBundledPresets() });
    applyDesignNameFallback(parsed, 'reference.ork');
    const fromParse = await simulateImported(parsed);
    expect(idFree(fromBytes.run)).toStrictEqual(idFree(fromParse.run));
    expect(fromBytes.result.summary).toStrictEqual(fromParse.result.summary);
    expect(fromBytes.importNote).toStrictEqual(fromParse.importNote);
  }, 60000);

  it('passes the open’s unmatched references through to the state it flies', async () => {
    // Show-off's sustainer motor renamed to one no catalogue has: the booster flies, the sustainer's reference is kept.
    const xml = new TextDecoder().decode(bytes('Show-off.CDX1'))
      .replace('<SustainerEngine>1/4A2  (AP)</SustainerEngine>', '<SustainerEngine>Z9999  (ZZ)</SustainerEngine>');
    const out = await simulateFile(new TextEncoder().encode(xml), 'Show-off.CDX1');
    expect(Object.values(out.state.unmatchedRefs ?? {}).map((r) => r.designation)).toContain('Z9999');
    expect(out.state.unmatchedRefs).toStrictEqual(out.plan.unmatchedRefs);
    expect(out.importNote.text).toContain('Z9999');
  }, 30000);
});

describe('simulateFile reads the shipped data only', () => {
  it('links parts against the shipped presets, not this browser’s custom ones', async () => {
    const mine = { manufacturer: 'Mine', partNo: 'MY-1', type: 'BodyTube' } as unknown as Preset;
    localStorage.setItem('online-openrocket.custom-presets.v1', JSON.stringify([mine]));
    await simulateFile(bytes('reference.ork'), 'reference.ork');
    expect(vi.mocked(loadPresets)).not.toHaveBeenCalled();
    expect(vi.mocked(loadBundledPresets)).toHaveBeenCalled();
    const given = vi.mocked(importOrk).mock.calls[0]![1]!.presets!;
    expect(given).toHaveLength((presetsJson as { presets: Preset[] }).presets.length);
    expect(given).not.toContainEqual(mine);
  }, 30000);

  it('flies the bundle’s curve over a curve this browser cached, and leaves the cache alone', async () => {
    const parsed = parseDesignFile(buffer('reference.ork'), 'reference.ork', { presets: await loadBundledPresets() });
    const plain = await simulateImported(structuredClone(parsed));
    // The same motor's cache entry, 10 % hotter, in the generation the app reads.
    const records = Object.values(plain.state.mountMotors);
    expect(records).toHaveLength(1);
    const primary = records[0]!;
    const db = findDbMotor(primary.spec.designation, primary.spec.diameter * 1000, undefined, primary.meta.manufacturer);
    expect(db, 'the catalogue row the file’s motor loaded from').toBeDefined();
    const key = `tc:samples:v7:${db!.motorId}`;
    const hot = primary.spec.times.map((time, i) => ({ time, thrust: primary.spec.thrusts[i]! * 1.1 }));
    localStorage.setItem(key, JSON.stringify({ samples: hot, masses: null, t: 1 }));
    const again = await simulateImported(structuredClone(parsed));
    expect(comparable(again.run)).toStrictEqual(comparable(plain.run));
    expect(localStorage.getItem(key)).not.toBeNull();
    // The app's own path WOULD fly the cached curve — else this proves nothing.
    const viaApp = await simulateImported(structuredClone(parsed), { network: 'allow' });
    expect(viaApp.result.summary.maxAltitude).toBeGreaterThan(plain.result.summary.maxAltitude);
  }, 60000);

  it('reports a catalogue motor the bundle has no curve for as unloaded — and makes no request', async () => {
    const { imported, designation } = await unbundledMotorDesign();
    const err = await simulateImported(imported).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulateDesignError);
    expect((err as SimulateDesignError).kind).toBe('no-motor');
    expect((err as SimulateDesignError).importNote?.text).toContain(`Motor “${designation}”`);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60000);
});

/** The first catalogue motor the shipped bundle has no curve for, as a one-motor design on the starter rocket. */
async function unbundledMotorDesign(): Promise<{ imported: ImportedDesign; designation: string }> {
  let missing: (typeof MOTOR_DB)[number] | undefined;
  for (const m of MOTOR_DB) {
    if ((await bundleHasCurve(m.motorId)) === false) { missing = m; break; }
  }
  expect(missing, 'a catalogue motor with no bundled curve').toBeDefined();
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const ref = {
    designation: missing!.designation, manufacturer: missing!.manufacturerAbbrev, diameter: missing!.diameter / 1000,
    length: missing!.length / 1000, delay: 0,
  } as OrkMotorRef;
  return {
    imported: { name: 'R', tree, motors: { [mount]: ref }, notes: [] } as unknown as ImportedDesign,
    designation: missing!.designation,
  };
}

/**
 * A CANCEL REACHES THE OPEN (verify-step1 finding 7, 2026-10-01). The signal
 * was checked once before the parse and never again, so every motor the file
 * names was still resolved — and, with `network: 'allow'`, downloaded — after
 * the caller had given up. And a cancel is reported as the caller's abort,
 * never as a SimulateDesignError: a caller that reads `kind: 'flight'` as "the
 * simulation failed" would misreport it.
 */
describe('simulateFile stops when the caller cancels', () => {
  it('matches no further motor reference after a cancel, and rejects with the abort', async () => {
    // Precondition: Show-off names more than one motor, so a second match would follow.
    const counted = vi.fn((ref: OrkMotorRef) => matchImportedMotor(ref, { fetchSpec: bundledOnlyFetchSpec }));
    await simulateFile(bytes('Show-off.CDX1'), 'Show-off.CDX1', { match: counted });
    expect(counted.mock.calls.length).toBeGreaterThan(1);

    const ac = new AbortController();
    const match = vi.fn((ref: OrkMotorRef) => {
      ac.abort('stop');
      return matchImportedMotor(ref, { fetchSpec: bundledOnlyFetchSpec });
    });
    const err = await simulateFile(bytes('Show-off.CDX1'), 'Show-off.CDX1', { match, signal: ac.signal })
      .catch((e: unknown) => e);
    expect(match).toHaveBeenCalledTimes(1);
    expect(err).not.toBeInstanceOf(SimulateDesignError);
    expect(err).toMatchObject({ name: 'AbortError', message: 'stop' });
  }, 60000);

  it("hands the caller's signal to a download when the network is allowed", async () => {
    const { imported } = await unbundledMotorDesign();
    const ac = new AbortController();
    let linked: boolean | null = null;
    fetchSpy.mockImplementation(async (...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      ac.abort('stop');
      // The request's own signal follows the caller's at once, or not at all.
      linked = init?.signal?.aborted ?? false;
      throw new TypeError('offline (test)');
    });
    const err = await simulateImported(imported, { network: 'allow', signal: ac.signal }).catch((e: unknown) => e);
    expect(fetchSpy).toHaveBeenCalled();
    expect(linked).toBe(true);
    expect(err).toMatchObject({ name: 'AbortError', message: 'stop' });
  }, 60000);
});

describe('simulateFile says why it did not fly', () => {
  it("'file': one byte over the limit is refused with the app’s sentence, before the importer runs", async () => {
    const err = await simulateFile(new Uint8Array(MAX_DESIGN_FILE_BYTES + 1), 'huge.ork').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'file', message: 'huge.ork is 64 MB — that is not a rocket design. Nothing was opened.' });
    expect(vi.mocked(importOrk)).not.toHaveBeenCalled();
  });

  it("'parse': the importer’s refusal, in the open-failure sentence the app shows", async () => {
    const junk = new TextEncoder().encode('<not-a-rocket');
    let direct: unknown;
    try { importOrk(junk.buffer.slice(0) as ArrayBuffer); } catch (e) { direct = e; }
    const err = await simulateFile(junk, 'junk.ork').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'parse', message: designFileOpenFailure('junk.ork', direct) });
  });

  it("'no-motor': a design that names no motor the app can load", async () => {
    const err = await simulateFile(bytes('kitchensink.ork'), 'kitchensink.ork').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'no-motor' });
    expect((err as SimulateDesignError).importNote?.text).toBeTruthy();
  }, 30000);
});
