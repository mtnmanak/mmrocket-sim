/** Drag-panel inputs only. Computed curves and component ids never belong here. */
export interface DragAnalysisPrefs {
  machMax: number;
  conditions: 'sealevel' | 'altitude' | 'file';
  /** Committed sweep altitude in metres, independent of display units. */
  altM: number;
  mode: 'component' | 'type';
  cpView: 'pct' | 'unit';
}

export const DEFAULT_DRAG_ANALYSIS: DragAnalysisPrefs = {
  machMax: 3, conditions: 'sealevel', altM: 0, mode: 'component', cpView: 'pct',
};

/** Whitelist saved inputs; the panel also applies the current model/table limits. */
export function normalizeDragAnalysis(value: unknown): DragAnalysisPrefs | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const p = value as Partial<Record<keyof DragAnalysisPrefs, unknown>>;
  return {
    machMax: typeof p.machMax === 'number' && Number.isFinite(p.machMax) && [1, 2, 3, 5, 10, 25].includes(p.machMax)
      ? p.machMax : DEFAULT_DRAG_ANALYSIS.machMax,
    conditions: p.conditions === 'altitude' || p.conditions === 'file' ? p.conditions : 'sealevel',
    altM: typeof p.altM === 'number' && Number.isFinite(p.altM) && p.altM >= 0 ? p.altM : 0,
    mode: p.mode === 'type' ? 'type' : 'component',
    cpView: p.cpView === 'unit' ? 'unit' : 'pct',
  };
}
