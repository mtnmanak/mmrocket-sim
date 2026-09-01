/**
 * ONE manufacturer naming table for the whole preset pipeline.
 *
 * There were THREE, and two of them disagreed:
 *
 *   - `fetch-component-presets.mjs`   7 entries, key-only (output kept verbatim)
 *   - `apply-preset-corrections.mjs`  the same 7, copied, with a comment saying
 *                                     "keep in lockstep with fetch-…"
 *   - `merge-rocksim-parts.mjs`      18 DIFFERENT entries, and this one really
 *                                     does rewrite the output string
 *
 * The consequence was not theoretical. `merge-rocksim-parts.mjs` was missing
 * `semrocastronautics`, so SEMROC and "SEMROC Astronautics" fell into two
 * different buckets, the rocksim rows never met their desktop-24.12 twins, and
 * six duplicate parts were appended instead of deduped. That is the mechanism
 * behind the owner's 2026-09-01a report that the database "double counts"
 * manufacturers.
 *
 * Two maps, and the distinction matters:
 *   ALIASES  normalised spelling -> the canonical KEY (identity; what dedupes)
 *   DISPLAY  canonical key       -> the string a user READS
 *
 * Keeping them apart is what lets "SEMROC Astronautics" and "SEMROC" dedupe
 * against each other AND print as one name. The old key-only tables did the
 * first and not the second, which is exactly how both spellings shipped.
 */

/** Normalise a manufacturer string to a bare comparison token. */
export const normRaw = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Spelling -> canonical key.
 *
 * Every entry is either a documented trading name of the same company or a
 * punctuation/suffix variant. Merges ruled by the owner 2026-09-01a: SEMROC,
 * LOC, BalsaMachining, Quest, and MRC -> MPC.
 */
export const ALIASES = {
  // — ruled 2026-09-01a —
  semrocastronautics: 'semroc',
  loc: 'locprecision',
  questaerospace: 'quest',
  balsamachiningcom: 'balsamachining',
  bms: 'balsamachining',
  // MRC's two rows are tube couplers built on MPC's own T-25 and T-30 series,
  // and the MRC T-25's outside diameter equals MPC's T-25 coupler exactly.
  // The owner ruled them one company.
  mrc: 'mpc',
  // — pre-existing, carried over from the three tables this replaces —
  publicmissilesltd: 'publicmissiles',
  pml: 'publicmissiles',
  estesindustries: 'estes',
  madcowrocketry: 'madcow',
  giantleaprocketry: 'giantleap',
  sunwardgroupltd: 'sunward',
};

/** Canonical key -> the spelling shown on screen. */
export const DISPLAY = {
  semroc: 'SEMROC',
  locprecision: 'LOC Precision',
  balsamachining: 'BalsaMachining',
  quest: 'Quest',
  mpc: 'MPC',
  publicmissiles: 'Public Missiles',
  estes: 'Estes',
  madcow: 'Madcow',
  giantleap: 'Giant Leap',
  sunward: 'Sunward Group LTD',
  // Cosmetic, for consistency ACROSS THE APP (the owner's phrasing): the parts
  // database spelled it "Aerotech" while the motor database — the same company,
  // on another screen — spells it "AeroTech", which is the company's own
  // styling. Not a merge; there is only one spelling in presets.json.
  aerotech: 'AeroTech',
};

/** The canonical identity key for a manufacturer string. */
export const mfrKey = (s) => {
  const k = normRaw(s);
  return ALIASES[k] ?? k;
};

/** The canonical display spelling, or the original when nothing is known. */
export const mfrDisplay = (s) => DISPLAY[mfrKey(s)] ?? String(s ?? '');

/**
 * A part number reduced to a comparison token.
 *
 * `+` SURVIVES, and that is the whole point. It used to be stripped with the
 * rest of the punctuation, which silently fused part numbers that a
 * manufacturer deliberately distinguishes with it: SEMROC's BT-2+ is a sleeve
 * that slips OVER a BT-2 (its bore clears the smaller tube's outside diameter
 * by 11 thou, measured), and BalsaMachining's CR2+3-F is a different ring from
 * CR23-F. Twenty rows in the catalogue carry one.
 *
 * The consequence was not only cosmetic. This is the INGEST dedupe key as well
 * as the report key, so at regeneration time a real part could be discarded as
 * a duplicate of a different real part. It also made 10 of 36 "duplicate"
 * groups pure artefacts of the key rather than anything wrong with the data.
 */
export const partKey = (partNo) =>
  String(partNo ?? '').toLowerCase().replace(/[^a-z0-9+]+/g, '');

/** Identity for dedupe across sources: kind + manufacturer + part number. */
export const presetKey = (p) => `${p.kind}|${mfrKey(p.manufacturer)}|${partKey(p.partNo)}`;

/**
 * Every normalised spelling that maps to more than one DISPLAY string in a set
 * of rows — i.e. the defect this module exists to prevent, stated as a check.
 * Returns [] when the database is consistent.
 */
export function spellingConflicts(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = mfrKey(r.manufacturer);
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(String(r.manufacturer));
  }
  return [...byKey.entries()]
    .filter(([, spellings]) => spellings.size > 1)
    .map(([k, spellings]) => ({ key: k, spellings: [...spellings].sort() }));
}
