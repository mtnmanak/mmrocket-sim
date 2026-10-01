import { beforeEach, describe, expect, it } from 'vitest';
import { nozzleForMotorId, resetNozzleDbCache } from './nozzleDb.js';
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

  it('fills the motors whose drawing is filed under another name, or in another folder', async () => {
    // Board Tier 1 row 13 (2026-10-01). All three loaded with a blank nozzle field:
    // H219T's DMS sheet is filed as H218T-14A.pdf, J1265T is AeroTech's J1265ST-14A,
    // and L1365M's nozzle is named only in its reload kit's instruction sheet.
    for (const [motorId, designation, partNo, exitIn] of [
      ['5f4294d2000231000000044e', 'H219T', '01500-5', 0.438],
      ['63bb65281d26f30004b4b07b', 'J1265T', '01670-7', 1.25],
      ['5f4294d200023100000003fc', 'L1365M', '01770', 1.875],
    ] as const) {
      const e = await nozzleForMotorId(motorId);
      expect(e, designation).not.toBeNull();
      expect(e!.nozzlePartNo, designation).toBe(partNo);
      expect(e!.exitDiameterM, designation).toBeCloseTo(exitIn * 0.0254, 6);
      expect(e!.confidence, designation).toBe('high');
      expect(e!.drawings.length, designation).toBeGreaterThan(0);
    }
  });

  it('ships the database’s own provenance', () => {
    // Read off the file itself: the accessor that carried it (nozzleDbMeta)
    // had no production caller and went (audit 2026-09-22, Dead code row 575).
    const { source, generated } = nozzles as unknown as { source: string; generated: string };
    expect(source).toMatch(/AeroTech/);
    expect(generated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the shipped nozzle data itself', () => {
  const { motors, counts, coverage } = nozzles as unknown as {
    // `motorId` is optional because the data says so: some rows match no catalogue motor.
    motors: { motorId?: string; manufacturer: string; exitDiameterM?: number; exitConfidence?: string }[];
    counts: {
      motorsWithExit: number;
      motorsLoadableWithExit: number;
      aerotechMatchedInProduction: number;
      lokiMatchedInProduction: number;
    };
    coverage: {
      byManufacturer: Record<string, {
        byCasingDiameterMm: Record<string, { inProduction: number; withNozzleRow: number; withExitDiameter: number }>;
      }>;
    };
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

  it('counts the motors you can load and get a figure for exactly as the lookup serves them', async () => {
    // THE COUNT v0.133 SAID "CANNOT DRIFT AGAIN" (board Tier 1 row 17). The builder
    // writes `counts.motorsLoadableWithExit` - a row a user can reach needs BOTH a
    // catalogue id and an exit - and until this test nothing read it back: the only
    // two places it appeared were the line that writes it and the value it wrote,
    // while the guide typed the same figure by hand. It is held here to the rows the
    // way `motorsWithExit` is held above, and through the app's own lookup rather
    // than a second filter, so it counts what a user actually gets.
    const served = new Set<string>();
    for (const m of motors) {
      if (m.motorId && (await nozzleForMotorId(m.motorId))) served.add(m.motorId);
    }
    expect(served.size).toBe(counts.motorsLoadableWithExit);
    // Rows are not motors: a row with no catalogue id can carry an exit a user can
    // never load, so this figure must stay below the all-rows one.
    expect(counts.motorsLoadableWithExit).toBeLessThan(counts.motorsWithExit);
  });

  it('states coverage that agrees with its own summary counts', () => {
    // `coverage` (per maker, per casing) and `counts` are two summaries of one build
    // against one catalogue, so they cannot legitimately disagree. In-production rows
    // with an exit are a subset of the loadable ones, which also counts the
    // out-of-production motors a user can still load (three today).
    const sum = (maker: string, key: 'withNozzleRow' | 'withExitDiameter') =>
      Object.values(coverage.byManufacturer[maker]!.byCasingDiameterMm).reduce((s, e) => s + e[key], 0);
    expect(sum('AeroTech', 'withNozzleRow')).toBe(counts.aerotechMatchedInProduction);
    expect(sum('Loki', 'withNozzleRow')).toBe(counts.lokiMatchedInProduction);
    expect(sum('AeroTech', 'withExitDiameter') + sum('Loki', 'withExitDiameter'))
      .toBeLessThanOrEqual(counts.motorsLoadableWithExit);
  });
});
