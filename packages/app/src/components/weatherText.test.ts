import { describe, expect, it } from 'vitest';
import { farText, visibilityText, windNumber, windText, fieldText } from './weatherText.js';
import { fmtFieldValue, INITIAL_UNITS } from '../prefs/units.js';

it('N032 weather altitude follows Altitude while location distance retains its own family', () => {
  const units = { ...INITIAL_UNITS, altitude: 'ft', distance: 'km' };
  expect(fieldText('launchAltitudeM', 304.8, units)).toBe('1,000 ft');
  expect(farText(units.distance, 1000)).toBe('1.0 km');
});

it.each(['auto', 3, 4] as const)('N005 wind text follows field precision %s', precision => {
  const digits = precision === 4 ? '1.0625' : '1.063';
  expect(fmtFieldValue(1.0625, precision)).toBe(digits);
  expect(windNumber('m/s', 1.0625, precision)).toBe(digits);
  expect(windText('m/s', 1.0625, precision)).toBe(`${digits} m/s`);
  expect(fieldText('windAverage', 1.0625, { ...INITIAL_UNITS, windspeed: 'm/s' }, precision)).toBe(`${digits} m/s`);
});

describe('visibilityText', () => {
  it.each([
    ['mi', 8000, '4.97 mi'], ['km', 8000, '8.00 km'],
    ['mi', 8046.72, '5.00 mi'], ['km', 8046.72, '8.05 km'],
    ['ft', 8000, '4.97 mi'], ['yd', 8000, '4.97 mi'], ['m', 8000, '8.00 km'],
    ['mi', 0, '0.00 mi'], ['km', 0, '0.00 km'],
    ['mi', 16080, '9.99 mi'], ['km', 15990, '15.99 km'],
    ['mi', 16093.44, '10 mi'], ['km', 16000, '16 km'],
    ['mi', 20000, '12 mi'], ['km', 20500, '21 km'],
  ])('formats %s visibility at %s m as %s', (unit, metres, expected) => {
    expect(visibilityText(unit, metres)).toBe(expected);
  });

  it('preserves location accuracy and model-distance formatting', () => {
    expect(farText('mi', 8000)).toBe('5.0 mi');
    expect(farText('km', 8000)).toBe('8.0 km');
    expect(farText('km', 12000)).toBe('12 km');
  });
});
