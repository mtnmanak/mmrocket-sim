import { describe, expect, it } from 'vitest';
import { coordinateLabel, coordinatesLabel, weatherPlaceLabel } from './coordinates.js';

describe('hemisphere labels', () => {
  it('labels both axes and both signs without changing the numbers', () => {
    expect(coordinatesLabel(26.380273, 80.126879)).toBe('26.380° N, 80.127° E');
    expect(coordinatesLabel(-26.380273, -80.126879)).toBe('26.380° S, 80.127° W');
    expect(coordinateLabel(-80.126879, 'longitude', 6)).toBe('80.126879° W');
    expect(coordinatesLabel(0, -0)).toBe('0.000° N, 0.000° E');
  });

  it('derives old coordinate and device labels at display time, preserving named places', () => {
    const place = { label: '26.380, 80.127', latitudeDeg: 26.380273, longitudeDeg: 80.126879 };
    for (const method of ['coordinates', 'device']) {
      expect(weatherPlaceLabel({ ...place, method })).toBe('26.380° N, 80.127° E');
    }
    expect(weatherPlaceLabel({ ...place, method: 'search', label: 'A named site' })).toBe('A named site');
    expect(place.longitudeDeg).toBe(80.126879);
    expect(place.label).toBe('26.380, 80.127');
  });
});
