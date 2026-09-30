import { describe, expect, it } from 'vitest';
import { likelyFlippedLongitude } from './longitudeCheck.js';

const LEM = { designSite: true, longitudeDeg: 80.126879, siteM: 3.048, demM: 125, utcOffsetHours: -4 };

describe('B-lite longitude evidence (register, Tier 0 row 44)', () => {
  it.each([3.048, 4.8768])('flags the LEM site at %s m in Florida winter and summer', (siteM) => {
    for (const utcOffsetHours of [-5, -4]) {
      expect(likelyFlippedLongitude({ ...LEM, siteM, utcOffsetHours })).toBe(true);
    }
  });

  it.each([
    ['a typed place or device fix', { designSite: false }],
    ['blank longitude', { longitudeDeg: null }],
    ['absent longitude', { longitudeDeg: undefined }],
    ['non-finite longitude', { longitudeDeg: NaN }],
    ['infinite longitude', { longitudeDeg: Infinity }],
    ['out-of-range longitude', { longitudeDeg: 181, utcOffsetHours: 9 }],
    ['legacy default longitude', { longitudeDeg: -80.6, utcOffsetHours: 5.5 }],
    ['near Greenwich', { longitudeDeg: 4.99, utcOffsetHours: -3 }],
    ['default altitude', { siteM: 0 }],
    ['invalid altitude', { siteM: NaN }],
    ['negative altitude', { siteM: -1 }],
    ['missing terrain', { demM: null, siteM: 100 }],
    ['invalid terrain', { demM: NaN }],
    ['matching terrain', { demM: 4 }],
    ['exactly 30 m disagreement', { demM: LEM.siteM + 30 }],
    ['missing browser offset', { utcOffsetHours: NaN }],
    ['browser distant from either sign', { utcOffsetHours: 0 }],
    ['a real Kanpur site with matching browser zone', { utcOffsetHours: 5.5 }],
    ['a real Kanpur site with matching altitude', { siteM: 125, utcOffsetHours: 5.5 }],
    ['a correct Florida site', { longitudeDeg: -80.126879 }],
    ['both signs near the browser offset', { longitudeDeg: 5, utcOffsetHours: 0 }],
    ['current sign exactly three hours away', { longitudeDeg: 30, utcOffsetHours: -1 }],
    ['date-line ambiguity', { longitudeDeg: 179, utcOffsetHours: 12 }],
  ])('does not flag %s', (_name, override) => {
    expect(likelyFlippedLongitude({ ...LEM, ...override })).toBe(false);
  });

  it('includes the 5 degree and 3 hour boundaries, but requires MORE than 30 m', () => {
    expect(likelyFlippedLongitude({ ...LEM, longitudeDeg: 5, utcOffsetHours: -3 })).toBe(true);
    expect(likelyFlippedLongitude({ ...LEM, demM: LEM.siteM + 30.001 })).toBe(true);
    expect(likelyFlippedLongitude({ ...LEM, utcOffsetHours: -LEM.longitudeDeg / 15 + 3 })).toBe(true);
    expect(likelyFlippedLongitude({ ...LEM, utcOffsetHours: -LEM.longitudeDeg / 15 + 3.001 })).toBe(false);
  });

  it('also checks a west sign against an east browser, without assuming a country', () => {
    expect(likelyFlippedLongitude({ ...LEM, longitudeDeg: -80.126879, utcOffsetHours: 5.5 })).toBe(true);
  });

  it('compares offsets across midnight for sites near the date line', () => {
    expect(likelyFlippedLongitude({ ...LEM, longitudeDeg: 140, utcOffsetHours: 14 })).toBe(true);
  });
});
