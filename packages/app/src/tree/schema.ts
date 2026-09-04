import type { ComponentNode, ComponentType } from '@online-openrocket/engine';
import { CLUSTER_OPTIONS } from './cluster.js';

/**
 * Editor schema: display names, containment rules, default nodes, and the
 * property fields (with UI units) for every component type. UI units are
 * mm/degrees/grams; conversion to engine SI happens in the property panel.
 */

/**
 * The editor's component types: the engine's `ComponentType` plus the app-level
 * parts the KERNEL never sees, which `treeModel.engineTree` lowers onto kernel
 * constructs before `buildTree`.
 *
 * `fairing` predates this alias and still sits in the engine package's union
 * (with a comment there saying the kernel never sees it); `protuberance` is
 * declared here instead, which is where an editor-only type belongs — the
 * engine package stays a description of what the kernel actually builds.
 *
 * Consumers index these tables with a plain `ComponentType` and keep working:
 * `ComponentType` is a subtype of `EditorComponentType`, so `FIELDS[node.type]`,
 * `POSITIONABLE.has(node.type)` and `DISPLAY_NAME[node.type]` all still
 * typecheck unchanged. `allowedChildren` deliberately keeps returning
 * `ComponentType[]` so the Add menu's callback signature is untouched.
 */
export type EditorComponentType = ComponentType | 'protuberance';

/** The app-level types, cast for the tables typed in engine terms. */
const APP_ONLY = (t: EditorComponentType): ComponentType => t as ComponentType;

export const DISPLAY_NAME: Record<EditorComponentType, string> = {
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
  fairing: 'Camera shroud / fairing',
  protuberance: 'Protuberance (drag bump)',
  podset: 'Pod set',
  parallelstage: 'Booster (parallel stage)',
};

/** Which children each AXIAL/container type accepts (subset of OpenRocket's rules). */
const STAGE_CHILDREN: ComponentType[] = ['nosecone', 'bodytube', 'transition'];
const INTERNAL: ComponentType[] = ['parachute', 'streamer', 'shockcord', 'masscomponent'];
const BODY_CHILDREN: ComponentType[] = [
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
  'fairing', APP_ONLY('protuberance'),
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock', ...INTERNAL,
];

// Off-axis assemblies attach to any body component; each holds its own
// axial chain (nose/body/transition), exactly like a mini-rocket.
const ASSEMBLIES: ComponentType[] = ['podset', 'parallelstage'];

export const CONTAINMENT: Partial<Record<EditorComponentType | 'stage', ComponentType[]>> = {
  stage: STAGE_CHILDREN,
  bodytube: [...BODY_CHILDREN, ...ASSEMBLIES],
  // NO assemblies on a nose cone or a transition: Transition.isCompatible
  // accepts InternalComponent or FreeformFinSet and nothing else (NoseCone
  // inherits it), so the kernel REFUSES a pod set or booster there. Offering
  // them in the Add menu let a user build, in two clicks and with no import at
  // all, a design that threw on build — killing mass, CG, CP, drag, the 3D
  // stats and Simulate at once, and autosaving the broken tree.
  nosecone: [...INTERNAL],
  // Freeform is the ONE fin type the kernel (and desktop OpenRocket) accepts on
  // a transition — trapezoid/elliptical sets are refused there. Both importers
  // convert to freeform for exactly that reason, so the editor has to allow it
  // or an imported design's fins cannot be edited after arrival.
  transition: [...INTERNAL, 'freeformfinset'],
  innertube: ['engineblock', 'masscomponent'],
  tubecoupler: ['bulkhead', 'centeringring', ...INTERNAL],
  podset: STAGE_CHILDREN,
  parallelstage: STAGE_CHILDREN,
};

export function allowedChildren(parentType: EditorComponentType | 'stage'): ComponentType[] {
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
   * The value an ABSENT key means — for a select or a checkbox.
   *
   * Without this the panel showed `options[0]` for any unset select, which was
   * a live defect: a camera shroud with no `fairingShape` DISPLAYED
   * "Streamlined" (the first option) while every drawing and the physics fell
   * back to half-round. The panel's fallback and the readers' fallback have to
   * be the same value, and the only way to guarantee that is to declare it
   * once, here, where both can see it.
   *
   * It is also what lets a checkbox default to ON: `conformal` is true for a
   * shroud that has never been told otherwise, including every shroud in every
   * file saved before the field existed.
   */
  dflt?: string | boolean;
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

/**
 * RASAero-class supersonic airfoil sections (feature #4). Unset ⇒ the classic
 * cross-section above drives the drag model (bit-identical to before). Each
 * section gets its proper supersonic thickness wave drag; blunt-base sections
 * add fin base drag; the LE radius adds bluntness drag (not for NACA, whose
 * nose radius is implicit).
 */
const AIRFOIL_SECTIONS: [string, string][] = [
  ['', 'Classic (from cross section)'],
  ['hexagonal', 'Hexagonal'],
  ['naca', 'NACA (round LE)'],
  ['doublewedge', 'Double wedge (diamond)'],
  ['biconvex', 'Biconvex'],
  ['hexbluntbase', 'Hexagonal, blunt base'],
  ['singlewedge', 'Single wedge (blunt base)'],
];

/** Desktop's surface-finish presets (surface roughness drives skin-friction drag). */
const FINISHES: [string, string][] = [
  ['rough', 'Rough (500 µm)'],
  ['roughunfinished', 'Rough unfinished (250 µm)'],
  ['unfinished', 'Unfinished (150 µm)'],
  ['normal', 'Regular paint (60 µm)'],
  ['smooth', 'Smooth paint (20 µm)'],
  ['optimum', 'Optimum paint (5 µm)'],
  ['polished', 'Aircraft sheet-metal (2 µm)'],
  ['finishpolished', 'Polished (0.5 µm)'],
  ['mirror', 'Mirror surface (0 µm)'],
];

const FINISH: FieldDef = { key: 'finish', label: 'Surface finish', unit: 'none', options: FINISHES, dflt: 'normal' };

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

/** Desktop's mass-component types (kernel MassComponentType; cosmetic — round-trips via .ork). */
const MASS_COMPONENT_TYPES: [string, string][] = [
  ['masscomponent', 'Mass component'],
  ['altimeter', 'Altimeter'],
  ['flightcomputer', 'Flight computer'],
  ['deploymentcharge', 'Deployment charge'],
  ['tracker', 'Tracker'],
  ['payload', 'Payload'],
  ['recoveryhardware', 'Recovery hardware'],
  ['battery', 'Battery'],
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
// Rotation of the whole set about the body axis (kernel FinSet/TubeFinSet
// baseRotation) — lets straight fins sit BETWEEN tube fins (2026-08-05d).
const FIN_ROTATION: FieldDef = { key: 'rotation', label: 'Rotation (about body axis)', unit: 'deg', step: 5, smin: -180, smax: 180 };

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
  // smax 3: high-efficiency canopies (Fruity Chutes Iris Ultra 2.2, toroidal
  // designs up to ~2.9) sit above the classic 0.75–1.5 flat-sheet range.
  key: 'cd', label: 'Drag coefficient (blank = auto)', unit: 'none', step: 0.05, smin: 0, smax: 3,
};

/** Feature #4: supersonic airfoil section + its geometry inputs (see AIRFOIL_SECTIONS). */
const AIRFOIL_FIELDS: FieldDef[] = [
  { key: 'airfoilSection', label: 'Supersonic airfoil', unit: 'none', options: AIRFOIL_SECTIONS },
  lenMM('airfoilLeDiamond', 'LE chamfer length', 0.5, 100),
  lenMM('airfoilTeDiamond', 'TE chamfer length', 0.5, 100),
  lenMM('finLeRadius', 'LE bluntness radius', 0.1, 5),
];

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

/**
 * Where a surface-mounted part sits around the body: launch lugs, rail
 * buttons, camera shrouds, protuberances. Zero is the top of the airframe as
 * the 2D side view draws it, which is also where a fin set with no rotation
 * puts its first fin — so "0" means "in line with fin 1", and that is exactly
 * the thing an owner needs to steer away from: a camera shroud in line with a
 * fin has the fin in shot (Eric, 2026-08-30). Degrees at the UI and .ork
 * boundaries, radians in the model, like every other angle here.
 */
const MOUNT_ANGLE: FieldDef = {
  key: 'angleOffset', label: 'Angle around body', unit: 'deg', step: 5, smin: -180, smax: 180,
};

/**
 * Off-axis placement for a component that rides INSIDE the airframe rather
 * than on its surface (OpenRocket's RadiusPositionable): how far off the
 * centreline, and in which direction. A split cluster's motor tubes are the
 * common case — each tube is a single tube at its own radius and angle.
 */
const RADIAL_PLACEMENT: FieldDef[] = [
  lenMM('radialPosition', 'Distance off centerline', 1, 300),
  { key: 'radialDirection', label: 'Direction around body', unit: 'deg', step: 5, smin: -180, smax: 180 },
];
const ASSEMBLY_FIELDS: FieldDef[] = [
  { key: 'instanceCount', label: 'Instances (around body)', unit: 'count', smin: 1, smax: 8 },
  // radiusOffset matches the kernel field + .ork <radiusoffset> (gap semantics
  // under RELATIVE) — keep the name aligned so the round-trip is 1:1.
  lenMM('radiusOffset', 'Radial distance', 1, 200),
  { key: 'radiusMethod', label: 'Radial reference', unit: 'none', options: RADIUS_METHODS },
  { key: 'angleOffset', label: 'Angle around body', unit: 'deg', step: 5, smin: -180, smax: 180 },
];

/**
 * RASAero's own protuberance classes (Users Manual pp. 24–29). RASAero asks for
 * a total frontal area per class per body tube and prints their drag in one
 * "Protuberance" column — with no normal force and no CP contribution at all
 * (Manual Fig. 108, subsonic/transonic/supersonic output blocks).
 *
 * The two streamlined classes are NOT constant coefficients: RASAero's method
 * makes a streamlined bump's drag per unit frontal area equal to the rocket
 * body's own (Chuck Rogers, TRF 197641 #1). The option labels say which body CD
 * each one uses, because that is the whole model — see treeModel.protuberanceCd.
 */
/**
 * The two ends of a camera shroud, shaped independently (v0.088).
 *
 * Eric, 2026-08-31: *"a lot of real world shrouds have a half-round shape on
 * the end the camera is pointing (to give the camera lens a proper aperture to
 * shoot video through) and then the other end is usually streamlined."*
 *
 * So it was never one shape. The DEFAULTS are streamlined fore / domed aft,
 * which is the rear-facing camera — the common case, and the one that also puts
 * the streamlined end into the wind. A forward-facing camera swaps the two;
 * that is why they are separate fields and not a single "which way does the
 * camera point" switch.
 *
 * A file written before v0.088 carries one `fairingShape` for the whole part;
 * it migrates to BOTH ends on read, so an existing shroud is drawn exactly as
 * it was.
 */
const END_SHAPES: [string, string][] = [
  ['streamlined', 'Streamlined (tapered)'],
  ['halfround', 'Domed / half-round'],
  ['box', 'Flat / blunt'],
];

/**
 * Whether the shroud's underside is cut to the curve of the body tube.
 *
 * Eric, 2026-08-31: *"right now, the bottom is just a square shape tangentially
 * to the body tube… Most camera shrouds are 3D printed in the modern world and
 * are conformal to the body tube. This should be the default."*
 *
 * DEFAULT TRUE, and an absent key reads as true — so every shroud in every file
 * saved before this existed becomes conformal too. That is deliberate: the flat
 * underside was never a description of anyone's part, it was the absence of one.
 * It changes the drawing only; see the note on drag in treeModel.FAIRING_CD_FRONTAL.
 */
const CONFORMAL: FieldDef = {
  key: 'conformal', label: 'Conformal to body tube?', unit: 'none', bool: true, dflt: true,
};

const PROTUBERANCE_CLASSES: [string, string][] = [
  ['streamlined', 'Streamlined, no base (raceway, cable tunnel) — Cd = body CD without base drag'],
  ['streamlinedbase', 'Streamlined, blunt back (camera housing, shoe) — Cd = body CD with base drag'],
  ['plate', 'Inclined flat plate (fin bracket, anchor) — Cd = 1.17·sin²θ'],
];

export const FIELDS: Record<EditorComponentType, FieldDef[]> = {
  // Separation applies to lower stages (the booster separates FROM the stack
  // above); the top stage ignores it — same as the desktop.
  stage: [
    { key: 'separationEvent', label: 'Separate at (lower stages)', unit: 'none', options: SEPARATION_EVENTS },
    { key: 'separationDelay', label: 'Separation delay', unit: 's', step: 0.5, smin: 0, smax: 10 },
    // RASAero power-on drag: motor exhaust pressurizes the base during burn,
    // lowering base drag. 0 (default) = power-on CD equals power-off CD. For a
    // cluster, enter the single equivalent nozzle (sum the exit AREAS).
    lenMM('nozzleExitDiameter', 'Nozzle exit diameter (0 = power-off drag)', 1, 200),
  ],
  nosecone: [
    lenMM('length', 'Length'),
    radMM('aftRadius', 'Base outer radius', 0.5, 80),
    lenMM('thickness', 'Wall thickness', 0.1, 10),
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES },
    // Shown only for shapes that use it (ogive/power/parabolic/haack) —
    // PropertyPanel hides it otherwise and caps it per shape (haack ≤ 1/3).
    { key: 'shapeParameter', label: 'Shape parameter', unit: 'none', step: 0.05, smin: 0, smax: 1 },
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
    { key: 'shapeParameter', label: 'Shape parameter', unit: 'none', step: 0.05, smin: 0, smax: 1 },
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
    // Min-diameter rockets: the motor loads directly in the body tube (no
    // inner mount tube) — same kernel path as the desktop's body-tube mount.
    { key: 'motorMount', label: 'Motor mount (motor loads in this tube)', unit: 'none', bool: true },
    // Sub-minimum rockets: the motor case IS the airframe (fins bonded to a
    // commercial case, or propellant cast into the airframe tube). The flag
    // widens the motor browser's fit check to this tube's OUTER diameter —
    // the sim itself never gated on motor fit (only shown when mount is on).
    { key: 'caseAirframe', label: 'Sub-minimum: motor case is the airframe', unit: 'none', bool: true },
    // Aft protrusion of the motor past the tube end (~6 mm is standard
    // min-diameter practice) — shifts the motor mass aft in the sim.
    { key: 'motorOverhang', label: 'Motor overhang (past aft end)', unit: 'mm', step: 1, smin: -50, smax: 100 },
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
    FIN_ROTATION,
    { key: 'crossSection', label: 'Cross section', unit: 'none', options: CROSS_SECTIONS },
    ...AIRFOIL_FIELDS,
    ...FIN_TABS,
    FINISH,
    DENSITY,
  ],
  freeformfinset: [
    FIN_COUNT,
    lenMM('thickness', 'Thickness', 0.5, 10),
    CANT,
    FIN_ROTATION,
    { key: 'crossSection', label: 'Cross section', unit: 'none', options: CROSS_SECTIONS },
    ...AIRFOIL_FIELDS,
    ...FIN_TABS,
    FINISH,
    DENSITY,
  ],
  ellipticalfinset: [
    FIN_COUNT,
    CANT,
    lenMM('rootChord', 'Root chord', 1, 200),
    lenMM('height', 'Height', 1, 150),
    lenMM('thickness', 'Thickness', 0.5, 10),
    FIN_ROTATION,
    { key: 'crossSection', label: 'Cross section', unit: 'none', options: CROSS_SECTIONS },
    ...AIRFOIL_FIELDS,
    ...FIN_TABS,
    FINISH,
    DENSITY,
  ],
  tubefinset: [
    { ...FIN_COUNT, smax: 12 },
    lenMM('length', 'Length', 1, 200),
    radMM('outerRadius', 'Outer radius', 0.5, 50),
    lenMM('thickness', 'Wall thickness', 0.1, 5),
    FIN_ROTATION,
    FINISH,
    DENSITY,
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
    { key: 'motorOverhang', label: 'Motor overhang (past aft end)', unit: 'mm', step: 1, smin: -50, smax: 100 },
    // A physical property of the airframe (how much room the mount really
    // has), so it lives ON the mount and persists through sessions and .ork
    // files. The Motors & Launch tab offers a per-stage override on top.
    { key: 'maxMotorLength', label: 'Max motor length (blank = no limit)', unit: 'mm', step: 5 },
    ...RADIAL_PLACEMENT,
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
    MOUNT_ANGLE,
  ],
  railbutton: [
    lenMM('outerDiameter', 'Outer diameter', 0.5, 20),
    // THE BUTTON'S FIVE DIMENSIONS ARE ONE FACT, and they were all missing
    // until v0.103 — a button flew, weighed and drew as the kernel
    // constructor's generic 9.7 mm part whatever the user typed or the file
    // said (RailButton.java:58-66). They belong together because they enter
    // the SAME two formulas:
    //  • DRAG. RailButtonCalc.java:57-60 builds the reference area as
    //    totalHeight*OD − (OD−innerDiameter)*innerHeight, where innerHeight is
    //    totalHeight − flangeHeight − baseHeight (RailButton.java:104-106). So
    //    a height typed without its waist mis-sizes the notch: on @Buckeye's
    //    vb38 button (OD 9.5, ID 6.0, H 8.0 mm) height alone gets ~60 % of the
    //    way, the rest is his 6 mm waist against the default 8 mm.
    //  • The SAME totalHeight enters a second time at RailButtonCalc.java:85-92,
    //    compared against the local boundary-layer thickness to set the velocity
    //    the button actually sees — so CD is SUPERLINEAR in height, not linear.
    //    Measured on the ARCAS-short fixture, 2 buttons, whole-rocket CD at
    //    M0.3: 0.003099 at 6 mm, 0.012523 at the 9.7 mm default, 0.040118 at
    //    15 mm — a 2.3x span of reference area producing a 13x span of drag.
    //  • MASS. RailButton.java:301-308 uses flange, base, inner height, ID, OD
    //    and screw height. screwHeight is mass-only; it is in no drag term.
    // Same lesson as the Fruity Chutes Cd/spill-hole ruling: carry them
    // together or the number is wrong in a way nobody can see.
    // The key is `totalHeight`, NOT `height`: componentTable.ts:74-84 dedupes
    // FIELDS keys ACROSS types and `height` is already the fairing's and the
    // protuberance's, so a `height` column here would be silently swallowed.
    lenMM('totalHeight', 'Total height', 0.5, 25),
    lenMM('innerDiameter', 'Inner (waist) diameter', 0.5, 20),
    lenMM('baseHeight', 'Base / standoff height', 0.5, 12),
    lenMM('flangeHeight', 'Flange height', 0.5, 12),
    lenMM('screwHeight', 'Screw-head height', 0.5, 12),
    // Rail buttons come in PAIRS (or more): the kernel's RailButton is
    // LineInstanceable — one node draws, weighs and drags as N collinear
    // copies marching AFT from the node's own position at this spacing. That
    // is exactly what a desktop .ork stores, so both fields round-trip 1:1.
    // Eric, 2026-08-31b: "Rail buttons are almost always implemented in pairs
    // or more than 2."
    { key: 'instanceCount', label: 'Number of rail buttons', unit: 'count', smin: 1, smax: 4 },
    lenMM('instanceSeparation', 'Distance between buttons', 10, 2000),
    MOUNT_ANGLE,
  ],
  parachute: [
    lenMM('diameter', 'Canopy diameter', 10, 1500),
    CD,
    // Spill hole: modeled as an area reduction — effective Cd scales by
    // 1 − (hole ⌀ / canopy ⌀)², applied at the engine boundary (the kernel
    // Parachute has no hole concept). RockSim SpillHoleDia round-trips.
    lenMM('spillHoleDiameter', 'Spill hole ⌀ (0 = none)', 0, 500),
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
    { key: 'massComponentType', label: 'Type', unit: 'none', options: MASS_COMPONENT_TYPES },
  ],
  // External protuberance (camera shroud, avionics fairing). The physics is
  // synthesized at the engine boundary (treeModel.engineTree): slender-strake
  // lift via a 1-fin Barrowman surface + Hoerner protuberance drag as a CD
  // override, charged against the area the shroud blocks measured FROM THE
  // TUBE SURFACE (width x height plus the tangent-to-arc crescent, v0.090).
  fairing: [
    lenMM('length', 'Length (along body)', 5, 500),
    lenMM('width', 'Width (across body)', 2, 200),
    lenMM('height', 'Height (off the surface)', 2, 200),
    { key: 'fairingForeShape', label: 'Fore end (toward the nose)', unit: 'none',
      options: END_SHAPES, dflt: 'streamlined' },
    { key: 'fairingAftShape', label: 'Aft end (toward the tail)', unit: 'none',
      options: END_SHAPES, dflt: 'halfround' },
    CONFORMAL,
    { key: 'mass', label: 'Mass (as built)', unit: 'g', step: 1, smin: 0, smax: 500 },
    MOUNT_ANGLE,
    FINISH,
  ],
  // RASAero's PROTUBERANCE: a discrete drag-producing bump — rail guide, launch
  // shoe, cable tunnel, camera housing, fin-root anchor. Frontal area x a drag
  // class, drag only: no lift, no CP shift (see PROTUBERANCE_CLASSES). Lowered
  // at the engine boundary onto a kernel RailButton carrying a CD override —
  // RailButtonCalc contributes no normal force and no friction, so the override
  // IS the whole contribution. Length is drawing/placement only.
  protuberance: [
    { key: 'dragClass', label: 'Drag class', unit: 'none', options: PROTUBERANCE_CLASSES },
    lenMM('width', 'Width (across body)', 1, 300),
    lenMM('height', 'Height (off the surface)', 1, 300),
    { key: 'count', label: 'How many (identical)', unit: 'count', smin: 1, smax: 24 },
    { key: 'plateAngle', label: 'Plate angle from the body', unit: 'deg', step: 5, smin: 0, smax: 90 },
    // The escape hatch from the Mach-flat scalar: a streamlined class is the
    // body CD at Mach 0.3, so a high-Mach design that wants the body CD at its
    // own max Q types it here. smax 2 covers every body CD the kernel produces.
    // smin 0 is the slider's "release the override" stop, NOT zero drag: 0 and
    // blank both fall through to the class (treeModel.protuberanceExplicitCd),
    // which is why the label names both. A slider has no blank position, so
    // without that the left stop would silently zero the component's physics.
    { key: 'cdFrontal', label: 'Cd on frontal area (blank or 0 = from class)', unit: 'none', step: 0.05, smin: 0, smax: 2 },
    { key: 'mass', label: 'Mass, all of them (0 = not counted)', unit: 'g', step: 1, smin: 0, smax: 2000 },
    lenMM('length', 'Length along body (shape only, no drag)', 1, 1000),
    MOUNT_ANGLE,
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
export const POSITIONABLE: Set<EditorComponentType> = new Set([
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset', 'launchlug', 'railbutton',
  'fairing', 'protuberance',
  'innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
  'parachute', 'streamer', 'shockcord', 'masscomponent',
  'podset', 'parallelstage',
]);

/** Sensible starting parameters for a freshly added component (SI). */
export function defaultParams(type: EditorComponentType): Partial<ComponentNode> {
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
    case 'tubefinset': return { finCount: 6, length: 0.1, thickness: 0.0005, position: { method: 'bottom', offset: 0 } };
    case 'innertube': return { length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 } };
    case 'tubecoupler': return { length: 0.05, thickness: 0.0005 };
    case 'centeringring': return { length: 0.002, position: { method: 'bottom', offset: -0.01 } };
    case 'bulkhead': return { length: 0.003 };
    case 'engineblock': return { length: 0.005, thickness: 0.001, position: { method: 'top', offset: 0 } };
    // angleOffset PI = the bottom of the side view, which is the kernel's own
    // default (LaunchLug.java and RailButton.java both initialise
    // angleOffsetRad to Math.PI) and desktop OpenRocket's. Ours was 0 until
    // v0.088 -- and 0 is the top, which is exactly where an unrotated fin set
    // puts fin 1. So every rail button this app added landed on a fin root
    // line, on the one line the launch rail needs clear. Nobody reported it
    // because the angle was not read from the file, drawn, or editable until
    // v0.087; it became visible the moment it became real.
    case 'launchlug': return { length: 0.05, outerRadius: 0.0022, thickness: 0.0003, angleOffset: Math.PI, position: { method: 'middle', offset: 0 } };
    // The five geometry values are EXACTLY the kernel constructor's
    // (RailButton.java:58-64: OD 9.7, total height 9.7, ID 8.0, flange 2.0,
    // base 2.0 mm, screw 0), so nothing anyone has already built moves when
    // these keys start being carried. That geometry matches NONE of the eight
    // real parts in OpenRocket's own RailButton_Database.orc (total heights
    // 4.05, 5.21, 6.86, 7.56, 7.75, 11.42, 14.22, 17.39 mm) — it is desktop's
    // invented default, kept deliberately so this release is a fidelity fix
    // and not a silent re-sizing of every existing button.
    case 'railbutton': return {
      outerDiameter: 0.0097, innerDiameter: 0.008, totalHeight: 0.0097,
      baseHeight: 0.002, flangeHeight: 0.002, screwHeight: 0,
      angleOffset: Math.PI, position: { method: 'middle', offset: 0 },
    };
    case 'parachute': return { diameter: 0.3, position: { method: 'top', offset: 0.02 } };
    case 'streamer': return { stripLength: 0.5, stripWidth: 0.05, position: { method: 'top', offset: 0.02 } };
    case 'shockcord': return { cordLength: 0.3, position: { method: 'top', offset: 0.01 } };
    case 'masscomponent': return { mass: 0.01, length: 0.02, radius: 0.005, position: { method: 'top', offset: 0.02 } };
    // A typical 3D-printed keychain-camera shroud on a mid/high-power bird.
    case 'fairing': return {
      length: 0.08, width: 0.025, height: 0.02,
      fairingForeShape: 'streamlined', fairingAftShape: 'halfround', conformal: true,
      mass: 0.03, position: { method: 'middle', offset: 0 },
    };
    // A typical cable tunnel / camera housing: 20 x 10 mm frontal, 60 mm long,
    // faired at the front with a blunt back end. Mass 0 — a protuberance is
    // aerodynamic bookkeeping first, and a mass typed here is billed in full.
    case 'protuberance': return {
      dragClass: 'streamlinedbase', width: 0.02, height: 0.01, length: 0.06,
      count: 1, plateAngle: Math.PI / 4, mass: 0,
      position: { method: 'middle', offset: 0 },
    };
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
