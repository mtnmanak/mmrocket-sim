import type { ComponentNode, ComponentType } from '@online-openrocket/engine';
import { CLUSTER_OPTIONS } from './cluster.js';

/**
 * Editor schema: display names, containment rules, default nodes, and the
 * property fields (with UI units) for every component type. UI units are
 * mm/degrees/grams; conversion to engine SI happens in the property panel.
 */

export const DISPLAY_NAME: Record<ComponentType, string> = {
  // Engine-supported since Release B; editor UI arrives with Release C.
  stage: 'Stage',
  nosecone: 'Nose cone',
  transition: 'Transition',
  bodytube: 'Body tube',
  trapezoidfinset: 'Trapezoidal fins',
  ellipticalfinset: 'Elliptical fins',
  freeformfinset: 'Freeform fins',
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
  podset: 'Pod set',
  parallelstage: 'Booster (parallel stage)',
};

/** Which children each AXIAL/container type accepts (subset of OpenRocket's rules). */
const STAGE_CHILDREN: ComponentType[] = ['nosecone', 'bodytube', 'transition'];
const INTERNAL: ComponentType[] = ['parachute', 'streamer', 'shockcord', 'masscomponent'];
const BODY_CHILDREN: ComponentType[] = [
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', ...INTERNAL,
];

// Off-axis assemblies attach to any body component; each holds its own
// axial chain (nose/body/transition), exactly like a mini-rocket.
const ASSEMBLIES: ComponentType[] = ['podset', 'parallelstage'];

export const CONTAINMENT: Partial<Record<ComponentType | 'stage', ComponentType[]>> = {
  stage: STAGE_CHILDREN,
  bodytube: [...BODY_CHILDREN, ...ASSEMBLIES],
  nosecone: [...INTERNAL, ...ASSEMBLIES],
  transition: [...INTERNAL, ...ASSEMBLIES],
  innertube: ['engineblock', 'masscomponent'],
  tubecoupler: ['bulkhead', 'centeringring', ...INTERNAL],
  podset: STAGE_CHILDREN,
  parallelstage: STAGE_CHILDREN,
};

export function allowedChildren(parentType: ComponentType | 'stage'): ComponentType[] {
  return CONTAINMENT[parentType] ?? [];
}

export type FieldUnit = 'mm' | 'm' | 's' | 'deg' | 'g' | 'count' | 'kg/m3' | 'none';

export interface FieldDef {
  key: string;
  label: string;
  unit: FieldUnit;
  step?: number;
  /** slider range in UI units; the slider extends itself if the typed value exceeds smax */
  smin?: number;
  smax?: number;
  /** select options (value -> label) — renders a dropdown instead of a number */
  options?: [string, string][];
  /** renders a checkbox (true/false) instead of a number */
  bool?: boolean;
  /**
   * SI value is a radius; when the user prefers diameter input the panel
   * shows/accepts the doubled value and swaps "radius" → "diameter" in the label.
   */
  radius?: boolean;
}

const SHAPES: [string, string][] = [
  ['ogive', 'Ogive'], ['conical', 'Conical'], ['ellipsoid', 'Ellipsoid'],
  ['parabolic', 'Parabolic'], ['haack', 'Haack'], ['power', 'Power'],
];

const CROSS_SECTIONS: [string, string][] = [
  ['square', 'Square'], ['rounded', 'Rounded'], ['airfoil', 'Airfoil (pointed)'],
];

/** Desktop's surface-finish presets (surface roughness drives skin-friction drag). */
const FINISHES: [string, string][] = [
  ['rough', 'Rough (500 µm)'],
  ['unfinished', 'Unfinished (150 µm)'],
  ['normal', 'Regular paint (60 µm)'],
  ['smooth', 'Smooth paint (20 µm)'],
  ['polished', 'Aircraft sheet-metal (2 µm)'],
  ['finishpolished', 'Polished (0.5 µm)'],
];

const FINISH: FieldDef = { key: 'finish', label: 'Surface finish', unit: 'none', options: FINISHES };

const DEPLOY_EVENTS: [string, string][] = [
  ['ejection', 'Motor ejection charge'],
  ['apogee', 'Apogee'],
  ['altitude', 'Altitude (descending)'],
  ['launch', 'Launch'],
  ['never', 'Never'],
];

/** Stage separation triggers (kernel SeparationEvent; desktop default: ejection). */
const SEPARATION_EVENTS: [string, string][] = [
  ['ejection', 'This stage\'s ejection charge'],
  ['burnout', 'This stage\'s motor burnout'],
  ['upperignition', 'Upper stage motor ignition'],
  ['ignition', 'This stage\'s motor ignition'],
  ['launch', 'Launch'],
  ['apogee', 'Apogee'],
  ['altitudeascending', 'Altitude (ascending)'],
  ['altitudedescending', 'Altitude (descending)'],
  ['never', 'Never'],
];

const lenMM = (key: string, label: string, step = 1, smax = 300): FieldDef =>
  ({ key, label, unit: 'mm', step, smin: 0, smax });

/** A radius field (subject to the radius/diameter preference). smax in mm of radius. */
const radMM = (key: string, label: string, step = 1, smax = 300): FieldDef =>
  ({ key, label, unit: 'mm', step, smin: 0, smax, radius: true });

const DENSITY: FieldDef = {
  key: 'density', label: 'Material density', unit: 'kg/m3', step: 10, smin: 0, smax: 3000,
};
const FIN_COUNT: FieldDef = { key: 'finCount', label: 'Fin count', unit: 'count', smin: 1, smax: 8 };
const CANT: FieldDef = { key: 'cant', label: 'Cant angle', unit: 'deg', step: 0.5, smin: -15, smax: 15 };

/**
 * Through-the-wall fin tabs. A tab exists when BOTH depth and length are > 0
 * (OpenRocket semantics); the engine clamps depth to the body radius. Tab
 * volume counts toward fin mass/CG.
 */
const FIN_TABS: FieldDef[] = [
  lenMM('tabHeight', 'Tab depth (0 = none)', 0.5, 50),
  lenMM('tabLength', 'Tab length', 1, 150),
  { key: 'tabOffset', label: 'Tab offset', unit: 'mm', step: 1, smin: -100, smax: 100 },
  {
    key: 'tabOffsetMethod', label: 'Tab offset from', unit: 'none',
    options: [['top', 'Front of fin'], ['middle', 'Middle of fin'], ['bottom', 'End of fin']],
  },
];
const CD: FieldDef = {
  key: 'cd', label: 'Drag coefficient (blank = auto)', unit: 'none', step: 0.05, smin: 0, smax: 2,
};

/**
 * Off-axis assembly placement (PodSet / ParallelStage). The radial reference
 * matters: RELATIVE treats radialDistance as a GAP from the parent surface
 * (0 = touching); FREE treats it as distance from the parent centerline.
 */
const RADIUS_METHODS: [string, string][] = [
  ['relative', 'Gap from parent surface'],
  ['free', 'From parent centerline'],
];
const ANGLE_METHODS: [string, string][] = [['relative', 'Relative'], ['fixed', 'Fixed']];
const ASSEMBLY_FIELDS: FieldDef[] = [
  { key: 'instanceCount', label: 'Instances (around body)', unit: 'count', smin: 1, smax: 8 },
  // radiusOffset matches the kernel field + .ork <radiusoffset> (gap semantics
  // under RELATIVE) — keep the name aligned so the round-trip is 1:1.
  lenMM('radiusOffset', 'Radial distance', 1, 200),
  { key: 'radiusMethod', label: 'Radial reference', unit: 'none', options: RADIUS_METHODS },
  { key: 'angleOffset', label: 'Angle around body', unit: 'deg', step: 5, smin: -180, smax: 180 },
];

export const FIELDS: Record<ComponentType, FieldDef[]> = {
  // Separation applies to lower stages (the booster separates FROM the stack
  // above); the top stage ignores it — same as the desktop.
  stage: [
    { key: 'separationEvent', label: 'Separate at (lower stages)', unit: 'none', options: SEPARATION_EVENTS },
    { key: 'separationDelay', label: 'Separation delay', unit: 's', step: 0.5, smin: 0, smax: 10 },
  ],
  nosecone: [
    lenMM('length', 'Length'),
    radMM('aftRadius', 'Base outer radius', 0.5, 80),
    lenMM('thickness', 'Wall thickness', 0.1, 10),
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES },
    { key: 'filled', label: 'Solid (filled)', unit: 'none', bool: true },
    radMM('shoulderRadius', 'Shoulder radius', 0.5, 80),
    lenMM('shoulderLength', 'Shoulder length', 1, 150),
    lenMM('shoulderThickness', 'Shoulder thickness', 0.1, 10),
    { key: 'shoulderCapped', label: 'Shoulder end capped', unit: 'none', bool: true },
    FINISH,
    DENSITY,
  ],
  transition: [
    lenMM('length', 'Length'),
    radMM('foreRadius', 'Fore radius', 0.5, 80),
    radMM('aftRadius', 'Aft radius', 0.5, 80),
    lenMM('thickness', 'Wall thickness', 0.1, 10),
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES },
    { key: 'filled', label: 'Solid (filled)', unit: 'none', bool: true },
    radMM('foreShoulderRadius', 'Fore shoulder radius', 0.5, 80),
    lenMM('foreShoulderLength', 'Fore shoulder length', 1, 150),
    radMM('aftShoulderRadius', 'Aft shoulder radius', 0.5, 80),
    lenMM('aftShoulderLength', 'Aft shoulder length', 1, 150),
    FINISH,
    DENSITY,
  ],
  bodytube: [
    lenMM('length', 'Length', 1, 1000),
    radMM('outerRadius', 'Outer radius', 0.5, 80),
    lenMM('thickness', 'Wall thickness', 0.1, 10),
    FINISH,
    DENSITY,
  ],
  trapezoidfinset: [
    FIN_COUNT,
    lenMM('rootChord', 'Root chord', 1, 200),
    lenMM('tipChord', 'Tip chord', 1, 200),
    { key: 'sweep', label: 'Sweep', unit: 'mm', step: 1, smin: -100, smax: 200 },
    lenMM('height', 'Height', 1, 150),
    lenMM('thickness', 'Thickness', 0.5, 10),
    CANT,
    { key: 'crossSection', label: 'Cross section', unit: 'none', options: CROSS_SECTIONS },
    ...FIN_TABS,
    FINISH,
    DENSITY,
  ],
  freeformfinset: [
    FIN_COUNT,
    lenMM('thickness', 'Thickness', 0.5, 10),
    CANT,
    { key: 'crossSection', label: 'Cross section', unit: 'none', options: CROSS_SECTIONS },
    ...FIN_TABS,
    FINISH,
    DENSITY,
  ],
  ellipticalfinset: [
    FIN_COUNT,
    lenMM('rootChord', 'Root chord', 1, 200),
    lenMM('height', 'Height', 1, 150),
    lenMM('thickness', 'Thickness', 0.5, 10),
    { key: 'crossSection', label: 'Cross section', unit: 'none', options: CROSS_SECTIONS },
    ...FIN_TABS,
    FINISH,
    DENSITY,
  ],
  tubefinset: [
    { ...FIN_COUNT, smax: 12 },
    lenMM('length', 'Length', 1, 200),
    radMM('outerRadius', 'Outer radius', 0.5, 50),
    FINISH,
  ],
  innertube: [
    lenMM('length', 'Length'),
    radMM('outerRadius', 'Outer radius', 0.5, 50),
    lenMM('thickness', 'Wall thickness', 0.1, 5),
    // Cluster: N copies of this tube (and its motor) at the pattern points.
    // One motor choice serves the whole cluster — thrust ×N, mass at the
    // real tube positions (kernel ClusterConfiguration).
    { key: 'cluster', label: 'Cluster layout', unit: 'none', options: CLUSTER_OPTIONS },
    { key: 'clusterScale', label: 'Cluster spacing (× tube ⌀)', unit: 'none', step: 0.05, smin: 1, smax: 3 },
    { key: 'clusterRotation', label: 'Cluster rotation', unit: 'deg', step: 5, smin: -180, smax: 180 },
    DENSITY,
  ],
  tubecoupler: [
    lenMM('length', 'Length', 1, 200),
    lenMM('thickness', 'Wall thickness', 0.1, 5),
    DENSITY,
  ],
  centeringring: [
    lenMM('length', 'Thickness (axial)', 0.5, 20),
    DENSITY,
  ],
  bulkhead: [
    lenMM('length', 'Thickness (axial)', 0.5, 20),
    DENSITY,
  ],
  engineblock: [
    lenMM('length', 'Length', 0.5, 20),
    lenMM('thickness', 'Wall thickness', 0.5, 10),
    DENSITY,
  ],
  launchlug: [
    lenMM('length', 'Length', 1, 100),
    radMM('outerRadius', 'Outer radius', 0.2, 10),
    lenMM('thickness', 'Wall thickness', 0.1, 2),
  ],
  railbutton: [
    lenMM('outerDiameter', 'Outer diameter', 0.5, 20),
  ],
  parachute: [
    lenMM('diameter', 'Canopy diameter', 10, 1500),
    CD,
    { key: 'lineCount', label: 'Line count', unit: 'count', smin: 0, smax: 16 },
    lenMM('lineLength', 'Line length', 10, 1000),
    { key: 'deployEvent', label: 'Deploy at', unit: 'none', options: DEPLOY_EVENTS },
    { key: 'deployAltitude', label: 'Deploy altitude (AGL)', unit: 'm', step: 10, smin: 0, smax: 500 },
    { key: 'deployDelay', label: 'Deploy delay', unit: 's', step: 0.5, smin: 0, smax: 10 },
  ],
  streamer: [
    lenMM('stripLength', 'Strip length', 10, 2000),
    lenMM('stripWidth', 'Strip width', 5, 150),
    CD,
    { key: 'deployEvent', label: 'Deploy at', unit: 'none', options: DEPLOY_EVENTS },
    { key: 'deployAltitude', label: 'Deploy altitude (AGL)', unit: 'm', step: 10, smin: 0, smax: 500 },
    { key: 'deployDelay', label: 'Deploy delay', unit: 's', step: 0.5, smin: 0, smax: 10 },
  ],
  shockcord: [
    lenMM('cordLength', 'Cord length', 10, 2000),
  ],
  masscomponent: [
    { key: 'mass', label: 'Mass', unit: 'g', step: 1, smin: 0, smax: 500 },
    lenMM('length', 'Length', 1, 200),
    radMM('radius', 'Radius', 0.5, 50),
  ],
  // A pod never separates (angle method is fixed to relative in the kernel).
  podset: ASSEMBLY_FIELDS,
  // A parallel booster separates and flies its own branch — add the angle
  // reference (meaningful only here) and the separation trigger.
  parallelstage: [
    ...ASSEMBLY_FIELDS,
    { key: 'angleMethod', label: 'Angle reference', unit: 'none', options: ANGLE_METHODS },
    { key: 'separationEvent', label: 'Separate at', unit: 'none', options: SEPARATION_EVENTS },
    { key: 'separationDelay', label: 'Separation delay', unit: 's', step: 0.5, smin: 0, smax: 10 },
  ],
};

/** Types that sit INSIDE their parent and use axial positioning. */
export const POSITIONABLE: Set<ComponentType> = new Set([
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
  'parachute', 'streamer', 'shockcord', 'masscomponent',
  'podset', 'parallelstage',
]);

/** Sensible starting parameters for a freshly added component (SI). */
export function defaultParams(type: ComponentType): Partial<ComponentNode> {
  switch (type) {
    case 'stage': return {};
    case 'nosecone': return { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' };
    case 'transition': return { length: 0.04, foreRadius: 0.012, aftRadius: 0.009, thickness: 0.002, shape: 'conical' };
    case 'bodytube': return { length: 0.2, outerRadius: 0.012, thickness: 0.0005, density: 680 };
    case 'trapezoidfinset': return { finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 } };
    case 'ellipticalfinset': return { finCount: 3, rootChord: 0.05, height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 } };
    case 'freeformfinset': return {
      finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.02, 0.03], [0.045, 0.03], [0.05, 0]],
      position: { method: 'bottom', offset: 0 },
    };
    case 'tubefinset': return { finCount: 6, length: 0.1, position: { method: 'bottom', offset: 0 } };
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
    // Assemblies default to 2 instances, tangent to the parent (radiusOffset 0
    // under RELATIVE = surfaces touching), aft-aligned — the desktop default.
    case 'podset': return {
      instanceCount: 2, radiusOffset: 0, radiusMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 }, children: [],
    };
    case 'parallelstage': return {
      instanceCount: 2, radiusOffset: 0, radiusMethod: 'relative', angleOffset: 0, angleMethod: 'relative',
      separationEvent: 'ejection', separationDelay: 0,
      position: { method: 'bottom', offset: 0 }, children: [],
    };
  }
}
