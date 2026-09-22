import { describe, expect, it } from 'vitest';
import { asciiOnly, foldTypography, oneLine } from './textFold.js';

describe('oneLine', () => {
  it('folds every line terminator a header reader might honour', () => {
    for (const br of ['\n', '\r\n', '\r', '\u2028', '\u2029', '\u0085', '\v', '\f', '\x1c', '\x1d', '\x1e']) {
      expect(oneLine(`Goblin${br}v 1 2 3`), JSON.stringify(br)).toBe('Goblin v 1 2 3');
    }
  });

  it('collapses runs and trims, and leaves other text alone', () => {
    expect(oneLine('  Big \n\n  Bertha  ')).toBe('Big Bertha');
    expect(oneLine('Ракета — 1')).toBe('Ракета — 1');
  });
});

describe('foldTypography', () => {
  it('folds the app\'s own typography to ASCII, and nothing else', () => {
    expect(foldTypography('sea level (101325 Pa; 20 °C — the kernel default)'))
      .toBe('sea level (101325 Pa; 20 degC - the kernel default)');
    expect(foldTypography('motor mount ⌀ 29.0 mm · 3×')).toBe('motor mount dia 29.0 mm - 3x');
    expect(foldTypography('“quoted” ‘x’ 0–5')).toBe('"quoted" \'x\' 0-5');
    expect(foldTypography('Ракета')).toBe('Ракета');
  });
});

describe('asciiOnly', () => {
  it('is printable 7-bit on one line whatever it is given', () => {
    const out = asciiOnly('Ракета —\nmount ⌀ 29 mm\u2028°');
    expect(out).toMatch(/^[\x20-\x7e]*$/);
    expect(out).toBe('?????? - mount dia 29 mm deg');
  });
});
