import { strToU8, zipSync } from 'fflate';
import { escapeXml } from './xmlUtil.js';

/**
 * Minimal .xlsx writer (2026-08-05c #4). An xlsx file is a zip of small XML
 * parts — we already bundle fflate, so this stays ~150 lines instead of an
 * 800 KB spreadsheet library. What it guarantees over CSV:
 *  - typed cells: numbers are numbers, text is text — Excel/Sheets never
 *    "helpfully" turn a designation or a date-like value into something else
 *    (inline strings, no shared-string table needed);
 *  - a bold, frozen header row with an autofilter;
 *  - column widths sized to the content.
 * No formulas, charts or multiple sheets — deliberately.
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

export function tableToXlsx(headers: string[], rows: Cell[][], sheetName = 'Data'): Uint8Array {
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

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
<autoFilter ref="A1:${colRef(nCols - 1)}${rows.length + 1}"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="2"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/></cellXfs>
</styleSheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/styles.xml': strToU8(styles),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
