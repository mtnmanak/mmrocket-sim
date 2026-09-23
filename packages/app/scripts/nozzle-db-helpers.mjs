/**
 * The pure parts of build-nozzle-db.mjs, where a test can reach them.
 *
 * WHY A SEPARATE FILE (audit 2026-09-22). build-nozzle-db.mjs is a 2,000-line
 * script whose work runs at module top level: it reads `docs/RCS Schematics`
 * through Python the moment it is imported, and exits when that folder is
 * missing — which it is on CI and on the laptop. So none of the code that
 * turns a drawing's inches into the metres the thrust term flies could be
 * tested, and a slipped factor would have shipped on the next regeneration
 * with nothing to see it: the nozzle screen checks bounds and ratios, and a
 * wrong factor applied to every row keeps every ratio intact.
 *
 * What lives here is what can be stated without the document set: the unit
 * conversion, the store-page reader, the readers that turn an assembly
 * drawing's LIST OF MATERIAL nozzle row into a throat, an exit and a Medusa's
 * open throats (and the equivalent diameter those combine to), the merge of
 * hand-measured nozzles into the motor rows, and which files a build read.
 * build-nozzle-db.mjs imports all of it, so there is still one copy of each,
 * and nozzle-db.test.mjs pins it. Nothing here touches the filesystem or the
 * network.
 */

/** 1 / 0.0254 to fifteen significant figures: the inch is DEFINED as 25.4 mm. */
export const IN_PER_M = 39.3700787401575;
export const inToM = (v) => v / IN_PER_M;
/** Six decimal places of a metre is a micron — finer than any drawing tolerance. */
export const round6 = (v) => Math.round(v * 1e6) / 1e6;

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
export function readSpecPage(page) {
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
  // The weight is the one figure a store page prints with a thousands
  // separator, and `Number('1,050')` is NaN — which JSON writes as null, so a
  // part of a kilogram or more would have shipped with its weight blanked and
  // nothing saying why (audit 2026-09-22). No part in today's set weighs that
  // much; the regex always accepted the comma, the conversion did not.
  const weight = /Weight\s*(?:=|:)\s*([\d,.]+)\s*grams/i.exec(s);
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
    weightG: weight ? Number(weight[1].replace(/,/g, '')) : undefined,
    multi,
  };
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
export function nozzleRow(asm) {
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
export function throatFromDescription(desc) {
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
export function exitFromDescription(desc) {
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
export function medusaOpening(desc) {
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
export const equivalent = (...ds) => Math.sqrt(ds.reduce((a, d) => a + d * d, 0));

/**
 * The base part a dash number belongs to. "01880-4" -> "01880",
 * "01800-4(M)" -> "01800", "01800M-1" -> "01800M", "01550-X" -> "01550".
 * The suffix is stripped, never interpreted: which mould a dash number belongs
 * to is decided by EVIDENCE in `resolvePart`, not by the shape of the string.
 */
export const basePartNo = (p) => p.replace(/-[\w()]+$/, '');

/**
 * MEASURED NOZZLES, MERGED into the motor rows — `measured` entries become rows
 * of `motors`, the one table `nozzleDb.ts` reads.
 *
 * TWO RULES, both deliberate:
 *
 *  1. A measurement fills a motor that has NO row. It never overwrites a
 *     published one. If it names a motor already covered, it is a PROBLEM and
 *     the build fails rather than silently preferring one source over the
 *     other — that is a decision a person should make in the open, not a
 *     precedence rule hidden in a script.
 *  2. Provenance is mandatory, exactly as it is for a published row: who
 *     measured it and when. A measured number with no measurer is
 *     indistinguishable, downstream, from one read off a drawing.
 *
 * `exitSource: 'measured'` and `exitConfidence: 'high'` — high because a
 * caliper on the part in hand is better evidence about THAT part than a band
 * that covers a run of throat sizes; the source field is what keeps the two
 * kinds of number tellable apart.
 *
 * `catalogueMotors` is motors.json's `motors`; `publishedRows` the rows built
 * from documents so far. Returns the new rows and every reason one could not
 * be made — the caller decides what a problem costs (the builder exits).
 */
export function mergeMeasured(measured, catalogueMotors, publishedRows) {
  const rows = [];
  const problems = [];
  for (const mn of measured) {
    if (!(mn.exitDiameterIn > 0)) { problems.push(`${mn.partNo}: no usable exitDiameterIn`); continue; }
    if (!mn.measuredBy || !mn.measuredOn) { problems.push(`${mn.partNo}: measurements need measuredBy and measuredOn`); continue; }
    if (!Array.isArray(mn.appliesTo) || mn.appliesTo.length === 0) { problems.push(`${mn.partNo}: appliesTo names no motor`); continue; }
    for (const want of mn.appliesTo) {
      const m = catalogueMotors.find((x) => x.designation === want || x.commonName === want);
      if (!m) { problems.push(`${mn.partNo}: the catalogue has no motor "${want}"`); continue; }
      if (publishedRows.some((r) => r.motorId === m.motorId)) {
        problems.push(`${mn.partNo}: ${want} already has a PUBLISHED row — a measurement must not `
          + 'silently replace one. Decide which source wins and say so here.');
        continue;
      }
      const exitIn = mn.exitDiameterIn;
      const throatIn = mn.throatDiameterIn;
      rows.push({
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
  return { rows, problems };
}

/**
 * Where each AeroTech document family sits under `docs/RCS Schematics`. The
 * extractor gives an assembly's `file` relative to ITS family's folder and
 * every other group's relative to the set root (see extract-nozzle-pdfs.py),
 * so a date computed from these paths has to join each one to the right
 * folder.
 */
export const ASSEMBLY_FOLDER = {
  reloadable: 'Motor Assembly Drawings',
  dms: 'DMS Motor Designs',
};

/**
 * Every source document a build read, as `{ root, file }` — `root` 'rcs' for
 * the AeroTech set and 'loki' for `docs/Loki Data` — so the caller can stat
 * them for the file's `generated` date.
 *
 * Before 2026-09-22 the date was taken over the AeroTech set alone and joined
 * EVERY assembly to "Motor Assembly Drawings": the 51 DMS sheets (read since
 * 2026-09-13) were looked up in a folder they are not in, the lookup failed
 * silently, and the 21 Loki sheets were never looked at at all. So a rebuild
 * that took in either could not move the date. An unknown docFamily throws: a
 * third family must be given its folder here, not silently mis-joined.
 */
export function sourceDocuments(raw, lokiSheetFiles = []) {
  const assemblyPath = (a) => {
    const folder = ASSEMBLY_FOLDER[a.docFamily ?? 'reloadable'];
    if (!folder) throw new Error(`assembly ${a.file}: unknown docFamily "${a.docFamily}"`);
    return `${folder}/${a.file}`;
  };
  return [
    ...raw.assemblies.map((a) => ({ root: 'rcs', file: assemblyPath(a) })),
    ...raw.specPages.map((f) => ({ root: 'rcs', file: f.file })),
    ...raw.nozzleDrawings.map((f) => ({ root: 'rcs', file: f.file })),
    ...(raw.certNozzles ?? []).map((f) => ({ root: 'rcs', file: f.file })),
    ...lokiSheetFiles.map((file) => ({ root: 'loki', file })),
  ];
}
