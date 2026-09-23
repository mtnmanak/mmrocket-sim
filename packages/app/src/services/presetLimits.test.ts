import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { limitPatch } from '../tree/sanitize.js';
import { csvToPresets, loadPresets, presetPatch, type Preset } from './presets.js';

/**
 * A PRESET PICK WRITES INSIDE THE LIMITS TABLE (seam review of audit
 * 2026-09-22). The table is enforced by the property panel's typed commit and
 * by the load boundary's sanitize pass; a pick went through neither, so the
 * catalogue and a user's own CSV could store what both forbid — and a restored
 * session then repaired it with no note, on a value the current build wrote.
 */
describe('limitPatch — a preset patch brought inside the limits table', () => {
  const coupler = { id: 'c1', type: 'tubecoupler', name: 'Coupler', length: 0.05, thickness: 0.0005 } as ComponentNode;

  it("repairs the shipped SEMROC HTC-11's negative wall, in the words a reopened file gives", async () => {
    // Its inside diameter (49.99 mm) is over its outside one (28.65 mm): the
    // only one of the catalogue's rows the limits table flags.
    const row = (await loadPresets()).find((p) => p.manufacturer === 'SEMROC' && p.partNo === 'HTC-11')!;
    const patch = presetPatch('tubecoupler', row);
    expect(patch['thickness']).toBeCloseTo(-0.010668, 9);
    const notes: string[] = [];
    const fixed = limitPatch(coupler, patch, notes);
    expect(fixed['thickness']).toBe(0);
    expect(fixed['outerRadius']).toBe(patch['outerRadius']);
    expect(notes).toEqual(['“SEMROC HTC-11”: wall thickness -10.668 mm cannot be negative — set to 0 mm.']);
  });

  it('caps a CSV canopy of a million shroud lines, which weighed 540 kg', () => {
    const [row] = csvToPresets('kind,manufacturer,partNo,description,diameter,lineCount\n'
      + 'PARACHUTE,Me,BIG,Hostile,0.6,1000000\n') as Preset[];
    const chute = { id: 'p1', type: 'parachute', name: 'Chute', diameter: 0.3 } as ComponentNode;
    const notes: string[] = [];
    const fixed = limitPatch(chute, presetPatch('parachute', row!), notes);
    expect(fixed['lineCount']).toBeLessThan(1000000);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^“Me BIG”: line count 1000000 is over the limit of \d+ \(.*\) — set to \d+\.$/);
  });

  it("reads a CSV's numbers as decimals, as every design-file reader does", () => {
    // Number() read "0x10" as 16 — a 16 m canopy from a hex typo — where the
    // file readers' parseDecimal (audit 2026-09-22) and desktop's
    // Double.parseDouble both refuse it; a refused cell is a blank one.
    const [row] = csvToPresets('kind,manufacturer,partNo,description,diameter,lineCount,lineLength\n'
      + 'Parachute,Me,HEX,Typo,0x10,0b110,1.5e-1\n') as Preset[];
    expect(row!['diameter']).toBeUndefined();
    expect(row!['lineCount']).toBeUndefined();
    expect(row!['lineLength']).toBe(0.15);
  });

  it('hands back the same patch, and no note, when nothing is out of limits', () => {
    const patch = { name: 'X', length: 0.1, thickness: 0.001 };
    const notes: string[] = [];
    expect(limitPatch(coupler, patch, notes)).toBe(patch);
    expect(notes).toEqual([]);
  });
});
