import { describe, expect, it } from 'vitest';
import type { DragSweep } from '@online-openrocket/engine';
import { APP_VERSION } from '../version.js';
import { dragTableCsv, sweepCp } from './dragTable.js';

/**
 * The Drag table (.csv) text on its own. The panel's download of it — the
 * same bytes, the MIME type, the file name — is pinned in
 * DragPanel.cp.test.tsx.
 */
const sweep = (over: Partial<DragSweep> = {}): DragSweep => ({
  machs: [0.5, 1],
  hasNozzle: false,
  cp: [0.25, 0.5],
  cna: [12, 0],
  powerOff: { total: [0.4, 0.6], friction: [0.2, 0.2], pressure: [0.1, 0.3], base: [0.1, 0.1] },
  powerOn: { total: [0.35, 0.55], friction: [0.2, 0.2], pressure: [0.1, 0.3], base: [0.05, 0.05] },
  components: [{ name: 'Nose cone', cd: [0.1, 0.2] }],
  ...over,
} as DragSweep);

const META = { design: 'Rocket', aeroModel: 'Classic Extended Barrowman', lengthUnit: 'mm', conditions: 'sea level' };

describe('sweepCp', () => {
  it('keeps a CP where the plane lifts and leaves a gap where it does not', () => {
    expect(sweepCp(sweep())).toEqual([0.25, null]);
  });

  it('reads a missing CNa as no lift', () => {
    expect(sweepCp(sweep({ cna: [12] }))).toEqual([0.25, null]);
  });
});

describe('dragTableCsv', () => {
  it('writes the four-line header, the column row and one row per Mach', () => {
    expect(dragTableCsv(sweep(), META).split('\n')).toEqual([
      `# MMRocket Sim ${APP_VERSION}`,
      '# design: Rocket',
      '# aero model: Classic Extended Barrowman',
      '# conditions: sea level',
      'mach,cd_power_off,cd_power_on,cp_mm_from_nose,cna_per_rad,friction,pressure,base_power_off,base_power_on,cd_Nose_cone',
      '0.5,0.4,0.35,250,12,0.2,0.1,0.1,0.05,0.1',
      '1,0.6,0.55,,0,0.2,0.3,0.1,0.05,0.2',
    ]);
  });

  it('writes the cp column in the length unit it is given', () => {
    const lines = dragTableCsv(sweep(), { ...META, lengthUnit: 'm' }).split('\n');
    expect(lines[4]).toContain(',cp_m_from_nose,');
    expect(lines[5]!.split(',')[3]).toBe('0.25');
  });

  it('adds the roll-plane line only for a CP that depends on roll', () => {
    const lines = dragTableCsv(sweep(), { ...META, rollCp: 0.032356 }).split('\n');
    expect(lines.filter((l) => l.startsWith('#'))).toHaveLength(5);
    expect(lines[4]).toMatch(/^# cp: one roll plane .* 32\.356 mm from nose$/);
    for (const rollCp of [null, undefined]) {
      expect(dragTableCsv(sweep(), { ...META, rollCp }).split('\n').filter((l) => l.startsWith('#'))).toHaveLength(4);
    }
  });

  it('folds each header line to one comma-free ASCII line, and a component name to one column', () => {
    const text = dragTableCsv(sweep({ components: [{ name: 'Fin set, “3”\nfins', cd: [1, 2] }] }), {
      ...META, design: 'Big “Bertha”\nMk 2, rev B', conditions: '20 °C — default',
    });
    const lines = text.split('\n');
    expect(lines[1]).toBe('# design: Big "Bertha" Mk 2; rev B');
    expect(lines[3]).toBe('# conditions: 20 degC - default');
    expect(lines[4]!.split(',').at(-1)).toBe('cd_Fin_set_"3"_fins');
  });
});
