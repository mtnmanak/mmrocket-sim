import type { SimRun } from './simReport.js';

export type GuideExitValue = 'cg' | 'cp' | 'stability';
const FIELD = { cg: 'launchCG', cp: 'launchCP', stability: 'launchStaticMarginCal' } as const;
const LABEL = { cg: 'CG', cp: 'CP', stability: 'Static margin' } as const;

/** Missing provenance on older runs cannot establish a flight sample. */
export function guideExitValueSource(run: SimRun, key: GuideExitValue): string {
  if (!Number.isFinite(run[FIELD[key]])) return 'unavailable';
  if (!Array.isArray(run.launchGuideDesignValues)) return 'source not recorded';
  return run.launchGuideDesignValues.includes(key)
    ? 'design estimate; no guide-exit sample' : 'flight sample';
}

export function guideExitValueLabel(run: SimRun, key: GuideExitValue): string {
  const source = guideExitValueSource(run, key);
  return source !== 'design estimate; no guide-exit sample'
    ? `${LABEL[key]} at launch guide exit` : `${LABEL[key]} (${source})`;
}

export function guideExitValueSources(run: SimRun): string {
  return (['cg', 'cp', 'stability'] as const)
    .map(key => `${LABEL[key]}: ${guideExitValueSource(run, key)}`).join('; ');
}
