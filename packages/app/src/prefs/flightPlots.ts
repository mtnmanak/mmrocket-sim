/** N041: viewer layouts only; no units, design, branch data or .ork state. */
export const PLOT_KEYS = ['altitude', 'velocity', 'Vz', 'acceleration', 'mass', 'thrust', 'drag',
  'mach', 'stability', 'stabilityPercent', 'cpLocation', 'cgLocation', 'aoa', 'dynamicPressure', 'qAlpha'] as const;
export const COMPARISON_IDS = ['', 'altitude-velocity', 'altitude-vertical', 'velocity-acceleration', 'stability', 'phase'] as const;
export const MAX_FLIGHT_PLOTS = 50;
export interface SavedFlightPlot {
  id: string;
  name: string;
  panels: string[];
  comparison: string;
}

export function normalizeFlightPlots(value: unknown): SavedFlightPlot[] {
  if (!Array.isArray(value)) return [];
  const out: SavedFlightPlot[] = [];
  const ids = new Set<string>(), names = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, panels, comparison } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > 100
      || typeof name !== 'string' || !name.trim() || name.trim().length > 80
      || !Array.isArray(panels) || !panels.every(key => PLOT_KEYS.some(k => k === key))
      || !COMPARISON_IDS.some(key => key === comparison)) continue;
    const title = name.trim(), folded = title.toLowerCase();
    if (ids.has(id) || names.has(folded)) continue;
    out.push({ id, name: title, panels: [...new Set(panels as string[])], comparison: comparison as string });
    ids.add(id); names.add(folded);
    if (out.length === MAX_FLIGHT_PLOTS) break;
  }
  return out;
}
