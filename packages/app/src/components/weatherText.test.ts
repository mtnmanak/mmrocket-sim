import { describe, expect, it } from 'vitest';
import { farText, visibilityText } from './weatherText.js';

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
