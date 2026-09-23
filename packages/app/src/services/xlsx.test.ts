import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { sheetsToXlsx, tableToXlsx, type ChartSpec } from './xlsx.js';

describe('minimal xlsx writer', () => {
  it('produces a valid workbook zip with typed cells', () => {
    const bytes = tableToXlsx(
      ['Designation', 'Apogee (ft)', 'Delay (s)'],
      [['H210-10', 2153, 10], ['G80-7', 1400.5, 'P']],
      'Batch',
    );
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(files)).toContain('[Content_Types].xml');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    // Numbers are NUMBER cells; text is an inline string (no date mangling).
    expect(sheet).toContain('<c r="B2" s="0"><v>2153</v></c>');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('H210-10');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:C3"/>');
    // Header row is styled bold (s="1").
    expect(sheet).toContain('<c r="A1" s="1"');
  });

  it('writes multiple sheets with sanitized names', () => {
    const bytes = sheetsToXlsx([
      { name: 'All results', headers: ['A'], rows: [[1]] },
      { name: 'Mixed 2+2: H100/H210', headers: ['A'], rows: [[2]] },
    ]);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(files)).toContain('xl/worksheets/sheet2.xml');
    const wb = strFromU8(files['xl/workbook.xml']!);
    expect(wb).toContain('name="All results"');
    // ':' and '/' are illegal in sheet names — sanitized, not dropped.
    expect(wb).toContain('name="Mixed 2+2  H100 H210"');
    expect(strFromU8(files['xl/worksheets/sheet2.xml']!)).toContain('<v>2</v>');
  });

  it('escapes XML in text cells and skips empty cells', () => {
    const bytes = tableToXlsx(['A'], [['a<b&c'], [null], ['']]);
    const sheet = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('a&lt;b&amp;c');
    expect(sheet).toContain('<row r="3"></row>');
  });

  it('drops the characters XML cannot carry from cells and tab names', () => {
    // Audit 2026-09-22: a U+0002 pasted into a part name from a vendor PDF
    // reached the cell verbatim, and Excel had to repair the workbook.
    const files = unzipSync(sheetsToXlsx([
      { name: 'Stage\u0002 1', headers: ['Part'], rows: [['Nose\u0002cone \uD800!']] },
    ]));
    expect(strFromU8(files['xl/worksheets/sheet1.xml']!)).toContain('>Nosecone !</t>');
    // In a tab name the control becomes a space, like the other characters
    // Excel refuses there.
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('<sheet name="Stage  1"');
  });
});

describe("sheet names follow all of Excel's rules", () => {
  const tabNames = (names: string[], charts: string[] = []): string[] => {
    const chart = (name: string): ChartSpec => ({
      name, title: name, xTitle: 't', yTitle: 'y',
      series: [{ name, sheetIndex: 0, xCol: 0, yCol: 0, rowCount: 1, color: '000000' }],
    });
    const wb = strFromU8(unzipSync(sheetsToXlsx(
      names.map((name) => ({ name, headers: ['A'], rows: [[1]] })), charts.map(chart)))['xl/workbook.xml']!);
    return [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]!);
  };
  const A28 = 'A'.repeat(28);

  it('ends on a clash with a name already shaped like its own suffix', () => {
    // The old loop re-suffixed its own output — `name.slice(0, 28) + '_' +
    // (i + 1)` — which for this name IS this name: two stage tabs called
    // `AAAA…(28)_2` hung the flight-data export for good (measured at the old
    // code: still running when killed at 20 s).
    const t0 = performance.now();
    const names = tabNames([`${A28}_2`, `${A28}_2`, `${A28}_2`]);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(names).toEqual([`${A28}_2`, `${A28}__2`, `${A28}__3`]);
    expect(names.every((n) => n.length <= 31)).toBe(true);
  });

  it('keeps the ordinary _2, _3 numbering for repeated names', () => {
    expect(tabNames(['Stage', 'Stage', 'Stage'])).toEqual(['Stage', 'Stage_2', 'Stage_3']);
  });

  it('treats names differing only in case as the same name, as Excel does', () => {
    // A stage named `mass` beside the `Mass` chart tab: Excel called that
    // workbook corrupt.
    expect(tabNames(['mass'], ['Mass'])).toEqual(['mass', 'Mass_2']);
  });

  it('strips an apostrophe from either end and renames the reserved History', () => {
    expect(tabNames(["'Booster'", "  ' Sustainer's '", 'history', 'HISTORY']))
      .toEqual(['Booster', "Sustainer's", 'History_', 'History__2']);
    expect(tabNames(["''"])).toEqual(['Sheet1']);
  });

  it('never ends a truncated name on an apostrophe or a space', () => {
    // Cut at 31 characters, these would end on the space and the apostrophe.
    expect(tabNames([`${'x'.repeat(29)} 'tail`, `${'y'.repeat(30)}'tail`]))
      .toEqual(['x'.repeat(29), 'y'.repeat(30)]);
  });

  it('deduplicates the name it writes: a cut through an emoji, a lone surrogate', () => {
    // The 31-unit cut split the rocket emoji, and the orphaned high half made
    // the name "different" from a plain X…(30) until escapeXml stripped it at
    // the write — two tabs of the same name. A name that was only a lone
    // surrogate wrote an EMPTY one. Excel refuses both.
    const X30 = 'X'.repeat(30);
    expect(tabNames([`${X30}\u{1F680}`, X30])).toEqual([X30, `${'X'.repeat(29)}_2`]);
    expect(tabNames(['\uD800', ''])).toEqual(['Sheet1', 'Sheet2']);
    expect(tabNames(['Stage\uDC00 1'])).toEqual(['Stage  1']);
    // A whole emoji inside the limit is kept.
    expect(tabNames(['Booster \u{1F680}'])).toEqual(['Booster \u{1F680}']);
  });
});

describe('chart tabs', () => {
  const dataSheet = {
    name: 'Data',
    headers: ['Time (s)', 'Altitude (ft)'],
    rows: [[0, 0], [0.05, 12], [0.1, 30]] as (number | null)[][],
  };
  const altChart: ChartSpec = {
    name: 'Altitude',
    title: 'Altitude (ft)',
    xTitle: 'Time (s)',
    yTitle: 'Altitude (ft)',
    series: [{ name: 'Altitude (ft)', sheetIndex: 0, xCol: 0, yCol: 1, rowCount: 3, color: '2A78D6' }],
  };

  it('emits chartsheet, drawing and chart parts wired by rels + content types', () => {
    const files = unzipSync(sheetsToXlsx([dataSheet], [altChart]));
    expect(Object.keys(files)).toContain('xl/chartsheets/sheet1.xml');
    expect(Object.keys(files)).toContain('xl/drawings/drawing1.xml');
    expect(Object.keys(files)).toContain('xl/charts/chart1.xml');
    const ct = strFromU8(files['[Content_Types].xml']!);
    expect(ct).toContain('PartName="/xl/chartsheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"');
    expect(ct).toContain('PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"');
    expect(ct).toContain('PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"');
    // Workbook lists the chart tab after the data sheet, rel typed chartsheet.
    const wb = strFromU8(files['xl/workbook.xml']!);
    expect(wb).toContain('<sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Altitude" sheetId="2" r:id="rId2"/>');
    const wbRels = strFromU8(files['xl/_rels/workbook.xml.rels']!);
    expect(wbRels).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"');
    // Styles rel comes after every sheet rel.
    expect(wbRels).toContain('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"');
    // Chartsheet → drawing → chart relationship chain.
    expect(strFromU8(files['xl/chartsheets/sheet1.xml']!)).toContain('<drawing r:id="rId1"/>');
    expect(strFromU8(files['xl/chartsheets/_rels/sheet1.xml.rels']!))
      .toContain('Target="../drawings/drawing1.xml"');
    const drawing = strFromU8(files['xl/drawings/drawing1.xml']!);
    expect(drawing).toContain('xdr:absoluteAnchor');
    expect(drawing).toContain('r:id="rId1"');
    expect(strFromU8(files['xl/drawings/_rels/drawing1.xml.rels']!))
      .toContain('Target="../charts/chart1.xml"');
  });

  it('chart series are scatter-with-lines ranges into the data sheet', () => {
    const files = unzipSync(sheetsToXlsx([dataSheet], [altChart]));
    const chart = strFromU8(files['xl/charts/chart1.xml']!);
    // Scatter (numeric x axis), NOT a category lineChart — flight timesteps
    // are adaptive, so category spacing would distort the time axis.
    expect(chart).toContain('<c:scatterChart>');
    expect(chart).not.toContain('<c:lineChart>');
    // Ranges are live references: header row excluded, rows 2..rowCount+1.
    expect(chart).toContain("<c:xVal><c:numRef><c:f>'Data'!$A$2:$A$4</c:f></c:numRef></c:xVal>");
    expect(chart).toContain("<c:yVal><c:numRef><c:f>'Data'!$B$2:$B$4</c:f></c:numRef></c:yVal>");
    // No marker clutter; NaN gaps stay gaps; axis titles carry units.
    expect(chart).toContain('<c:marker><c:symbol val="none"/></c:marker>');
    expect(chart).toContain('<c:dispBlanksAs val="gap"/>');
    expect(chart).toContain('<a:t>Time (s)</a:t>');
    expect(chart).toContain('<a:t>Altitude (ft)</a:t>');
    expect(chart).toContain('<a:srgbClr val="2A78D6"/>');
    // Single series: the title names it, no legend box.
    expect(chart).not.toContain('<c:legend>');
  });

  it('multi-series charts carry a legend; formulas quote sanitized names', () => {
    const files = unzipSync(sheetsToXlsx(
      [
        { name: "Al's Data:1", headers: ['t', 'h'], rows: [[0, 0], [1, 5]] },
        { name: 'Booster', headers: ['t', 'h'], rows: [[0, 0], [1, 2]] },
      ],
      [{
        name: 'Altitude',
        title: 'Altitude (m)',
        xTitle: 'Time (s)',
        yTitle: 'Altitude (m)',
        series: [
          { name: "Al's Data:1", sheetIndex: 0, xCol: 0, yCol: 1, rowCount: 2, color: '2A78D6' },
          { name: 'Booster', sheetIndex: 1, xCol: 0, yCol: 1, rowCount: 2, color: '1BAF7A' },
        ],
      }],
    ));
    const chart = strFromU8(files['xl/charts/chart1.xml']!);
    // ':' is illegal in sheet names — the formula must use the sheet's FINAL
    // (sanitized) name and double any embedded quote.
    expect(chart).toContain("<c:f>'Al''s Data 1'!$B$2:$B$3</c:f>");
    expect(chart).toContain("<c:f>'Booster'!$B$2:$B$3</c:f>");
    expect(chart).toContain('<c:legend><c:legendPos val="b"/>');
    // Both series present, distinct idx/order.
    expect(chart).toContain('<c:idx val="0"/>');
    expect(chart).toContain('<c:idx val="1"/>');
  });

  it('a workbook without charts has no chart parts at all', () => {
    const files = unzipSync(tableToXlsx(['A'], [[1]]));
    expect(Object.keys(files).some((k) => k.includes('chart') || k.includes('drawing'))).toBe(false);
  });
});
