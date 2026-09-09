/**
 * AeroTech's own published nozzle exit diameters, looked up by motor.
 *
 * The database is `src/data/nozzles.json`, built by
 * `packages/app/scripts/build-nozzle-db.mjs` from Eric's local copy of
 * AeroTech's published document set (1,074 files, `docs/RCS Schematics`,
 * gitignored — only one machine can rebuild it, which is why the JSON is a
 * committed artifact and `scripts/check-upstream.mjs` §5 watches it).
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
 * The file is ~237 kB and lazy-loaded: nothing here is needed until a motor is
 * assigned, and the entry chunk should not carry it.
 */

/** One motor's published nozzle, as the panel needs it. */
export interface NozzleEntry {
  motorId: string;
  designation: string;
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
  /** The published drawings the reading came from, for the provenance line. */
  drawings: string[];
}

interface RawMotor {
  motorId: string;
  designation: string;
  exitDiameterM?: number;
  nozzlePartNo?: string;
  exitConfidence?: string;
  confidenceNote?: string;
  provenance?: { assemblyDrawings?: string[] };
}

interface RawDb {
  generated: string;
  source: string;
  motors: RawMotor[];
}

let byMotorId: Map<string, NozzleEntry> | null = null;
let meta: { generated: string; source: string } | null = null;

function toEntry(m: RawMotor): NozzleEntry | null {
  const d = m.exitDiameterM;
  // A motor row can exist with no usable exit (one does, at confidence "none").
  // Returning it would fill the field with nothing, which is the one outcome
  // worse than leaving it blank.
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
  const c = m.exitConfidence;
  const confidence = c === 'high' || c === 'medium' || c === 'low' ? c : 'low';
  return {
    motorId: m.motorId,
    designation: m.designation,
    exitDiameterM: d,
    ...(m.nozzlePartNo ? { nozzlePartNo: m.nozzlePartNo } : {}),
    confidence,
    ...(m.confidenceNote ? { note: m.confidenceNote } : {}),
    drawings: m.provenance?.assemblyDrawings ?? [],
  };
}

async function db(): Promise<Map<string, NozzleEntry>> {
  if (!byMotorId) {
    const mod = await import('../data/nozzles.json');
    const raw = mod.default as unknown as RawDb;
    meta = { generated: raw.generated, source: raw.source };
    const map = new Map<string, NozzleEntry>();
    for (const m of raw.motors ?? []) {
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
 * against a dated catalogue snapshot. An id that has no row simply has no
 * published drawing — 189 of AeroTech's 272 in-production motors do, and
 * nothing else does at all (Loki and Cesaroni publish none; see the file's own
 * `gaps`).
 */
export async function nozzleForMotorId(motorId: string | undefined): Promise<NozzleEntry | null> {
  if (!motorId) return null;
  // An EX motor is the user's own file, never AeroTech's catalogue.
  if (motorId.startsWith('ex:')) return null;
  return (await db()).get(motorId) ?? null;
}

/** Where the database came from, for the provenance line. Null until loaded. */
export function nozzleDbMeta(): { generated: string; source: string } | null {
  return meta;
}

/** Test seam — the module-level cache would otherwise leak between cases. */
export function resetNozzleDbCache(): void {
  byMotorId = null;
  meta = null;
}
