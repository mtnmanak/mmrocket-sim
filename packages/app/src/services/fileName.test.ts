import { describe, expect, it } from 'vitest';
import { CSV_BOM, safeName, stampedName } from './fileName.js';

/**
 * The download-filename convention had no test of any kind: `safeName`,
 * `stampedName` and `CSV_BOM` had zero references in the suite, and
 * `stampedName`'s guard — the one that stops a design named entirely in
 * non-ASCII collapsing to underscores and colliding with every other such
 * design's exports — was entirely unpinned.
 */
describe('safeName', () => {
  it('keeps word characters and hyphens, folds everything else to one underscore', () => {
    expect(safeName('WM Goblin')).toBe('WM_Goblin');
    expect(safeName('4in WM Extreme')).toBe('4in_WM_Extreme');
    expect(safeName('Level-3 / cert packet')).toBe('Level-3_cert_packet');
    // A RUN of unsafe characters is one underscore, not one each.
    expect(safeName('a   b')).toBe('a_b');
    expect(safeName('a.b.c')).toBe('a_b_c');
  });

  it('leaves an already-safe name byte for byte', () => {
    expect(safeName('BT-50_v2')).toBe('BT-50_v2');
  });

  it('is ASCII-only, which is exactly why stampedName needs its guard', () => {
    // `\w` does not match Cyrillic, Greek, Japanese or Arabic, so a name written
    // in any of them survives as nothing but separators.
    expect(safeName('Ракета')).toBe('_');
    expect(safeName('ロケット')).toBe('_');
  });
});

describe('stampedName — the design leads, and never silently collides', () => {
  it('names the design first and what the file holds second', () => {
    expect(stampedName('WM Goblin', 'flight-data', 'csv')).toBe('WM_Goblin-flight-data.csv');
    expect(stampedName('WM Goblin', 'drag-analysis', 'csv')).toBe('WM_Goblin-drag-analysis.csv');
  });

  it('falls back to "rocket" when the design has no usable name', () => {
    expect(stampedName(undefined, 'sim', 'csv')).toBe('rocket-sim.csv');
    expect(stampedName(null, 'sim', 'csv')).toBe('rocket-sim.csv');
    expect(stampedName('', 'sim', 'csv')).toBe('rocket-sim.csv');
    expect(stampedName('   ', 'sim', 'csv')).toBe('rocket-sim.csv');
  });

  it('falls back when NOTHING ASCII survives, rather than shipping "_-sim.csv"', () => {
    // Every design named only in Cyrillic would otherwise export to the same
    // filename, silently overwriting the last one in the Downloads folder.
    expect(stampedName('Ракета', 'sim', 'csv')).toBe('rocket-sim.csv');
    expect(stampedName('ロケット', 'sim', 'csv')).toBe('rocket-sim.csv');
    expect(stampedName('!!!', 'sim', 'csv')).toBe('rocket-sim.csv');
    // ONE ASCII alphanumeric is enough to keep the design's own name.
    expect(stampedName('Ракета 2', 'sim', 'csv')).toBe('_2-sim.csv');
  });

  it('trims the design name before sanitising it', () => {
    expect(stampedName('  WM Goblin  ', 'sim', 'csv')).toBe('WM_Goblin-sim.csv');
  });
});

describe('CSV_BOM', () => {
  it('is the UTF-8 BOM, one character, so Excel does not read the headers as ANSI', () => {
    // Without it Excel's double-click import garbles the Greek and typographic
    // characters in the headers (θl, dΦ, ρ, —); every other reader ignores it.
    expect(CSV_BOM).toBe('﻿');
    expect(CSV_BOM.length).toBe(1);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xFEFF);
  });
});
