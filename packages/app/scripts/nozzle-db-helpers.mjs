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
 * conversion, the store-page reader, the merge of hand-measured nozzles into
 * the motor rows, and which files a build read. build-nozzle-db.mjs imports
 * all of it, so there is still one copy of each, and nozzle-db.test.mjs pins
 * it. Nothing here touches the filesystem or the network.
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
