import { describe, expect, it } from 'vitest';
import { normalizeFlightPlots } from './flightPlots.js';

const plot = { id: 'one', name: 'Coast', panels: ['altitude', 'stabilityPercent'], comparison: 'stability' };

describe('stored flight plots', () => {
  it('copies a valid selection, including an empty panel list and phase axes', () => {
    expect(normalizeFlightPlots([plot, { ...plot, id: 'two', name: 'Phase', panels: [], comparison: 'phase' }]))
      .toEqual([plot, { ...plot, id: 'two', name: 'Phase', panels: [], comparison: 'phase' }]);
  });
  it('drops invalid records and duplicate ids or names without crashing', () => {
    expect(normalizeFlightPlots(null)).toEqual([]);
    expect(normalizeFlightPlots([plot, null, {}, { ...plot, id: 'two', name: ' coast ' },
      { ...plot, name: 'Other' }, { ...plot, id: 'three', name: 'Bad comparison', comparison: 'obsolete' },
      { ...plot, id: 'four', name: 'Bad series', panels: ['not-a-series'] }])).toEqual([plot]);
  });
  it('normalizes names and unique keys and bounds malformed stores', () => {
    expect(normalizeFlightPlots([{ ...plot, name: '  Coast  ', panels: ['altitude', 'altitude'] }]))
      .toEqual([{ ...plot, panels: ['altitude'] }]);
    expect(normalizeFlightPlots([{ ...plot, name: 'x'.repeat(81) }])).toEqual([]);
    expect(normalizeFlightPlots(Array.from({ length: 60 }, (_, i) => ({ ...plot, id: String(i), name: String(i) }))))
      .toHaveLength(50);
  });
});
