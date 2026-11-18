import { describe, expect, it } from 'vitest';
import { normalizeFlightPlots } from './flightPlots.js';
import { STABILITY_DIAGNOSTIC_PANELS } from '../flightChartModel.js';

const plot = { id: 'one', name: 'Coast', panels: ['altitude', 'stabilityPercent'], comparison: 'stability' };

describe('stored flight plots', () => {
  it('reloads a saved diagnostic layout with every new panel intact', () => {
    const panels = ['stability', 'ωn', 'rollPitchRatio', 'Ccm', 'aoa', 'dθ', 'Cn', 'CNα', 'Cθ', 'Cζθ'];
    expect(STABILITY_DIAGNOSTIC_PANELS).toEqual(panels);
    const saved = { ...plot, panels, comparison: '' };
    expect(normalizeFlightPlots(JSON.parse(JSON.stringify([saved])))).toEqual([saved]);
    const older = { ...saved, panels: panels.filter(key => key !== 'rollPitchRatio') };
    expect(normalizeFlightPlots(JSON.parse(JSON.stringify([older])))).toEqual([older]);
  });
  it('validates custom axes and event selection while accepting older layouts', () => {
    const custom = { ...plot, comparison: 'custom', custom: { x: 'Px', y: 'Py' }, events: ['BURNOUT'] };
    expect(normalizeFlightPlots([custom])).toEqual([custom]);
    for (const bad of [null, { x: 'tc', y: 'Py' }, { x: {}, y: 'Py' }]) {
      expect(normalizeFlightPlots([{ ...custom, custom: bad }])).toEqual([]);
    }
    expect(normalizeFlightPlots([{ ...custom, events: ['not-an-event'] }])).toEqual([]);
    expect(normalizeFlightPlots([plot])).toEqual([plot]);
  });
  it('copies a valid selection, including an empty panel list and phase axes', () => {
    expect(normalizeFlightPlots([plot, { ...plot, id: 'two', name: 'Phase', panels: [], comparison: 'phase' }]))
      .toEqual([plot, { ...plot, id: 'two', name: 'Phase', panels: [], comparison: 'phase' }]);
  });
  it('drops invalid records and duplicate ids or names without crashing', () => {
    expect(normalizeFlightPlots(null)).toEqual([]);
    expect(normalizeFlightPlots([plot, null, {}, { ...plot, id: 'two', name: ' coast ' },
      { ...plot, name: 'Other' }, { ...plot, id: 'three', name: 'Bad comparison', comparison: 'obsolete' }])).toEqual([plot]);
  });
  it('drops unknown panel keys while preserving the rest of a future layout', () => {
    const future = { ...plot, panels: ['stability', 'someFutureKey'] };
    expect(normalizeFlightPlots([future])).toEqual([{ ...future, panels: ['stability'] }]);
    expect(normalizeFlightPlots([{ ...plot, panels: ['not-a-series'] }])).toEqual([{ ...plot, panels: [] }]);
  });
  it('normalizes names and unique keys and bounds malformed stores', () => {
    expect(normalizeFlightPlots([{ ...plot, name: '  Coast  ', panels: ['altitude', 'altitude'] }]))
      .toEqual([{ ...plot, panels: ['altitude'] }]);
    expect(normalizeFlightPlots([{ ...plot, name: 'x'.repeat(81) }])).toEqual([]);
    expect(normalizeFlightPlots(Array.from({ length: 60 }, (_, i) => ({ ...plot, id: String(i), name: String(i) }))))
      .toHaveLength(50);
  });
});
