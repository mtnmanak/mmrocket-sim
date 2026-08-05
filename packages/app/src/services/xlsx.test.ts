import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { sheetsToXlsx, tableToXlsx } from './xlsx.js';

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
});
