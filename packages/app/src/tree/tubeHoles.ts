import type { ComponentNode } from '@online-openrocket/engine';
import { num } from './nodeNum.js';

export const TUBE_HOLE_TYPE = 'tubehole';
export const TUBE_HOLE_ADVICE = 'Fabrication only: these marks do not change mass, CG, drag or any flight number. The app does not calculate vent pressure.';
export const TUBE_HOLE_DEFAULTS = { holeDiameter: 0.003, holePosition: 0.025, angleOffset: 0, holeCount: 1 };

export interface TubeHoleMark { angle: number; station: number; diameter: number }

/** N045: one bounded placement rule for stored files, drawings and drilling wraps. */
export function tubeHoleMarks(node: ComponentNode): TubeHoleMark[] {
  const count = Math.max(1, Math.min(64, Math.round(num(node, 'holeCount', TUBE_HOLE_DEFAULTS.holeCount))));
  const station = Math.max(0, Math.min(1000, num(node, 'holePosition', TUBE_HOLE_DEFAULTS.holePosition)));
  const diameter = Math.max(0.0001, Math.min(1000, num(node, 'holeDiameter', TUBE_HOLE_DEFAULTS.holeDiameter)));
  const rotation = num(node, 'angleOffset', 0);
  return Array.from({ length: count }, (_, i) => ({
    angle: ((rotation + i * 2 * Math.PI / count) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI),
    station, diameter,
  }));
}
