import { beforeEach, describe, expect, it } from 'vitest';
import { nozzleDbMeta, nozzleForMotorId, resetNozzleDbCache } from './nozzleDb.js';
import nozzles from '../data/nozzles.json';

/**
 * Runs against the SHIPPED `src/data/nozzles.json`, the way
 * `preset-density.test.mjs` runs against the shipped presets — the point is to
 * fail the deploy on bad DATA, not only on bad code. Only one machine can
 * rebuild this file (it is derived from a 1,074-file local document set), so it
 * is a committed artifact and nothing else would notice if it regressed.
 */
describe('the published nozzle lookup', () => {
  beforeEach(resetNozzleDbCache);

  it('finds a motor by its catalogue id and reports where the number came from', async () => {
    // D13W, RMS-18-20, nozzle 01000-1 at 0.188 in = 4.775 mm.
    const e = await nozzleForMotorId('5f4294d20002310000000021');
    expect(e).not.toBeNull();
    expect(e!.designation).toBe('D13-10W');
    expect(e!.exitDiameterM).toBeCloseTo(0.004775, 9);
    expect(e!.nozzlePartNo).toBe('01000-1');
    expect(e!.confidence).toBe('high');
    // Provenance is the whole requirement — a filled field the user cannot
    // trace is worse than an empty one.
    expect(e!.drawings.length).toBeGreaterThan(0);
    expect(e!.drawings[0]).toMatch(/Assembly\.pdf$/);
  });

  it('returns null for a motor with no published drawing', async () => {
    expect(await nozzleForMotorId('not-a-real-motor-id')).toBeNull();
    expect(await nozzleForMotorId(undefined)).toBeNull();
  });

  it('never returns an EX motor — that is the user’s own file, not a catalogue row', async () => {
    expect(await nozzleForMotorId('ex:loki-k627lr')).toBeNull();
  });

  it('carries the alternative-nozzle note on the motors that have two', async () => {
    // Eric's §6(b) ruling: default to the current one, and tell the user the
    // other exists. The DEFAULT is already the current one — picked by the
    // dated revision block on AeroTech's own sheet — so what the app owes is
    // the note.
    const e = await nozzleForMotorId('5f4294d200023100000001e7'); // I115W-M
    expect(e).not.toBeNull();
    expect(e!.note).toMatch(/two nozzles/i);
    expect(e!.note).toMatch(/check which nozzle is in your reload kit/i);
    // And it defaulted to the current one, not the Medusa.
    expect(e!.exitDiameterM).toBeCloseTo(0.011125, 9);
  });

  it('exposes the database’s own provenance once loaded', async () => {
    expect(nozzleDbMeta()).toBeNull();
    await nozzleForMotorId('5f4294d20002310000000021');
    expect(nozzleDbMeta()?.source).toMatch(/AeroTech/);
    expect(nozzleDbMeta()?.generated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the shipped nozzle data itself', () => {
  const motors = (nozzles as unknown as {
    motors: { motorId: string; exitDiameterM?: number; exitConfidence?: string }[];
  }).motors;

  it('never ships an exit diameter that is not a usable length', async () => {
    // The screen that matters: a zero, negative, NaN or absurd exit would be
    // filled into a user's design automatically and silently change apogee.
    for (const m of motors) {
      if (m.exitDiameterM === undefined) continue;
      expect(Number.isFinite(m.exitDiameterM), m.motorId).toBe(true);
      expect(m.exitDiameterM, m.motorId).toBeGreaterThan(0);
      // 98 mm is the largest case AeroTech publish; an exit wider than the
      // casing means the part number resolved to the wrong drawing.
      expect(m.exitDiameterM, m.motorId).toBeLessThan(0.098);
    }
  });

  it('has no duplicate motor ids, so a lookup cannot be ambiguous', () => {
    const ids = motors.map((m) => m.motorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still covers the count the record claims', async () => {
    // 191 motors with an exit, of 192 rows — the one without is at confidence
    // "none" and must never reach a caller.
    const withExit = motors.filter((m) => typeof m.exitDiameterM === 'number' && m.exitDiameterM > 0);
    expect(withExit.length).toBe(191);
    for (const m of motors) {
      if (m.exitConfidence === 'none') {
        expect(await nozzleForMotorId(m.motorId)).toBeNull();
      }
    }
  });
});
