/**
 * Regenerates src/data/nozzles.json — commercial motor NOZZLE geometry, keyed
 * to the bundled motor catalogue.
 *
 * Usage: node packages/app/scripts/build-nozzle-db.mjs [--source "<folder>"] [--report]
 *
 * WHY THIS EXISTS (2026-09-08). v0.119 added RASAero's pressure-thrust term,
 * F(h) = F_curve(t) + A_exit x (101,325 - P(h)). A_exit is the stage's nozzle
 * exit AREA, and until now the only way to supply it was for the user to type
 * a diameter nobody publishes in a form a simulator can read. Measured on
 * MESOS, that term is worth +75 % of apogee; the nozzle's base-drag half is
 * worth another +12 %. So the number matters, and a user guessing it is a
 * large error in a safety number. AeroTech publish the number — spread across
 * 324 assembly drawings and 33 store pages — so this script reads them.
 *
 * WHERE THE DATA COMES FROM. `docs/RCS Schematics`, AeroTech/RCS's complete
 * published document set (1,074 files), downloaded by the owner on
 * 2026-09-08. That folder is LOCAL-ONLY and gitignored, exactly like the rest
 * of `docs/`, so THIS SCRIPT CANNOT RUN IN CI. nozzles.json is a committed
 * artifact, the same arrangement as packages/engine/vendor/orkengine.mjs: the
 * build output is in the repo, the inputs are not.
 *
 * THE JOIN, in one line:
 *   assembly drawing -> nozzle part number -> exit diameter -> motors.json id
 *
 * THE RULE THE WHOLE THING RESTS ON, and it is AeroTech's own, printed on 14
 * of the 23 nozzle drawing files: "DASH NUMBERS INDICATE IN-HOUSE MACHINING OF
 * THROAT DIAMETER". A part like 01880-4 is a base 01880 whose THROAT has been
 * drilled out; the moulded EXIT is untouched. So one exit diameter serves
 * every dash number of a base part, and the throat is read per motor from its
 * own drawing.
 *
 * AND THE EXCEPTION, which is why the resolution order below is what it is.
 * The 98 mm 01800 family has a SECOND MOULD. `rcs_018003_nozzle_dwg.pdf` says
 * in its own note 2: "SAME AS RCS P/N 01800 KLMN NOZZLE EXCEPT AS NOTED FOR
 * THROAT, ENTRANCE, AND EXIT DIMENSIONS", and its title block reads "WITH
 * 1.750" EXIT". Base 01800 exits at 0.900 in; 01800-3, -3M, -4(M), -5(M),
 * -6(M) and 01800M-1 all exit at 1.750 in. Applying the dash rule blindly
 * would have given six 98 mm motors an exit 48 % too small in diameter — a
 * factor of 3.8 in AREA, which is the whole of the pressure-thrust term. That
 * is the reason every row records WHICH source gave its exit, and the reason
 * a part-specific source always outranks the base part's.
 *
 * PDF EXTRACTION IS PYTHON. `extract-nozzle-pdfs.py` beside this file reads the
 * drawings with PyMuPDF and emits raw JSON; this script does every judgement.
 * The repo has no JS PDF library and the house rule forbids adding an app
 * dependency, so the extractor is the one Python file in the pipeline and it
 * is deliberately dumb — it reports what is on the page and decides nothing.
 *
 * CONVENTIONS. Output is SI (metres) because the app is SI internally; each
 * row also keeps the source's own inch figure, because that is the number a
 * reader can check against the drawing. Rows are sorted deterministically so a
 * regeneration diffs cleanly. Provenance is mandatory on every row.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'src', 'data', 'nozzles.json');
const MOTORS = join(here, '..', 'src', 'data', 'motors.json');
const EXTRACTOR = join(here, 'extract-nozzle-pdfs.py');

const IN_PER_M = 39.3700787401575;
const inToM = (v) => v / IN_PER_M;
/** Six decimal places of a metre is a micron — finer than any drawing tolerance. */
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- the source

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REPORT = argv.includes('--report');
const source = flag('--source') ?? process.env.RCS_SCHEMATICS
  ?? join(here, '..', '..', '..', 'docs', 'RCS Schematics');
if (!existsSync(source)) {
  console.error(`No RCS document set at ${source}.`);
  console.error('It is LOCAL-ONLY (docs/ is gitignored). Pass --source "<folder>" or set RCS_SCHEMATICS.');
  process.exit(1);
}

const python = process.env.PYTHON ?? 'python';
const raw = JSON.parse(execFileSync(python, [EXTRACTOR, source], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}));

// ------------------------------------------------------- reading a spec page

/**
 * A store page's Summary paragraph, e.g.
 *   "Molded glass/phenolic nozzle for 98mm diameter motors. Dimensions:
 *    3.619" O.D. 1.000" diameter throat 2.737" diameter exit Weight = 549 grams"
 * and, for the multi-throat parts,
 *   "... 0.192" diameter center throat 0.500" diameter center exit
 *    0.125" diameter plugged outer throats x 6 0.375" diameter outer exits x 6"
 * and, for the three Enerjet parts, a "Throat diameter: 0.13"" list form.
 *
 * Everything here is a labelled number lifted verbatim. Nothing is derived.
 */
function readSpecPage(page) {
  const s = page.summary ?? '';
  const num = (re) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : undefined;
  };
  const centerThroat = num(/([\d.]+)"\s*diameter center throat/i);
  const centerExit = num(/([\d.]+)"\s*diameter center exit/i);
  const outerThroat = num(/([\d.]+)"\s*diameter (?:plugged )?outer throats?\s*x\s*(\d+)/i);
  const outerExit = num(/([\d.]+)"\s*diameter outer exits?\s*x\s*(\d+)/i);
  const outerCount = (() => {
    const m = /diameter outer exits?\s*x\s*(\d+)/i.exec(s);
    return m ? Number(m[1]) : undefined;
  })();
  const multi = centerThroat !== undefined && outerExit !== undefined
    ? { centerThroatIn: centerThroat, centerExitIn: centerExit, outerThroatIn: outerThroat, outerExitIn: outerExit, outerCount }
    : undefined;
  return {
    partNo: page.productCode,
    file: page.file,
    title: page.title,
    summary: s,
    odIn: num(/([\d.]+)"\s*O\.?D\.?(?!\s*X)/i) ?? num(/O\.D\.:\s*([\d.]+)"/i),
    // The plain (single-throat) numbers. A Medusa page has none of these; its
    // geometry is in `multi`, and the equivalent diameters are computed later.
    throatIn: num(/([\d.]+)"\s*diameter throat/i) ?? num(/Throat diameter:\s*([\d.]+)"/i),
    exitIn: num(/([\d.]+)"\s*diameter exit/i) ?? num(/Exit diameter:\s*([\d.]+)"/i),
    weightG: num(/Weight\s*(?:=|:)\s*([\d,.]+)\s*grams/i),
    multi,
  };
}

const specByPart = new Map();
for (const page of raw.specPages) {
  if (!page.productCode) continue;
  specByPart.set(page.productCode.toUpperCase(), readSpecPage(page));
}

// --------------------------------------------------- reading a nozzle drawing

/**
 * The part a nozzle drawing is OF. Every RCS title block ends "<part> SCALE
 * n / m", which is exact for 19 of the 23; the four Quest Q-JET inserts print
 * no part in the block, so those fall back to the part number in the filename
 * and are marked as such.
 */
function drawingPart(d) {
  const m = /([A-Z0-9][A-Z0-9-]*)\s+SCALE\s/.exec(d.text);
  if (m && /^(?:0\d{4}|ISP[\dA-Z-]+|Q-[\dA-Z]+)(?:-[\dA-Z]+)?$/.test(m[1])) {
    return { partNo: m[1], fromFilename: false };
  }
  const f = /\((q-\w+|isp[\w-]+|0\d{4}[\w-]*)\)/i.exec(d.file)
    ?? /_(0\d{4})_/.exec(d.file) ?? /[-_](0\d{4})\b/.exec(d.file);
  return f ? { partNo: f[1].toUpperCase(), fromFilename: true } : { partNo: null, fromFilename: false };
}

const drawingByPart = new Map();
for (const d of raw.nozzleDrawings) {
  const { partNo, fromFilename } = drawingPart(d);
  if (!partNo) continue;
  // "KLMN MOLDED NOZZLE, WITH 1.750" EXIT / .734" THROAT" — a title block that
  // states the geometry outright. Only the 01800-3 drawing does, and it is
  // exactly the part the dash rule would otherwise get wrong.
  const titleExit = /([\d.]+)"\s*EXIT/i.exec(d.text);
  const titleThroat = /([\d.]+)"\s*THROAT/i.exec(d.text);
  const rec = {
    file: d.file,
    partNo,
    partFromFilename: fromFilename,
    statesDashNumberRule: d.statesDashNumberRule,
    titleExitIn: titleExit ? Number(titleExit[1]) : undefined,
    titleThroatIn: titleThroat ? Number(titleThroat[1]) : undefined,
    callouts: d.callouts,
    // "01550-1 NOZZLE DRILLED .313"" — the drawing's own dash-number table.
    dashThroatIn: Object.fromEntries(d.dashRows.map(([p, v]) => [p.toUpperCase(), Number(v)])),
  };
  // Two of the drawings are byte-different downloads of the same sheet; keep
  // the first and let the duplicate corroborate rather than overwrite.
  if (!drawingByPart.has(partNo)) drawingByPart.set(partNo, rec);
}

// ------------------------------------------- reading an assembly LOM nozzle row

/**
 * Rows in a LIST OF MATERIAL whose description mentions a nozzle but which are
 * NOT the nozzle: the moulded shipping cap over the throat, the nozzle O-ring,
 * the aft closure that a small nozzle screws into, and the ABS adapter that
 * bonds a 1 in nozzle into a fibreglass case. Without this filter the wrong
 * row wins on 227 of the 324 drawings — every motor with a 04580 nozzle cap.
 */
const NOT_A_NOZZLE = /NOZZLE CAP|^CAP\b|O-RING|AFT CLOSURE|ADAPTER|INSULATOR|CASTING PLUG/i;

/** The nozzle row of one assembly drawing, or null with the reason. */
function nozzleRow(asm) {
  const hits = asm.lomRows.filter((r) => /NOZZLE/i.test(r.desc) && !NOT_A_NOZZLE.test(r.desc));
  if (hits.length === 0) return { row: null, why: 'no LIST OF MATERIAL row names a nozzle' };
  if (hits.length > 1) {
    return { row: null, why: `${hits.length} rows name a nozzle: ${hits.map((h) => h.part).join(', ')}` };
  }
  return { row: hits[0], why: null };
}

/**
 * The throat this MOTOR's nozzle is drilled to, from its own drawing's
 * description. Tried in order, because the sheets say the same thing six ways:
 *   "(1.219" DT DRILLED)"  "(.455" DT UNDRILLED)"  ".844" I.D."  "1.00" THROAT"
 *   ".344" UNDRILLED"  ".413 DRILLED"  "(DT = .484 SHOWN)"  "DRILLED .077""
 *   "UNDRILLED .291""  "SPADED .313""
 * A number in front of DT/THROAT/I.D. is the most explicit label, so it goes
 * first; the bare "DRILLED <n>" form goes last because "DRILLED" also appears
 * with the number in front of it.
 */
function throatFromDescription(desc) {
  const pats = [
    // No trailing \b after I.D. — the character after it is a space, and there
    // is no word boundary between "." and " ", so the six 98 mm rows written
    // '.844" I.D. /1.75" EXIT' silently fell through to the base part's
    // nominal throat until this was caught on 2026-09-08.
    /([\d.]+)"?\s*(?:DT\b|THROAT|I\.D\.)/i,
    /([\d.]+)"?\s*(?:UN)?DRILLED/i,
    /\bDT\s*=\s*([\d.]+)/i,
    /(?:UNDRILLED|DRILLED|SPADED|THROAT)\s*[:=]?\s*([\d.]+)/i,
  ];
  for (const p of pats) {
    const m = p.exec(desc);
    if (m && Number.isFinite(Number(m[1])) && Number(m[1]) > 0) return Number(m[1]);
  }
  return undefined;
}

/** An exit the description states outright, as the 01800 "M" mould rows do. */
function exitFromDescription(desc) {
  const m = /([\d.]+)"?\s*EXIT/i.exec(desc);
  return m ? Number(m[1]) : undefined;
}

/**
 * How many of a Medusa's throats this dash number opens.
 *
 * A Medusa is one centre throat plus six outer throats moulded CLOSED; a dash
 * number drills the centre and, on some parts, some of the outers. Every
 * opened throat flows, so every opened throat's exit contributes to A_exit —
 * which is exactly how the app's own field is defined ("the SINGLE EQUIVALENT
 * nozzle with the exit AREAS added", schema.ts / nozzleCheck.ts). The
 * descriptions write the count five ways:
 *   "1x.297"/ 6x.220""      centre .297, six outers .220
 *   "1 X .228C / 2 x .228M"  C = centre, M = outer ("middle")
 *   "1 X .228C"              centre only
 *   "1C .359" + 3M .297" DT DRILLED"
 *   "4M DRILLED .256""       four outers; the centre keeps its moulded size
 *   "DRILLED .266""          centre only, ASSUMED — see `outerCountAssumed`
 * The last form is the only one that does not state the outer count, and it is
 * read as centre-only because that is the moulded state: the store pages call
 * the outer throats "plugged". Rows resolved that way are marked, never hidden.
 */
function medusaOpening(desc) {
  let m = /1C\s*([\d.]+)"?\s*\+\s*(\d+)M\s*([\d.]+)/i.exec(desc);
  if (m) return { centerThroatIn: Number(m[1]), outerCount: Number(m[2]), outerThroatIn: Number(m[3]) };
  m = /1\s*[xX]\s*([\d.]+)"?C?\s*\/\s*(\d+)\s*[xX]\s*([\d.]+)"?M?/.exec(desc);
  if (m) return { centerThroatIn: Number(m[1]), outerCount: Number(m[2]), outerThroatIn: Number(m[3]) };
  m = /1\s*[xX]\s*([\d.]+)"?C\b/.exec(desc);
  if (m) return { centerThroatIn: Number(m[1]), outerCount: 0 };
  // No `\.?` in front of the capture: the descriptions write ".242" with no
  // leading zero, and a separate optional dot ate it, turning 0.242 in into
  // 242 in and a 12 m throat (caught 2026-09-08 by the report's own numbers).
  m = /(\d+)M\s*DRILLED\s*([\d.]+)/i.exec(desc);
  if (m) return { outerCount: Number(m[1]), outerThroatIn: Number(m[2]) };
  const t = throatFromDescription(desc);
  if (t !== undefined) return { centerThroatIn: t, outerCount: 0, outerCountAssumed: true };
  return null;
}

/** sqrt of a sum of squared diameters — the single equivalent diameter of N holes. */
const equivalent = (...ds) => Math.sqrt(ds.reduce((a, d) => a + d * d, 0));

// -------------------------------------------------------- resolving one part

/**
 * The base part a dash number belongs to. "01880-4" -> "01880",
 * "01800-4(M)" -> "01800", "01800M-1" -> "01800M", "01550-X" -> "01550".
 * The suffix is stripped, never interpreted: which mould a dash number belongs
 * to is decided by EVIDENCE in `resolvePart`, not by the shape of the string.
 */
const basePartNo = (p) => p.replace(/-[\w()]+$/, '');

/**
 * Exit and throat for one nozzle part number, with the source that gave each.
 *
 * ORDER OF EVIDENCE, strongest first. A source that names THIS part always
 * beats one that names only its base — that is what keeps the 01800 second
 * mould out of the base part's 0.900 in exit.
 *   1. a store page for this exact part            (spec-page)
 *   2. this part's own drawing title block         (drawing-title)
 *   3. an assembly LOM description that states it  (assembly-description)
 *   4. the base part's store page + the dash rule  (base-spec-page)
 * Nothing below that: an unlabelled drawing callout is recorded as a
 * cross-check, never promoted to an answer, because the callouts are bare
 * leader-line numbers with no indication of which feature they dimension (the
 * 01800-3 sheet prints both the 1.750 exit and a 2.774 outside diameter).
 */
function resolvePart(partNo, descriptions) {
  const key = partNo.toUpperCase();
  const base = basePartNo(key);
  const exact = specByPart.get(key);
  const baseSpec = specByPart.get(base);
  const drawing = drawingByPart.get(key);
  const baseDrawing = drawingByPart.get(base);

  // A STORE-PAGE TITLE NAMES A THROAT, so it may only be used for the part it
  // is a page FOR (2026-09-08, from review). `exact?.title ?? baseSpec?.title`
  // put "98mm Nozzle, 0.344\" Throat" on 01880-4 (throat 1.219), on 01800-3
  // (0.734, and a different mould entirely) and on 01000-4 (0.073) — a label
  // contradicting the numbers printed beside it, on rows this table exists so
  // that someone can pick a nozzle by part number. The base part's title is
  // still recorded, under a name that says what it is.
  const out = {
    partNo: key,
    basePartNo: base === key ? undefined : base,
    manufacturer: 'AeroTech',
    name: exact?.title ?? undefined,
    basePartName: exact ? undefined : baseSpec?.title ?? undefined,
  };

  // ---- exit
  let exitIn; let exitSource; let confidence;
  const isMedusa = /MEDUSA/i.test(descriptions.join(' ')) || Boolean((exact ?? baseSpec)?.multi);
  if (exact?.exitIn !== undefined) {
    exitIn = exact.exitIn; exitSource = 'spec-page'; confidence = 'high';
  } else if (drawing?.titleExitIn !== undefined) {
    exitIn = drawing.titleExitIn; exitSource = 'drawing-title'; confidence = 'high';
  } else {
    const stated = descriptions.map(exitFromDescription).filter((v) => v !== undefined);
    if (stated.length) {
      exitIn = stated[0]; exitSource = 'assembly-description'; confidence = 'high';
    } else if (isMedusa && (exact?.multi ?? baseSpec?.multi)) {
      // Handled per motor, since the opened-throat count is per dash number.
      exitSource = 'medusa'; confidence = 'per-motor';
    } else if (baseSpec?.exitIn !== undefined) {
      exitIn = baseSpec.exitIn;
      exitSource = 'base-spec-page';
      // AeroTech's own printed rule is what licenses carrying the base exit
      // across a dash number. Where the base drawing does not print it, the
      // inference is still sound but unattested, so it is not called high.
      confidence = baseDrawing?.statesDashNumberRule ? 'high' : 'medium';
    } else {
      exitSource = 'none'; confidence = 'none';
    }
  }
  out.exitDiameterIn = exitIn;
  out.exitSource = exitSource;
  out.exitConfidence = confidence;

  // ---- throat
  //
  // The THROAT is the number a dash number changes, so — unlike the exit — the
  // base part's value is the WEAKEST evidence here, not a safe carry-across.
  // 01880's page says 1.000 in; 01880-4 is drilled to 1.219. Order is therefore
  // exact page, this part's own drawing title, what the assembly sheets that
  // fit this part actually say, the base drawing's dash-number table, and only
  // then the base part's own throat (right for the base part itself, and a
  // stated nominal for anything else).
  const stated = [...new Set(descriptions.map(throatFromDescription).filter((v) => v !== undefined))];
  if (exact?.throatIn !== undefined) {
    out.throatDiameterIn = exact.throatIn; out.throatSource = 'spec-page';
  } else if (drawing?.titleThroatIn !== undefined) {
    out.throatDiameterIn = drawing.titleThroatIn; out.throatSource = 'drawing-title';
  } else if (stated.length === 1) {
    out.throatDiameterIn = stated[0]; out.throatSource = 'assembly-description';
  } else if (baseDrawing?.dashThroatIn?.[key] !== undefined) {
    out.throatDiameterIn = baseDrawing.dashThroatIn[key]; out.throatSource = 'drawing-dash-table';
  } else if (baseSpec?.throatIn !== undefined) {
    out.throatDiameterIn = baseSpec.throatIn; out.throatSource = 'base-spec-page';
  }
  // Two assembly sheets naming the same part with different throats is a fact
  // about AeroTech's paperwork (01800-3 is drilled .500 on one sheet and
  // undrilled .734 on another), so it is recorded rather than averaged away.
  // It costs nothing operationally: each MOTOR takes the throat from its own
  // sheet, and the thrust term uses the exit, not the throat.
  if (stated.length > 1) out.throatVariesAcrossSheets = stated.sort((a, b) => a - b);

  if (exact?.multi ?? baseSpec?.multi) out.medusa = exact?.multi ?? baseSpec?.multi;

  // `drawing` is THIS part's own sheet; the base sheet only stands in for it
  // where the exit actually came from the base mould. It used to fall back
  // unconditionally, which sent a reader following 01800-3M's provenance to
  // `rcs_01800_nozzle_dwg.pdf` — the base sheet whose dash table says ".900
  // De", flatly contradicting that row's 1.750 in. Undefined is better than a
  // pointer at a document that disagrees.
  const baseDrawingApplies = exitSource === 'base-spec-page'
    || (exitIn !== undefined && baseSpec?.exitIn !== undefined && exitIn === baseSpec.exitIn);
  out.provenance = {
    specPage: exact?.file,
    baseSpecPage: exact ? undefined : baseSpec?.file,
    drawing: drawing?.file ?? (baseDrawingApplies ? baseDrawing?.file : undefined),
    dashNumberRuleStatedOnDrawing: baseDrawing?.statesDashNumberRule ?? drawing?.statesDashNumberRule ?? false,
  };

  // A cross-check, not a source: does the drawing print the number the store
  // page claims? Only meaningful when the drawing is OF the mould the exit came
  // from — the base 01800 sheet dimensions the 0.900 in mould and says nothing
  // about the 1.750 in one, so comparing them would manufacture a false alarm.
  const sameMould = drawing ?? (exitSource === 'base-spec-page' ? baseDrawing : undefined);
  if (sameMould?.callouts && exitIn !== undefined) {
    out.exitOnDrawing = sameMould.callouts.some((c) => Math.abs(c - exitIn) <= 0.0015);
  }
  return out;
}

// ------------------------------------------------------ the motor catalogue

const motorsDb = JSON.parse(readFileSync(MOTORS, 'utf8'));
const AEROTECH = motorsDb.motors.filter((m) => m.manufacturerAbbrev === 'AeroTech');
const byMotorId = new Map(motorsDb.motors.map((m) => [m.motorId, m]));

const displayDesignation = (d) => d.replace(/^HP-/i, '');
/** "RMS-98/20480" and the folder "RMS-98-20480 High Power" both reduce to "98-20480". */
const caseKey = (s) => (String(s ?? '').match(/\d+/g) ?? []).join('-');

/**
 * Catalogue designations a drawing filename might mean. AeroTech write the
 * same motor three ways across the two:
 *   "N4000W-PS"  -> N4000W-PS      (delay tag is part of the catalogue name)
 *   "G54W-L"     -> G54W           (delay tag is the reload's, not the motor's)
 *   "D13-10W"    -> D13W           (the delay sits INSIDE the small-motor name)
 *   "C3.4-PT"    -> C3.4T          (plugged; the P is not part of the name)
 *   "G33-5J"     -> G33J, then G33 (some are catalogued with no propellant letter)
 */
function designationCandidates(raw) {
  const out = [raw];
  let m = /^([A-Z]+[\d.]+)-(\d+)([A-Z/]+)$/.exec(raw);
  if (m) { out.push(m[1] + m[3]); out.push(m[1]); }
  m = /^([A-Z]+[\d.]+)-P([A-Z]+)$/.exec(raw);
  if (m) { out.push(m[1] + m[2]); out.push(m[1]); }
  m = /^(.*[A-Z])-(?:S|M|L|X|P|PS|\d+A)$/.exec(raw);
  if (m) out.push(m[1]);
  return [...new Set(out)];
}

/**
 * The catalogue row a drawing is of.
 *
 * The ranking MIRRORS the app's own `findDbMotor` (services/motorDb.ts) —
 * exact designation or display designation first, then a prefix either way or
 * a common-name hit — so a nozzle row is attached to the same motor the
 * importer would resolve. `nozzle-db.test.mjs` pins that: every row in the
 * shipped file is re-resolved through the app's real matcher and must come
 * back with the same motorId. Duplicating the rank here rather than importing
 * it is forced — motorDb.ts is TypeScript with a JSON import, which plain node
 * cannot load — so the test is the thing that stops the two drifting.
 *
 * The extra tie-break this has and findDbMotor does not is the CASE FAMILY,
 * taken from the drawing's own folder ("RMS-29-180 High Power") and compared
 * with the catalogue's `caseInfo` ("RMS-29/180"). 322 of the 323 matches agree
 * on it, which is the strongest evidence available that the join is right.
 */
function findMotor(designation, diameterMm, caseFolder) {
  const wantCase = caseKey(caseFolder);
  for (const cand of designationCandidates(designation)) {
    const want = cand.toLowerCase();
    const scored = [];
    for (const m of AEROTECH) {
      if (diameterMm && Math.abs(m.diameter - diameterMm) > 1.5) continue;
      const rawD = m.designation.toLowerCase();
      const dispD = displayDesignation(m.designation).toLowerCase();
      let rank = -1;
      if (rawD === want || dispD === want) rank = 0;
      else if (rawD.startsWith(want) || dispD.startsWith(want)
        || want.startsWith(dispD) || m.commonName.toLowerCase() === want) rank = 1;
      if (rank < 0) continue;
      scored.push({ m, rank, caseMiss: m.caseInfo && caseKey(m.caseInfo) === wantCase ? 0 : 1 });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => a.rank - b.rank || a.caseMiss - b.caseMiss
      || Number(b.m.availability !== 'OOP') - Number(a.m.availability !== 'OOP'));
    const top = scored[0];
    const tied = scored.filter((s) => s.rank === top.rank && s.caseMiss === top.caseMiss);
    return { entry: top.m, via: cand, caseAgrees: top.caseMiss === 0, ambiguous: tied.length > 1 };
  }
  return null;
}

// -------------------------------------------------------------- build it up

/** Every distinct nozzle part number, with the descriptions it was seen under. */
const partDescriptions = new Map();
const perDrawing = [];
const unresolved = [];

for (const asm of raw.assemblies) {
  const folder = asm.caseFolder;
  const { row, why } = nozzleRow(asm);
  if (!row) { unresolved.push({ file: asm.file, why }); continue; }
  const part = row.part.toUpperCase();
  if (!partDescriptions.has(part)) partDescriptions.set(part, []);
  partDescriptions.get(part).push(row.desc);
  perDrawing.push({ asm, folder, row, part });
}

const parts = new Map();
for (const [part, descs] of partDescriptions) {
  parts.set(part, { ...resolvePart(part, descs), usedByDrawings: descs.length });
}
// Nozzles AeroTech publish that no drawing in this set puts on a motor — the
// Quest Q-JET inserts, the Enerjet spares, the 54 mm hybrid nozzle, the small
// 24 mm 01100. They belong in the parts table anyway: someone building an
// experimental motor picks a nozzle by part number, and a part left out of the
// table looks like a part with no data.
for (const [part, page] of specByPart) {
  if (parts.has(part)) continue;
  // 01919-1 is on the Single-Throat Nozzles shelf but is an ABS ADAPTER that
  // bonds a 1 in nozzle into a fibreglass case — it has no throat, no exit and
  // no business in a nozzle table.
  if (page.throatIn === undefined && page.exitIn === undefined && !page.multi) continue;
  const p = resolvePart(part, []);
  parts.set(part, { ...p, usedByDrawings: 0, weightG: page.weightG, odIn: page.odIn });
}

// ------------------------------------------------------------ the motor rows

const rows = [];
const unmatched = [];
/** Sheets whose stated throat contradicts the mould their part number names. */
const contradicted = [];
for (const { asm, folder, row, part } of perDrawing) {
  const p = parts.get(part);
  const diameterFromFolder = Number(/(\d\d)[-/ ]/.exec(folder.replace(/RMS\s*&\s*LMS/i, 'RMS'))?.[1]) || null;
  const found = findMotor(asm.designationFromFile, diameterFromFolder, folder);

  // Throat: this motor's own drawing wins over the part's nominal.
  const throatIn = throatFromDescription(row.desc) ?? p.throatDiameterIn;
  let exitIn = p.exitDiameterIn;
  let exitSource = p.exitSource;
  let exitConfidence = p.exitConfidence;
  let contradictedNote;
  let medusa;

  if (p.medusa && p.exitSource === 'medusa') {
    const open = medusaOpening(row.desc);
    const g = p.medusa;
    if (open) {
      const n = open.outerCount ?? 0;
      const centerExit = g.centerExitIn;
      // Four decimals of an inch is 2.5 microns — well inside the +/- .005 in
      // the drawings' own title blocks call for, and it keeps a derived number
      // from printing 16 digits of false precision.
      exitIn = Math.round(equivalent(centerExit, ...Array(n).fill(g.outerExitIn)) * 1e4) / 1e4;
      exitSource = 'medusa-open-throats';
      exitConfidence = open.outerCountAssumed ? 'medium' : 'high';
      medusa = {
        openOuterThroats: n,
        outerCountAssumed: Boolean(open.outerCountAssumed),
        centerExitIn: centerExit,
        outerExitIn: g.outerExitIn,
        centerThroatIn: open.centerThroatIn ?? g.centerThroatIn,
        outerThroatIn: open.outerThroatIn,
      };
    } else {
      exitSource = 'none'; exitConfidence = 'none';
    }
  }

  // A Medusa's throat is the equivalent of the throats it opens, not one hole.
  const throatEquivIn = medusa
    ? equivalent(medusa.centerThroatIn ?? 0, ...Array(medusa.openOuterThroats).fill(medusa.outerThroatIn ?? 0))
    : throatIn;

  /**
   * A SHEET THAT DRILLS A THROAT NARROWER THAN THE PART'S OWN MOULD, which
   * means the sheet is not describing that mould at all. (2026-09-08, from
   * review.)
   *
   * A dash number DRILLS — AeroTech's own printed rule — and drilling only ever
   * makes a throat bigger. So when a motor's LIST OF MATERIAL says ".500\"
   * DRILLED" against a part whose own drawing title block reads "NET MOLDED
   * .734\" THROAT", the two cannot both be about the same piece of hardware,
   * and the exit that came off that title block is not this motor's exit.
   *
   * L400W-PS is the case and, before this, the only one: its sheet calls out
   * 01800-3 ".500\" DRILLED" while `rcs_018003_nozzle_dwg.pdf` is the 1.750 in
   * / .734 in net-moulded second mould (revision "FUTURE B REDESIGNED FOR NET
   * MOLDED EXIT/THROAT 03/11/03"). The file shipped 1.750 in at confidence
   * "high" on a motor whose exit AREA is then 3.78x too large — about 23 N of
   * phantom thrust at a 20 kPa deficit on a 400 N motor, all of it on the up
   * side of apogee. `throatVariesAcrossSheets: [0.5, 0.734]` on the part had
   * already recorded the contradiction and nothing acted on it.
   *
   * WHAT IT FALLS BACK TO, and why that is the reading rather than a guess: the
   * base 01800 sheet prints the dash table "01800-1 NOZZLE DRILLED .413 Dt x
   * .900 De / 01800-2 NOZZLE DRILLED .594 Dt x .900 De", so a ".500 DRILLED"
   * 98 mm nozzle sits squarely between two documented dash numbers of the BASE
   * mould, whose exit is 0.900 in. Independent physical check: at 0.900 in the
   * expansion ratio is 3.24, inside this line's 1.96-7.55 band, where 1.750 in
   * gives 12.25 — 62 % above anything else AeroTech make. And the propellant
   * arithmetic agrees: ~2.4 kg of White Lightning over ~12.8 s through .500 in
   * is 1,500 kg/s/m2 of throat, which is N1000W's 1,540 (the other long-burn W
   * in this family); through .734 in it would be 697, half of any of them.
   *
   * Graded LOW even so, and labelled: the number is inferred from the base
   * mould's dash table rather than printed against this motor.
   */
  if (
    exitIn !== undefined
    && (exitSource === 'drawing-title' || exitSource === 'spec-page')
    && p.throatDiameterIn !== undefined
    && throatIn !== undefined
    && throatIn < p.throatDiameterIn - 0.002
  ) {
    const baseExit = parts.get(p.basePartNo ?? '')?.exitDiameterIn;
    contradicted.push(`${asm.designationFromFile} (${part}): sheet drills ${throatIn} in, part moulds `
      + `${p.throatDiameterIn} in — exit ${exitIn} in dropped${baseExit !== undefined ? `, base ${baseExit} in used` : ''}`);
    exitIn = baseExit;
    exitSource = baseExit === undefined ? 'none' : 'base-spec-page';
    exitConfidence = baseExit === undefined ? 'none' : 'low';
    contradictedNote = baseExit === undefined
      ? undefined
      : `This sheet drills the throat to ${throatIn} in, narrower than the ${p.throatDiameterIn} in `
        + `${part}'s own drawing moulds — a dash number only ever enlarges a throat, so this motor is not `
        + `using that mould. The base ${p.basePartNo ?? part} exit is used instead.`;
  }

  /**
   * A THROAT WIDER THAN THE MOULDED EXIT means the divergent section is gone.
   *
   * G69N-P: nozzle 01400, whose moulded geometry is a .104 in throat opening
   * to a .250 in exit — SPADED .313 in. A .313 in bore through a .250 in exit
   * removes the bell entirely, so the exit plane IS the bore. The motor makes
   * the case: 72 N average over 1.88 s on Warp 9, a propellant that only burns
   * that slowly at the low chamber pressure a huge throat gives.
   *
   * The alternative reading — exit unchanged at .250 in — is geometrically
   * impossible, so this is not a choice between two stories. It is still only
   * "medium": the number is inferred from the bore rather than printed.
   */
  if (exitIn !== undefined && throatEquivIn !== undefined && throatEquivIn > exitIn + 1e-6) {
    exitIn = throatEquivIn;
    exitSource = 'throat-bored-through';
    exitConfidence = 'medium';
  }

  const rec = {
    ...(found ? { motorId: found.entry.motorId } : {}),
    manufacturer: 'AeroTech',
    designation: asm.designationFromFile,
    ...(found ? { catalogDesignation: found.entry.designation, commonName: found.entry.commonName } : {}),
    caseFamily: folder,
    ...(found ? { casingDiameterMm: found.entry.diameter } : {}),
    nozzlePartNo: part,
    ...(exitIn !== undefined ? { exitDiameterM: round6(inToM(exitIn)), exitDiameterIn: exitIn } : {}),
    // ROUNDED FIRST, then converted (2026-09-08, from review). Taking the
    // metres from the full-precision Medusa equivalent while publishing the
    // inches to four decimals put the two units 1e-6 m apart on eight rows —
    // physically nothing (0.0001 in is 2.5 microns, well inside the drawings'
    // own +/- .005) but enough that the units cross-check could not be exact,
    // and an exact check is the only one that catches a real unit drift.
    ...(throatEquivIn !== undefined
      ? {
        throatDiameterM: round6(inToM(Math.round(throatEquivIn * 1e4) / 1e4)),
        throatDiameterIn: Math.round(throatEquivIn * 1e4) / 1e4,
      }
      : {}),
    exitSource,
    exitConfidence,
    // Why a row is only "medium", in the file rather than in a commit message.
    // The dash-number rule is AeroTech's, printed on 14 of the 23 nozzle
    // drawing files; where their own sheet for this family does not print it, the
    // carry-across rests on the wider convention plus the fact that when the
    // 98 mm family DOES change an exit, the description says so outright
    // ("/1.75" EXIT"). Sound, but inferred — so it is labelled, not hidden.
    ...(exitSource === 'base-spec-page' && exitConfidence === 'medium'
      ? { confidenceNote: 'Exit carried from the base part under the dash-number rule, which this family\'s own drawing does not print.' }
      : {}),
    ...(medusa?.outerCountAssumed
      ? { confidenceNote: 'The sheet gives a drilled throat with no count, so only the centre throat is taken as open — the moulded state. If outer throats were also opened the exit area is larger.' }
      : {}),
    ...(exitSource === 'throat-bored-through'
      ? { confidenceNote: `The sheet opens the throat to ${throatEquivIn} in, wider than this nozzle's ${p.exitDiameterIn} in moulded exit, so the divergent section is bored away and the exit plane is the bore itself.` }
      : {}),
    ...(contradictedNote ? { confidenceNote: contradictedNote } : {}),
    ...(medusa ? { medusa } : {}),
    provenance: {
      assemblyDrawing: asm.file,
      lomDescription: row.desc,
      // The drawing's own title block agrees with the filename's designation
      // (the sheet often omits the delay tag, so the stem is what is checked).
      designationOnSheet: asm.designationOnSheet ? 'exact' : asm.designationStemOnSheet ? 'stem' : 'no',
      // The document that actually gave THIS row's exit — not the part's
      // best document. The N1000W's 1.750 in comes off its own assembly sheet,
      // and pointing at the base part's store page (which says 0.900 in) would
      // send a reader to a number that contradicts the row.
      exitFrom: exitSource === 'assembly-description' ? asm.file
        : exitSource === 'drawing-title' ? p.provenance.drawing
          : exitSource === 'medusa-open-throats'
            ? `${p.provenance.baseSpecPage ?? p.provenance.specPage} (geometry) + ${asm.file} (throats opened)`
            : p.provenance.specPage ?? p.provenance.baseSpecPage ?? p.provenance.drawing ?? asm.file,
      matchedVia: found?.via,
      caseAgrees: found ? found.caseAgrees : undefined,
    },
  };
  rows.push(rec);
  if (!found) unmatched.push({ file: asm.file, designation: asm.designationFromFile });
}

/**
 * ONE ROW PER MOTOR — and the reason that is not just deduplication.
 *
 * Several drawings describe one catalogue motor: three delay lengths of the
 * same reload (H165R-S/-M/-L), or two nozzle OPTIONS for the same motor. The
 * delay variants always agree. The options do not, and they are real:
 *
 *   K1100T   01670-3 single throat, exit 1.250 in  |  01700-12 Medusa, exit 1.046 in
 *   K550W    01670   single throat, exit 1.250 in  |  01700-10 Medusa, exit 0.820 in
 *   I300T    01550-1                 exit 0.688 in |  01500-7               exit 0.438 in
 *   I115W / I117FJ / I215R / I229T / I599N   "New Small Nozzle" | "Original Medusa Nozzle"
 *   M650W    01780-1 "New Single-Throat"     | 01750-2 "Older Medusa"
 *
 * On K1100T and K550W the two options have the SAME total throat area to three
 * decimals (0.615 in and 0.455 in equivalent), which is what a genuine
 * alternative looks like — same motor performance, different nozzle hardware.
 * So the file must not pretend to know which one is in the user's motor. The
 * primary is chosen by AeroTech's own labels where they exist ("New" beats
 * "Original"/"Older"), then by how many sheets show it; every other exit is
 * kept in `alternatives`, and `exitAmbiguous` marks the row so a consumer can
 * ask instead of assuming. Between 1.250 in and 1.046 in there is 43 % of the
 * exit AREA, which is 43 % of the pressure-thrust term.
 *
 * A throat that differs while the exit agrees (G76: 0.156 in on one sheet,
 * 0.172 in on two) is recorded in `throatVariants` and nothing more — it does
 * not enter the thrust term at all.
 */
const NEWER = /\bnew\b/i;
const OLDER = /\b(original|older|old)\b/i;
const label = (f) => (NEWER.test(f) ? 0 : OLDER.test(f) ? 2 : 1);

/**
 * THE SHEET'S OWN DATED REVISION BLOCK OUTRANKS ITS FILENAME. (2026-09-08,
 * from review.)
 *
 * The pick below used to start at `label()`, which reads the FILENAME — and a
 * filename says "New Single-Throat Nozzle" only where whoever saved the PDF
 * chose to write it. Every RCS sheet carries a REVISIONS block that dates its
 * own content, and on two motors that block flatly contradicts the majority:
 *
 *   K1100T-L  "FUTURE C PER EO 'C', NEW HIGH POWER NOZZLE 8/19/04"  01670-3, exit 1.250 in
 *   K1100T-M/-S/-X  stop at "FUTURE B RMS-PLUS DELAY SYSTEM 1/11/02"  01700-12 Medusa, 1.0458 in
 *   K550W-L   "FUTURE C PER EO 'C', NEW H/P NOZZLE 8/19/04"          01670,   exit 1.250 in
 *   K550W-M/-S      stop at "FUTURE B ... 1/14/02"                   01700-10 Medusa, 0.8197 in
 *
 * Majority-of-sheets voted 3-1 and 2-1 for the part AeroTech's own engineering
 * order says was REPLACED, understating the exit AREA by 1.43x on K1100T and
 * 2.33x on K550W. M650W is the control: there the filename heuristic happened
 * to agree, and the 2021 revision "SUBSTITUTE 75MM SMALL THROAT NOZZLE FOR
 * 75MM MEDUSA NOZZLE" says the same thing independently.
 *
 * Only revisions that MENTION THE NOZZLE count — a delay-system or seal-disk
 * revision dates the sheet, not the part this file is about. 32 of the 324
 * sheets carry one. Where no sheet in a group has one, the filename label and
 * then the majority decide exactly as before.
 */
const nozzleRevisionDate = (asm) => (asm.revisions ?? [])
  .filter((r) => r.mentionsNozzle && r.isoDate)
  .reduce((newest, r) => (newest === null || r.isoDate > newest ? r.isoDate : newest), null);
const revisionByFile = new Map(raw.assemblies.map((a) => [a.file, nozzleRevisionDate(a)]));
const revDate = (f) => revisionByFile.get(f) ?? '';

const grouped = new Map();
for (const r of rows) {
  const key = r.motorId ?? `raw:${r.caseFamily}/${r.designation}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(r);
}

const motorRows = [];
for (const group of grouped.values()) {
  const drawings = group.map((r) => r.provenance.assemblyDrawing).sort();
  // A SHEET WITH NO EXIT IS NOT A SECOND NOZZLE. (2026-09-08, from review.)
  // `undefined` counted as a distinct member of this Set, so a group holding
  // one sheet that states an exit and one that does not read as two published
  // OPTIONS: the row would be marked `exitAmbiguous` and its note would offer
  // the reader "<part> undefined in" as the alternative. Only sheets that
  // actually state an exit can disagree about one. No group in the current
  // document set mixes the two — J615ST-20A, the one exitless motor, is
  // exitless on every sheet — so this changes no number today; it stops a
  // future aerospike or blank sheet from making a nonsense row.
  const exits = [...new Set(group.map((r) => r.exitDiameterM).filter((v) => v !== undefined))];
  const pick = [...group].sort((a, b) => {
    // ...and it can never be the PRIMARY while a sibling states one. The row's
    // whole job is to carry an exit diameter (2026-09-08, from review).
    const ea = a.exitDiameterM === undefined ? 1 : 0;
    const eb = b.exitDiameterM === undefined ? 1 : 0;
    if (ea !== eb) return ea - eb;
    const ra = revDate(a.provenance.assemblyDrawing);
    const rb = revDate(b.provenance.assemblyDrawing);
    if (ra !== rb) return rb.localeCompare(ra); // newest dated nozzle revision first
    const la = label(a.provenance.assemblyDrawing);
    const lb = label(b.provenance.assemblyDrawing);
    if (la !== lb) return la - lb;
    const na = group.filter((g) => g.exitDiameterM === a.exitDiameterM).length;
    const nb = group.filter((g) => g.exitDiameterM === b.exitDiameterM).length;
    if (na !== nb) return nb - na;
    return a.provenance.assemblyDrawing.localeCompare(b.provenance.assemblyDrawing);
  })[0];

  const { assemblyDrawing, ...prov } = pick.provenance;
  const out = { ...pick, provenance: { ...prov, assemblyDrawings: drawings } };

  // 0.002 in is below the +/- .005 the drawings themselves specify, so two
  // numbers closer than that are the same throat written two ways (0.615 on a
  // single-throat sheet against the Medusa equivalent 0.6153), not a variant.
  const throats = [...new Set(group.map((r) => r.throatDiameterIn).filter((v) => v !== undefined))]
    .sort((a, b) => a - b);
  const distinct = throats.filter((t, i) => i === 0 || t - throats[i - 1] > 0.002);
  if (distinct.length > 1) out.throatVariants = distinct;

  if (exits.length > 1) {
    out.exitAmbiguous = true;
    // NEVER "high" WHEN TWO PUBLISHED SHEETS DISAGREE. (2026-09-08, from
    // review.) `exitAmbiguous` said so, but `exitConfidence` — the field a
    // consumer filters on — still read "high", so a caller that trusted the
    // grade would pick one of two numbers up as settled. Between the K1100T's
    // two options there is 43 % of the exit area and therefore 43 % of the
    // pressure-thrust term; on I300T-L the two differ by 2.47x in area. A
    // dated revision on the winning sheet is real evidence and is recorded in
    // `exitPickedBy`, but it still describes AeroTech's CURRENT hardware, not
    // necessarily the reload kit in the user's hand.
    out.exitPickedBy = revDate(pick.provenance.assemblyDrawing) ? 'dated-revision'
      : label(pick.provenance.assemblyDrawing) !== 1 ? 'sheet-label' : 'majority-of-sheets';
    if (out.exitConfidence === 'high') out.exitConfidence = 'medium';
    // ONE LIST, DESCRIBED ONCE. (2026-09-08, from review.) The prose note and
    // `alternatives` were built from two separate dedupes of the same rows —
    // a Map, which keeps the LAST row for a repeated part number, against a
    // findIndex filter, which keeps the FIRST. Where one part number appeared
    // twice in a group with different exits (a Medusa part whose exit is
    // resolved per motor is the way that happens), the sentence a user reads
    // and the list a consumer reads would name the same part with two
    // different numbers. The note is now written FROM the list it describes,
    // so they cannot disagree.
    //
    // Deduped at all because several delay variants of the same motor show the
    // same alternative part, and listing it three times reads like three
    // nozzles.
    out.alternatives = group
      .filter((r) => r.exitDiameterM !== undefined && r.exitDiameterM !== pick.exitDiameterM)
      .filter((r, i, xs) => xs.findIndex((y) => y.nozzlePartNo === r.nozzlePartNo) === i)
      .map((r) => ({
        nozzlePartNo: r.nozzlePartNo,
        exitDiameterM: r.exitDiameterM,
        exitDiameterIn: r.exitDiameterIn,
        throatDiameterM: r.throatDiameterM,
        assemblyDrawing: r.provenance.assemblyDrawing,
        lomDescription: r.provenance.lomDescription,
      }));
    const others = out.alternatives.map((a) => `${a.nozzlePartNo} ${a.exitDiameterIn} in`);
    out.confidenceNote = `AeroTech publish two nozzles for this motor (${pick.nozzlePartNo} `
      + `${pick.exitDiameterIn} in against ${others.join(', ')}). `
      + (out.exitPickedBy === 'dated-revision'
        ? `The one used here is the one that sheet's own dated revision block calls current (${revDate(pick.provenance.assemblyDrawing)}); `
        : out.exitPickedBy === 'sheet-label'
          ? "The one used here is the one AeroTech's own sheet name calls the newer; "
          : 'The one used here is the one more sheets show; ')
      + 'check which nozzle is in your reload kit before trusting the exit area.';
  }
  motorRows.push(out);
}
motorRows.sort((a, b) => a.designation.localeCompare(b.designation) || a.caseFamily.localeCompare(b.caseFamily));

/**
 * Why a part has no exit diameter. Stated per part, because "no number" and
 * "no number is meaningful" are different answers and a consumer has to be able
 * to tell them apart.
 */
const NO_EXIT_NOTES = {
  // J615ST-20A only. An aerospike expands against the ambient stream instead of
  // a moulded bell, so it has no exit plane for A_exit x (p0 - p) to act on —
  // altitude compensation is what the geometry is FOR. Leaving this blank is
  // the correct answer, not a gap to be filled.
  '01680': 'Aerospike with an annular ring — no conventional exit plane, so the pressure-thrust term does not apply as it does to a bell nozzle. Deliberately blank.',
};

const partRows = [...parts.values()]
  .map((p) => ({
    ...p,
    ...(p.exitDiameterIn !== undefined ? { exitDiameterM: round6(inToM(p.exitDiameterIn)) } : {}),
    ...(p.throatDiameterIn !== undefined ? { throatDiameterM: round6(inToM(p.throatDiameterIn)) } : {}),
    ...(NO_EXIT_NOTES[p.partNo] ? { note: NO_EXIT_NOTES[p.partNo] } : {}),
  }))
  .sort((a, b) => a.partNo.localeCompare(b.partNo));

// ------------------------------------------------------------------ gaps

/**
 * Manufacturers with no nozzle data here, and why. Stated in the file itself so
 * a consumer can tell "we have not got it" from "it does not exist", and so
 * measured numbers have a documented place to land.
 *
 * LOKI: nothing published was found in the local document set — the only Loki
 * file on disk is `docs/User files/TRF RASAero Files/Loki_J1026CT.eng`, a
 * thrust curve with no geometry. Testers' own RASAero files DO carry exits for
 * Loki motors, and they are exactly why a user-typed number is not data: four
 * files type 0.9 in for the 54 mm K627LR, and the same corpus types 0, 0.91 and
 * 1.3 in for the SAME motor (`38mm Min Diameter.CDX1`, `38mm_thought
 * experiment.CDX1`). None of that is imported. The owner has one of every Loki
 * graphite nozzle and offered to measure them; five or six measurements would
 * cover the line, because Loki change only the throat. Those go in
 * MEASURED_NOZZLES below, never by hand into nozzles.json (a hand edit is wiped
 * by the next run of this script).
 *
 * CESARONI: the owner searched pro38.com's product and resources pages and the
 * wider web and found no published nozzle geometry at all. Recorded as a known
 * gap rather than guessed at; a Cesaroni exit inferred from a photograph would
 * be indistinguishable, in the output, from one AeroTech printed on a drawing.
 */
const MEASURED_NOZZLES = [
  // Ruled, measured additions go here, e.g.
  // { manufacturer: 'Loki', partNo: '54mm graphite', exitDiameterIn: 0.9,
  //   throatDiameterIn: 0.5, measuredBy: 'owner, calipers', measuredOn: '2026-09-??',
  //   appliesTo: ['K627LR'] },
];

/**
 * AN INDEPENDENT CHECK, and what it does and does not settle.
 *
 * TWELVE of the 312 certification letters in the set are Tripoli forms that
 * print "Nozzle Throat Diameter (in)" and "Nozzle Exit Cone Diameter (in)" —
 * measured by the certifying body, not stated by the maker. Every one is a
 * 1997-2001 test on a 98 mm motor. THREE of the twelve are Kosdon-by-AeroTech
 * motors with no row in this database at all, so the comparison that actually
 * happens is over NINE.
 *
 * THE THROATS AGREE EXACTLY wherever the motor still uses the same part
 * (M1939W .844, N2000W 1.000, K458W .413, L952W .594, L1500T .734, M2400T
 * .844), which is real corroboration that the LIST OF MATERIAL descriptions
 * are being read correctly.
 *
 * THE EXITS DO NOT, and the reason is on the drawing: `rcs_018003_nozzle_dwg`
 * carries "FUTURE B REDESIGNED FOR NET MOLDED EXIT/THROAT 03/11/03". Before
 * that the 98 mm exits ran about 0.7 in wider than the throat (.734 -> 1.40,
 * .844 -> 1.58, 1.000 -> 1.750); after it the "M" mould is a flat 1.750 in and
 * the base mould a flat 0.900 in. The Tripoli numbers describe hardware that
 * stopped being made two decades ago and whose certifications expired in
 * 2001-2006. So they are recorded, compared and reported — never used. If a
 * future comparison starts DISAGREEING ON THROATS, the extraction has broken.
 */
const certCheck = (raw.certNozzles ?? []).map((c) => {
  const stem = c.designation.replace(/\s*\(.*\)$/, '');
  // The fallback strips the letter's plugged-delay suffix ("-P", "-PS") so a
  // letter can still find a sheet that writes the motor without it. It was
  // written /-P S?$/ — a literal "-P", a SPACE, then an optional S — which
  // matches nothing any letter is called, so the fallback silently degraded to
  // a plain startsWith on the full stem (2026-09-08, from review). All twelve
  // letters in the current set resolve on the EXACT branch above (the three
  // that do not are Kosdon-by-AeroTech motors with no row here at all), so
  // fixing the pattern moves no number in the file today; it makes the
  // fallback work the first time a letter and a sheet disagree about the
  // suffix, which is the case it was written for.
  const row = motorRows.find((r) => r.designation === stem)
    ?? motorRows.find((r) => r.designation.startsWith(stem.replace(/-PS?$/, '')));
  return {
    designation: c.designation,
    certFile: c.file,
    testDate: c.testDate,
    certifiedUntil: c.certifiedUntil,
    certThroatIn: c.throatIn,
    certExitIn: c.exitIn,
    dbNozzlePartNo: row?.nozzlePartNo,
    dbThroatIn: row?.throatDiameterIn,
    dbExitIn: row?.exitDiameterIn,
    throatAgrees: row?.throatDiameterIn !== undefined
      ? Math.abs(row.throatDiameterIn - c.throatIn) <= 0.006 : undefined,
    exitAgrees: row?.exitDiameterIn !== undefined
      ? Math.abs(row.exitDiameterIn - c.exitIn) <= 0.006 : undefined,
  };
}).sort((a, b) => a.designation.localeCompare(b.designation));

/**
 * The newest mtime among the source documents this build actually read, as a
 * date. It was `new Date()` — the clock — which made a rebuild from identical
 * inputs produce a different artifact every day, so a re-run for any reason
 * showed a diff whether or not anything had changed. Falls back to the clock
 * only if nothing can be stat'ed, which cannot happen on a run that got this
 * far (the extractor read all of them).
 */
const sourceDate = (() => {
  // Assembly `file`s are relative to "Motor Assembly Drawings"; every other
  // group's is relative to the set root (see extract-nozzle-pdfs.py).
  const files = [
    ...raw.assemblies.map((f) => join('Motor Assembly Drawings', f.file)),
    ...raw.specPages.map((f) => f.file),
    ...raw.nozzleDrawings.map((f) => f.file),
    ...raw.certNozzles.map((f) => f.file),
  ];
  let newest = 0;
  for (const f of files) {
    try { newest = Math.max(newest, statSync(join(source, f)).mtimeMs); } catch { /* moved or renamed */ }
  }
  return new Date(newest > 0 ? newest : Date.now()).toISOString().slice(0, 10);
})();

/**
 * COVERAGE, COUNTED PER CASING DIAMETER — because a diameter is what people
 * make claims about. (2026-09-08, from review.)
 *
 * v0.120's release note said this database covers "every 98 mm motor". It does
 * not. AeroTech have 32 in-production 98 mm motors in the bundled catalogue and
 * 28 of them have a row here. The four without one are M1305M, M1340W,
 * N1975W-PS and O5500X-PS, and what they have in common is which FOLDER their
 * paperwork sits in: this pipeline reads `Motor Assembly Drawings`, AeroTech
 * file the DMS single-use motors under `DMS Motor Designs` (51 PDFs, 29 mm to
 * 152 mm) and M1305M has only an instruction sheet.
 *
 * The two 98 mm DMS sheets opened on 2026-09-08 are in the SAME format this
 * script already parses, nozzle line and part number included — M1340W-PS
 * reads "NOZZLE ( KLMN 98MM) .734" I.D. /1.75" EXIT", part 01800-3M — so the
 * gap is reachable by pointing the extractor at that folder too. Not done here:
 * reading a new document family adds rows to a shipped data file, which is a
 * decision about what the app tells people, not a defect fix. Recorded so the
 * decision can be taken deliberately.
 *
 * The claim was written by hand from a spot check, and nothing in the repo
 * could disagree with it. This block is COMPUTED from the same motors.json
 * every other count comes from and it NAMES what is missing, so the next
 * person quoting a coverage figure reads one off instead of counting, and a
 * catalogue refresh moves the figure with it.
 */
const coverageByCasing = (() => {
  const have = new Set(motorRows.filter((m) => m.motorId).map((m) => m.motorId));
  const by = new Map();
  for (const m of AEROTECH) {
    // In production only: coverage of motors nobody can buy is not the claim
    // anyone means, and `uncovered` below lists the retired ones regardless.
    if (m.availability === 'OOP') continue;
    if (!by.has(m.diameter)) by.set(m.diameter, { inProduction: 0, withNozzleRow: 0, missing: [] });
    const e = by.get(m.diameter);
    e.inProduction++;
    if (have.has(m.motorId)) e.withNozzleRow++;
    else e.missing.push(m.designation);
  }
  return Object.fromEntries([...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mm, e]) => [String(mm), { ...e, missing: e.missing.sort() }]));
})();

const db = {
  generated: sourceDate,
  source: 'AeroTech / RCS Rocket Motor Components published drawings and store pages',
  sourceNote: 'docs/RCS Schematics (LOCAL-ONLY, gitignored). Regenerate with packages/app/scripts/build-nozzle-db.mjs.',
  catalogueGenerated: motorsDb.generated,
  rule: 'A dash number drills the THROAT; the moulded EXIT is unchanged — AeroTech\'s own note, printed on 14 of the 23 nozzle drawing files. The 98mm 01800 "M" mould is the documented exception (1.750 in exit against the base 0.900 in) and is resolved from part-specific sources.',
  counts: {
    assemblyDrawings: raw.assemblies.length,
    nozzlePartResolved: perDrawing.length,
    distinctNozzleParts: partRows.length,
    // TWO counts, not one (2026-09-08, from review). `partsWithExit` was
    // 101 of 102 while only 81 rows actually carry `exitDiameterIn` — the
    // other 20 are Medusa parts whose exit depends on how many outer throats
    // the motor's own sheet opens, so it is resolved PER MOTOR and there is
    // nothing in the parts table to read. One number covering both told a
    // reader of that table it would find an exit on 101 rows when 21 have none.
    partsWithExitDiameter: partRows.filter((p) => p.exitDiameterIn !== undefined).length,
    partsResolvedPerMotor: partRows.filter((p) => p.exitSource === 'medusa').length,
    motorsWithExit: motorRows.filter((m) => m.exitDiameterM !== undefined).length,
    motorsMatchedToCatalogue: motorRows.filter((m) => m.motorId).length,
    // The honest coverage figure. `motorsMatchedToCatalogue` counts rows that
    // matched ANY catalogue entry, and two of them (G33-5J, G71-10R) matched
    // motors marked out of production — so quoting matched/inProduction as the
    // in-production coverage overstates it. This is the numerator that belongs
    // over `catalogueAeroTechInProduction`.
    motorsMatchedInProduction: motorRows.filter((m) => m.motorId
      && byMotorId.get(m.motorId)?.availability !== 'OOP').length,
    motorsWithTwoNozzleOptions: motorRows.filter((m) => m.exitAmbiguous).length,
    catalogueMotors: motorsDb.motors.length,
    catalogueAeroTech: AEROTECH.length,
    catalogueAeroTechInProduction: AEROTECH.filter((m) => m.availability !== 'OOP').length,
  },
  gaps: {
    Loki: 'No published Loki nozzle geometry in the local document set. Testers\' own RASAero files type 0.9 in for the 54 mm K627LR in four files and 0, 0.91 and 1.3 in for the same motor elsewhere — user input, not data, and deliberately not imported. Owner has the hardware and will measure; add through MEASURED_NOZZLES in build-nozzle-db.mjs.',
    Cesaroni: 'No published nozzle geometry found on pro38.com or elsewhere (owner searched 2026-09-08). Known gap.',
    AeroTechSingleUse: 'AeroTech publish an assembly drawing for RELOADABLE motors, because the drawing is the reload kit\'s parts list, and this file is built from that folder ("Motor Assembly Drawings"). Most single-use motors have no reload kit and no such drawing — that is most of the AeroTech catalogue this file does not cover. One qualification, found 2026-09-08: the DMS single-use motors ARE drawn, in the same format, under "DMS Motor Designs" (51 sheets, 29 mm to 152 mm), and M1340W-PS names its nozzle there — "NOZZLE ( KLMN 98MM) .734" I.D. /1.75" EXIT", part 01800-3M. That folder is deliberately not read yet: adding a document family adds rows to shipped data, which is a decision rather than a fix.',
  },
  coverage: {
    note: 'What this file covers, per motor CASING DIAMETER, counted from motors.json at build time rather than written down. A hand-written coverage claim is exactly how "every 98 mm motor" reached a release note while four in-production 98 mm motors had no row here (M1305M, M1340W, N1975W-PS, O5500X-PS). "inProduction" is the AeroTech rows this catalogue does not mark OOP, and every motor short of a row is named. Most of the missing are single-use motors, whose paperwork is not the reload-kit assembly drawing this file is built from — see gaps.AeroTechSingleUse.',
    byCasingDiameterMm: coverageByCasing,
  },
  // Which AeroTech motors are NOT here, grouped by the case they belong to.
  // Computed rather than written down, so it cannot go stale against a
  // motors.json refresh, and stated in the file because "no row" and "no data"
  // look identical to a consumer that cannot see this list.
  //
  // THE DIAMETER IS PART OF THE KEY (2026-09-08, from review). Grouped by case
  // alone, the three uncovered 98 mm single-use motors (M1340W, N1975W-PS,
  // O5500X-PS) sat unlabelled inside a 75-strong "single-use" list, so a reader
  // checking "does this cover the 98 mm motors?" could not see them and the
  // "every 98 mm motor" claim went unchallenged. A motor's casing size is the
  // first thing anyone asks this list about, so it is in the heading.
  uncovered: (() => {
    const have = new Set(motorRows.filter((m) => m.motorId).map((m) => m.motorId));
    const by = new Map();
    for (const m of AEROTECH) {
      if (have.has(m.motorId)) continue;
      const key = `${m.diameter} mm ${m.caseInfo || 'single-use (no reload case)'}`;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(m.designation);
    }
    return Object.fromEntries([...by.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, v.sort()]));
  })(),
  measured: MEASURED_NOZZLES,
  crossCheck: {
    note: 'Tripoli certification letters that print a measured throat and exit. All are 1997-2001 tests on 98 mm motors, predating AeroTech\'s 2003 "REDESIGNED FOR NET MOLDED EXIT/THROAT" revision, so the throats corroborate this database and the exits describe the older hardware. Comparison only — never an input.',
    tripoli: certCheck,
  },
  nozzles: partRows,
  motors: motorRows,
};

writeFileSync(OUT, `${JSON.stringify(db, null, 1)}\n`);

// ------------------------------------------------------------------ report

const c = db.counts;
const pct = (n, d) => `${((n / d) * 100).toFixed(1)} %`;
console.log(`assembly drawings parsed          ${c.assemblyDrawings}`);
console.log(`  nozzle part resolved            ${c.nozzlePartResolved} (${pct(c.nozzlePartResolved, c.assemblyDrawings)})`);
console.log(`distinct nozzle parts             ${c.distinctNozzleParts}`);
console.log(`  with an exit diameter           ${c.partsWithExitDiameter}`);
console.log(`  exit resolved per motor         ${c.partsResolvedPerMotor} (Medusa: depends which throats the motor opens)`);
console.log(`motors (rows)                     ${motorRows.length}`);
console.log(`  matched into motors.json        ${c.motorsMatchedToCatalogue} (${pct(c.motorsMatchedToCatalogue, c.catalogueAeroTech)} of AeroTech, ${pct(c.motorsMatchedToCatalogue, c.catalogueMotors)} of all ${c.catalogueMotors})`);
console.log(`  of the IN-PRODUCTION AeroTech   ${c.motorsMatchedInProduction} (${pct(c.motorsMatchedInProduction, c.catalogueAeroTechInProduction)} of ${c.catalogueAeroTechInProduction})`);
console.log(`  with an exit diameter           ${c.motorsWithExit}`);
for (const conf of ['high', 'medium', 'low', 'none', 'per-motor']) {
  const n = motorRows.filter((m) => m.exitConfidence === conf).length;
  if (n) console.log(`    confidence ${conf.padEnd(10)}      ${n}`);
}
console.log(`  two nozzle options published    ${c.motorsWithTwoNozzleOptions}`);
for (const m of motorRows.filter((x) => x.exitAmbiguous)) {
  console.log(`    ${m.designation.padEnd(11)} ${m.nozzlePartNo} ${m.exitDiameterIn} in`
    + ` vs ${m.alternatives.map((a) => `${a.nozzlePartNo} ${a.exitDiameterIn} in`).join(', ')}`);
}
const tAgree = certCheck.filter((x) => x.throatAgrees === true).length;
const tSeen = certCheck.filter((x) => x.throatAgrees !== undefined).length;
console.log(`\nTripoli cross-check (1997-2001 tests)  ${certCheck.length} letters carry a measured nozzle`);
console.log(`  throat agrees                   ${tAgree}/${tSeen}`);
console.log(`  exit agrees                     ${certCheck.filter((x) => x.exitAgrees === true).length}/${certCheck.filter((x) => x.exitAgrees !== undefined).length}  (the 2003 net-moulded redesign — see crossCheck.note)`);
if (contradicted.length) {
  console.log(`\nsheet throat contradicts the part's own mould (${contradicted.length}):`);
  for (const t of contradicted) console.log(`  ${t}`);
}
if (unresolved.length) {
  console.log(`\nno nozzle row (${unresolved.length}):`);
  for (const u of unresolved) console.log(`  ${u.file} — ${u.why}`);
}
if (unmatched.length) {
  console.log(`\nnot in motors.json (${unmatched.length}):`);
  for (const u of unmatched) console.log(`  ${u.designation}  (${u.file})`);
}
// Per casing diameter, because "covers every N mm motor" is the claim people
// make about this file and it has to be readable off the run that produced it
// (2026-09-08, from review — v0.120's note claimed all 98 mm and was four short).
console.log('\nin-production AeroTech coverage, by casing diameter');
for (const [mm, e] of Object.entries(db.coverage.byCasingDiameterMm)) {
  console.log(`  ${`${mm} mm`.padEnd(8)} ${String(e.withNozzleRow).padStart(3)} of ${String(e.inProduction).padEnd(3)}`
    + (e.missing.length ? `  no row: ${e.missing.join(' ')}` : '  (all)'));
}

const uncoveredTotal = Object.values(db.uncovered).reduce((a, v) => a + v.length, 0);
console.log(`\nAeroTech motors with no nozzle row  ${uncoveredTotal}`);
for (const [k, v] of Object.entries(db.uncovered).slice(0, 6)) {
  console.log(`  ${k.padEnd(28)} ${String(v.length).padStart(3)}  ${v.slice(0, 6).join(' ')}${v.length > 6 ? ' ...' : ''}`);
}
const rest = Object.entries(db.uncovered).slice(6);
if (rest.length) console.log(`  ${'(and)'.padEnd(28)} ${String(rest.reduce((a, [, v]) => a + v.length, 0)).padStart(3)}  across ${rest.length} more cases`);

console.log(`\nWrote ${motorRows.length} motors and ${partRows.length} nozzle parts to ${OUT}`);

if (REPORT) {
  console.log('\n--- parts ---');
  for (const p of partRows) {
    console.log(`${p.partNo.padEnd(12)} exit ${String(p.exitDiameterIn ?? '-').padEnd(7)} throat ${String(p.throatDiameterIn ?? '-').padEnd(7)} ${p.exitSource}/${p.exitConfidence}${p.exitOnDrawing === false ? '  [NOT ON DRAWING]' : ''}`);
  }
  console.log('\n--- motors with an alternative geometry ---');
  for (const m of motorRows.filter((x) => x.alternatives)) {
    console.log(`${m.designation}  ${m.nozzlePartNo} exit ${m.exitDiameterIn} vs ${JSON.stringify(m.alternatives)}`);
  }
}
