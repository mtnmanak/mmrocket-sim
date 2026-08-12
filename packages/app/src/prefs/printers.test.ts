/**
 * The printer preference: the mm -> m boundary, preset matching, and the
 * "no printer configured" state that keeps the STL export exactly as it was.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PRESET, DEFAULT_PRINT_CLEARANCE, DEFAULT_PRINT_MARGIN, PRINTER_PRESETS,
  normalizePrinter, presetMatching, printerFromPreset, printerName, toPrinterVolume,
} from './printers.js';

describe('printer presets', () => {
  it('ships the eight machines, each with a distinct id', () => {
    expect(PRINTER_PRESETS).toHaveLength(8);
    expect(new Set(PRINTER_PRESETS.map((p) => p.id)).size).toBe(8);
  });

  it('converts the quoted millimetres to metres at the boundary', () => {
    // The one place mm appear for a build volume. Everything downstream —
    // planAxialSplit, splitBodyLoop — is metres, like bodyLoop().
    const h2d = printerFromPreset('bambu-h2d')!;
    expect(h2d.x).toBeCloseTo(0.350, 12);
    expect(h2d.y).toBeCloseTo(0.320, 12);
    expect(h2d.z).toBeCloseTo(0.325, 12);
    const mini = printerFromPreset('bambu-a1mini')!;
    expect([mini.x, mini.y, mini.z]).toEqual([0.18, 0.18, 0.18]);
    const mk4s = printerFromPreset('prusa-mk4s')!;
    expect([mk4s.x, mk4s.y, mk4s.z].map((v) => Math.round(v * 1000))).toEqual([250, 210, 220]);
  });

  it('defaults the process settings and carries them across a machine change', () => {
    const first = printerFromPreset('prusa-xl')!;
    expect(first.margin).toBe(DEFAULT_PRINT_MARGIN);
    expect(first.clearance).toBe(DEFAULT_PRINT_CLEARANCE);
    expect(DEFAULT_PRINT_MARGIN * 1000).toBe(8);
    expect(DEFAULT_PRINT_CLEARANCE * 1000).toBeCloseTo(0.15, 12);
    // Switching machines must not silently reset a tuned clearance.
    const tuned = { ...first, clearance: 0.00005 };
    expect(printerFromPreset('ender-3', tuned)!.clearance).toBe(0.00005);
  });

  it('an unknown preset id is not a printer', () => {
    expect(printerFromPreset('anycubic-kobra')).toBeNull();
  });
});

describe('presetMatching — editing a dimension makes it Custom', () => {
  it('recognises an untouched preset volume', () => {
    expect(presetMatching(0.350, 0.320, 0.325)).toBe('bambu-h2d');
    expect(presetMatching(0.300, 0.300, 0.300)).toBe('k1-max');
  });

  it('one millimetre off any axis is Custom', () => {
    expect(presetMatching(0.351, 0.320, 0.325)).toBe(CUSTOM_PRESET);
    expect(presetMatching(0.350, 0.320, 0.324)).toBe(CUSTOM_PRESET);
  });

  it('tolerates float noise from a unit round-trip (inches and back)', () => {
    const inches = 0.350 / 0.0254;
    expect(presetMatching(inches * 0.0254, 0.320, 0.325)).toBe('bambu-h2d');
  });
});

describe('toPrinterVolume — the unset state is load-bearing', () => {
  it('is null when no printer is configured', () => {
    expect(toPrinterVolume(undefined)).toBeNull();
  });

  it('is null for a nonsense volume rather than planning cuts for it', () => {
    expect(toPrinterVolume({ preset: CUSTOM_PRESET, x: 0, y: 0.2, z: 0.2, margin: 0.008, clearance: 0 }))
      .toBeNull();
  });

  it('passes metres straight through to the splitter', () => {
    const v = toPrinterVolume(printerFromPreset('bambu-h2d')!)!;
    expect(v).toEqual({ x: 0.350, y: 0.320, z: 0.325, margin: 0.008, clearance: DEFAULT_PRINT_CLEARANCE });
  });
});

describe('normalizePrinter — stored blobs', () => {
  it('drops a half-parsed machine instead of repairing it', () => {
    expect(normalizePrinter(undefined)).toBeUndefined();
    expect(normalizePrinter({ preset: 'bambu-h2d' })).toBeUndefined();
    expect(normalizePrinter({ x: 0.35, y: 0.32, z: 'tall' })).toBeUndefined();
  });

  it('fills in missing process settings and keeps unknown keys (forward compat)', () => {
    const p = normalizePrinter({ x: 0.35, y: 0.32, z: 0.325, nozzle: 0.6 })!;
    expect(p.preset).toBe('bambu-h2d');
    expect(p.margin).toBe(DEFAULT_PRINT_MARGIN);
    expect(p.clearance).toBe(DEFAULT_PRINT_CLEARANCE);
    expect((p as unknown as { nozzle: number }).nozzle).toBe(0.6);
  });
});

describe('printerName', () => {
  it('names a preset and stays generic for a hand-typed volume', () => {
    expect(printerName(printerFromPreset('bambu-h2d')!)).toBe('Bambu H2D');
    expect(printerName({ preset: CUSTOM_PRESET, x: 0.2, y: 0.2, z: 0.2, margin: 0.008, clearance: 0.00015 }))
      .toBe('printer');
    expect(printerName(undefined)).toBe('printer');
  });
});
