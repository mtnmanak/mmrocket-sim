import { describe, expect, it } from 'vitest';
import { checkFileLongitude, deviceMirrorsDesign, likelyFlippedLongitude } from './longitudeCheck.js';

const BOCA = { latitudeDeg: 26.380273, longitudeDeg: 80.126879 };
const SIBLING = { latitudeDeg: 28.1, longitudeDeg: -80.63 };

describe('file longitude evidence', () => {
  it('finds five matching siblings without replacing the opened site', () => {
    const result = checkFileLongitude(BOCA, [BOCA, ...Array.from({ length: 5 }, () => SIBLING)])!;
    expect(result.opened).toEqual(BOCA);
    expect(result.siblingCount).toBe(5);
    expect(result.distanceKm).toBeCloseTo(13618, 0);
    expect(result.flippedDistanceKm).toBeCloseTo(198, 0);
  });

  it('excludes the desktop default even for an Indian site whose mirror is nearby', () => {
    expect(checkFileLongitude({ latitudeDeg: 28.61, longitudeDeg: 80.6 }, [
      { latitudeDeg: 28.61, longitudeDeg: -80.6 },
    ])).toBeUndefined();
  });

  it('does not flag the CT-Concep98 multi-site shape', () => {
    expect(checkFileLongitude({ latitudeDeg: 40, longitudeDeg: -119 }, [
      { latitudeDeg: 40.65, longitudeDeg: -119.35 }, { latitudeDeg: 41.35, longitudeDeg: -83.5 },
    ])).toBeUndefined();
  });

  it.each([
    ['blank', { ...BOCA, longitudeDeg: null }, [SIBLING]],
    ['absent', { latitudeDeg: BOCA.latitudeDeg }, [SIBLING]],
    ['legacy default', { ...BOCA, longitudeDeg: -80.6 }, [{ ...SIBLING, longitudeDeg: 80.63 }]],
    ['near Greenwich', { latitudeDeg: 0, longitudeDeg: 4.99 }, [{ latitudeDeg: 0, longitudeDeg: -4.99 }]],
    ['blank sibling', BOCA, [{ ...SIBLING, longitudeDeg: NaN }]],
    ['legacy sibling longitude', BOCA, [{ ...SIBLING, longitudeDeg: -80.6 }]],
    ['missing latitude', { longitudeDeg: 80.126879 }, [SIBLING]],
    ['bad latitude', { ...BOCA, latitudeDeg: 91 }, [SIBLING]],
    ['bad longitude', { ...BOCA, longitudeDeg: 181 }, [SIBLING]],
    ['same hemisphere', BOCA, [{ ...SIBLING, longitudeDeg: 80.63 }]],
    ['mirror more than 300 km away', BOCA, [{ ...SIBLING, latitudeDeg: 31 }]],
    ['sites less than 2000 km apart', { latitudeDeg: 0, longitudeDeg: 5 }, [{ latitudeDeg: 0, longitudeDeg: -5 }]],
  ])('stays silent for %s', (_name, opened, siblings) => {
    expect(checkFileLongitude(opened, siblings)).toBeUndefined();
  });
});

describe('device longitude evidence', () => {
  it('matches a rounded west fix while retaining the precise design', () => {
    expect(deviceMirrorsDesign(BOCA, { latitudeDeg: 26.38, longitudeDeg: -80.13 })).toBe(true);
  });
  it.each([
    ['real eastern site and device', BOCA, { latitudeDeg: 26.38, longitudeDeg: 80.13 }],
    ['latitude outside half a degree', BOCA, { latitudeDeg: 27, longitudeDeg: -80.13 }],
    ['longitude outside half a degree', BOCA, { latitudeDeg: 26.38, longitudeDeg: -81 }],
    ['blank', { ...BOCA, longitudeDeg: null }, { latitudeDeg: 26.38, longitudeDeg: -80.13 }],
    ['legacy default', { ...BOCA, longitudeDeg: -80.6 }, { latitudeDeg: 26.38, longitudeDeg: 80.6 }],
    ['near Greenwich', { latitudeDeg: 0, longitudeDeg: 4.99 }, { latitudeDeg: 0, longitudeDeg: -5 }],
    ['device near Greenwich', { latitudeDeg: 0, longitudeDeg: 5 }, { latitudeDeg: 0, longitudeDeg: -4.99 }],
  ])('stays silent for %s', (_name, design, device) => {
    expect(deviceMirrorsDesign(design, device)).toBe(false);
  });
  it('includes the latitude, longitude-sum and five-degree boundaries', () => {
    expect(deviceMirrorsDesign({ latitudeDeg: 0, longitudeDeg: 5 }, { latitudeDeg: 0.5, longitudeDeg: -5.5 })).toBe(true);
  });
});

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
