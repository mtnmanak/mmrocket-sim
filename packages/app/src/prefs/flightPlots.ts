import { DEFAULT_PLOT_EVENTS } from '../flightPlotEvents.js';

/** N041: viewer layouts only; no units, design, branch data or .ork state. */
export const PLOT_KEYS = ['altitude', 'velocity', 'Vz', 'acceleration', 'mass', 'thrust', 'drag',
  'mach', 'stability', 'stabilityPercent', 'cpLocation', 'cgLocation', 'aoa', 'dynamicPressure', 'qAlpha'] as const;
export const COMPARISON_IDS = ['', 'altitude-velocity', 'altitude-vertical', 'velocity-acceleration', 'stability', 'phase', 'custom', 'ground-track'] as const;
export const MAX_FLIGHT_PLOTS = 50;
export interface SavedFlightPlot {
  id: string;
  name: string;
  panels: string[];
  comparison: string;
  custom?: { x: string; y: string };
  events?: string[];
}

export function normalizeFlightPlots(value: unknown): SavedFlightPlot[] {
  if (!Array.isArray(value)) return [];
  const out: SavedFlightPlot[] = [];
  const ids = new Set<string>(), names = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, panels, comparison, custom, events } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > 100
      || typeof name !== 'string' || !name.trim() || name.trim().length > 80
      || !Array.isArray(panels) || !panels.every(key => PLOT_KEYS.some(k => k === key))
      || !COMPARISON_IDS.some(key => key === comparison)) continue;
    const axes = custom as Record<string, unknown> | undefined;
    const validKey = (key: unknown): key is string => typeof key === 'string' && !!key.trim()
      && key.length <= 100 && key !== 'tc' && !['__proto__', 'constructor', 'prototype'].includes(key);
    if (custom !== undefined && (!axes || typeof axes !== 'object' || !validKey(axes['x']) || !validKey(axes['y']))) continue;
    if (comparison === 'custom' && !axes) continue;
    if (events !== undefined && (!Array.isArray(events) || !events.every(e => DEFAULT_PLOT_EVENTS.some(k => k === e)))) continue;
    const title = name.trim(), folded = title.toLowerCase();
    if (ids.has(id) || names.has(folded)) continue;
    out.push({ id, name: title, panels: [...new Set(panels as string[])], comparison: comparison as string,
      ...(axes ? { custom: { x: axes['x'] as string, y: axes['y'] as string } } : {}),
      ...(events ? { events: [...new Set(events as string[])] } : {}) });
    ids.add(id); names.add(folded);
    if (out.length === MAX_FLIGHT_PLOTS) break;
  }
  return out;
}
