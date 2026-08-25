import { strToU8, zipSync } from 'fflate';
import { escapeXml } from './xmlUtil.js';

/**
 * Minimal .xlsx writer (2026-08-05c #4; multi-sheet 2026-08-05 chat; charts
 * 2026-08-25). An xlsx file is a zip of small XML parts — we already bundle
 * fflate, so this stays a few hundred lines instead of an 800 KB spreadsheet
 * library. What it guarantees over CSV:
 *  - typed cells: numbers are numbers, text is text — Excel/Sheets never
 *    "helpfully" turn a designation or a date-like value into something else
 *    (inline strings, no shared-string table needed);
 *  - a bold, frozen header row with an autofilter, per sheet;
 *  - column widths sized to the content;
 *  - multiple sheets (combination-batch exports group results per tab);
 *  - optional native chart tabs (one chartsheet per ChartSpec) whose series
 *    reference the data sheets' cell ranges — the charts stay live against
 *    the data. Charts are c:scatterChart ("X Y Scatter with straight
 *    lines"), NOT c:lineChart: a lineChart's category axis spaces samples
 *    evenly, which lies about adaptively-timestepped flight data (see
 *    flightXlsx.ts for the measurement).
 * No formulas or cell styling beyond that — deliberately.
 */

/** Column letter(s) for a 0-based index (A, B, … Z, AA, …). */
function colRef(i: number): string {
  let s = '';
  let x = i;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

export type Cell = string | number | null | undefined;

export interface Sheet {
  name: string;
  headers: string[];
  rows: Cell[][];
}

/** One plotted series: a pair of columns on a data sheet, referenced by range. */
export interface ChartSeriesSpec {
  /** Series display name (shown in the legend when there is one). */
  name: string;
  /** Index into the `sheets` array of the data sheet the ranges live on. */
  sheetIndex: number;
  /** 0-based column index of the x values (the time column). */
  xCol: number;
  /** 0-based column index of the y values. */
  yCol: number;
  /** Number of DATA rows (the ranges span sheet rows 2 … rowCount+1). */
  rowCount: number;
  /** Line color, RRGGBB hex without '#'. */
  color: string;
}

/** One chart tab: a full-page chartsheet holding a single x-y line plot. */
export interface ChartSpec {
  /** Tab name — shares Excel's sheet-name rules/namespace with data sheets. */
  name: string;
  title: string;
  /** Axis titles — carry the unit ("Time (s)", "Altitude (ft)"). */
  xTitle: string;
  yTitle: string;
  series: ChartSeriesSpec[];
}

/** `'Sheet name'!$A$2:$A$727` — always quoted; embedded quotes double. */
function rangeRef(sheetName: string, col: number, firstRow: number, lastRow: number): string {
  const c = colRef(col);
  return `'${sheetName.replace(/'/g, "''")}'!$${c}$${firstRow}:$${c}$${lastRow}`;
}

/** DrawingML title block (chart title and axis titles share the shape). */
function chartTitleXml(text: string): string {
  return '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>'
    + `<a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

/**
 * Chart part (xl/charts/chartN.xml): one scatter-with-straight-lines plot.
 * Element order follows ECMA-376 CT_Chart / CT_ScatterChart / CT_ValAx.
 * Blank cells (NaN samples) render as gaps, not zeros; markers are off —
 * a 5000-sample flight with markers is unreadable ink. Single-series charts
 * carry no legend (the title names the series); multi-series get one.
 */
function chartXml(chart: ChartSpec, dataSheetName: (i: number) => string): string {
  const sers = chart.series.map((s, i) => {
    const last = s.rowCount + 1;
    const sheet = dataSheetName(s.sheetIndex);
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>`
      + `<c:tx><c:v>${escapeXml(s.name)}</c:v></c:tx>`
      + `<c:spPr><a:ln w="19050" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:round/></a:ln></c:spPr>`
      + '<c:marker><c:symbol val="none"/></c:marker>'
      + `<c:xVal><c:numRef><c:f>${escapeXml(rangeRef(sheet, s.xCol, 2, last))}</c:f></c:numRef></c:xVal>`
      + `<c:yVal><c:numRef><c:f>${escapeXml(rangeRef(sheet, s.yCol, 2, last))}</c:f></c:numRef></c:yVal>`
      + '<c:smooth val="0"/></c:ser>';
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart>
${chartTitleXml(chart.title)}
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/>
<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${sers}<c:axId val="1"/><c:axId val="2"/></c:scatterChart>
<c:valAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${chartTitleXml(chart.xTitle)}<c:tickLblPos val="nextTo"/><c:crossAx val="2"/></c:valAx>
<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>${chartTitleXml(chart.yTitle)}<c:tickLblPos val="nextTo"/><c:crossAx val="1"/></c:valAx>
</c:plotArea>
${chart.series.length > 1 ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>\n' : ''}<c:plotVisOnly val="1"/>
<c:dispBlanksAs val="gap"/>
</c:chart>
</c:chartSpace>`;
}

/**
 * Chartsheet part: a dedicated full-page chart tab. Requires exactly
 * sheetViews + drawing per CT_Chartsheet; the drawing rel carries the chart.
 */
function chartsheetXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr/>
<sheetViews><sheetView workbookViewId="0" zoomToFit="1"/></sheetViews>
<drawing r:id="rId1"/>
</chartsheet>`;
}

/**
 * Drawing part for a chartsheet: an absolutely-anchored graphic frame filling
 * the page (EMU extent ≈ landscape page; chartsheets zoom-to-fit anyway).
 */
function chartDrawingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:absoluteAnchor>
<xdr:pos x="0" y="0"/><xdr:ext cx="9312088" cy="6084794"/>
<xdr:graphicFrame macro="">
<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic>
</xdr:graphicFrame>
<xdr:clientData/>
</xdr:absoluteAnchor>
</xdr:wsDr>`;
}

function sheetXml({ headers, rows }: Sheet): string {
  const nCols = headers.length;

  const cellXml = (v: Cell, r: number, c: number, style: number): string => {
    const ref = `${colRef(c)}${r + 1}`;
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) {
      return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
    }
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(v))}</t></is></c>`;
  };

  // Column widths from the longest content (capped — comments columns get long).
  const widths = headers.map((h, c) => {
    let w = h.length;
    for (const row of rows) {
      const v = row[c];
      if (v !== null && v !== undefined) w = Math.max(w, String(v).length);
    }
    return Math.min(40, Math.max(8, w + 2));
  });

  const rowsXml: string[] = [];
  rowsXml.push(`<row r="1">${headers.map((h, c) => cellXml(h, 0, c, 1)).join('')}</row>`);
  rows.forEach((row, i) => {
    rowsXml.push(`<row r="${i + 2}">${row.map((v, c) => cellXml(v, i + 1, c, 0)).join('')}</row>`);
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
<autoFilter ref="A1:${colRef(nCols - 1)}${rows.length + 1}"/>
</worksheet>`;
}

/**
 * Multi-sheet workbook, optionally followed by chart tabs. Sheet names are
 * deduplicated/truncated to Excel's rules — data sheets and chart tabs share
 * one name namespace, and chart series ranges use the SANITIZED data-sheet
 * names (they address sheets by final name, so the two must agree).
 */
export function sheetsToXlsx(sheets: Sheet[], charts: ChartSpec[] = []): Uint8Array {
  const used = new Set<string>();
  const sanitize = (raw: string, i: number): string => {
    // Excel: ≤31 chars, no : \ / ? * [ ]
    let name = (raw || `Sheet${i + 1}`).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 28)}_${i + 1}`;
    used.add(name);
    return name;
  };
  const safeNames = sheets.map((s, i) => sanitize(s.name, i));
  const chartNames = charts.map((c, i) => sanitize(c.name, sheets.length + i));

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>
</styleSheet>`;

  // Tab order: data sheets first, chart tabs after. Chartsheets are ordinary
  // <sheet> entries in the workbook — only the relationship type differs.
  const allTabs = [
    ...safeNames.map((name, i) => ({ name, rel: 'worksheet', target: `worksheets/sheet${i + 1}.xml` })),
    ...chartNames.map((name, i) => ({ name, rel: 'chartsheet', target: `chartsheets/sheet${i + 1}.xml` })),
  ];

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${allTabs.map((t, i) => `<sheet name="${escapeXml(t.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${allTabs.map((t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t.rel}" Target="${t.target}"/>`).join('\n')}
<Relationship Id="rId${allTabs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
${charts.map((_, i) => `<Override PartName="/xl/chartsheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/>
<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/styles.xml': strToU8(styles),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });
  // Chart tab chain: chartsheet → (rels) → drawing → (rels) → chart part.
  const relsXml = (target: string, type: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>
</Relationships>`;
  charts.forEach((c, i) => {
    files[`xl/chartsheets/sheet${i + 1}.xml`] = strToU8(chartsheetXml());
    files[`xl/chartsheets/_rels/sheet${i + 1}.xml.rels`] = strToU8(relsXml(`../drawings/drawing${i + 1}.xml`, 'drawing'));
    files[`xl/drawings/drawing${i + 1}.xml`] = strToU8(chartDrawingXml());
    files[`xl/drawings/_rels/drawing${i + 1}.xml.rels`] = strToU8(relsXml(`../charts/chart${i + 1}.xml`, 'chart'));
    files[`xl/charts/chart${i + 1}.xml`] = strToU8(chartXml(c, (si) => safeNames[si] ?? `Sheet${si + 1}`));
  });
  return zipSync(files);
}

/** Single-sheet convenience (saved simulations, plain batch). */
export function tableToXlsx(headers: string[], rows: Cell[][], sheetName = 'Data'): Uint8Array {
  return sheetsToXlsx([{ name: sheetName, headers, rows }]);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
