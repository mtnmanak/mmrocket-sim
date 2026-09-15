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
    // "DRILLED TO .209" AND "AS MOLDED .155" — the two forms the DMS sheets
    // use and the reloadable ones never did (2026-09-13, from review).
    //
    // Without the optional TO, "NOZZLE (F60/G80) DRILLED TO .209"" matched
    // nothing and the throat fell back to the PART's nominal. Sixteen DMS rows
    // hit that, and on five of them the part's nominal is a different number,
    // so v0.131 shipped H115DM-14A at .180 where its own sheet says .209,
    // I140W-14A at .180 for .242, I175WS-13A at .180 for .281, I500T-14A at
    // .398 for .469, and G72DM-14A with no throat at all where the sheet says
    // .155. The other eleven agreed with the nominal by luck, which is why
    // nothing looked wrong. NO EXIT MOVED and no flight number with it — the
    // exit comes from the part's moulded bell under the dash rule, which is
    // correct — but the throat is published data and it was wrong.
    //
    // "MOLDED" is here for the 29 mm DMS cases whose nozzle is moulded into
    // the case and stated "AS MOLDED .155"".
    // NOTE the capture includes the leading dot — `[\d.]+` already matches
    // ".209". Writing it as `\.?([\d.]+)` instead consumed the dot OUTSIDE the
    // group and returned 209 for .209, which turned 322 fields of this file
    // into integers in one build. Caught immediately by diffing against the
    // previous file, which is why that diff is worth running every time.
    // `DRILL(?:ED)?`, not `DRILLED` (2026-09-14, from review). The DMS sheets write the
    // bare verb as well as the participle — I65W-PS's LOM row reads
    // `MEDUSA NOZZLE CENTER DRILL TO .266"` — and matching only "DRILLED" returned
    // undefined for it. That fell all the way through: `medusaOpening` tries four patterns
    // and then this function as its last resort, so a Medusa whose throat could not be read
    // resolved to `exitSource: 'none'` and I65W-PS SHIPPED WITH NO EXIT DIAMETER AT ALL,
    // where part 01700-1 publishes a 0.500 in centre exit. UNDRILLED stays first in the
    // alternation, so it still wins over the bare verb inside its own word.
    /(?:UNDRILLED|DRILL(?:ED)?|SPADED|THROAT|MOLDED)\s*(?:TO\s+)?[:=]?\s*([\d.]+)/i,
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
function findMotor(designation, diameterMm, caseFolder, preferSingleUse = false) {
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
      // A DMS drawing is of a SINGLE-USE motor, and the catalogue says which
      // motors those are (`type: 'SU'`). That matters where the catalogue
      // carries BOTH forms of one motor: H550ST is the RMS-38/360 reload and
      // HP-H550ST is the same motor as a DMS single-use, and the 38mm/H550ST-14A
      // DMS sheet is unambiguously the second. Before this the right one was
      // picked only by a coincidence — `caseKey('38mm')` and `caseKey('38 DMS')`
      // both reduce to "38" — which would not have held for the 35 DMS motors
      // whose catalogue `caseInfo` is null. Deriving it from the motor's own
      // type is the real reason, and `dmsAreSingleUse` below asserts it.
      const typeMiss = preferSingleUse && m.type !== 'SU' ? 1 : 0;
      scored.push({ m, rank, typeMiss, caseMiss: m.caseInfo && caseKey(m.caseInfo) === wantCase ? 0 : 1 });
    }
    if (!scored.length) continue;
    scored.sort((a, b) => a.rank - b.rank || a.typeMiss - b.typeMiss || a.caseMiss - b.caseMiss
      || Number(b.m.availability !== 'OOP') - Number(a.m.availability !== 'OOP'));
    const top = scored[0];
    const tied = scored.filter((s) => s.rank === top.rank && s.typeMiss === top.typeMiss && s.caseMiss === top.caseMiss);
    return { entry: top.m, via: cand, caseAgrees: top.caseMiss === 0, ambiguous: tied.length > 1 };
  }
  return null;
}

// -------------------------------------------------------------- build it up

/** Every distinct nozzle part number, with the descriptions it was seen under. */
const partDescriptions = new Map();
const perDrawing = [];
const unresolved = [];

// A SHEET AT A FAMILY ROOT HAS NO CASE FOLDER, so it has no casing size to
// filter the catalogue join by — which would let a same-named motor of another
// size win. None exists today; the build refuses rather than guesses if one
// ever appears (2026-09-13, from review).
const rootLevel = raw.assemblies.filter((a) => a.atFamilyRoot).map((a) => a.file);
if (rootLevel.length > 0) {
  console.error('These drawings sit at a document-family root, so their casing size cannot be read:');
  for (const f of rootLevel) console.error(`  ${f}`);
  console.error('Put each in a casing-size subfolder, or give findMotor another way to get the diameter.');
  process.exit(1);
}

for (const asm of raw.assemblies) {
  const folder = asm.caseFolder;
  const { row, why } = nozzleRow(asm);
  if (!row) { unresolved.push({ file: asm.file, why }); continue; }
  // A PART NUMBER WITH A REVISION IN IT BLEEDS INTO THE DESCRIPTION.
  // The DMS sheets write the part cell as "01912 REV. 'C'", and the
  // extractor's row regex takes the first token as the part and everything
  // after it as the description — so the description came out as
  // "REV. 'C' 'G' MOLDED CASE (NOZZLE DRILLED .234\")" when the sheet's own
  // DESCRIPTION cell is only the part from 'G' onwards. The part number is
  // still right and no number moved, but `lomDescription` is offered as
  // verbatim and was not (2026-09-13, found by reading the drawings back).
  // Stripped here rather than in the extractor, which stays deliberately dumb.
  row.desc = row.desc.replace(/^REV\.\s*'[A-Z]'\s*/i, '');
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
  const isDms = asm.docFamily === 'dms';
  // A reloadable folder is a case family ("RMS-29-180 High Power"); a DMS
  // folder is just the casing size ("29mm", "152mm"). Both give a diameter,
  // which is all this is for, but only the first can tie-break the catalogue
  // join — a DMS motor has no reload case for `caseInfo` to agree with.
  const diameterFromFolder = isDms
    ? Number(/^(\d+)\s*mm/i.exec(folder)?.[1]) || null
    : Number(/(\d\d)[-/ ]/.exec(folder.replace(/RMS\s*&\s*LMS/i, 'RMS'))?.[1]) || null;
  const found = findMotor(asm.designationFromFile, diameterFromFolder, folder, isDms);

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
      // SAY WHY, like every other exit-less row (2026-09-14, from review). This branch
      // dropped the exit silently, so a Medusa whose description no pattern could read
      // shipped with `exitSource: 'none'` and NO explanation — in a file whose stated rule is
      // that every absence names its reason (`NO_EXIT_NOTES` covers 01680/01912/01600,
      // `cutNote` covers K76WN-P). I65W-PS was the one row in the whole file with an
      // unexplained blank; the `DRILL TO` fix above means nothing reaches here today, which
      // is exactly when a fallback is worth writing down rather than after it bites.
      exitSource = 'none'; exitConfidence = 'none';
      contradictedNote = `The nozzle is a Medusa, but this sheet's description `
        + `(${JSON.stringify(row.desc)}) does not state which throats are opened in any form `
        + `this build understands, so the equivalent exit area cannot be derived. `
        + `Reported rather than guessed: assuming centre-only would publish a number the sheet does not support.`;
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
   * A NOZZLE THE SHEET SAYS WAS CUT SHORTER HAS NO KNOWN EXIT. (2026-09-13,
   * with the DMS drawings.)
   *
   * K76WN-P's row reads "54MM HYBRID NOZZLE .313" DT CUT TO 1.395" LONG". A
   * converging-diverging nozzle widens continuously from the throat to the exit
   * plane, so cutting the bell SHORTER moves the exit plane back up the cone
   * and the exit is SMALLER than the mould's — by an amount only the drawing's
   * own half-angle could give, and that is not on this sheet.
   *
   * Carrying the base 0.812 in across would therefore publish a number that is
   * too BIG, which is the direction that adds thrust the motor does not make
   * and overstates apogee. The dash-number rule does not cover this: a dash
   * number drills the throat and leaves the moulded exit alone, whereas this
   * says the moulded part itself was shortened. So the exit is dropped and the
   * reason is recorded. The throat still stands — it is stated outright.
   *
   * Deliberately narrow: it fires only on CUT/SHORTENED/TRIMMED language about
   * the nozzle's LENGTH. "CUT" appears nowhere else in the 375 sheets' nozzle
   * rows.
   */
  // `[^.]*` was wrong and silently matched nothing: the descriptions are full
  // of decimal inches ("CUT TO 1.395" LONG"), so a dot-excluding gap can never
  // reach the word LONG. Bounded any-character instead.
  const cutShorter = /\b(?:CUT|SHORTENED|TRIMMED)\b[\s\S]{0,30}?\bLONG\b|\bCUT\s+(?:DOWN|BACK)\b/i.exec(row.desc);
  let cutNote;
  if (exitIn !== undefined && cutShorter) {
    cutNote = `This sheet says the nozzle was ${cutShorter[0]} — the moulded ${part.replace(/-.*$/, '')} `
      + `exit of ${exitIn} in is the FULL bell's, and a bell cut shorter exits narrower than that by an `
      + 'amount the sheet does not give. Published as unknown rather than as a number that would be too '
      + 'large, since an overstated exit adds thrust the motor does not make.';
    exitIn = undefined;
    exitSource = 'none';
    exitConfidence = 'none';
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
    // What a reader should understand the drawing to be OF. For a reloadable
    // motor that is the reload case; for a DMS motor there is no case to name,
    // so it says what the sheet actually is.
    caseFamily: isDms ? `${folder} DMS (single-use)` : folder,
    docFamily: isDms ? 'dms' : 'reloadable',
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
    // ONE FIELD, EVERY REASON THAT APPLIES (2026-09-13, from review).
    //
    // These five were five separate conditional spreads of the SAME key, so a
    // row that tripped two rules kept only the last one's explanation and lost
    // the other without a word — in the field whose entire job is to say why a
    // number is not simply read off a drawing. No row trips two today, which is
    // exactly why nobody would have noticed the first one that did.
    ...(() => {
      const notes = [
        exitSource === 'base-spec-page' && exitConfidence === 'medium'
          ? 'Exit carried from the base part under the dash-number rule, which this family\'s own drawing does not print.' : null,
        medusa?.outerCountAssumed
          ? 'The sheet gives a drilled throat with no count, so only the centre throat is taken as open — the moulded state. If outer throats were also opened the exit area is larger.' : null,
        exitSource === 'throat-bored-through'
          ? `The sheet opens the throat to ${throatEquivIn} in, wider than this nozzle's ${p.exitDiameterIn} in moulded exit, so the divergent section is bored away and the exit plane is the bore itself.` : null,
        contradictedNote ?? null,
        cutNote ?? null,
      ].filter(Boolean);
      return notes.length ? { confidenceNote: notes.join(' ') } : {};
    })(),
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
    // APPEND, NEVER ASSIGN (2026-09-14, from review) — a LATENT fix, and the record of what
    // it is and is not matters, because the review that prompted it got the mechanism wrong.
    //
    // This was `out.confidenceNote = ...`, which would silently destroy whatever the "one
    // field, every reason that applies" block above had built — the identical defect that
    // block was written to fix, in the same field, one commit later.
    //
    // THE REVIEW CLAIMED IT WAS LIVE ON EIGHT SHIPPED ROWS (I115W-M, I117FJ-M, I215R-M,
    // I229T-M, I300T-14A, I599N-P, K1100T-L, M650W-P), reasoning that each carries
    // `exitSource: 'base-spec-page'` at `medium` and so had the dash-number sentence
    // generated and then overwritten. IT DID NOT. Those rows read `medium` only BECAUSE of
    // the downgrade three lines above; at row-build time they were `high`, so the sentence —
    // whose condition is `base-spec-page && medium` — was never generated for them at all.
    // Proved by making this change and regenerating: the notes on all eight are byte-identical
    // and only I65W-PS moved. The 24-vs-0 split the review measured is real and has a
    // different cause: the dash sentence marks a family whose own drawing does not print the
    // rule, which is what `high` vs `medium` encodes at ROW level, and the ambiguity downgrade
    // is about something else entirely. Those eight are correctly without it.
    //
    // So this changes no published note today. It is still right: `cutNote` and
    // `contradictedNote` are set per row and CAN coexist with ambiguity, and either would
    // have been destroyed here without a word. A field that accumulates reasons must be
    // written in one place and appended to everywhere else — the row that trips two rules is
    // always the one nobody tested.
    const ambiguityNote = `AeroTech publish two nozzles for this motor (${pick.nozzlePartNo} `
      + `${pick.exitDiameterIn} in against ${others.join(', ')}). `
      + (out.exitPickedBy === 'dated-revision'
        ? `The one used here is the one that sheet's own dated revision block calls current (${revDate(pick.provenance.assemblyDrawing)}); `
        : out.exitPickedBy === 'sheet-label'
          ? "The one used here is the one AeroTech's own sheet name calls the newer; "
          : 'The one used here is the one more sheets show; ')
      + 'check which nozzle is in your reload kit before trusting the exit area.';
    out.confidenceNote = out.confidenceNote
      ? `${out.confidenceNote} ${ambiguityNote}`
      : ambiguityNote;
  }
  motorRows.push(out);
}
motorRows.sort((a, b) => a.designation.localeCompare(b.designation) || a.caseFamily.localeCompare(b.caseFamily));

/**
 * Why a part has no exit diameter. Stated per part, because "no number" and
 * "no number is meaningful" are different answers and a consumer has to be able
 * to tell them apart.
 */
/**
 * WHAT THE DMS DRAWINGS THEMSELVES SAY, where it differs from what this file
 * publishes. Recorded 2026-09-13, when all 41 new DMS rows were read back from
 * their own PDFs by someone other than the code that wrote them, and every
 * published exit was then attacked by a second reader. NO EXIT WAS REFUTED.
 * (41 of the 49 DMS rows carry an exit; the other eight publish none, so there
 * was nothing to check on them.)
 * What that pass turned up anyway is kept below (the count is no longer written out here -
 * it was "These four" after the list had been cut to three, in the very commit that added a
 * build-time check because the list "is no longer trusted prose"), because a
 *
 * NONE OF THEM CHANGES A ROW, and the reason is a standing rule of this file:
 * a leader-line CALLOUT on a drawing is an unlabelled number, so it is only
 * ever a cross-check, never the answer. The LIST OF MATERIAL text is the
 * answer. That rule is why `exitOnDrawing` exists on parts and why the Tripoli
 * letters are compared and not used.
 *
 * THE TWO WORTH ACTING ON ONE DAY are the exits: K76WN-P and I40N-P both
 * publish nothing today, and their own sheets appear to dimension an exit. That
 * is a decision for the owner — reading exits off callouts would be a new
 * source with a new error mode — so it is written here rather than taken.
 */
const DMS_SHEET_OBSERVATIONS = [
  {
    motors: ['K76WN-P'],
    field: 'exit',
    published: null,
    onSheet: 0.625,
    note: 'This row deliberately publishes NO exit: its description says the 01650 nozzle was "CUT TO '
      + '1.395 in LONG", and a bell cut shorter exits narrower than the mould\'s 0.812 in by an amount the '
      + 'text does not give. The drawing appears to dimension the answer - 0.625 in, twice - which both '
      + 'confirms the reasoning (0.625 < 0.812) and offers the real number. Still a callout, so still not '
      + 'taken.',
  },
  {
    motors: ['I40N-P'],
    field: 'exit',
    published: null,
    onSheet: 0.289,
    note: 'Part 01600 has no published exit anywhere, so this row publishes none. The sheet carries two '
      + 'leadered aft-end diameters, 0.289 in and 0.156 in, the second being the stated throat - which '
      + 'makes the first a candidate exit. A callout, so not taken.',
  },
  {
    motors: ['K62N-P'],
    field: 'exitSource',
    published: 'spec-page',
    onSheet: 0.5,
    note: 'The 0.5 in exit is right, and the sheet states it DIRECTLY (a leadered 0.500 in callout beside '
      + 'the 0.250 in throat) as well as the part page. The row\'s provenance understates what backs it. '
      + 'No number changes.',
  },
];

/**
 * AND THE OBSERVATIONS ARE CHECKED AGAINST THE ROWS THEY DESCRIBE.
 *
 * The first version of this list carried a fourth entry claiming H195NT-14A and
 * I205W-14A publish a 0.313 in throat against their sheets' 0.291 - "the two
 * sources disagree by 7.6 %". THEY DO NOT. Both rows publish 0.291, which is
 * exactly what the sheets say and what part 01550's own spec page says; 0.313
 * is part 01550-1's DRILLED dash number, a different part.
 *
 * IT GOT THERE BECAUSE I HAND-TYPED THE VERIFICATION INPUT instead of feeding
 * the exported rows, mistyped those two throats, and the readers correctly
 * reported a disagreement against my typo. I then wrote that disagreement into
 * this file AND into a user-facing release note - the exact fault v0.130 had
 * been cut one release earlier to correct.
 *
 * So the list is no longer trusted prose. Every entry's `published` value is
 * compared with what the file actually publishes for those motors, and a
 * mismatch FAILS THE BUILD. An observation that cannot survive that check is
 * not an observation, it is a story.
 */


const NO_EXIT_NOTES = {
  // J615ST-20A only. An aerospike expands against the ambient stream instead of
  // a moulded bell, so it has no exit plane for A_exit x (p0 - p) to act on —
  // altitude compensation is what the geometry is FOR. Leaving this blank is
  // the correct answer, not a gap to be filled.
  '01680': 'Aerospike with an annular ring — no conventional exit plane, so the pressure-thrust term does not apply as it does to a bell nozzle. Deliberately blank.',
  // The three that arrived with the DMS single-use drawings, 2026-09-13. Each
  // is a real absence with a stated reason, not a gap waiting to be filled.
  '01912': 'Not a nozzle part at all: the 29 mm DMS moulded case has its nozzle MOULDED INTO THE CASE, and the sheet gives only the throat it is drilled to. There is no nozzle drawing or store page to take an exit from, because there is no separate part.',
  '01600': 'A machined 38 mm nozzle whose drawing states an outside diameter (1.25 in) and a drilled throat, and no exit. The O.D. is the part\'s outside, NOT the exit plane, and guessing one from the other is how a 1.25 in exit would reach a thrust term that has no business with it.',
};

/**
 * Which motors a no-exit part affects, COUNTED rather than written down.
 *
 * The first draft of the two notes above ended "Affects G125T, G72DM, G75M and
 * G80T" and "Affects I40N-P and J33N-P" — hand-written lists over data this
 * build already holds, which is the pattern the coverage block was rewritten to
 * remove ("a hand-written coverage claim is exactly how 'every 98 mm motor'
 * reached a release note"). One of them also quoted the part as
 * `REV. C G MOLDED CASE`, a string this same commit strips as a column bleed.
 */

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
  //
  // NOTHING LOKI NEEDS TO GO HERE ANY MORE — see the LOKI section below, which
  // reads Loki's own published tables. This list is still the landing place for
  // a measurement of something nobody publishes (Cesaroni), and it is emitted
  // as `measured` for the record; it is NOT merged into `motors`, so a row put
  // here alone would not reach the app.
];

/* ------------------------------------------------------------------- LOKI
 *
 * LOKI RESEARCH, added 2026-09-13. Until now this file's `gaps.Loki` said there
 * was no published Loki geometry and that the owner would have to measure his
 * own nozzles. That was wrong twice over, and both halves are published by Loki
 * themselves:
 *
 *  1. `https://lokiresearch.com/page/Tech_Info` prints NOZZLE EXIT DIAMETERS as
 *     a band table per casing diameter, and the numbering convention that makes
 *     it usable — "Every nozzle is engraved with a number indicating the throat
 *     size in 64ths of an inch. For example, a #24 nozzle has a 24/64" = 0.375"
 *     throat diameter." The owner had read that page and we both concluded the
 *     exits were not on it; they are, at the FOOT of the page, below the O-ring
 *     table (Eric, 2026-09-13: "we thought they didn't publish the exit
 *     diameters, but the exit diameters are on the bottom of the page").
 *
 *  2. Every reload kit's INSTRUCTION SHEET names the nozzle that motor takes,
 *     in a table headed "Important! The correct nozzle must be used or motor
 *     failure may occur!". The owner put all 21 in `docs/Loki Data`.
 *
 * So the join is Loki's own, in one line:
 *   instruction sheet -> nozzle number -> that casing's exit band -> motorId
 *
 * THE BANDS ARE WHY THIS WORKS AT ALL. Loki mould ONE exit per casing size per
 * band and drill the throat to suit the motor — the same arrangement AeroTech's
 * dash numbers describe, and the reason the old gap note could say "five or six
 * measurements would cover the line, because Loki change only the throat". So
 * an exit follows from a nozzle number, and a nozzle number is published for
 * every motor whose CASE is in Loki's table, sheet on disk or not.
 *
 * TWO SOURCES FOR THE NUMBER, graded apart:
 *   - `loki-sheet` (high): the motor's own instruction sheet names it.
 *   - `loki-case-table` (medium): Loki's "Commercial Nozzle throat" column for
 *     that case. Published data, but joined through thrustcurve.org's
 *     `caseInfo` string rather than read off a sheet with the motor's own name
 *     on it, so it is one inference wide and says so.
 *
 * AND THE TWO AGREE EVERYWHERE BOTH EXIST. Every sheet was read independently
 * of the case table and no sheet contradicts the column for its case. That is
 * the check this section rests on, so it is RUN on every build
 * (`lokiSheetVsTable`, reported in the output) rather than claimed here.
 *
 * WHAT IS DELIBERATELY NOT USED. The same Tech Info table carries a "Suggested
 * EX Nozzle throat" column beside the commercial one, and it is a different
 * number: 38/480 suggests #22 where the commercial motor takes #19, 76/8000
 * suggests #60 against #56. It is a starting point for people making their own
 * propellant ("based on the use of typical packable EX propellant
 * formulations"). Taking that column instead would widen the 38/480 throat by
 * 34 % in area and move motors into the wrong exit band. Written down because
 * the two columns sit side by side and the wrong one is the easier to grab.
 *
 * AND THIS PARAGRAPH DID NOT PREVENT IT. The first transcription took the EX
 * number on all five rows where Loki's commercial cell is EMPTY, because it was
 * read from a flattened text dump in which an empty cell simply is not there.
 * See `LOKI_CASE_NOZZLE` below, which now carries both columns so the mistake
 * has nowhere to hide. A warning in a comment is not a mechanism.
 */

/**
 * Loki's published exit diameters, keyed by casing diameter in mm. Verbatim
 * from the Tech Info page, read 2026-09-13. A band runs `from` its nozzle
 * number `to` the next, inclusive; `Infinity` is their "and up".
 *
 * There is NO 98 mm or 114 mm band. Their 98 mm and 114 mm hardware sits under
 * "Historical Information Only — Not In Production", so the two 98 mm motors
 * thrustcurve.org still lists are a stated gap rather than an oversight.
 */
const LOKI_EXIT_BANDS = {
  38: [{ from: 10, to: 15, exitIn: 0.470 }, { from: 16, to: 18, exitIn: 0.630 },
    { from: 19, to: 24, exitIn: 0.780 }, { from: 25, to: Infinity, exitIn: 0.900 }],
  54: [{ from: 19, to: 23, exitIn: 0.850 }, { from: 24, to: 28, exitIn: 1.000 },
    { from: 29, to: Infinity, exitIn: 1.250 }],
  76: [{ from: 28, to: 39, exitIn: 1.255 }, { from: 40, to: 51, exitIn: 1.500 },
    { from: 52, to: Infinity, exitIn: 1.818 }],
};

/**
 * Loki's per-case nozzle columns, verbatim, keyed by the case designation
 * thrustcurve.org writes in `caseInfo`. Read cell by cell from the Tech Info
 * page's HTML (columns 7 and 8 of its one big table), 2026-09-13.
 *
 * BOTH COLUMNS ARE HERE, AND ONLY ONE IS USED. That is the whole point of the
 * shape.
 *
 * The first version of this constant was a flat `case -> number` map built from
 * a FLATTENED text dump of the page, and on every row where Loki's Commercial
 * cell is empty the flattening silently slid the Suggested EX number into its
 * place. FIVE of twenty keys were wrong that way — 76/4800 (#48), 98/5000
 * (#44), 98/7500 (#52), 98/10000 (#60) and 98/16000 (#80) are all EX numbers
 * sitting where a commercial one was claimed — and the comment above them said
 * "verbatim ... Commercial Nozzle throat column". No catalogued motor uses any
 * of those five cases, so nothing user-facing was ever wrong; a thrustcurve.org
 * refresh adding one 76/4800 motor would have published an EX throat as
 * commercial, in a field that buys thrust.
 *
 * Found 2026-09-13 by an adversarial re-check of this file's own claims, and it
 * is worth noticing WHAT it caught: the section header forty lines above warns
 * in capitals that the EX column is a different number and that "the wrong one
 * is the easier to grab". I wrote that warning and then grabbed the wrong one
 * five times. A warning is not a mechanism. THIS is the mechanism: a null
 * commercial cell is spelled out, the EX number sits beside it labelled, and
 * `lokiCommercialThroat()` is the only reader.
 *
 * `suggestedEx` is recorded rather than dropped precisely so nobody later
 * "fills in the gap" from the page and reintroduces the same error.
 */
const LOKI_CASE_NOZZLE = {
  // 29 mm has no commercial column at all — Loki list no 29 mm hardware.
  '38/120': { commercial: 10, suggestedEx: 11 },
  '38/240': { commercial: 16, suggestedEx: 16 },
  '38/480': { commercial: 19, suggestedEx: 22 },
  '38/740': { commercial: 22, suggestedEx: 28 },
  '38/1200': { commercial: 28, suggestedEx: 28 },
  '54/950': { commercial: 19, suggestedEx: 24 },
  '54/1200': { commercial: 24, suggestedEx: 29 },
  '54/1600': { commercial: 26, suggestedEx: 33 },
  '54/2000': { commercial: 29, suggestedEx: 36 },
  // The cell reads "#42 Single Use" — the number is stated, the qualifier is
  // Loki's own note that the 2800 case's nozzle is not reloadable.
  '54/2800': { commercial: 42, suggestedEx: 44 },
  // "Single Use" and nothing else: no number. L2050LW and M1378LR live here,
  // which is why they are a gap the owner is closing with calipers.
  '54/4000': { commercial: null, suggestedEx: null },
  '76/2400': { commercial: 28, suggestedEx: 32 },
  '76/3600': { commercial: 40, suggestedEx: 40 },
  '76/4800': { commercial: null, suggestedEx: 48 },
  '76/6000': { commercial: 52, suggestedEx: 52 },
  '76/8000': { commercial: 56, suggestedEx: 60 },
  '76/13000': { commercial: null, suggestedEx: 80 },
  // Everything below is under Loki's "Historical Information Only — Not In
  // Production" banner. 98/12500 is the one that matters and the one that has a
  // commercial number: the N3800-LW's own instruction sheet says #64 too, which
  // is a real corroboration across two documents. It still yields no EXIT,
  // because the exit-band table stops at 76 mm.
  '98/5000': { commercial: null, suggestedEx: 44 },
  '98/7500': { commercial: null, suggestedEx: 52 },
  '98/10000': { commercial: null, suggestedEx: 60 },
  '98/12500': { commercial: 64, suggestedEx: 76 },
  '98/16000': { commercial: null, suggestedEx: 80 },
  '114/6000': { commercial: null, suggestedEx: 48 },
  '114/9000': { commercial: null, suggestedEx: 60 },
  '114/12000': { commercial: null, suggestedEx: 64 },
  '114/22000': { commercial: null, suggestedEx: 90 },
};

/**
 * The COMMERCIAL throat for a case, or undefined. The only reader of the table
 * above, so the EX column cannot reach a shipped row by accident.
 */
const lokiCommercialThroat = (caseInfo) => {
  const cell = LOKI_CASE_NOZZLE[caseInfo];
  return cell && cell.commercial !== null ? cell.commercial : undefined;
};

/**
 * The 21 instruction sheets in `docs/Loki Data`, read 2026-09-13:
 * `[commonName, nozzle number, the throat the sheet PRINTS]`.
 *
 * The printed throat is kept so a reading can be checked against the paper; the
 * throat this file publishes is the exact n/64 that the number MEANS, because
 * that is Loki's definition and not a three-decimal rounding of it. The two are
 * checked against each other below.
 *
 * HOW THESE WERE READ, and why "the text of the PDF" is not the answer. Six of
 * the 76 mm sheets carry their table as an IMAGE with no text layer at all, and
 * on `76mm_L930_M1882_instructions.pdf` the text layer's READING ORDER pairs
 * each motor with the OTHER one's nozzle — L930 with #52, M1882 with #40.
 * Reading order is not layout. Every row here came from the WORD COORDINATES on
 * the page, or from the rendered image where there is no text, and each was
 * then checked against Loki's per-case column above and against the case length
 * the sheet prints beside it. `76mm Blue 8000 case.pdf` heads itself M-3464 and
 * labels its own table row M-3400; the headline is the motor, the row label is
 * Loki's typo, and the impulse (9395 N-sec) and case (40.875") settle it.
 */
const LOKI_SHEETS = [
  { file: '38mm Red.pdf', rows: [['G66', 10, 0.156], ['H90', 16, 0.250], ['I210', 19, 0.297], ['J320', 22, 0.344]] },
  { file: '38mm Spitfire.pdf', rows: [['G69', 10, 0.156], ['H100', 16, 0.250], ['I316', 19, 0.297], ['J396', 22, 0.344]] },
  { file: '38mm White.pdf', rows: [['G80', 10, 0.156], ['H144', 16, 0.250], ['I405', 19, 0.297], ['J528', 22, 0.344]] },
  { file: '38mm blue.pdf', rows: [['H160', 16, 0.250], ['I430', 19, 0.297], ['J712', 22, 0.344]] },
  { file: '38mm cocktail.pdf', rows: [['G70', 10, 0.156], ['H125', 16, 0.250], ['I377', 19, 0.297]] },
  { file: '38mm Blue 1200 case.pdf', rows: [['K1127', 28, 0.437]] },
  { file: '38mm Red Blue Cocktail 1200 case.pdf', rows: [['J1026', 28, 0.437]] },
  { file: '38mm Spitfire 1200 case.pdf', rows: [['J650', 28, 0.437]] },
  { file: '54mm White 1200.pdf', rows: [['J175', 24, 0.375], ['J525', 24, 0.375], ['J820', 24, 0.375]] },
  { file: '54mm Spitfire.pdf', rows: [['J350', 24, 0.375], ['K690', 29, 0.453], ['K830', 42, 0.656]] },
  { file: '54mm White 2000 case.pdf', rows: [['K250', 29, 0.453], ['K960', 29, 0.453]] },
  { file: '54mm_K350_L1400_instructions.pdf', rows: [['K350', 42, 0.656], ['L1400', 42, 0.656]] },
  { file: '76mm Red.pdf', rows: [['L480', 40, 0.625], ['M900', 52, 0.813]] },
  { file: '76mm Spitfire.pdf', rows: [['L780', 40, 0.625], ['M1200', 52, 0.813]] },
  { file: '76mm White.pdf', rows: [['L930', 40, 0.625], ['M1882', 52, 0.813]] },
  { file: '76mm Blue.pdf', rows: [['L1482', 40, 0.625], ['M2550', 52, 0.813]] },
  { file: '76mm_L930_M1882_instructions.pdf', rows: [['L930', 40, 0.625], ['M1882', 52, 0.813]] },
  { file: '76mm White M3k.pdf', rows: [['M3000', 56, 0.875]] },
  { file: '76mm Blue 8000 case.pdf', rows: [['M3464', 56, 0.875]] },
  { file: '76mm M1969 Spitfire.pdf', rows: [['M1969', 56, 0.875]] },
  { file: '98mm_N3800_instructions.pdf', rows: [['N3800', 64, 1.0]] },
];

const LOKI_TECH_INFO = 'lokiresearch.com Tech Info (published nozzle exit diameter table)';

/**
 * LOKI WILL MACHINE A 76 MM EXIT WIDER THAN THE ONE IN THE TABLE, and say so on
 * the same page (2026-09-13, Eric's ruling (b) on `issues-2026-09-13b.md`):
 *
 *   "76mm nozzle exits up to 2.0" are available upon request for an additional
 *    machining fee, however this removes more graphite material, thus weakening
 *    the part and making it more vulnerable to cracking."
 *
 * So the 76 mm figure this file publishes is the STANDARD one, and a flyer who
 * asked for a custom exit has a different nozzle in the case. 2.0 in against
 * 1.818 in is **21 % more AREA**, and on `Mach 3.rkt` the whole pressure-thrust
 * term was worth +5.54 % of apogee — so the difference is not decoration.
 *
 * WHY IT IS DATA AND NOT UI COPY. It is a fact Loki publish, with a citation,
 * about specific hardware. Spelling "Loki AND 76 mm" into a React component
 * would put a manufacturer's data in the one place nothing checks it; here it
 * rides with the row, the panel renders whatever it finds, and the day another
 * casing or another maker offers the same thing it is one line in this file.
 *
 * ONLY 76 mm: Loki's note names no other size, and 38/54 mm flyers seeing a
 * caution about an option they cannot buy is exactly the noise Eric's ruling
 * on the absence-line was about. His reasoning for showing it at all: "since
 * these are custom built nozzles, the user will definitely know they are using
 * a non-standard exit diameter and will know to update that field. The average
 * user may not even know what the exit diameter is or why it should be changed."
 */
const LOKI_CUSTOM_EXIT_CASING_MM = 76;
const LOKI_CUSTOM_EXIT_MAX_IN = 2.0;

/** The exit Loki mould for this nozzle number in this casing, or undefined. */
const lokiBand = (casingMm, nozzleNo) => (LOKI_EXIT_BANDS[casingMm] ?? [])
  .find((b) => nozzleNo >= b.from && nozzleNo <= b.to);

/** Which band a number landed in, spelled out for the provenance line. */
function lokiBandLabel(casingMm, nozzleNo) {
  const b = lokiBand(casingMm, nozzleNo);
  if (!b) return undefined;
  const range = b.to === Infinity ? `#${b.from} and up` : `#${b.from} thru #${b.to}`;
  return `${casingMm} mm, ${range} = ${b.exitIn.toFixed(3)} in`;
}

const LOKI = motorsDb.motors.filter((m) => m.manufacturerAbbrev === 'Loki');

// `commonName` is the join key: it is what Loki's sheets print once the hyphen
// is dropped ("J-525" -> "J525"), and it is unique across all 60 Loki rows in
// the bundled catalogue. The designation is not usable — the catalogue appends
// the propellant ("J525-LW", "HP-G69-SF") and the sheets never do.
const lokiByCommon = new Map();
for (const m of LOKI) {
  if (lokiByCommon.has(m.commonName)) {
    throw new Error(`Loki commonName ${m.commonName} is not unique in the catalogue — the join key has to change.`);
  }
  lokiByCommon.set(m.commonName, m);
}

// Sheet readings per motor. A motor printed on two sheets — L930 and M1882 are,
// on the 2005 instruction sheet and again on the 2013 reload-kit sheet — keeps
// both files as provenance and has to agree with itself.
const lokiFromSheet = new Map();
const lokiSheetProblems = [];
for (const { file, rows: sheetRows } of LOKI_SHEETS) {
  for (const [common, nozzleNo, printedThroatIn] of sheetRows) {
    // The number IS the throat in 64ths — Loki's own definition — so the
    // printed decimal is a rounding of it, and a disagreement wider than that
    // rounding means one of the two was misread.
    if (Math.abs(nozzleNo / 64 - printedThroatIn) > 0.001) {
      lokiSheetProblems.push(`${file} ${common}: #${nozzleNo} is ${(nozzleNo / 64).toFixed(4)} in, sheet prints ${printedThroatIn}`);
    }
    const prev = lokiFromSheet.get(common);
    if (prev && prev.nozzleNo !== nozzleNo) {
      lokiSheetProblems.push(`${common}: ${prev.files.join(', ')} say #${prev.nozzleNo}, ${file} says #${nozzleNo}`);
    }
    if (prev) prev.files.push(file);
    else lokiFromSheet.set(common, { nozzleNo, printedThroatIn, files: [file] });
  }
}
for (const common of lokiFromSheet.keys()) {
  if (!lokiByCommon.has(common)) {
    lokiSheetProblems.push(`${common}: read off a sheet, but the catalogue has no Loki motor by that name`);
  }
}

// THE CROSS-CHECK, run rather than asserted: every sheet reading against Loki's
// own per-case commercial throat column, wherever both exist.
const lokiSheetVsTable = [...lokiFromSheet]
  .map(([common, read]) => {
    const m = lokiByCommon.get(common);
    const stated = m?.caseInfo ? lokiCommercialThroat(m.caseInfo) : undefined;
    return stated === undefined ? null : {
      commonName: common,
      caseInfo: m.caseInfo,
      sheetNozzleNo: read.nozzleNo,
      caseTableNozzleNo: stated,
      agrees: stated === read.nozzleNo,
      sheets: read.files,
    };
  })
  .filter((x) => x !== null)
  .sort((a, b) => a.commonName.localeCompare(b.commonName));

const lokiRows = [];
for (const m of LOKI) {
  const read = lokiFromSheet.get(m.commonName);
  const fromTable = m.caseInfo ? lokiCommercialThroat(m.caseInfo) : undefined;
  const nozzleNo = read?.nozzleNo ?? fromTable;
  // No sheet and no case in Loki's own column: nothing published at all. No
  // row, and the motor is named in `uncovered` instead — the same treatment as
  // an AeroTech motor whose reload kit has no assembly drawing.
  if (nozzleNo === undefined) continue;

  const throatIn = Math.round((nozzleNo / 64) * 1e4) / 1e4;
  const exitIn = lokiBand(m.diameter, nozzleNo)?.exitIn;
  const fromSheet = read !== undefined;

  lokiRows.push({
    motorId: m.motorId,
    manufacturer: 'Loki',
    designation: m.designation,
    catalogDesignation: m.designation,
    commonName: m.commonName,
    caseFamily: m.caseInfo ?? 'no case stated',
    casingDiameterMm: m.diameter,
    // Loki publish no nozzle part numbers; the ENGRAVED NUMBER is the part's
    // identity, and checking it is what the instruction sheet tells a flyer to
    // do before every flight. So that is what this field carries.
    nozzlePartNo: `#${nozzleNo}`,
    ...(exitIn !== undefined ? { exitDiameterM: round6(inToM(exitIn)), exitDiameterIn: exitIn } : {}),
    throatDiameterM: round6(inToM(throatIn)),
    throatDiameterIn: throatIn,
    exitSource: exitIn === undefined ? 'none' : fromSheet ? 'loki-sheet' : 'loki-case-table',
    exitConfidence: exitIn === undefined ? 'none' : fromSheet ? 'high' : 'medium',
    ...(exitIn === undefined
      ? {
        confidenceNote: `Loki publish no exit-diameter band for ${m.diameter} mm — their ${m.diameter} mm `
          + 'hardware is listed as "Historical Information Only — Not In Production" and the exit table '
          + `stops at 76 mm. The throat is known (#${nozzleNo}); the exit is not.`,
      }
      : !fromSheet
        ? {
          confidenceNote: 'No instruction sheet for this motor is on disk. The nozzle is the one Loki\'s own '
            + `"Commercial Nozzle throat" column gives for the ${m.caseInfo} case (#${nozzleNo}); every one of `
            + `the ${lokiSheetVsTable.length} motors whose sheet IS on disk agrees with that column, but this `
            + 'row is the column and not the sheet.',
        }
        : {}),
    // Loki's own published note about custom exits, on the rows it applies to.
    // Only where an exit was actually published: a row with no figure has
    // nothing for the note to qualify.
    ...(exitIn !== undefined && m.diameter === LOKI_CUSTOM_EXIT_CASING_MM
      ? {
        customExitNote: `Loki will machine a 76 mm exit out to ${LOKI_CUSTOM_EXIT_MAX_IN.toFixed(1)} in on request `
          + `(their own note, for a machining fee). This is their STANDARD ${exitIn} in. If yours was `
          + `machined out, type it — ${LOKI_CUSTOM_EXIT_MAX_IN.toFixed(1)} in is `
          + `${Math.round(((LOKI_CUSTOM_EXIT_MAX_IN / exitIn) ** 2 - 1) * 100)} % more exit AREA.`,
      }
      : {}),
    provenance: {
      lomDescription: fromSheet
        ? `Nozzle Size #${nozzleNo} ${read.printedThroatIn.toFixed(3)}" (instruction sheet table)`
        : `Commercial Nozzle throat #${nozzleNo} for the ${m.caseInfo} case (Tech Info table)`,
      matchedVia: m.commonName,
      ...(exitIn !== undefined
        ? { exitFrom: `${LOKI_TECH_INFO}: ${lokiBandLabel(m.diameter, nozzleNo)}` }
        : {}),
      assemblyDrawings: fromSheet
        ? [...read.files.map((f) => `Loki instruction sheet "${f}" (docs/Loki Data)`), LOKI_TECH_INFO]
        : [LOKI_TECH_INFO],
    },
  });
}

// A misread sheet is a wrong exit AREA on a live motor, so it stops the build
// rather than shipping. The two checks it covers — the engraved number against
// the throat the same cell prints, and a motor that appears on two sheets
// against itself — are the only two places the transcription above can be
// checked without the paper.
if (lokiSheetProblems.length > 0) {
  console.error('Loki sheet readings do not hold together:');
  for (const p of lokiSheetProblems) console.error(`  ${p}`);
  process.exit(1);
}
const lokiDisagree = lokiSheetVsTable.filter((x) => !x.agrees);
if (lokiDisagree.length > 0) {
  console.error('A Loki instruction sheet disagrees with Loki\'s own commercial-throat column:');
  for (const d of lokiDisagree) {
    console.error(`  ${d.commonName} (${d.caseInfo}): sheet #${d.sheetNozzleNo}, table #${d.caseTableNozzleNo}`);
  }
  process.exit(1);
}

// ONE table, two manufacturers, one sort — so the file still diffs cleanly and
// nothing downstream has to know there are two sources behind it.
/**
 * EVERY DMS ROW IS OF A SINGLE-USE MOTOR, asserted rather than assumed.
 *
 * "DMS Motor Designs" is AeroTech's single-use line, so a row built from one of
 * those sheets that lands on a RELOADABLE catalogue motor is a mis-join — and
 * the catalogue has both forms of several motors (H550ST the RMS-38/360 reload
 * against HP-H550ST the DMS), so this is a live way to get it wrong rather than
 * a theoretical one. All 40 matched DMS rows satisfy it today.
 *
 * This is also the reason the app's own `findDbMotor` legitimately disagrees on
 * one of them: it has no notion of which document family a row came from, so
 * given "H550ST-14A" it returns the reload. `nozzle-db.test.mjs` documents that
 * narrowly instead of failing on it — see its join section.
 */
const dmsMisjoined = motorRows
  .filter((m) => m.docFamily === 'dms' && m.motorId)
  .filter((m) => byMotorId.get(m.motorId)?.type !== 'SU')
  .map((m) => `${m.designation} -> ${m.catalogDesignation} (type ${byMotorId.get(m.motorId)?.type})`);
if (dmsMisjoined.length > 0) {
  console.error('A DMS single-use drawing matched a motor the catalogue does not call single-use:');
  for (const d of dmsMisjoined) console.error(`  ${d}`);
  process.exit(1);
}

motorRows.push(...lokiRows);

/**
 * MEASURED NOZZLES, MERGED — and until 2026-09-13 they were not.
 *
 * `MEASURED_NOZZLES` was written on 2026-09-08 as the documented landing place
 * for a nozzle nobody publishes, and `gaps.Loki` told the owner to put his
 * caliper readings there. It was emitted as `measured` in the JSON and NEVER
 * MERGED INTO `motors`, so a row put there would have reached the file and not
 * the app: `nozzleDb.ts` reads `motors` and nothing else. The escape hatch was
 * a hole. Found 2026-09-13, the day before Eric measures the two 54/4000
 * one-time-use nozzles (L2050LW, M1378LR) that are the last closeable Loki gap.
 *
 * TWO RULES, both deliberate:
 *
 *  1. A measurement fills a motor that has NO row. It never overwrites a
 *     published one. If it names a motor already covered, the build FAILS
 *     rather than silently preferring one source over the other — that is a
 *     decision a person should make in the open, not a precedence rule hidden
 *     in a script. (Today no measured entry collides with anything.)
 *  2. Provenance is mandatory, exactly as it is for a published row: who
 *     measured it and when. A measured number with no measurer is
 *     indistinguishable, downstream, from one read off a drawing.
 *
 * `exitSource: 'measured'` and `exitConfidence: 'high'` — high because a
 * caliper on the part in hand is better evidence about THAT part than a band
 * that covers a run of throat sizes; the source field is what keeps the two
 * kinds of number tellable apart.
 */
const measuredRows = [];
const measuredProblems = [];
for (const mn of MEASURED_NOZZLES) {
  if (!(mn.exitDiameterIn > 0)) { measuredProblems.push(`${mn.partNo}: no usable exitDiameterIn`); continue; }
  if (!mn.measuredBy || !mn.measuredOn) { measuredProblems.push(`${mn.partNo}: measurements need measuredBy and measuredOn`); continue; }
  if (!Array.isArray(mn.appliesTo) || mn.appliesTo.length === 0) { measuredProblems.push(`${mn.partNo}: appliesTo names no motor`); continue; }
  for (const want of mn.appliesTo) {
    const m = motorsDb.motors.find((x) => x.designation === want || x.commonName === want);
    if (!m) { measuredProblems.push(`${mn.partNo}: the catalogue has no motor "${want}"`); continue; }
    if (motorRows.some((r) => r.motorId === m.motorId)) {
      measuredProblems.push(`${mn.partNo}: ${want} already has a PUBLISHED row — a measurement must not `
        + 'silently replace one. Decide which source wins and say so here.');
      continue;
    }
    const exitIn = mn.exitDiameterIn;
    const throatIn = mn.throatDiameterIn;
    measuredRows.push({
      motorId: m.motorId,
      manufacturer: mn.manufacturer,
      designation: m.designation,
      catalogDesignation: m.designation,
      commonName: m.commonName,
      caseFamily: m.caseInfo ?? 'no case stated',
      casingDiameterMm: m.diameter,
      nozzlePartNo: mn.partNo,
      exitDiameterM: round6(inToM(exitIn)),
      exitDiameterIn: exitIn,
      ...(throatIn > 0
        ? { throatDiameterM: round6(inToM(throatIn)), throatDiameterIn: throatIn }
        : {}),
      exitSource: 'measured',
      exitConfidence: 'high',
      confidenceNote: `Measured from the hardware by ${mn.measuredBy} on ${mn.measuredOn}, because `
        + `${mn.manufacturer} publish no figure for this motor. Not a published number.`,
      provenance: {
        lomDescription: `${mn.partNo} — measured exit ${exitIn} in`
          + (throatIn > 0 ? `, throat ${throatIn} in` : ''),
        matchedVia: want,
        exitFrom: `Measured: ${mn.measuredBy}, ${mn.measuredOn}`,
        assemblyDrawings: [`Measured from the hardware (${mn.measuredBy}, ${mn.measuredOn})`],
      },
    });
  }
}
if (measuredProblems.length > 0) {
  console.error('MEASURED_NOZZLES cannot be merged:');
  for (const p of measuredProblems) console.error(`  ${p}`);
  process.exit(1);
}
motorRows.push(...measuredRows);
motorRows.sort((a, b) => a.manufacturer.localeCompare(b.manufacturer)
  || a.designation.localeCompare(b.designation)
  || a.caseFamily.localeCompare(b.caseFamily));

const observationProblems = [];
for (const ob of DMS_SHEET_OBSERVATIONS) {
  for (const des of ob.motors) {
    const row = motorRows.find((m) => m.designation === des);
    if (!row) { observationProblems.push(`${des}: named in DMS_SHEET_OBSERVATIONS but has no row`); continue; }
    const actual = ob.field === 'exit' ? (row.exitDiameterIn ?? null)
      : ob.field === 'throat' ? (row.throatDiameterIn ?? null)
        : ob.field === 'exitSource' ? row.exitSource : undefined;
    if (actual === undefined) { observationProblems.push(`${des}: unknown observation field "${ob.field}"`); continue; }
    if (actual !== ob.published) {
      observationProblems.push(`${des}: the observation says this file publishes ${JSON.stringify(ob.published)} `
        + `for ${ob.field}, but it publishes ${JSON.stringify(actual)}`);
    }
    // CHECK THE OTHER HALF TOO (2026-09-14, from review). Only `published` was compared, and
    // every one of these observations is a claim about TWO numbers: what the drawing says
    // (`onSheet`) and what we publish (`published`). The entry that had to be withdrawn was
    // wrong in its `published` half, so the check written in response covers exactly the
    // failure that had already happened and nothing else — and for K76WN-P and I40N-P the
    // assertion reduces to `null === null`, which passes even if the observation were attached
    // to a completely different part. `onSheet` is the half a mistyped verification input
    // corrupts, which is precisely how the withdrawn entry got here.
    if (ob.onSheet !== undefined) {
      if (typeof ob.onSheet !== 'number' || !Number.isFinite(ob.onSheet) || ob.onSheet <= 0) {
        observationProblems.push(`${des}: onSheet is ${JSON.stringify(ob.onSheet)}, which is not a dimension`);
      } else if (ob.published !== null && Math.abs(ob.onSheet - ob.published) < 1e-9) {
        // If the two agree there is no observation to make: these entries exist only to
        // record a difference between the drawing and the file.
        observationProblems.push(`${des}: onSheet and published are the same number `
          + `(${ob.onSheet}), so there is nothing for this observation to observe`);
      }
    }
    // An observation must name the part it is about, so it cannot silently survive the row
    // being re-keyed to a different nozzle.
    if (ob.partNo !== undefined && row.nozzlePartNo !== ob.partNo) {
      observationProblems.push(`${des}: the observation is about part ${ob.partNo}, but this row's `
        + `nozzle is ${JSON.stringify(row.nozzlePartNo)}`);
    }
  }
}
if (observationProblems.length > 0) {
  console.error('DMS_SHEET_OBSERVATIONS does not describe the rows this build produced:');
  for (const o of observationProblems) console.error(`  ${o}`);
  process.exit(1);
}

/**
 * Which motors a no-exit part affects, and the DMS observation check — BOTH RUN AFTER EVERY
 * ROW EXISTS (moved here 2026-09-14, from review).
 *
 * They used to sit immediately after the AeroTech loop, while `motorRows` still held ONLY
 * AeroTech rows: Loki's are pushed further down and the measured ones after those. So an
 * observation naming a Loki motor reported "named in DMS_SHEET_OBSERVATIONS but has no row"
 * and exited 1 on a file that does contain the row, and a NO_EXIT_NOTES entry for a Loki or
 * measured part silently produced no "Affects ..." sentence at all — a check that fails on
 * good data, and a check that passes by finding nothing. Neither could bite today because
 * every entry in both tables is AeroTech's, which is precisely why they would have bitten
 * the first person to add a Loki one.
 *
 * ONE PASS, ONE MAP (2026-09-14, from review). `noExitAffects(p.partNo)` was called twice per
 * part — once for the length test and once for the join — so every no-exit part scanned all
 * of `motorRows` twice.
 */
const affectedByPart = new Map();
for (const m of motorRows) {
  if (!m.nozzlePartNo) continue;
  if (!affectedByPart.has(m.nozzlePartNo)) affectedByPart.set(m.nozzlePartNo, []);
  affectedByPart.get(m.nozzlePartNo).push(m.designation);
}
for (const list of affectedByPart.values()) list.sort();
const noExitAffects = (partNo) => affectedByPart.get(partNo) ?? [];

const partRows = [...parts.values()]
  .map((p) => {
    const affects = noExitAffects(p.partNo);
    return {
      ...p,
      ...(p.exitDiameterIn !== undefined ? { exitDiameterM: round6(inToM(p.exitDiameterIn)) } : {}),
      ...(p.throatDiameterIn !== undefined ? { throatDiameterM: round6(inToM(p.throatDiameterIn)) } : {}),
      ...(NO_EXIT_NOTES[p.partNo]
        ? { note: NO_EXIT_NOTES[p.partNo] + (affects.length ? ` Affects ${affects.join(', ')}.` : '') }
        : {}),
    };
  })
  .sort((a, b) => a.partNo.localeCompare(b.partNo));

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
/**
 * PER MANUFACTURER since 2026-09-13, because there are now two of them and one
 * table keyed by casing diameter alone would have added AeroTech's 38 mm motors
 * to Loki's and reported a coverage figure for neither.
 *
 * `withExitDiameter` is counted apart from `withNozzleRow` (2026-09-13). A row
 * is not a number: J615ST-20A has a row and no exit because an aerospike has no
 * exit plane, and Loki's N3800 has a row with a known #64 throat and no exit
 * because Loki's exit table stops at 76 mm. Quoting "has a row" as coverage of
 * the thing the app actually needs would overstate both.
 */
const coverageFor = (motors) => {
  const have = new Map(motorRows.filter((m) => m.motorId).map((m) => [m.motorId, m]));
  const by = new Map();
  for (const m of motors) {
    // In production only: coverage of motors nobody can buy is not the claim
    // anyone means, and `uncovered` below lists the retired ones regardless.
    if (m.availability === 'OOP') continue;
    if (!by.has(m.diameter)) {
      by.set(m.diameter, { inProduction: 0, withNozzleRow: 0, withExitDiameter: 0, missing: [] });
    }
    const e = by.get(m.diameter);
    e.inProduction++;
    const row = have.get(m.motorId);
    if (row) {
      e.withNozzleRow++;
      if (row.exitDiameterM !== undefined) e.withExitDiameter++;
    } else e.missing.push(m.designation);
  }
  return Object.fromEntries([...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mm, e]) => [String(mm), { ...e, missing: e.missing.sort() }]));
};

// Figures quoted in `gaps.AeroTechSingleUse`, counted rather than written down
// — the last hand-written coverage claim in this file ("every 98 mm motor")
// was wrong by four motors.
const dmsWithExit = motorRows.filter((m) => m.docFamily === 'dms' && m.exitDiameterM !== undefined
  && m.motorId && byMotorId.get(m.motorId)?.availability !== 'OOP').length;
const uncoveredInProd = (() => {
  const have = new Set(motorRows.filter((m) => m.motorId).map((m) => m.motorId));
  return AEROTECH.filter((m) => m.availability !== 'OOP' && !have.has(m.motorId)).length;
})();

const db = {
  generated: sourceDate,
  source: 'AeroTech / RCS Rocket Motor Components published drawings and store pages; Loki Research published instruction sheets and Tech Info tables',
  sourceNote: 'docs/RCS Schematics and docs/Loki Data (both LOCAL-ONLY, gitignored). Regenerate with packages/app/scripts/build-nozzle-db.mjs.',
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
    // THE NUMBER THE GUIDE QUOTES, DERIVED (2026-09-14, from review). The guide said "278
    // motors you can load" as hand-typed prose with nothing behind it, and the paragraph's
    // own components (221 AeroTech + 54 Loki) sum to 275, because three of the covered motors
    // are out of production and the sentence never said so. Neither `motorsWithExit` (287, all
    // rows) nor `motorsMatchedToCatalogue` (287, ignoring the exit) is that figure: a motor a
    // user can LOAD and get a number for needs BOTH a catalogue id and an exit. It is now
    // counted here, so the guide can quote a build-derived value the way the coverage block
    // already forced everything else to - the 287 this replaced survived exactly because
    // nothing computed it.
    motorsLoadableWithExit: motorRows.filter((m) => m.motorId && m.exitDiameterM !== undefined).length,
    // The honest coverage figure — AND IT IS PER MANUFACTURER, because it was
    // not, and that broke the moment a second manufacturer arrived.
    //
    // It was written in v0.120 as "every row whose motor is in production",
    // over `catalogueAeroTechInProduction`, which was right while AeroTech
    // were the only source. v0.127 added 55 Loki rows to the same array and the
    // numerator silently picked them up — the release printed
    // "of the IN-PRODUCTION AeroTech 244 (89.7 % of 272)" using a numerator
    // that already contained Loki. Nothing noticed until 2026-09-13, when the
    // DMS drawings pushed it to 284 and the line read 104.4 % OF ITS OWN
    // DENOMINATOR. A percentage over 100 is the only reason this was caught,
    // which is a poor way to find out.
    //
    // Two named fields now, each over its own catalogue total, and
    // `coverage.byManufacturer` is the authority either way.
    aerotechMatched: motorRows.filter((m) => m.manufacturer === 'AeroTech' && m.motorId).length,
    lokiMatched: motorRows.filter((m) => m.manufacturer === 'Loki' && m.motorId).length,
    aerotechMatchedInProduction: motorRows.filter((m) => m.manufacturer === 'AeroTech' && m.motorId
      && byMotorId.get(m.motorId)?.availability !== 'OOP').length,
    lokiMatchedInProduction: motorRows.filter((m) => m.manufacturer === 'Loki' && m.motorId
      && byMotorId.get(m.motorId)?.availability !== 'OOP').length,
    motorsWithTwoNozzleOptions: motorRows.filter((m) => m.exitAmbiguous).length,
    catalogueMotors: motorsDb.motors.length,
    catalogueAeroTech: AEROTECH.length,
    catalogueAeroTechInProduction: AEROTECH.filter((m) => m.availability !== 'OOP').length,
    // The two AeroTech document families, counted apart. "assemblyDrawings"
    // above is both of them together, which is why these exist.
    reloadableDrawings: raw.assemblies.filter((a) => a.docFamily !== 'dms').length,
    dmsDrawings: raw.assemblies.filter((a) => a.docFamily === 'dms').length,
    dmsRows: motorRows.filter((m) => m.docFamily === 'dms').length,
    dmsRowsWithExit: motorRows.filter((m) => m.docFamily === 'dms' && m.exitDiameterM !== undefined).length,
    dmsInProductionWithExit: dmsWithExit,
    lokiSheetsRead: LOKI_SHEETS.length,
    lokiMotorsOnASheet: lokiFromSheet.size,
    lokiRows: lokiRows.length,
    lokiRowsWithExit: lokiRows.filter((m) => m.exitDiameterM !== undefined).length,
    lokiRowsFromCaseTable: lokiRows.filter((m) => m.exitSource === 'loki-case-table').length,
    catalogueLoki: LOKI.length,
    catalogueLokiInProduction: LOKI.filter((m) => m.availability !== 'OOP').length,
  },
  gaps: {
    Loki: `Covered since 2026-09-13 from Loki's OWN published tables, not from measurement: their Tech Info page prints the nozzle exit diameter per casing and nozzle-number band, and each reload kit's instruction sheet names the nozzle that motor takes. ${lokiRows.filter((m) => m.exitDiameterM !== undefined).length} of ${LOKI.length} catalogued Loki motors now carry an exit. WHAT IS STILL SHORT — four motors, and Eric ruled on each of them 2026-09-13: N3800-LW and N5500LW are SPECIALIST MOTORS HE DOES NOT HAVE THE FIGURES FOR ("we can leave them as unknown and, if we get the data, we can update the database") — Loki publish no exit band above 76 mm, their 98 mm hardware being listed "Historical Information Only — Not In Production", so N3800-LW carries its #64 throat and no exit and N5500LW has neither. L2050LW and M1378LR (54/4000, whose commercial-throat cell reads "Single Use") are ONE-TIME-USE NOZZLES HE OWNS AND WILL MEASURE — expect those two through MEASURED_NOZZLES, not through a sheet. H500-LW is a fifth row-less motor, out of production with no case stated. All are named in \`uncovered\`.`,
    Cesaroni: 'No published nozzle geometry found on pro38.com or elsewhere (owner searched 2026-09-08). Known gap. Worth re-checking the way Loki\'s was: the Loki exits were on a page we had both already read, at the foot of it, under a heading we were not looking for.',
    AeroTechSingleUse: `AeroTech publish an assembly drawing for RELOADABLE motors, because the drawing is the reload kit's parts list — that is the "Motor Assembly Drawings" folder. SINCE 2026-09-13 THE SINGLE-USE DMS LINE IS READ TOO, from "DMS Motor Designs": 51 sheets, 29 mm to 152 mm, in the identical LIST OF MATERIAL format and naming the same nozzle part families, which is worth ${dmsWithExit} more motors with a published exit. That folder was FOUND on 2026-09-08 and left unread for five days behind a deferral ("adding a document family is a decision rather than a fix") that was recorded here and never actually put to the owner — he asked why on 2026-09-13 and there was no good answer. What is STILL not covered is the older single-use line, which has neither a reload kit nor a DMS sheet: ${uncoveredInProd} in-production AeroTech motors have no row here at all, most of them 24 mm and 29 mm hobby motors, and every one is named in \`uncovered\`.`,
  },
  coverage: {
    note: 'What this file covers, per MANUFACTURER and then per motor CASING DIAMETER, counted from motors.json at build time rather than written down. A hand-written coverage claim is exactly how "every 98 mm motor" reached a release note while four in-production 98 mm motors had no row here (M1305M, M1340W, N1975W-PS, O5500X-PS). "inProduction" is the rows this catalogue does not mark OOP; "withNozzleRow" is how many have a row here and "withExitDiameter" how many of those carry the number the app actually needs — they differ where a row exists with no exit (an aerospike, or a Loki motor larger than Loki\'s published exit table). Every motor short of a row is named, and named again in `uncovered`.',
    byManufacturer: {
      AeroTech: { byCasingDiameterMm: coverageFor(AEROTECH) },
      Loki: { byCasingDiameterMm: coverageFor(LOKI) },
    },
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
    for (const m of [...AEROTECH, ...LOKI]) {
      if (have.has(m.motorId)) continue;
      const key = `${m.manufacturerAbbrev} ${m.diameter} mm ${m.caseInfo || 'single-use (no reload case)'}`;
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
    // The second independent check in this file, and the one the whole Loki
    // section rests on: every motor whose instruction sheet is on disk, read
    // from the sheet, against the "Commercial Nozzle throat" Loki publish for
    // that case. Two documents, no shared step. Recorded rather than only
    // asserted so a reader can see the agreement instead of taking it on trust
    // — and the build refuses to write this file if any row says `agrees:
    // false`.
    dmsSheetObservations: {
      note: `The ${motorRows.filter((m) => m.docFamily === 'dms' && m.exitDiameterM !== undefined).length} `
        + `DMS rows that carry an EXIT were read back from their own PDFs on 2026-09-13 by readers other `
        + `than the code that built them, and each of those exits was then attacked by a second reader `
        + `told to refute it. NONE was refuted. (There are `
        + `${motorRows.filter((m) => m.docFamily === 'dms').length} DMS rows in all; the rest publish no `
        + `exit, so there was no exit to check.) These are the differences between what the drawings show `
        + `and what this file publishes, kept as a comparison — a drawing callout is an unlabelled number `
        + `and is never an input here.`,
      rows: DMS_SHEET_OBSERVATIONS,
    },
    lokiSheetAgainstCaseTable: {
      note: `${lokiSheetVsTable.filter((x) => x.agrees).length} of ${lokiSheetVsTable.length} instruction-sheet readings agree with Loki's own per-case commercial-throat column. A disagreement fails the build.`,
      rows: lokiSheetVsTable,
    },
  },
  nozzles: partRows,
  motors: motorRows,
};

writeFileSync(OUT, `${JSON.stringify(db, null, 1)}\n`);

// ------------------------------------------------------------------ report

const c = db.counts;
const pct = (n, d) => `${((n / d) * 100).toFixed(1)} %`;
console.log(`assembly drawings parsed          ${c.assemblyDrawings}`);
console.log(`  reloadable / DMS single-use     ${c.reloadableDrawings} / ${c.dmsDrawings}`);
console.log(`  nozzle part resolved            ${c.nozzlePartResolved} (${pct(c.nozzlePartResolved, c.assemblyDrawings)})`);
console.log(`distinct nozzle parts             ${c.distinctNozzleParts}`);
console.log(`  with an exit diameter           ${c.partsWithExitDiameter}`);
console.log(`  exit resolved per motor         ${c.partsResolvedPerMotor} (Medusa: depends which throats the motor opens)`);
console.log(`motors (rows)                     ${motorRows.length}`);
// PER MANUFACTURER (2026-09-13, from review). This printed
// `motorsMatchedToCatalogue` — EVERY maker's rows — as a percentage of
// `catalogueAeroTech`: the same Loki-contamination bug fixed in the counts
// block above, one line away, in the same commit, and missed. It read
// "287 (93.5 % of AeroTech)" when AeroTech's own figure is 231/307 = 75.2 %.
console.log(`  matched into motors.json        ${c.motorsMatchedToCatalogue} (${pct(c.motorsMatchedToCatalogue, c.catalogueMotors)} of all ${c.catalogueMotors})`);
console.log(`    AeroTech                      ${c.aerotechMatched} (${pct(c.aerotechMatched, c.catalogueAeroTech)} of ${c.catalogueAeroTech})`);
console.log(`    Loki                          ${c.lokiMatched} (${pct(c.lokiMatched, c.catalogueLoki)} of ${c.catalogueLoki})`);
console.log(`  of the IN-PRODUCTION AeroTech   ${c.aerotechMatchedInProduction} (${pct(c.aerotechMatchedInProduction, c.catalogueAeroTechInProduction)} of ${c.catalogueAeroTechInProduction})`);
console.log(`  of the IN-PRODUCTION Loki       ${c.lokiMatchedInProduction} (${pct(c.lokiMatchedInProduction, c.catalogueLokiInProduction)} of ${c.catalogueLokiInProduction})`);
console.log(`  with an exit diameter           ${c.motorsWithExit}`);
// ONE POPULATION PER HEADING (2026-09-14, from review). This loop counted ALL rows while
// printed as an indented subdivision of "with an exit diameter", so the report read
// `with an exit diameter 287` over `high 238 / medium 48 / low 1 / none 10` - 238+48+1 = 287,
// and the 10 "none" rows are exactly the ones that heading EXCLUDES. A reader totalling the
// indented lines got 297 under a heading of 287. Same mixed-population fault fixed three
// lines above, in the same block, in the same commit.
for (const conf of ['high', 'medium', 'low', 'per-motor']) {
  const n = motorRows.filter((m) => m.exitDiameterM !== undefined && m.exitConfidence === conf).length;
  if (n) console.log(`    confidence ${conf.padEnd(10)}      ${n}`);
}
const noExitRows = motorRows.filter((m) => m.exitDiameterM === undefined).length;
if (noExitRows) console.log(`  with NO exit diameter           ${noExitRows} (each reason is in the part's note)`);
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
for (const [maker, cov] of Object.entries(db.coverage.byManufacturer)) {
  console.log(`\nin-production ${maker} coverage, by casing diameter`);
  for (const [mm, e] of Object.entries(cov.byCasingDiameterMm)) {
    console.log(`  ${`${mm} mm`.padEnd(8)} ${String(e.withExitDiameter).padStart(3)} with an exit`
      + ` of ${String(e.inProduction).padEnd(3)}`
      + (e.withNozzleRow !== e.withExitDiameter ? ` (${e.withNozzleRow} rows)` : '')
      + (e.missing.length ? `  no row: ${e.missing.join(' ')}` : '  (all)'));
  }
}

// Loki, whose whole section rests on two documents agreeing (2026-09-13).
console.log(`\nLoki: ${c.lokiSheetsRead} instruction sheets read, ${c.lokiMotorsOnASheet} motors named on one`);
console.log(`  rows written                    ${c.lokiRows} of ${c.catalogueLoki} catalogued Loki motors`);
console.log(`    with an exit diameter         ${c.lokiRowsWithExit}`);
console.log(`    nozzle from the case table    ${c.lokiRowsFromCaseTable} (no sheet on disk for these)`);
console.log(`  sheet vs Loki's own case table  ${lokiSheetVsTable.filter((x) => x.agrees).length}/${lokiSheetVsTable.length} agree`);

// DMS, added 2026-09-13 — the folder that sat unread for five days.
console.log(`
AeroTech DMS single-use: ${c.dmsDrawings} sheets read`);
console.log(`  rows written                    ${c.dmsRows}`);
console.log(`    with an exit diameter         ${c.dmsRowsWithExit}`);
console.log(`    IN PRODUCTION, with an exit   ${c.dmsInProductionWithExit}`);

const uncoveredTotal = Object.values(db.uncovered).reduce((a, v) => a + v.length, 0);
// `uncovered` has held BOTH makers since v0.127, so this label was wrong too —
// it printed 80 under an "AeroTech" heading when AeroTech's own count is 76
// (2026-09-13, from review). Same shape as the percentage above: a figure that
// grew a second manufacturer and kept its old name.
// GROUPED, NOT PREFIX-MATCHED-AND-SUBTRACTED (2026-09-14, from review). This filtered on
// `k.startsWith('AeroTech')` and called the REMAINDER Loki - correct only while exactly two
// makers exist, and `db.gaps` already names Cesaroni as a live gap. The first third
// manufacturer would have had its motors printed as Loki's: the identical fault the comment
// two lines up describes, reintroduced one line below it. The key's first token IS the
// manufacturer, so group by it and let a new maker appear on its own line.
const uncoveredByMaker = new Map();
for (const [k, v] of Object.entries(db.uncovered)) {
  const maker = k.split(/[\s/]/)[0];
  uncoveredByMaker.set(maker, (uncoveredByMaker.get(maker) ?? 0) + v.length);
}
const uncoveredBreakdown = [...uncoveredByMaker.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([maker, n]) => `${maker} ${n}`).join(', ');
console.log(`
Motors with no nozzle row  ${uncoveredTotal} (${uncoveredBreakdown})`);
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
