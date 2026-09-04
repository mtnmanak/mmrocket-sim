/**
 * Shared CSV cell escaping for the export services: RFC-4180 quoting plus
 * OWASP formula-injection neutralisation.
 *
 * RFC-4180 quoting alone does NOT stop a spreadsheet evaluating a cell — the
 * quotes are consumed as field delimiters before Excel/LibreOffice/Sheets
 * hands the text to its formula parser. Four writers feed this function text
 * that came out of a file somebody else wrote: component `name` and
 * `materialName` (componentTable.ts, straight off an imported .ork/.rkt/.CDX1),
 * the design name and the free-text Comments column (simStore.ts), a booster
 * branch's name in the flight-data headers (flightDataCsv.ts) and
 * `description`/`partNo` from an imported preset CSV (presets.ts). Designs are
 * traded in the beta thread and through share links, so a nose cone named
 * `=cmd|'/c calc.exe'!A1` reaches here verbatim and, unguarded, raises Excel's
 * DDE prompt on the recipient's machine. A leading apostrophe makes the cell
 * text; the guarded cell is always quoted so the apostrophe cannot be read as
 * anything but data.
 */

/**
 * First characters a spreadsheet may read as the start of a formula. TAB and
 * CR are in the list because Excel strips leading whitespace and then reads
 * the '=' behind it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  // Guard ONLY a non-numeric cell. '-12.5' also leads with a risky character,
  // and this exporter is mostly numbers — accelerations, CG offsets, wind
  // components and every negative detail column would become quoted text that
  // a spreadsheet cannot sum or chart. Number() finite is the discriminator:
  // '-12.5' and '+1' stay numbers, '=SUM(A1)', '@foo', '-1-1' and '\t=…' do not.
  const inject = FORMULA_LEAD.test(s) && !Number.isFinite(Number(s));
  const body = inject ? `'${s}` : s;
  // \r joins the quote set for field integrity as well: a bare CR ends a
  // record in some readers (our own parseCsv in presets.ts is one).
  return inject || /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}
