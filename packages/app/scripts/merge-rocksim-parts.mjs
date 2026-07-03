#!/usr/bin/env node
/**
 * Merge RockSim component-library CSVs (docs/materials/*.CSV) into the bundled
 * component-preset database (src/data/presets.json).
 *
 * Policy (project owner, 2026-07-03): OpenRocket data wins. RockSim rows that
 * duplicate an existing preset (same kind + manufacturer + part number, or same
 * kind + manufacturer + all primary dimensions within 2%) are dropped. Rows with
 * the same part number but dimensions differing by >2% are CONFLICTS: the
 * OpenRocket version is kept and the conflict is logged. Everything else is
 * appended with `"source": "rocksim"`.
 *
 * CSV format notes (verified against OpenRocket 24.12
 * info.openrocket.core.preset.loader.* and empirically against known parts):
 *  - Fields never contain commas; naive comma splitting is correct. Double
 *    quotes are Excel-style when balanced but frequently unbalanced/stray, so
 *    quotes are only stripped when they wrap a whole field ("" -> ").
 *  - "Units" column applies to every length in the row: 0 or "in."/"in" =
 *    inches, 1 or "mm" = millimeters, blank/"?" = inches (OpenRocket's
 *    assumption). Checked: Estes BT-20 coupler 16.5 mm ID rows carry 1/mm;
 *    LOC 5.38" style rows carry 0.
 *  - "Mass Units" column: 0 or "oz." = ounces, 1 = pounds, 2 or "g" = grams,
 *    3 = kilograms (RockSim mass-unit codes). Checked: Apogee CR 10-13 paper
 *    ring mass 0.11 with code 2 matches its ~0.12 g geometric mass; Estes
 *    BNC-50K balsa cone mass 0.13 with code 0 matches ~3.7 g (0.13 oz), not
 *    0.13 g. A mass of 0, blank or "?" means "not cataloged" (OpenRocket's
 *    MassColumnParser does the same) and is omitted.
 *  - Nose/transition shape codes (RockSimNoseConeCode): 0=CONICAL, 1=OGIVE,
 *    2=ELLIPSOID (RockSim "parabolic"), 3=ELLIPSOID, 4=POWER, 5=PARABOLIC,
 *    6=HAACK; blank=CONICAL. Thickness 0/blank means a solid (filled) part.
 *
 * Usage: node packages/app/scripts/merge-rocksim-parts.mjs [--dry-run]
 * Also writes docs/testing/rocksim-merge-report-2026-07-03.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const CSV_DIR = path.join(REPO, 'docs', 'materials');
const PRESETS_PATH = path.join(REPO, 'packages', 'app', 'src', 'data', 'presets.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------- units

const IN = 0.0254; // m
const MM = 0.001; // m
const OZ = 0.028349523125; // kg
const LB = 0.45359237; // kg

/** Length unit factor for a row's "Units" cell (meters per unit). */
function lengthFactor(u) {
  const t = (u ?? '').trim().toLowerCase();
  if (t === '' || t === '?' || t === '0' || t.startsWith('in')) return IN;
  if (t === '1' || t.startsWith('mm')) return MM;
  return null; // unknown -> row flagged
}

/** Mass unit factor for a "Mass Units" cell (kg per unit). */
function massFactor(u) {
  const t = (u ?? '').trim().toLowerCase().replace(/\./g, '');
  if (t === '0' || t === 'oz') return OZ;
  if (t === '1' || t === 'lb') return LB;
  if (t === '2' || t === 'g') return 0.001;
  if (t === '3' || t === 'kg') return 1;
  return null;
}

const round6 = (v) => Math.round(v * 1e7) / 1e7;

// ---------------------------------------------------------------- CSV

function parseCsv(file) {
  const text = fs.readFileSync(file, 'latin1');
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((line) =>
      line.split(',').map((f) => {
        let s = f.trim();
        if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
          s = s.slice(1, -1).replace(/""/g, '"');
        }
        return s.trim();
      }),
    );
}

const num = (s) => {
  const t = (s ?? '').trim();
  if (t === '' || t === '?') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
};

// ---------------------------------------------------------------- materials

// RockSim material name (lowercased) -> app built-in material (materials.ts).
// Only clearly-equivalent mappings; anything else is omitted (the CSVs carry
// no density, and most rows have an explicit mass which acts as an override).
const BULK_MAP = {
  balsa: ['Balsa', 170],
  birch: ['Birch', 670],
  fiberglass: ['Fiberglass', 1850],
  'g10 (pml 0.062")': ['Fiberglass', 1850],
  'g10 fiberglass': ['Fiberglass', 1850],
  'kraft phenolic': ['Kraft phenolic', 950],
  'blue tube': ['Blue tube', 1300],
  polycarbonate: ['Polycarbonate (Lexan)', 1200],
  aluminum: ['Aluminum', 2700],
  'aluminum (al)': ['Aluminum', 2700],
  brass: ['Brass', 8600],
  delrin: ['Delrin', 1420],
  'delrin plastic': ['Delrin', 1420],
  styrofoam: ['Styrofoam (generic EPS)', 20],
  maple: ['Maple', 755],
  'maple (hard)': ['Maple', 755],
  polystyrene: ['Polystyrene', 1050],
  'polystyrene ps': ['Polystyrene', 1050],
  plywood: ['Plywood (birch)', 630],
  'aircraft plywood (birch)': ['Plywood (birch)', 630],
  'aircraft plywood (loc)': ['Plywood (birch)', 630],
  paper: ['Paper (office)', 820],
  cardstock: ['Cardboard', 680],
  cardboard: ['Cardboard', 680],
  pvc: ['PVC', 1390],
  'quantum tubing': ['Quantum tubing', 1050],
};

const SURFACE_MAP = {
  'rip stop nylon': ['Ripstop nylon', 0.067],
  'ripstop nylon': ['Ripstop nylon', 0.067],
  '4oz. ripstop nylon': ['Ripstop nylon', 0.067],
  mylar: ['Mylar', 0.021],
  'polyethylene ldpe': ['Polyethylene (thin)', 0.015],
  // Semroc PN-xx rows say 'G10 (PML 0.062")' for a *nylon* chute canopy —
  // obviously bogus source data; the description wins.
  'g10 (pml 0.062")': ['Ripstop nylon', 0.067],
};

const LINE_MAP = {
  '1/16 in. braided nylon': ['Braided nylon (2 mm, 1/16 in)', 0.001],
  // Apogee 29500 carpet string is a light braided line; nearest built-in.
  'carpet string (apogee 29500)': ['Braided nylon (2 mm, 1/16 in)', 0.001],
  // 30 lb test ~ Kevlar thread size 138 (130 N). Name copied exactly
  // (double space) from materials.ts.
  '30 lb. kevlar': ['Kevlar thread 138  (0.4 mm, 1/64 in)', 0.00014808],
};

const unmappedMaterials = new Map(); // name -> count

function mapMaterial(name, table, type) {
  const key = (name ?? '').trim().toLowerCase();
  if (!key || key === 'material') return undefined;
  let hit = table[key];
  // G10 spellings vary ('G10 (PML 0.062")', 'G10 (PML 0.062in)', 'G10
  // fiberglass'); as a BULK material they are all fiberglass laminate.
  if (!hit && type === 'BULK' && key.startsWith('g10')) hit = ['Fiberglass', 1850];
  if (hit) return { name: hit[0], type, density: hit[1] };
  unmappedMaterials.set(name.trim(), (unmappedMaterials.get(name.trim()) ?? 0) + 1);
  return undefined; // no density in the CSVs -> omit entirely (per policy)
}

// ---------------------------------------------------------------- manufacturers

const normMfg = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Aliases observed across the two datasets (normalized form -> canonical key).
const MFG_ALIASES = {
  loc: 'locprecision',
  locprecision: 'locprecision',
  bms: 'balsamachining',
  balsamachining: 'balsamachining',
  balsamachiningcom: 'balsamachining',
  madcow: 'madcow',
  madcowrocketry: 'madcow',
  quest: 'quest',
  questaerospace: 'quest',
  publicmissiles: 'publicmissiles',
  publicmissilesltd: 'publicmissiles',
  pml: 'publicmissiles',
  estes: 'estes',
  estesindustries: 'estes',
  giantleap: 'giantleap',
  giantleaprocketry: 'giantleap',
  sunward: 'sunward',
  sunwardgroupltd: 'sunward',
};

const mfgKey = (s) => {
  const n = normMfg(s);
  return MFG_ALIASES[n] ?? n;
};

const normPart = (s) => (s ?? '').toLowerCase().replace(/[\s-]/g, '');

// ---------------------------------------------------------------- shape

function mapShape(s) {
  const t = (s ?? '').trim().toLowerCase();
  const codes = { 0: 'CONICAL', 1: 'OGIVE', 2: 'ELLIPSOID', 3: 'ELLIPSOID', 4: 'POWER', 5: 'PARABOLIC', 6: 'HAACK' };
  if (t in codes) return codes[t];
  if (t === '' || t === 'conical' || t === 'cone' || t === 'conic') return 'CONICAL';
  if (t === 'ogive') return 'OGIVE';
  if (t === 'elliptical') return 'ELLIPSOID';
  if (t === 'parabolic') return 'PARABOLIC';
  if (t === 'sears-haack') return 'HAACK';
  if (t === 'power-series' || t === 'ps') return 'POWER';
  return undefined;
}

// ---------------------------------------------------------------- file specs

// Column indices are 0-based; verified against each file's header row and
// against OpenRocket's loader column names.
const FILES = [
  {
    file: 'Body_tubeDATA.CSV', kind: 'BodyTube',
    // Mfg, Part, Desc, Units, ID, OD, Length, Material, Engine, MassUnits, Mass
    parse: (r, f) => ({
      insideDiameter: dim(r[4], f), outsideDiameter: dim(r[5], f), length: dim(r[6], f),
      material: mapMaterial(r[7], BULK_MAP, 'BULK'), mass: massOf(r[10], r[9]),
    }),
  },
  {
    file: 'BulkheadDATA.CSV', kind: 'BulkHead',
    // Mfg, Part, Desc, Units, ID, OD, Length, Material, CG, CG Units, Mass, Autosize
    parse: (r, f) => ({
      outsideDiameter: dim(r[5], f), length: dim(r[6], f),
      material: mapMaterial(r[7], BULK_MAP, 'BULK'), mass: massOf(r[10], r[9]),
    }),
  },
  {
    file: 'CRDATA.CSV', kind: 'CenteringRing',
    // Mfg, Part, Desc, Units, ID, OD, Length, Material, CG, MassUnits, Mass, AutoSize
    parse: (r, f) => ({
      insideDiameter: dim(r[4], f), outsideDiameter: dim(r[5], f), length: dim(r[6], f),
      material: mapMaterial(r[7], BULK_MAP, 'BULK'), mass: massOf(r[10], r[9]),
    }),
  },
  {
    file: 'EBDATA.CSV', kind: 'EngineBlock',
    parse: (r, f) => ({
      insideDiameter: dim(r[4], f), outsideDiameter: dim(r[5], f), length: dim(r[6], f),
      material: mapMaterial(r[7], BULK_MAP, 'BULK'), mass: massOf(r[10], r[9]),
    }),
  },
  {
    file: 'LaunchLugDATA.CSV', kind: 'LaunchLug',
    // Mfg, Part, Desc, Units, ID, OD, Length, Material, CG Loc, MassUnits, Mass
    parse: (r, f) => ({
      insideDiameter: dim(r[4], f), outsideDiameter: dim(r[5], f), length: dim(r[6], f),
      material: mapMaterial(r[7], BULK_MAP, 'BULK'), mass: massOf(r[10], r[9]),
    }),
  },
  {
    file: 'TubeCouplerDATA.CSV', kind: 'TubeCoupler',
    // Header says "Mass Units,CG,Mass" but the data is actually CG, unit
    // string (always "g"), Mass — verified against ARR couplers whose CG cell
    // is half the row's length.
    parse: (r, f) => ({
      insideDiameter: dim(r[4], f), outsideDiameter: dim(r[5], f), length: dim(r[6], f),
      material: mapMaterial(r[7], BULK_MAP, 'BULK'), mass: massOf(r[10], r[9]),
    }),
  },
  {
    file: 'NoseconeDATA.CSV', kind: 'NoseCone',
    // Mfg, Part, Desc, Units, Length, Outer Dia, L/D, Insert Length, Insert OD,
    // Thickness, Shape, Config, Material, CG Loc, Mass Units, Mass, Base Ext
    parse: (r, f) => {
      const p = {
        length: dim(r[4], f), outsideDiameter: dim(r[5], f),
        shoulderLength: dim(r[7], f), shoulderDiameter: dim(r[8], f),
        shape: mapShape(r[10]),
        material: mapMaterial(r[12], BULK_MAP, 'BULK'), mass: massOf(r[15], r[14]),
      };
      const th = dim(r[9], f);
      if (th === undefined || th === 0) p.filled = true; else p.thickness = th;
      return p;
    },
  },
  {
    file: 'TransitionDATA.CSV', kind: 'Transition',
    // Mfg, Part, Desc, Units, Front Insert Len, Front Insert OD, Front OD,
    // Length, Rear OD, Core Dia, Rear Insert Len, Rear Insert OD, Thickness,
    // Config, Material, CG Loc, Mass Units, Mass, Shape, ...
    parse: (r, f) => {
      const p = {
        foreShoulderLength: dim(r[4], f), foreShoulderDiameter: dim(r[5], f),
        foreOutsideDiameter: dim(r[6], f), length: dim(r[7], f),
        aftOutsideDiameter: dim(r[8], f),
        aftShoulderLength: dim(r[10], f), aftShoulderDiameter: dim(r[11], f),
        shape: mapShape(r[18]),
        material: mapMaterial(r[14], BULK_MAP, 'BULK'), mass: massOf(r[17], r[16]),
      };
      const th = dim(r[12], f);
      if (th === undefined || th === 0) p.filled = true; else p.thickness = th;
      return p;
    },
  },
  {
    file: 'ParachuteDATA.CSV', kind: 'Parachute',
    // Mfg, Part, Desc, Units, n sides, OD, ID, Shroud Count, Shroud Len,
    // Shroud Material, Chute Thickness, Chute Material, Mass Units, Mass, CG, Cd
    parse: (r, f) => ({
      sides: num(r[4]) || undefined,
      diameter: dim(r[5], f),
      lineCount: num(r[7]) || undefined,
      lineLength: dim(r[8], f),
      lineMaterial: mapMaterial(r[9], LINE_MAP, 'LINE'),
      material: mapMaterial(r[11], SURFACE_MAP, 'SURFACE'),
      mass: massOf(r[13], r[12]),
    }),
  },
  {
    file: 'StreamerDATA.CSV', kind: 'Streamer',
    // Mfg, Part, Desc, Units, Length, Width, Thickness, Count, Material
    // (+ optional trailing CG, mass-unit string, Mass on 12-column rows)
    parse: (r, f) => ({
      length: dim(r[4], f), width: dim(r[5], f), thickness: dim(r[6], f) || undefined,
      material: mapMaterial(r[8], SURFACE_MAP, 'SURFACE'),
      mass: r.length >= 12 ? massOf(r[11], r[10]) : undefined,
    }),
  },
];

const SKIPPED_FILES = ['FinsDATA.CSV', 'FinsDATA1.CSV', 'Fins3DATA.CSV', 'MotorRetainerDATA.CSV', 'GRAPHS.CSV'];

// Primary dimensions per kind, used for dimension-based dedup and conflicts.
const PRIMARY_DIMS = {
  BodyTube: ['insideDiameter', 'outsideDiameter', 'length'],
  TubeCoupler: ['insideDiameter', 'outsideDiameter', 'length'],
  EngineBlock: ['insideDiameter', 'outsideDiameter', 'length'],
  CenteringRing: ['insideDiameter', 'outsideDiameter', 'length'],
  LaunchLug: ['insideDiameter', 'outsideDiameter', 'length'],
  BulkHead: ['outsideDiameter', 'length'],
  NoseCone: ['outsideDiameter', 'length'],
  Transition: ['foreOutsideDiameter', 'aftOutsideDiameter', 'length'],
  Parachute: ['diameter', 'lineCount'],
  Streamer: ['length', 'width'],
};

// Per-row helpers bound to the row's length factor.
function dim(cell, factor) {
  const v = num(cell);
  if (v === undefined) return undefined;
  const m = round6(v * factor);
  return m === 0 ? undefined : m;
}

function massOf(massCell, unitCell) {
  const v = num(massCell);
  if (v === undefined || v === 0) return undefined;
  const f = massFactor(unitCell);
  if (f === null) return undefined;
  return round6(v * f);
}

const close = (a, b, tol = 0.02) =>
  Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b));

// ---------------------------------------------------------------- main

const db = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));

// Index existing presets by kind|mfgKey; remember canonical display names.
const existingIndex = new Map();
const displayName = new Map();
for (const p of db.presets) {
  const key = `${p.kind}|${mfgKey(p.manufacturer)}`;
  if (!existingIndex.has(key)) existingIndex.set(key, []);
  existingIndex.get(key).push(p);
  const mk = mfgKey(p.manufacturer);
  if (!displayName.has(mk)) displayName.set(mk, p.manufacturer);
}

const report = {
  perFile: {},
  conflicts: [],
  duplicatesByDims: [],
  suspiciousMasses: [],
  added: [],
  badRows: [],
};

const newPresets = [];
const addedIndex = new Map(); // intra-run dedup: kind|mfgKey|normPart|dims

for (const spec of FILES) {
  const rows = parseCsv(path.join(CSV_DIR, spec.file));
  const stats = { parsed: 0, skipped: 0, duplicates: 0, conflicts: 0, added: 0 };
  report.perFile[spec.file] = stats;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const manufacturer = (r[0] ?? '').trim();
    // Some rows (ProLine CRs, Madcow fiberglass couplers/cones) have no part
    // number but a perfectly good description — the description IS the
    // catalog identifier there, so use it.
    const partNo = (r[1] ?? '').trim() || (r[2] ?? '').trim();
    const factor = lengthFactor(r[3]);
    if (partNo.toLowerCase() === 'test') {
      stats.skipped++;
      report.badRows.push(`${spec.file} line ${i + 1}: ${manufacturer} "${partNo}" (test row in source data)`);
      continue;
    }
    if (!manufacturer || !partNo || r.length < 7 || factor === null) {
      stats.skipped++;
      report.badRows.push(`${spec.file} line ${i + 1}: ${JSON.stringify(r.slice(0, 4))} (missing mfg/partNo or bad units)`);
      continue;
    }
    stats.parsed++;

    const fields = spec.parse(r, factor);
    const dims = PRIMARY_DIMS[spec.kind];
    if (!dims.some((d) => typeof fields[d] === 'number' && fields[d] > 0)) {
      stats.skipped++;
      stats.parsed--;
      report.badRows.push(`${spec.file} line ${i + 1}: ${manufacturer} ${partNo} (no usable dimensions)`);
      continue;
    }

    const key = `${spec.kind}|${mfgKey(manufacturer)}`;
    const candidates = existingIndex.get(key) ?? [];
    const npart = normPart(partNo);

    // 1. Same part number?
    const samePart = candidates.find((p) => normPart(p.partNo) === npart);
    if (samePart) {
      const comparable = dims.filter(
        (d) => typeof fields[d] === 'number' && typeof samePart[d] === 'number',
      );
      const mismatched = comparable.filter((d) => !close(fields[d], samePart[d]));
      if (mismatched.length === 0) {
        stats.duplicates++;
      } else {
        stats.conflicts++;
        report.conflicts.push({
          kind: spec.kind, manufacturer, partNo,
          fields: mismatched.map((d) => ({ dim: d, openrocket: samePart[d], rocksim: fields[d] })),
        });
      }
      continue;
    }

    // 2. Same dimensions under a different part number? (>=2 comparable dims)
    const dimDup = candidates.find((p) => {
      const comparable = dims.filter(
        (d) => typeof fields[d] === 'number' && typeof p[d] === 'number',
      );
      return comparable.length >= 2 && comparable.every((d) => close(fields[d], p[d]));
    });
    if (dimDup) {
      stats.duplicates++;
      report.duplicatesByDims.push(
        `${spec.kind} ${manufacturer} ${partNo} == existing ${dimDup.manufacturer} ${dimDup.partNo}`,
      );
      continue;
    }

    // 3. Intra-run dedup: the RockSim files repeat parts — identical rows,
    // and rows re-listed with the catalog description shuffled into the
    // part-number column (or vice versa). A row is a duplicate if a
    // previously added row of this kind+manufacturer has the same primary
    // dimensions AND shares an identifier (part number or description).
    const dimSig = dims.map((d) => fields[d] ?? '').join('|');
    const ids = [...new Set([npart, normPart(r[2])].filter(Boolean))];
    const sigs = ids.map((id) => `${key}|${id}|${dimSig}`);
    if (sigs.some((s) => addedIndex.has(s))) {
      stats.duplicates++;
      continue;
    }
    for (const s of sigs) addedIndex.set(s, true);

    // Build the preset (existing display name wins so UI grouping stays clean).
    const preset = {
      kind: spec.kind,
      manufacturer: displayName.get(mfgKey(manufacturer)) ?? manufacturer,
      partNo,
      description: (r[2] ?? '').trim() || partNo,
    };
    if (fields.material) preset.material = fields.material;
    if (fields.lineMaterial) preset.lineMaterial = fields.lineMaterial;
    if (fields.mass !== undefined) preset.mass = fields.mass;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'material' || k === 'lineMaterial' || k === 'mass') continue;
      if (v !== undefined && v !== null) preset[k] = v;
    }
    preset.source = 'rocksim';

    // Mass plausibility check for simple tube/disc geometries.
    if (preset.mass && preset.material?.type === 'BULK') {
      let vol;
      const { insideDiameter: id = 0, outsideDiameter: od, length: len } = preset;
      if (['BodyTube', 'TubeCoupler', 'EngineBlock', 'CenteringRing', 'LaunchLug'].includes(spec.kind) && od && len) {
        vol = (Math.PI / 4) * (od * od - id * id) * len;
      } else if (spec.kind === 'BulkHead' && od && len) {
        vol = (Math.PI / 4) * od * od * len;
      }
      if (vol) {
        const geo = vol * preset.material.density;
        const ratio = preset.mass / geo;
        if (ratio > 8 || ratio < 1 / 8) {
          report.suspiciousMasses.push(
            `${spec.kind} ${manufacturer} ${partNo}: catalog ${(preset.mass * 1000).toFixed(2)} g vs geometric ~${(geo * 1000).toFixed(2)} g (${preset.material.name})`,
          );
        }
      }
    }

    newPresets.push(preset);
    report.added.push(`${spec.kind} ${preset.manufacturer} ${partNo}`);
    stats.added++;
  }
}

// ---------------------------------------------------------------- write

if (!DRY_RUN) {
  db.presets.push(...newPresets);
  db.count = db.presets.length;
  fs.writeFileSync(PRESETS_PATH, JSON.stringify(db, null, 1) + '\n', 'utf8');
}

// ---------------------------------------------------------------- summary

let totalParsed = 0, totalSkipped = 0, totalDup = 0, totalConf = 0, totalAdded = 0;
console.log('file                      parsed skipped duplicates conflicts added');
for (const [f, s] of Object.entries(report.perFile)) {
  console.log(
    f.padEnd(26) + String(s.parsed).padStart(6) + String(s.skipped).padStart(8) +
    String(s.duplicates).padStart(11) + String(s.conflicts).padStart(10) + String(s.added).padStart(6),
  );
  totalParsed += s.parsed; totalSkipped += s.skipped; totalDup += s.duplicates;
  totalConf += s.conflicts; totalAdded += s.added;
}
console.log('TOTAL'.padEnd(26) + String(totalParsed).padStart(6) + String(totalSkipped).padStart(8) +
  String(totalDup).padStart(11) + String(totalConf).padStart(10) + String(totalAdded).padStart(6));
console.log(`\nSkipped files (no preset kind in our DB): ${SKIPPED_FILES.join(', ')}`);
console.log(`Unmapped RockSim materials (presets emitted without material): ${
  [...unmappedMaterials.entries()].map(([n, c]) => `${n} (${c})`).join(', ') || 'none'}`);
if (report.suspiciousMasses.length) {
  console.log('\nSuspicious masses:');
  for (const s of report.suspiciousMasses) console.log('  ' + s);
}
console.log(`\nPreset count: ${db.count}${DRY_RUN ? ' (dry run, not written)' : ''}`);

// Optional machine-readable dump: --json <path>
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
  fs.writeFileSync(
    process.argv[jsonIdx + 1],
    JSON.stringify({ ...report, skippedFiles: SKIPPED_FILES, unmapped: [...unmappedMaterials.entries()] }, null, 2),
  );
}
