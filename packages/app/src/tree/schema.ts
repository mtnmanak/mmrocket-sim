import type { ComponentNode, ComponentType } from '@online-openrocket/engine';

/**
 * Editor schema: display names, containment rules, default nodes, and the
 * property fields (with UI units) for every component type. UI units are
 * mm/degrees/grams; conversion to engine SI happens in the property panel.
 */

export const DISPLAY_NAME: Record<ComponentType, string> = {
  nosecone: 'Nose cone',
  transition: 'Transition',
  bodytube: 'Body tube',
  trapezoidfinset: 'Trapezoidal fins',
  ellipticalfinset: 'Elliptical fins',
  tubefinset: 'Tube fins',
  innertube: 'Inner tube',
  tubecoupler: 'Tube coupler',
  centeringring: 'Centering ring',
  bulkhead: 'Bulkhead',
  engineblock: 'Engine block',
  launchlug: 'Launch lug',
  railbutton: 'Rail button',
  parachute: 'Parachute',
  streamer: 'Streamer',
  shockcord: 'Shock cord',
  masscomponent: 'Mass component',
};

/** Which children each AXIAL/container type accepts (subset of OpenRocket's rules). */
const STAGE_CHILDREN: ComponentType[] = ['nosecone', 'bodytube', 'transition'];
const INTERNAL: ComponentType[] = ['parachute', 'streamer', 'shockcord', 'masscomponent'];
const BODY_CHILDREN: ComponentType[] = [
  'trapezoidfinset', 'ellipticalfinset', 'tubefinset', 'launchlug', 'railbutton',
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', ...INTERNAL,
];

export const CONTAINMENT: Partial<Record<ComponentType | 'stage', ComponentType[]>> = {
  stage: STAGE_CHILDREN,
  bodytube: BODY_CHILDREN,
  nosecone: INTERNAL,
  transition: INTERNAL,
  innertube: ['engineblock', 'masscomponent'],
  tubecoupler: ['bulkhead', 'centeringring', ...INTERNAL],
};

export function allowedChildren(parentType: ComponentType | 'stage'): ComponentType[] {
  return CONTAINMENT[parentType] ?? [];
}

export type FieldUnit = 'mm' | 'deg' | 'g' | 'count' | 'kg/m3' | 'none';

export interface FieldDef {
  key: string;
  label: string;
  unit: FieldUnit;
  step?: number;
  /** select options (value -> label) — renders a dropdown instead of a number */
  options?: [string, string][];
}

const SHAPES: [string, string][] = [
  ['ogive', 'Ogive'], ['conical', 'Conical'], ['ellipsoid', 'Ellipsoid'],
  ['parabolic', 'Parabolic'], ['haack', 'Haack'], ['power', 'Power'],
];

const lenMM = (key: string, label: string, step = 1): FieldDef => ({ key, label, unit: 'mm', step });

export const FIELDS: Record<ComponentType, FieldDef[]> = {
  nosecone: [
    lenMM('length', 'Length'),
    lenMM('aftRadius', 'Base radius', 0.5),
    lenMM('thickness', 'Wall thickness', 0.1),
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES },
    { key: 'density', label: 'Material density', unit: 'kg/m3', step: 10 },
  ],
  transition: [
    lenMM('length', 'Length'),
    lenMM('foreRadius', 'Fore radius', 0.5),
    lenMM('aftRadius', 'Aft radius', 0.5),
    lenMM('thickness', 'Wall thickness', 0.1),
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES },
    { key: 'density', label: 'Material density', unit: 'kg/m3', step: 10 },
  ],
  bodytube: [
    lenMM('length', 'Length'),
    lenMM('outerRadius', 'Outer radius', 0.5),
    lenMM('thickness', 'Wall thickness', 0.1),
    { key: 'density', label: 'Material density', unit: 'kg/m3', step: 10 },
  ],
  trapezoidfinset: [
    { key: 'finCount', label: 'Fin count', unit: 'count' },
    lenMM('rootChord', 'Root chord'),
    lenMM('tipChord', 'Tip chord'),
    lenMM('sweep', 'Sweep'),
    lenMM('height', 'Height'),
    lenMM('thickness', 'Thickness', 0.5),
    { key: 'cant', label: 'Cant angle', unit: 'deg', step: 0.5 },
    { key: 'density', label: 'Material density', unit: 'kg/m3', step: 10 },
  ],
  ellipticalfinset: [
    { key: 'finCount', label: 'Fin count', unit: 'count' },
    lenMM('rootChord', 'Root chord'),
    lenMM('height', 'Height'),
    lenMM('thickness', 'Thickness', 0.5),
    { key: 'density', label: 'Material density', unit: 'kg/m3', step: 10 },
  ],
  tubefinset: [
    { key: 'finCount', label: 'Fin count', unit: 'count' },
    lenMM('length', 'Length'),
    lenMM('outerRadius', 'Outer radius', 0.5),
  ],
  innertube: [
    lenMM('length', 'Length'),
    lenMM('outerRadius', 'Outer radius', 0.5),
    lenMM('thickness', 'Wall thickness', 0.1),
  ],
  tubecoupler: [
    lenMM('length', 'Length'),
    lenMM('thickness', 'Wall thickness', 0.1),
  ],
  centeringring: [
    lenMM('length', 'Thickness (axial)', 0.5),
  ],
  bulkhead: [
    lenMM('length', 'Thickness (axial)', 0.5),
  ],
  engineblock: [
    lenMM('length', 'Length', 0.5),
    lenMM('thickness', 'Wall thickness', 0.5),
  ],
  launchlug: [
    lenMM('length', 'Length'),
    lenMM('outerRadius', 'Outer radius', 0.2),
    lenMM('thickness', 'Wall thickness', 0.1),
  ],
  railbutton: [
    lenMM('outerDiameter', 'Outer diameter', 0.5),
  ],
  parachute: [
    lenMM('diameter', 'Canopy diameter', 10),
    { key: 'cd', label: 'Drag coefficient (blank = auto)', unit: 'none', step: 0.05 },
    { key: 'lineCount', label: 'Line count', unit: 'count' },
    lenMM('lineLength', 'Line length', 10),
  ],
  streamer: [
    lenMM('stripLength', 'Strip length', 10),
    lenMM('stripWidth', 'Strip width', 5),
    { key: 'cd', label: 'Drag coefficient (blank = auto)', unit: 'none', step: 0.05 },
  ],
  shockcord: [
    lenMM('cordLength', 'Cord length', 10),
  ],
  masscomponent: [
    { key: 'mass', label: 'Mass', unit: 'g', step: 1 },
    lenMM('length', 'Length'),
    lenMM('radius', 'Radius', 0.5),
  ],
};

/** Types that sit INSIDE their parent and use axial positioning. */
export const POSITIONABLE: Set<ComponentType> = new Set([
  'trapezoidfinset', 'ellipticalfinset', 'tubefinset', 'launchlug', 'railbutton',
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
  'parachute', 'streamer', 'shockcord', 'masscomponent',
]);

/** Sensible starting parameters for a freshly added component (SI). */
export function defaultParams(type: ComponentType): Partial<ComponentNode> {
  switch (type) {
    case 'nosecone': return { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' };
    case 'transition': return { length: 0.04, foreRadius: 0.012, aftRadius: 0.009, thickness: 0.002, shape: 'conical' };
    case 'bodytube': return { length: 0.2, outerRadius: 0.012, thickness: 0.0005, density: 680 };
    case 'trapezoidfinset': return { finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 };
    case 'ellipticalfinset': return { finCount: 3, rootChord: 0.05, height: 0.03, thickness: 0.003 };
    case 'tubefinset': return { finCount: 6, length: 0.1 };
    case 'innertube': return { length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 } };
    case 'tubecoupler': return { length: 0.05, thickness: 0.0005 };
    case 'centeringring': return { length: 0.002, position: { method: 'bottom', offset: -0.01 } };
    case 'bulkhead': return { length: 0.003 };
    case 'engineblock': return { length: 0.005, thickness: 0.001, position: { method: 'top', offset: 0 } };
    case 'launchlug': return { length: 0.05, outerRadius: 0.0022, thickness: 0.0003, position: { method: 'middle', offset: 0 } };
    case 'railbutton': return { position: { method: 'middle', offset: 0 } };
    case 'parachute': return { diameter: 0.3, position: { method: 'top', offset: 0.02 } };
    case 'streamer': return { stripLength: 0.5, stripWidth: 0.05, position: { method: 'top', offset: 0.02 } };
    case 'shockcord': return { cordLength: 0.3, position: { method: 'top', offset: 0.01 } };
    case 'masscomponent': return { mass: 0.01, length: 0.02, radius: 0.005, position: { method: 'top', offset: 0.02 } };
  }
}
