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
  const { motors, counts } = nozzles as unknown as {
    motors: { motorId: string; exitDiameterM?: number; exitConfidence?: string }[];
    counts: { motorsWithExit: number };
  };

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
    // ROWS WITHOUT AN ID ARE NOT DUPLICATES OF EACH OTHER (2026-09-13). This
    // read `new Set(motors.map(m => m.motorId)).size === motors.length`, and
    // every row that matched NO catalogue motor carries `motorId: undefined` —
    // so a Set collapsed all of them into one entry and the count came up
    // short. It passed for two months because there was exactly ONE such row
    // (AeroTech I59N-P, which has a drawing and no catalogue entry); adding the
    // DMS drawings took it to ten and the test failed with "expected 288 to be
    // 297", which says nothing at all about duplicate ids.
    //
    // What the check is FOR is the lookup: `nozzleForMotorId` keys a Map by
    // motorId, so two rows sharing one id would make the answer depend on
    // insertion order. Only rows that HAVE an id can do that.
    const ids = motors.map((m) => m.motorId).filter((id): id is string => typeof id === 'string');
    const seen = new Map<string, number>();
    for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(dupes, `these motorIds appear on more than one row: ${dupes.join(', ')}`).toEqual([]);
    // And the check is not vacuous: most rows do carry an id.
    expect(ids.length).toBeGreaterThan(motors.length / 2);
  });

  it('still covers the count the record claims', async () => {
    // AGAINST THE FILE'S OWN COUNT, not against a number typed here
    // (2026-09-13). This read `toBe(191)` — the figure on the day it was
    // written — so the first legitimate regeneration broke it: adding Loki's
    // 55 motors took it to 246 and the failure said nothing about whether the
    // data was right, only that it had changed. `counts.motorsWithExit` is
    // computed by the builder from the rows it just wrote, so comparing the
    // two catches the thing a pin cannot: a file whose summary and whose rows
    // disagree, which is what a half-finished hand edit looks like.
    const withExit = motors.filter((m) => typeof m.exitDiameterM === 'number' && m.exitDiameterM > 0);
    expect(withExit.length).toBe(counts.motorsWithExit);
    // And it is not vacuous: the database has to be substantial, or an empty
    // file would agree with its own empty summary.
    expect(withExit.length).toBeGreaterThan(200);
    // A row at confidence "none" has no usable exit and must never reach a
    // caller — filling the field with nothing is the one outcome worse than
    // leaving it blank.
    for (const m of motors) {
      if (m.exitConfidence === 'none') {
        expect(await nozzleForMotorId(m.motorId)).toBeNull();
      }
    }
  });
});
