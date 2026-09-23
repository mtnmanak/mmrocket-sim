/**
 * The manufacturers' own published nozzle exit diameters, looked up by motor.
 *
 * The database is `src/data/nozzles.json`, built by
 * `packages/app/scripts/build-nozzle-db.mjs` from Eric's local copies of two
 * published document sets — AeroTech's (1,074 files, `docs/RCS Schematics`) and
 * Loki Research's (21 reload-kit instruction sheets, `docs/Loki Data`, plus the
 * exit-diameter and commercial-throat tables on their Tech Info page). Both are
 * gitignored and only one machine can rebuild from them, which is why the JSON
 * is a committed artifact and `scripts/check-upstream.mjs` §5 watches it.
 *
 * WHY THIS EXISTS. The nozzle exit area is not decoration: since v0.119 the
 * supersonic models add RASAero's pressure term `A_exit x (101325 - P(h))` to
 * every thrusting stage, so the number moves apogee. It was a field the user
 * had to find, and then fill from a drawing they would have to go and find
 * themselves. On a tester's file the app read an N1000W exit of 2.737 in where
 * AeroTech's drawing says 1.750 — 2.4x the area, and most of why that file
 * over-predicted its flight by nearly 60 %.
 *
 * Eric's ruling, 2026-09-08: fill it in automatically, WITH PROVENANCE. So the
 * lookup returns where the number came from as well as the number, and the
 * panel shows both — a filled field the user cannot trace is worse than an
 * empty one, because it looks like their own input.
 *
 * The file is ~345 kB and lazy-loaded: nothing here is needed until a motor is
 * assigned, and the entry chunk should not carry it.
 */

import { getExMotor } from './exMotors.js';

/** One motor's published nozzle, as the panel needs it. */
export interface NozzleEntry {
  motorId: string;
  designation: string;
  /**
   * WHOSE published figure this is — 'AeroTech' or 'Loki' today. It is in the
   * entry because the panel says it out loud, and until 2026-09-13 the panel
   * said "AeroTech's published figure" unconditionally. That was true while
   * AeroTech were the only source; the moment Loki's 55 motors arrived it would
   * have credited AeroTech with Loki's numbers, which is both wrong and exactly
   * the kind of unfollowable provenance the line exists to prevent.
   */
  manufacturer: string;
  /** Metres. Always finite and > 0 — entries without one are not returned. */
  exitDiameterM: number;
  /** AeroTech's part number for the nozzle itself, e.g. `01500-5`. */
  nozzlePartNo?: string;
  /**
   * How well the reading is supported. `high` is a part number resolved from an
   * assembly drawing to a dimensioned spec page; `medium`/`low` carry a reason
   * in `note`. Anything without a usable exit never reaches a caller.
   */
  confidence: 'high' | 'medium' | 'low';
  /**
   * True when this came out of a motor file the USER imported rather than a
   * manufacturer's published data. The panel must say so: crediting "Klima's
   * published figure" for a number somebody typed into their own .rse is
   * exactly the unfollowable provenance `manufacturer` exists to prevent.
   */
  fromImportedFile?: boolean;
  /**
   * Present when AeroTech publish MORE THAN ONE nozzle for this motor — nine
   * motors do, and the two options for the K1100T differ by 43 % in area.
   *
   * The value above is already the CURRENT one (Eric's ruling: "default to the
   * current motor and make some kind of note to the user that other versions of
   * the motor exist"), chosen by the dated revision block on AeroTech's own
   * sheet. This note is that note — it names the alternative so a flyer holding
   * an older reload kit can tell.
   */
  note?: string;
  /**
   * A caution the MANUFACTURER publishes about this row's own figure — today,
   * Loki's note that a 76 mm exit can be machined out to 2.0 in on request, so
   * the standard figure this database carries may not be the nozzle in the
   * case (Eric's ruling (b), 2026-09-13).
   *
   * Separate from `note`, which is about the database's own ambiguity (two
   * published nozzles for one motor). This one is not an ambiguity: the figure
   * is right for the standard part and the user may hold a different part.
   * Written by the builder with the citation, never assembled in the UI — a
   * component spelling out "Loki AND 76 mm" would put a manufacturer's data
   * where nothing checks it.
   */
  customExitNote?: string;
  /** The published drawings the reading came from, for the provenance line. */
  drawings: string[];
}

interface RawMotor {
  /**
   * OPTIONAL, because the DATA says so (2026-09-14, from review). This was declared
   * `motorId: string` while ten shipped rows carry none — the eight AeroTech parts in no
   * thrustcurve.org catalogue entry, plus two more. `nozzles.json` reaches this file through
   * `as unknown as RawDb`, which casts straight past the real shape, so the declaration was
   * simply a lie the compiler could not see: the runtime guard below reads as dead code, and
   * any future `map.set(m.motorId, …)` or `m.motorId.startsWith(…)` would typecheck clean and
   * throw on the first row without one. Patching the symptom and leaving the type lying is
   * how the NEXT consumer inherits the bug.
   */
  motorId?: string;
  designation: string;
  manufacturer?: string;
  exitDiameterM?: number;
  nozzlePartNo?: string;
  exitConfidence?: string;
  confidenceNote?: string;
  customExitNote?: string;
  provenance?: { assemblyDrawings?: string[] };
}

interface RawDb {
  generated: string;
  source: string;
  motors: RawMotor[];
}

let byMotorId: Map<string, NozzleEntry> | null = null;

function toEntry(m: RawMotor): NozzleEntry | null {
  // A row with no motorId cannot become an entry, because `NozzleEntry.motorId` is the key
  // callers look it up by. The caller already skips these, but with `motorId` now declared
  // OPTIONAL — which is what the data has always been — that guard no longer narrows across
  // this function boundary, and stating it here is what makes the honest type compile instead
  // of being cast away. This is the check the old `motorId: string` lie was hiding.
  if (typeof m.motorId !== 'string' || !m.motorId) return null;
  const d = m.exitDiameterM;
  // A motor row can exist with no usable exit. NINE do in the shipped file (2026-09-23):
  // eight AeroTech rows (see nozzleForMotorId) and Loki's N3800-LW, whose throat is known
  // and whose exit Loki do not publish above 76 mm. (It said "one does" until 2026-09-14,
  // then TEN until v0.133 gave the I65W-PS its exit — the count moves with every rebuild.)
  // Returning it would fill the field with nothing, which is the one outcome
  // worse than leaving it blank.
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
  const c = m.exitConfidence;
  const confidence = c === 'high' || c === 'medium' || c === 'low' ? c : 'low';
  return {
    motorId: m.motorId,
    designation: m.designation,
    // Every row in the shipped file carries one; the fallback is here so a
    // hand-edited or older file names nobody rather than the wrong maker.
    manufacturer: m.manufacturer ?? 'the manufacturer',
    exitDiameterM: d,
    ...(m.nozzlePartNo ? { nozzlePartNo: m.nozzlePartNo } : {}),
    confidence,
    ...(m.confidenceNote ? { note: m.confidenceNote } : {}),
    ...(m.customExitNote ? { customExitNote: m.customExitNote } : {}),
    drawings: m.provenance?.assemblyDrawings ?? [],
  };
}

async function db(): Promise<Map<string, NozzleEntry>> {
  if (!byMotorId) {
    const mod = await import('../data/nozzles.json');
    const raw = mod.default as unknown as RawDb;
    const map = new Map<string, NozzleEntry>();
    for (const m of raw.motors ?? []) {
      // A ROW WITH NO motorId CANNOT BE LOOKED UP, so it must not be inserted.
      // Nine shipped rows have a drawing and an exit but matched no catalogue
      // motor, and `map.set(undefined, e)` put every one of them on the same
      // unreachable key — harmless only because `nozzleForMotorId` returns
      // early on a falsy id, which is a second guard standing in for a missing
      // first one (2026-09-13, from review).
      if (typeof m.motorId !== 'string' || !m.motorId) continue;
      const e = toEntry(m);
      if (e) map.set(e.motorId, e);
    }
    byMotorId = map;
  }
  return byMotorId;
}

/**
 * The published nozzle for this thrustcurve.org motor id, or null.
 *
 * Keyed on `motorId` and NOT on the designation: designations repeat across
 * manufacturers and across a motor's own history, and the database is built
 * against a dated catalogue snapshot. An id that has no row simply has nothing
 * published. Counted off the shipped file on 2026-09-23 (its `coverage`, summed
 * per maker — `withExitDiameter`, never `withNozzleRow`): 222 of AeroTech's 272
 * in-production motors have a figure, and 54 of Loki's 58. EIGHT AeroTech rows
 * exist with no number on purpose: the J615ST aerospike (no exit plane at all),
 * four 29 mm DMS motors whose nozzle is moulded into the case, two on a machined
 * part that states an O.D. and no exit, and one whose sheet says the nozzle was
 * cut shorter than its mould. (This said NINE, counting the I65W-PS Medusa, until
 * v0.133 read its exit off part 01700-1.) Cesaroni publish nothing anyone has
 * found. These figures move with every rebuild; the file's own `coverage` and
 * `gaps` are counted at build time, so check this sentence against them rather
 * than quoting it.
 */
export async function nozzleForMotorId(motorId: string | undefined): Promise<NozzleEntry | null> {
  if (!motorId) return null;
  // An EX motor is never in AeroTech's or Loki's catalogue — but since
  // 2026-09-21 its own .rse may carry an exit diameter, and if it does that is
  // the ONLY nozzle figure that motor will ever have. Before this the number
  // was read past and the builder had to type it back by hand, on a field the
  // app then cleared from under them the next time they changed motors.
  //
  // The entry is synthesised rather than stored: the EX library is the single
  // source of truth for it, so a motor re-imported from a corrected file is
  // corrected here too, with no second copy to go stale. `manufacturer` is the
  // file's own `mfg`, because the panel says whose figure this is out loud and
  // it must never credit AeroTech with a number out of somebody's own file.
  if (motorId.startsWith('ex:')) {
    const ex = getExMotor(motorId);
    const d = ex?.exitDiameterM;
    if (!ex || typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
    return {
      motorId,
      designation: ex.designation,
      manufacturer: ex.realManufacturer || 'your own motor file',
      exitDiameterM: d,
      // 'low' is the honest grade: a catalogue 'high' means a part number
      // traced to a dimensioned drawing, and a value typed into a motor file
      // by its author has no such chain. The panel shows the note beside it.
      confidence: 'low',
      note: `read from the ${ex.source === 'rse' ? '.rse' : 'motor'} file you imported, not from a manufacturer's drawing`,
      // No drawing chain exists for a file somebody wrote themselves.
      drawings: [],
      fromImportedFile: true,
    };
  }
  return (await db()).get(motorId) ?? null;
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetNozzleDbCache(): void {
  byMotorId = null;
}
