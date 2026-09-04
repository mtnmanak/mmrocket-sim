import { describe, expect, it } from 'vitest';
import { csvCell } from './csvUtil.js';

describe('csvCell — RFC 4180 quoting', () => {
  it('passes an ordinary string through untouched', () => {
    expect(csvCell('Nose cone')).toBe('Nose cone');
    expect(csvCell('Body tube 2')).toBe('Body tube 2');
  });

  it('quotes and doubles the characters that break a field', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    // A bare CR ends a record in some readers (presets.ts parseCsv is one).
    expect(csvCell('two\rlines')).toBe('"two\rlines"');
  });

  it('renders null/undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});

describe('csvCell — formula-injection neutralisation', () => {
  it('leaves negative numbers numeric — the case the guard must not break', () => {
    // Most of this export is numbers, and accelerations, CG offsets and wind
    // components are routinely negative. Quoting them would make the column
    // text a spreadsheet cannot sum or chart.
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell('-0.0003')).toBe('-0.0003');
    expect(csvCell('-1.5e-7')).toBe('-1.5e-7');
  });

  it('leaves an explicitly signed positive number numeric', () => {
    expect(csvCell('+1')).toBe('+1');
    expect(csvCell('+3.25')).toBe('+3.25');
  });

  it('neutralises a leading = + - @ TAB or CR when the cell is not a number', () => {
    expect(csvCell('=SUM(A1)')).toBe('"\'=SUM(A1)"');
    expect(csvCell('+1+1')).toBe('"\'+1+1"');
    expect(csvCell('-1-1')).toBe('"\'-1-1"');
    expect(csvCell('@foo')).toBe('"\'@foo"');
    expect(csvCell('\t=SUM(A1)')).toBe('"\'\t=SUM(A1)"');
    expect(csvCell('\r=SUM(A1)')).toBe('"\'\r=SUM(A1)"');
  });

  it('neutralises the DDE payload a traded design can carry in a component name', () => {
    // A .ork whose nose cone is named this imports and displays as an odd
    // name, then leads a componentCsv row. Excel raises the external-link
    // prompt on the leading '=' unless the cell is made text.
    const cell = csvCell("=cmd|'/c calc.exe'!A1");
    expect(cell.startsWith('"\'=')).toBe(true);
    expect(cell).toBe('"\'=cmd|\'/c calc.exe\'!A1"');
  });

  it('still escapes embedded quotes inside a neutralised cell', () => {
    expect(csvCell('=HYPERLINK("http://x","y")'))
      .toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });

  it('leaves a plain hyphenated string that is not a number guarded', () => {
    // A real preset description in the shipped database: "-not properly
    // simulated". Excel reads a leading '-' as the start of a formula and
    // renders #NAME?, so it is guarded even though it is harmless text.
    expect(csvCell('-not properly simulated')).toBe('"\'-not properly simulated"');
  });
});
