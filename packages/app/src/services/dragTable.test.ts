import { describe, expect, it } from 'vitest';
import type { DragSweep } from '@online-openrocket/engine';
import { APP_VERSION } from '../version.js';
import { CP_AOA_DEGREES, dragTableCsv, sweepCp } from './dragTable.js';

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

// Mutation guard: positive CNa must not turn an undefined high-AOA CP into zero.
it('preserves null CP with positive CNa as a gap and an empty CSV cell', () => {
  const data = sweep({ cp: [0.25, null], cna: [12, 12] });
  expect(sweepCp(data)).toEqual([0.25, null]);
  const rows = dragTableCsv(data, META).split('\n').filter((line) => !line.startsWith('#'));
  expect(rows[0]!.split(',')[3]).toBe('cp_mm_from_nose');
  expect(rows[1]!.split(',')[3]).toBe('250');
  expect(rows[2]!.split(',').slice(3, 5)).toEqual(['', '12']);
});

// Regression (decision 66(b) sweepCp guard): a non-finite position with a usable
// CNa is "no position", never passed through. The old sweepCp tested CNa only.
it('treats a non-finite CP with positive CNa as missing', () => {
  const data = sweep({ cp: [0.25, Number.NaN, Number.POSITIVE_INFINITY], cna: [12, 12, 12] });
  expect(sweepCp(data)).toEqual([0.25, null, null]);
});

describe('dragTableCsv at an angle of attack', () => {
  it('adds one cp column named for a non-zero angle, with its own gaps; at 0 it adds nothing', () => {
    const atAngle = sweep({ cp: [0.3, null], cna: [14, 14] });
    const lines = dragTableCsv(sweep(), { ...META, aoaCp: { aoaDeg: 10, sweep: atAngle } }).split('\n');
    expect(lines[4]).toBe('# angle of attack: cp_mm_from_nose_aoa_10deg is the CP at 10 deg angle of attack'
      + ' (same roll plane); every other column is at 0 deg');
    expect(lines[5]).toBe('mach,cd_power_off,cd_power_on,cp_mm_from_nose,cp_mm_from_nose_aoa_10deg,cna_per_rad,'
      + 'friction,pressure,base_power_off,base_power_on,cd_Nose_cone');
    expect(lines[6]).toBe('0.5,0.4,0.35,250,300,12,0.2,0.1,0.1,0.05,0.1');
    expect(lines[7]).toBe('1,0.6,0.55,,,0,0.2,0.3,0.1,0.05,0.2');
    expect(dragTableCsv(sweep(), { ...META, aoaCp: { aoaDeg: 0, sweep: atAngle } }))
      .toBe(dragTableCsv(sweep(), META));
  });

  it('offers no angle of attack above 20 degrees', () => {
    expect([...CP_AOA_DEGREES]).toEqual([0, 2, 5, 10, 15, 20]);
    expect(Math.max(...CP_AOA_DEGREES)).toBe(20);
  });
});
