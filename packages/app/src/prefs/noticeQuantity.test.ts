import { describe, expect, it } from 'vitest';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeComparison, noticeQuantity, fmtSig, uiToSi } from './units.js';

describe('notice quantities near zero', () => {
  it.each([
    [INITIAL_UNITS, '+0 g (+0 oz)', '+0 mm (+0 in)', '0 g (0 oz)', '0 mm (0 in)'],
    [IMPERIAL_UNITS, '+0 oz (+0 g)', '+0 in (+0 mm)', '0 oz (0 g)', '0 in (0 mm)'],
  ] as const)('suppresses subtraction residue and normalizes negative zero (%j)', (units, mass, length, unsignedMass, unsignedLength) => {
    for (const residue of [0.3 - (0.1 + 0.2), -1e-25, -0]) {
      expect(noticeQuantity('mass', residue, units, { signed: true })).toBe(mass);
      expect(noticeQuantity('length', residue, units, { signed: true })).toBe(length);
      expect(noticeQuantity('mass', residue, units)).toBe(unsignedMass);
      expect(noticeQuantity('length', residue, units)).toBe(unsignedLength);
    }
  });

  it('rounds signed differences without reviving their insignificant digits', () => {
    expect(noticeQuantity('mass', -1e-7, INITIAL_UNITS, { signed: true })).toBe('+0 g (+0 oz)');
    expect(noticeQuantity('length', -1e-7, INITIAL_UNITS, { signed: true })).toBe('+0 mm (+0 in)');
    expect(noticeQuantity('length', 0.00015, 'm')).toBe('0.00015 m (0.00591 in)');
    expect(noticeQuantity('length', 0.00005, 'm')).toBe('0.00005 m (0.00197 in)');
    expect(noticeQuantity('length', 1e-10, INITIAL_UNITS)).toBe('0.0000001 mm (0.00000000394 in)');
  });

  it.each([
    [0, '-459.7 °F (-273.1 °C)', '-273.1 °C (-459.7 °F)'],
    [uiToSi('temperature', '°F', 32), '32 °F (0 °C)', '0 °C (32 °F)'],
    [-160 / 9 + 273.15, '0 °F (-17.8 °C)', '-17.8 °C (0 °F)'],
  ])('rounds affine temperature zero points after conversion', (kelvin, imperial, metric) => {
    expect(noticeQuantity('temperature', kelvin as number, IMPERIAL_UNITS)).toBe(imperial);
    expect(noticeQuantity('temperature', kelvin as number, INITIAL_UNITS)).toBe(metric);
  });

  it('converts zero kelvin before normalizing display residue', () => {
    expect(noticeQuantity('temperature', 0, 'K')).toBe('0 K (-459.7 °F)');
  });

  it('can retain fixed precision for an assumed wall dimension', () => {
    expect(noticeQuantity('length', 0.002, INITIAL_UNITS, { preserveSmall: false }))
      .toBe('2 mm (0.079 in)');
    expect(noticeQuantity('length', 0.002, IMPERIAL_UNITS, { preserveSmall: false }))
      .toBe('0.079 in (2 mm)');
  });
});


it('chooses the sign after grouping rounds a displayed difference to zero', () => {
  expect(noticeQuantity('mass', -1e-20, INITIAL_UNITS, { digits: 20, otherDigits: 20, grouped: true, signed: true }))
    .toBe('+0 g (+0 oz)');
  expect(noticeQuantity('mass', -1e-20, INITIAL_UNITS, { digits: 20, otherDigits: 20, grouped: true }))
    .toBe('0 g (0 oz)');
  expect(noticeQuantity('mass', -2, INITIAL_UNITS, { grouped: true, signed: true }))
    .toBe('−2,000 g (−4.41 lb)');
});

it.each([
  ['area', '0 mm² (0 in²)'],
  ['surfaceDensity', '0 kg/m² (0 lb/ft²)'],
  ['lineDensity', '0 kg/m (0 lb/ft)'],
] as const)('normalizes %s residue in display and comparison', (quantity, zero) => {
  expect(noticeQuantity(quantity, -1e-25, INITIAL_UNITS)).toBe(zero);
  expect(noticeQuantity(quantity, -0, INITIAL_UNITS)).toBe(zero);
  expect(noticeComparison(quantity, -1e-25, 0, INITIAL_UNITS)).toEqual([zero, zero]);
});

it('treats tiny residue as equality while retaining huge rejected lengths', () => {
  expect(noticeComparison('length', -1e-18, 0, INITIAL_UNITS))
    .toEqual(['0 mm (0 in)', '0 mm (0 in)']);
  expect(noticeComparison('length', -1e30, 0, INITIAL_UNITS))
    .toEqual(['-1e+33 mm (-3.93701e+31 in)', '0 mm (0 in)']);
});

it('normalizes negative zero when significant formatting exhausts fixed decimals', () => {
  expect(fmtSig(-1e-25, 3)).toBe('0');
});
