import { describe, expect, it } from 'vitest';
import { guideExitValueLabel, guideExitValueSource, guideExitValueSources } from './guideExitValues.js';
import type { SimRun } from './simReport.js';

describe('guide-exit value provenance', () => {
  const run = { launchCG: 0.2, launchCP: 0.3, launchStaticMarginCal: 1,
    launchGuideDesignValues: [] } as unknown as SimRun;
  it('keeps genuine flight samples labelled as guide-exit values', () => {
    expect(guideExitValueSource(run, 'cp')).toBe('flight sample');
    expect(guideExitValueLabel(run, 'cg')).toBe('CG at launch guide exit');
  });
  it('tracks each substitute independently, without relabelling measured neighbours', () => {
    const partial: SimRun = { ...run, launchGuideDesignValues: ['stability'] };
    expect(guideExitValueLabel(partial, 'stability'))
      .toBe('Static margin (design estimate; no guide-exit sample)');
    expect(guideExitValueLabel(partial, 'cp')).toBe('CP at launch guide exit');
  });
  it('does not infer a flight measurement from absent legacy or malformed evidence', () => {
    for (const evidence of [undefined, null, {}, 'cg']) {
      const legacy = { ...run, launchGuideDesignValues: evidence } as SimRun;
      expect(guideExitValueLabel(legacy, 'cg')).toBe('CG at launch guide exit');
      expect(guideExitValueLabel(legacy, 'cp')).toBe('CP at launch guide exit');
      expect(guideExitValueLabel(legacy, 'stability')).toBe('Static margin at launch guide exit');
      expect(guideExitValueSource(legacy, 'cg')).toBe('source not recorded');
      expect(guideExitValueSources(legacy)).toContain('CP: source not recorded');
    }
  });
  it('does not call a missing numerical value a design estimate', () => {
    const missing = { ...run, launchCP: null, launchGuideDesignValues: ['cp'] } as SimRun;
    expect(guideExitValueSource(missing, 'cp')).toBe('unavailable');
  });
});
