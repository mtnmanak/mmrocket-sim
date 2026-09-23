import type { ComponentNode, ComponentType } from '@online-openrocket/engine';
import { CLUSTER_OPTIONS } from './cluster.js';
import { lookupTable } from '../services/xmlUtil.js';
import { num } from './nodeNum.js';

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

const CONTAINMENT: Partial<Record<EditorComponentType | 'stage', ComponentType[]>> = {
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
  /**
   * BLANK IS A REAL STATE for this field, so clearing the box commits
   * `undefined`: "auto", a kernel default the panel prints as a placeholder,
   * "no limit", "off". Every other numeric field DISCARDS an empty draft — the
   * box reverts to its value on blur (audit 2026-09-22).
   *
   * Before this flag every schema field was clearable, and a cleared REQUIRED
   * dimension had no single meaning: every layer substituted its own hidden
   * default. A body tube with its length cleared flew 0.3 m in the kernel,
   * drew 0 long in 3D, measured 0.025 m in the 2D drawing and positioning,
   * and framed its children's position sliders at 0.2 m. Mark a field
   * optional only when every reader agrees what its absence means.
   */
  optional?: boolean;
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

/**
 * THE KERNEL'S FIN-COUNT RULE: 1 to 8, for every fin type. `FinSet.setFinCount`
 * and `TubeFinSet.setFinCount` both clamp to it (FinSet.java:179-182,
 * TubeFinSet.java:233-236), and desktop's four fin dialogs all bound their
 * spinner to it (`new IntegerModel(component, "FinCount", 1, 8)`).
 *
 * Until audit 2026-09-22 the app did not: the tube-fin slider ran to 12, a
 * typed count had no ceiling at all, every drawing looped the raw number and
 * every export wrote it — so a 12-fin set was drawn, printed and exported as 12
 * while the kernel flew 8. Measured by that audit: trapezoid sets of 8 and 12
 * gave an identical kernel fin-set mass (19.584 g) and CP (0.34217 m), and 12
 * tube fins printed an 8.66 mm OD against the 15.37 mm the kernel flew. Every
 * DRAWING, the tube-fin geometry, the fin alignment and the rail and wake
 * checks (mountAngle.ts) now read the count through `finCountOf` (counts.ts),
 * so nothing stored can draw more than the kernel flies. The
 * other readers — the exporters, the fin template and DXF labels, the
 * interleave rotation for a second set — still read the node itself, and are
 * kept honest by the two places a count is written: the panel's count field
 * stops here, and the sanitize pass (sanitize.ts) repairs a file or a saved
 * session that says more.
 */
export const KERNEL_MAX_FINS = 8;

/**
 * Line instances (launch lugs, rail buttons): the bridge's own ceiling —
 * `ComponentFactory.applyLineInstances` clamps to 1..64 (ComponentFactory.java
 * :904), whose comment says why: every mass and aero pass allocates one
 * Coordinate per instance, so a file saying 100000000 would wedge the tab.
 */
export const KERNEL_MAX_LINE_INSTANCES = 64;

/**
 * Pod sets and boosters: the kernel has NO ceiling (PodSet/ParallelStage
 * .setInstanceCount only refuse < 1), so this one is the app's. Every instance
 * is a whole nose-body-fins chain in all three views and in the kernel, and 32
 * is four times the panel slider's 8 — far above any real ring of pods — while
 * keeping a hostile count from multiplying the drawing into the millions.
 */
export const MAX_ASSEMBLY_INSTANCES = 32;

/**
 * Parachute shroud lines. The kernel takes any count (Parachute.setLineCount
 * has no clamp) and bills `lineCount × lineLength × line density` as mass, so a
 * .rkt saying 1,000,000 lines made a 540 kg parachute (audit 2026-09-22). The
 * ceiling is the APP's, against a corrupt count, and deliberately loose.
 *
 * It was 64, "matching the line-instance ceiling above" — but that ceiling
 * exists because every lug or rail-button instance is a Coordinate the kernel
 * allocates on each pass, and a canopy's lines are no such thing: one integer,
 * multiplied into the mass, drawn by nothing. So 64 clamped a count the kernel
 * flies faithfully, and the one design over it in the owner's 939-file RockSim
 * corpus — Black-Brant-IV-24mm.rkt, 66 lines — was stored at 64 and told it had
 * "more than any real parachute" (seam review of audit 2026-09-22). No number
 * moved there: that file's KnownMass overrides the chute's mass. And its 66 is
 * very likely a typo for 6 — the part is an 18" plastic hexagon, which the
 * corpus carries 27 more times at 6 or 8 lines — but a file's plausible count
 * is flown as written, not called impossible, and a typo is the user's to fix.
 * 256 is over ten times the most any parachute in the shipped parts catalogue
 * has (24; the corpus tops out at 20 bar that 66), and the 540 kg file's
 * 600 mm canopy weighs 0.157 kg at it (0.054 kg at the old 64).
 * @internal Exported for tree/sanitize.test.ts; no other module imports it.
 */
export const MAX_SHROUD_LINES = 256;

/**
 * A protuberance's `count` is an area multiplier, never a loop — this is the
 * ceiling the .ork reader already applied (orkFile.ts, `count <= 1000`),
 * carried here so the panel and a restored session honour the same one.
 */
const MAX_PROTUBERANCE_COUNT = 1000;

/**
 * No dimension of a real rocket is a kilometre. A value past it is corrupt or
 * hostile, and it is not harmless: the drawings size themselves to the part,
 * and a clipped transition's clip search — `calculateClip` in shapeProfile.ts
 * and the kernel's identical loop — never converges once the length reaches
 * ~1e12 m, freezing the tab on first render (audit 2026-09-22). Capping it at
 * the load boundary protects the kernel's copy, which the app cannot bound.
 */
export const MAX_DIMENSION_M = 1000;

/**
 * The smallest value stored for a dimension where ZERO fails the kernel build.
 * Measured at audit 2026-09-22 on the shipped kernel: a tube-fin length of 0
 * throws "The number NaN cannot be converted to a BigInt" from staticInfo, and
 * a camera-shroud height of 0 with a blunt or domed end lowers to a strake with
 * two coincident points and throws "Unknown format conversion: g" from
 * buildTree; 1e-12 m builds in both. 0.1 mm is below any tube fin or shroud
 * anyone builds, yet still reads as a number rather than as zero in millimetres
 * and in inches (the panel shows three decimals), so the repair is visible.
 * @internal Exported for tree/sanitize.test.ts; no other module imports it.
 */
export const MIN_POSITIVE_DIMENSION_M = 0.0001;

/** What a limit bounds, which decides how a note formats the number. */
export type LimitKind = 'length' | 'mass' | 'density' | 'count';

/**
 * A HARD limit on a stored SI value — not a slider range. `smin`/`smax` on a
 * FieldDef are where a slider stops; these are what a node may hold at all,
 * enforced in two places that must agree: `PropertyPanel`'s `commit` (a typed
 * or dragged value) and `sanitizeTree` (a file, a share link or a restored
 * session, run inside `normalizeTree`).
 */
export interface FieldLimit {
  kind: LimitKind;
  /** Hard minimum (SI). A value below it is raised to it. */
  hmin: number;
  /** Hard maximum (SI). A value above it is lowered to it. */
  hmax?: number;
  /** For the import note: why the CEILING is where it is (quoted only when a value is over it). */
  why?: string;
  /** For the import note, where the component type has no FieldDef for the key. */
  label?: string;
}

const LEN: FieldLimit = { kind: 'length', hmin: 0, hmax: MAX_DIMENSION_M };
/** A length whose SIGN means something (sweep, overhang, offsets) — only its size is bounded. */
const SIGNED_LEN: FieldLimit = { kind: 'length', hmin: -MAX_DIMENSION_M, hmax: MAX_DIMENSION_M };
const POSITIVE_LEN: FieldLimit = { kind: 'length', hmin: MIN_POSITIVE_DIMENSION_M, hmax: MAX_DIMENSION_M };
const MASS: FieldLimit = { kind: 'mass', hmin: 0 };
const BULK: FieldLimit = { kind: 'density', hmin: 0 };
const FINS: FieldLimit = {
  kind: 'count', hmin: 1, hmax: KERNEL_MAX_FINS,
  why: 'the most fins a set can have in OpenRocket, and so the most the simulation flies',
};
const LINE_INSTANCES: FieldLimit = {
  kind: 'count', hmin: 1, hmax: KERNEL_MAX_LINE_INSTANCES,
  why: 'the most the simulation places in a line', label: 'number of instances',
};

/**
 * Every node key with a hard limit, whatever the component type. Some negative
 * values the kernel does not survive: a negative fin height or root chord, a
 * negative wall, lug length, streamer strip, chute line length or canopy / line
 * density each throws "attempted to initialize an InertiaMatrix with a
 * negative inertia value" and fails the whole build. Measured 2026-09-22 by a
 * single-field fuzz of the five .ork fixtures in services/__fixtures__, every
 * numeric element made negative in turn: 20 of 300 edits failed the build
 * before this table and none after (zeros: 1 of 158 before, none after). The
 * rest are a length, a radius or a mass that cannot be negative either. The
 * kernel clamps some of them itself (MassComponent.setComponentMass,
 * RocketComponent.setOverrideMass), but it FLIES others as given: in the same
 * fuzz, 15 edits built and moved mass, CG or CP — a negative canopy diameter,
 * shroud line count or line length (a negative line count subtracts mass), a
 * negative root chord (which also changed the rocket's length), negative rail
 * button diameters. Zero here moves those numbers, toward something physical;
 * the panel has never accepted a negative dimension, and none of the 133 real
 * designs checked on 2026-09-22 (the fixtures and the tester uploads) carries
 * one. A lookupTable (null prototype): the keys it is asked about come off
 * nodes a file wrote, and `constructor` must not resolve to Object.prototype's.
 */
const LIMITS_BY_KEY: Record<string, FieldLimit> = lookupTable<FieldLimit>({
  length: LEN, rootChord: LEN, tipChord: LEN, height: LEN, thickness: LEN,
  outerRadius: LEN, innerRadius: LEN, aftRadius: LEN, foreRadius: LEN, radius: LEN,
  shoulderRadius: LEN, shoulderLength: LEN, shoulderThickness: LEN,
  foreShoulderRadius: LEN, foreShoulderLength: LEN, aftShoulderRadius: LEN, aftShoulderLength: LEN,
  diameter: LEN, spillHoleDiameter: LEN, lineLength: LEN, stripLength: LEN, stripWidth: LEN,
  cordLength: LEN, width: LEN,
  outerDiameter: LEN, innerDiameter: LEN, totalHeight: LEN, baseHeight: LEN, flangeHeight: LEN,
  screwHeight: LEN,
  tabHeight: LEN, tabLength: LEN, airfoilLeDiamond: LEN, airfoilTeDiamond: LEN, finLeRadius: LEN,
  filletRadius: { ...LEN, label: 'fillet radius' },
  nozzleExitDiameter: LEN, maxMotorLength: LEN,
  sweep: SIGNED_LEN, tabOffset: SIGNED_LEN, motorOverhang: SIGNED_LEN,
  instanceSeparation: { ...SIGNED_LEN, label: 'distance between instances' },
  radiusOffset: SIGNED_LEN, radialPosition: SIGNED_LEN,
  overrideCGX: { ...SIGNED_LEN, label: 'CG override' },
  mass: MASS, overrideMass: { ...MASS, label: 'mass override' },
  density: BULK,
  surfaceDensity: { ...BULK, label: 'canopy material density' },
  lineDensity: { ...BULK, label: 'line material density' },
  filletDensity: { ...BULK, label: 'fillet material density' },
  // A lug or ring set read from a .ork keeps its <instancecount> even where
  // nothing draws or flies it; the bridge's ceiling bounds it all the same.
  instanceCount: LINE_INSTANCES,
});

/**
 * Type-specific limits, which win over LIMITS_BY_KEY. A lookupTable for the
 * same reason: a restored session's `type` is whatever string it saved.
 */
const LIMITS_BY_TYPE: Record<string, Record<string, FieldLimit>> = lookupTable<Record<string, FieldLimit>>({
  trapezoidfinset: { finCount: FINS },
  ellipticalfinset: { finCount: FINS },
  freeformfinset: { finCount: FINS },
  tubefinset: { finCount: FINS, length: POSITIVE_LEN },
  fairing: { height: POSITIVE_LEN },
  podset: {
    instanceCount: { kind: 'count', hmin: 1, hmax: MAX_ASSEMBLY_INSTANCES, why: 'the most this app draws or flies' },
  },
  parallelstage: {
    instanceCount: { kind: 'count', hmin: 1, hmax: MAX_ASSEMBLY_INSTANCES, why: 'the most this app draws or flies' },
  },
  parachute: {
    lineCount: {
      kind: 'count', hmin: 0, hmax: MAX_SHROUD_LINES,
      why: 'over ten times the most lines of any parachute in the parts database, and every line is weighed',
    },
  },
  protuberance: { count: { kind: 'count', hmin: 1, hmax: MAX_PROTUBERANCE_COUNT } },
});

/**
 * The hard limit on `key` for a component of `type`, or undefined when the key
 * has none. The ONE table the property panel's commit and the sanitize pass
 * both read (audit 2026-09-22) — see FieldLimit.
 */
export function fieldLimit(type: EditorComponentType | string, key: string): FieldLimit | undefined {
  const byType = LIMITS_BY_TYPE[type];
  if (byType && Object.hasOwn(byType, key)) return byType[key];
  return LIMITS_BY_KEY[key];
}

/**
 * `value` brought inside `limit`: a count rounded to a whole number first (the
 * .ork reader and the panel both round), then clamped. Identity for a value
 * already inside — and for anything that is not a finite number, which every
 * reader already treats as absent (nodeNum.num).
 */
export function applyFieldLimit(limit: FieldLimit, value: number): number {
  if (!Number.isFinite(value)) return value;
  let v = limit.kind === 'count' ? Math.round(value) : value;
  if (v < limit.hmin) v = limit.hmin;
  if (limit.hmax !== undefined && v > limit.hmax) v = limit.hmax;
  return v;
}

/**
 * The spelling-blind form: lower case, no underscores. It is the form desktop
 * compares a file's text against — its enum match lowers the CONSTANT's name
 * and drops the underscores (DocumentConfig.findEnum, IgnitionEvent.equals) —
 * and the kernel bridge applies it to what we send (OrkEngine
 * .separationEventOf, `name.toLowerCase().replace("_", "")`). This side
 * applies it to the file's text too, so "ALTITUDE_ASCENDING", "Apogee" and
 * "hex_blunt_base" all name a real value — where desktop, which compares the
 * text as written, would warn and drop them.
 */
const enumForm = (s: string): string => s.trim().toLowerCase().replace(/_/g, '');

/**
 * The canonical spelling of `raw` among `values`, or null when it names none of
 * them. The canonical spelling matters beyond the kernel: the panel's selects
 * and every `=== 'apogee'` in the app compare it exactly.
 */
export function canonicalEnum(values: readonly string[], raw: string): string | null {
  const want = enumForm(raw);
  return values.find((v) => enumForm(v) === want) ?? null;
}

/**
 * A string field the kernel bridge validates. An unknown value is imported
 * verbatim by every reader, and three of these make the bridge THROW
 * (ComponentFactory's airfoil switch, OrkEngine.separationEventOf,
 * ComponentFactory's cluster lookup), which takes down the whole build — and for
 * a separation in a NON-default flight configuration, only when that
 * configuration is picked (audit 2026-09-22). The fix is desktop's: a value it
 * cannot find is dropped with a warning and the default stands. Dropping the
 * key IS the default here — every reader and the bridge read an absent key as
 * `fallback`.
 */
export interface EnumLimit {
  values: readonly string[];
  /** What an absent key means, in words, for the note. */
  fallback: string;
}

/** Stage separation triggers — exactly the kernel's set (OrkEngine.separationEventOf). */
export const SEPARATION_EVENT_VALUES: readonly string[] = SEPARATION_EVENTS.map(([v]) => v);

const AIRFOIL: EnumLimit = {
  values: AIRFOIL_SECTIONS.map(([v]) => v).filter((v) => v !== ''),
  fallback: 'the classic cross-section drag',
};
const SEPARATION: EnumLimit = {
  values: SEPARATION_EVENT_VALUES,
  fallback: 'this stage’s ejection charge, desktop OpenRocket’s default',
};

/**
 * The enum fields by component type — a lookupTable, keyed by a node's `type`.
 *
 * A recovery device's `deployEvent` is deliberately NOT here. The bridge never
 * throws on one (ComponentFactory.deployEventOf flies any value it does not
 * name as the ejection charge), and desktop 24.12 has a sixth value the app's
 * menu lacks — LOWER_STAGE_SEPARATION, saved as "lowerstageseparation". A first
 * cut of this table checked deploy events against the app's five and deleted
 * that one, so a desktop file lost it on save; and an absent deployEvent does
 * not mean one thing everywhere (the .ork writer reads it as ejection, the
 * .CDX1 writer as apogee), which breaks the rule above. It stays as the file
 * wrote it, the way it always has.
 */
export const ENUM_LIMITS: Record<string, Record<string, EnumLimit>> = lookupTable<Record<string, EnumLimit>>({
  trapezoidfinset: { airfoilSection: AIRFOIL },
  ellipticalfinset: { airfoilSection: AIRFOIL },
  freeformfinset: { airfoilSection: AIRFOIL },
  stage: { separationEvent: SEPARATION },
  parallelstage: { separationEvent: SEPARATION },
  innertube: { cluster: { values: CLUSTER_OPTIONS.map(([v]) => v), fallback: 'a single tube' } },
});

const FIN_COUNT: FieldDef = { key: 'finCount', label: 'Fin count', unit: 'count', smin: 1, smax: KERNEL_MAX_FINS };
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
    // What an absent method MEANS to every reader — the kernel, the drawing
    // (TreeSchematic.finTabFront), the cut template, the .ork writer and the
    // snap anchors all fall back to middle. Without it the panel showed
    // options[0], "Front of fin", for a tab they all placed mid-fin, and
    // picking "Front of fin" then fired no change, so the state on screen was
    // unreachable (audit 2026-09-22).
    dflt: 'middle',
  },
];
const CD: FieldDef = {
  // smax 3: high-efficiency canopies (Fruity Chutes Iris Ultra 2.2, toroidal
  // designs up to ~2.9) sit above the classic 0.75–1.5 flat-sheet range.
  //
  // smin IS ONE STEP, NOT ZERO, and that is deliberate — this is the one field
  // on the list whose failure mode is a lawn dart. PropertyPanel renders a
  // ValueSlider whenever smin and smax are both set, its left stop is smin, and
  // `commit` clamps only the MAXIMUM — so with smin 0 a single mouse drag, no
  // typing and no confirmation, wrote `cd: 0` and produced a canopy with no
  // drag at all. engineTree passes it through untouched and ComponentFactory
  // sees a real 0.0 rather than the NaN that means "auto", so RecoveryDevice
  // stores it unclamped and clears cdAutomatic; the slider then offers no way
  // back to auto (only clearing the text field does that).
  //
  // The protuberance's `cdFrontal` answers the same shape of problem the other
  // way — 0 there is the "release the override" stop, honoured by
  // treeModel.protuberanceExplicitCd — but a recovery Cd has no class to fall
  // through to, so the fix here is to put the stop out of the slider's reach.
  // A TYPED 0 still means what the user typed: `commit` never applies smin.
  key: 'cd', label: 'Drag coefficient (blank = auto)', unit: 'none', step: 0.05, smin: 0.05, smax: 3,
  optional: true,
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
 *
 * Both keys round-trip (orkFile.ts reads/writes <radialposition>/
 * <radialdirection>, scaleRocket scales them), AftView draws with them, and
 * ComponentFactory's innertube and masscomponent cases hand them to the kernel
 * (since v0.105), so do NOT "clean up" either as unused. What the kernel does
 * with them: a mass component's CG moves with its offset. A SINGLE off-axis
 * inner tube, and every mount's motor, keep their CG on the tube's parent axis
 * and carry the offset as a parallel-axis ROLL-inertia term, m·r² per
 * instance; a CLUSTERED tube's CG sits at the mean of its instances' offsets
 * (the pattern shifted by this offset), and its tubes carry their spread about
 * that mean the same way (kernel fix for code review E1, 2026-09-22 — until
 * then a split cluster flew with the roll inertia of the same tubes stacked on
 * the axis, as desktop OpenRocket 24.12 still does; engine-java/patches/
 * LEDGER.md "Correctness fixes"). The flight's pitch and yaw moment arms use
 * only the CG's x — a lateral CG reaches the numbers through the inertia
 * build-up (RigidBody.rebase) and nowhere else — and an off-axis motor's
 * thrust still makes no moment (upstream's own TODO in
 * RK4SimulationStepper.calculateThrust). Recorded in
 * docs/testing/format-audit-2026-09-03.md rows 81 and 115.
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
 * So it was never one shape. That is why they are separate fields and not a
 * single "which way does the camera point" switch.
 *
 * THE CREATION DEFAULT IS streamlined fore / FLAT aft (Eric, 2026-09-18:
 * *"Most shrouds are flat ended where the camera is … the default config
 * should be tapered at the front and flat at the back"*, with photographs).
 * It replaces the domed aft end this comment used to justify. Tapered into the
 * wind, flat where the lens looks out.
 *
 * That is NOT what an ABSENT key means, and the two must not be confused. An
 * absent end is decided by `shroudEnds` (shroud.ts) alone — half-round on
 * both ends, and a file written before v0.088 has its single `fairingShape`
 * migrated to both ends — and the panel shows exactly that, because it
 * resolves these two selects through the same function (RESOLVE_SELECT in
 * PropertyPanel). So the two end fields carry NO `dflt`: one used to sit here,
 * was never read, and the fore end's said 'streamlined' against shroudEnds'
 * 'halfround' (audit 2026-09-22). The creation default is what a NEW part is
 * born with (`defaultParams('fairing')`), so no saved design moves with it.
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
    //
    // Since 2026-09-08 the SAME number also buys thrust: under Rogers Kbf or
    // the supersonic model the kernel adds RASAero's pressure term
    // `A_exit x (101325 - P(h))` to this stage while its motor burns, so a
    // published sea-level curve gains the exit area times the pressure the
    // rocket has climbed out of. The label has to say so — it read
    // "0 = power-off drag" for two months, which is now half the truth, and a
    // value typed on the strength of the old label is spent on a safety
    // number. Both halves are off under Classic EB.
    //
    // Kept SHORT deliberately: the panel's longest label before this was 43
    // characters ('Cd on frontal area (blank or 0 = from class)'), and there is
    // no tooltip field on FieldDef, so a label is the only copy the box gets.
    // The full explanation lives in the guide and in the RASAero import note.
    // Optional: blank is "off", the same state the Motors & Launch field's
    // clear commits (NozzleField), and what its fill-from-the-database rule
    // looks for.
    { ...lenMM('nozzleExitDiameter', 'Nozzle exit diameter (drives thrust and drag; 0 = off)', 1, 200), optional: true },
  ],
  nosecone: [
    lenMM('length', 'Length'),
    radMM('aftRadius', 'Base outer radius', 0.5, 80),
    lenMM('thickness', 'Wall thickness', 0.1, 10),
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES },
    // Shown only for shapes that use it (ogive/power/parabolic/haack) —
    // PropertyPanel hides it otherwise and caps it per shape (haack ≤ 1/3).
    // Optional: blank is the shape's kernel default, printed as the placeholder.
    { key: 'shapeParameter', label: 'Shape parameter', unit: 'none', step: 0.05, smin: 0, smax: 1, optional: true },
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
    // A transition with no shape is CONICAL to every reader (the drawing, the
    // .ork writer, the panel's own shape-parameter rule) — not options[0],
    // the nose cone's ogive, which the panel used to show for it.
    { key: 'shape', label: 'Shape', unit: 'none', options: SHAPES, dflt: 'conical' },
    { key: 'shapeParameter', label: 'Shape parameter', unit: 'none', step: 0.05, smin: 0, smax: 1, optional: true },
    { key: 'filled', label: 'Solid (filled)', unit: 'none', bool: true },
    radMM('foreShoulderRadius', 'Fore shoulder radius', 0.5, 80),
    lenMM('foreShoulderLength', 'Fore shoulder length', 1, 150),
    radMM('aftShoulderRadius', 'Aft shoulder radius', 0.5, 80),
    lenMM('aftShoulderLength', 'Aft shoulder length', 1, 150),
    // A capped shoulder is a closed disc of the component's own material, so it
    // is mass. The nose cone has offered this since the beginning (line 404); a
    // transition read and saved both flags but had nowhere to set them, and the
    // kernel bridge dropped them entirely until v0.105.
    { key: 'foreShoulderCapped', label: 'Fore shoulder end capped', unit: 'none', bool: true },
    { key: 'aftShoulderCapped', label: 'Aft shoulder end capped', unit: 'none', bool: true },
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
    // FIN_COUNT's own 1..8, the kernel's (see KERNEL_MAX_FINS). This slider ran
    // to 12 until audit 2026-09-22, and 9–12 drew tubes the kernel never flew.
    FIN_COUNT,
    lenMM('length', 'Length', 1, 200),
    // Optional: blank is the kernel's auto radius, the one at which the tubes
    // touch, printed as the placeholder.
    { ...radMM('outerRadius', 'Outer radius', 0.5, 50), optional: true },
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
    { key: 'maxMotorLength', label: 'Max motor length (blank = no limit)', unit: 'mm', step: 5, optional: true },
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
    // All six geometry fields are optional: a button saved before v0.103 has
    // none of them, and blank is the kernel constructor's part, printed as the
    // placeholder and used by every reader alike (see RAILBUTTON_DEFAULTS in
    // PropertyPanel).
    { ...lenMM('outerDiameter', 'Outer diameter', 0.5, 20), optional: true },
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
    { ...lenMM('totalHeight', 'Total height', 0.5, 25), optional: true },
    { ...lenMM('innerDiameter', 'Inner (waist) diameter', 0.5, 20), optional: true },
    { ...lenMM('baseHeight', 'Base / standoff height', 0.5, 12), optional: true },
    { ...lenMM('flangeHeight', 'Flange height', 0.5, 12), optional: true },
    { ...lenMM('screwHeight', 'Screw-head height', 0.5, 12), optional: true },
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
    lenMM('spillHoleDiameter', 'Spill hole ⌀ (0 = none)', 1, 500),
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
    // No `dflt`: an absent end is whatever shroudEnds says (see END_SHAPES).
    { key: 'fairingForeShape', label: 'Fore end (toward the nose)', unit: 'none', options: END_SHAPES },
    { key: 'fairingAftShape', label: 'Aft end (toward the tail)', unit: 'none', options: END_SHAPES },
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
    // treeModel.protuberanceClass reads an absent class as streamlinedbase;
    // options[0] is the no-base class, which the panel showed instead.
    { key: 'dragClass', label: 'Drag class', unit: 'none', options: PROTUBERANCE_CLASSES,
      dflt: 'streamlinedbase' },
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
    { key: 'cdFrontal', label: 'Cd on frontal area (blank or 0 = from class)', unit: 'none', step: 0.05, smin: 0, smax: 2, optional: true },
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
      // Tapered into the wind, flat where the lens looks out — see END_SHAPES.
      fairingForeShape: 'streamlined', fairingAftShape: 'box', conformal: true,
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

/**
 * How many fins an ABSENT `finCount` means: the kernel constructors' own,
 * FinSet 3 and TubeFinSet 6 — the same counts `defaultParams` gives a new set.
 * No importer writes a set without one (the .ork and .rkt readers fall back to
 * these same 3 / 6). An absent count comes from a design saved while the panel
 * could still clear the Fin count box — which deleted the key until
 * FieldDef.optional (audit 2026-09-22) — or from a hand-edited file.
 */
export function finCountDefault(type: EditorComponentType): number {
  return type === 'tubefinset' ? 6 : 3;
}

/**
 * The rotation a fin set is born with when it is added to a tube that already
 * carries one: half the existing set's pitch past its first fin, so the new
 * fins sit BETWEEN the old ones (2026-08-05d — tube fins + straight fins
 * interleave).
 *
 * The existing set's count falls back per TYPE (audit 2026-09-22). App used a
 * flat 3, so beside a tube-fin set with no `finCount` — six tubes to the
 * kernel — the new set turned 60° instead of 30° and landed ON a tube.
 */
export function interleaveRotation(existing: ComponentNode): number {
  const count = Math.max(1, Math.round(num(existing, 'finCount', finCountDefault(existing.type))));
  return num(existing, 'rotation', 0) + Math.PI / count;
}

/**
 * What an ABSENT numeric key flies, by key (SI): the kernel bridge's own
 * fallback — `ComponentFactory`'s `dbl(node, key, default)`, or the kernel
 * constructor's field where the bridge sets nothing for a missing key — which
 * the .ork writer and the drawings read the same way. Line numbers are
 * ComponentFactory.java's.
 */
const BLANK_BY_KEY: Record<string, number> = lookupTable<number>({
  cant: 0, // :173, :184, :193
  rotation: 0, // :229 (tube fins), :530 (fin sets)
  tabHeight: 0, tabLength: 0, tabOffset: 0, // applyFinTabs :758-765 — no tab
  airfoilLeDiamond: 0, airfoilTeDiamond: 0, finLeRadius: 0, // :554-556
  motorOverhang: 0, // :161, :253
  radialPosition: 0, radialDirection: 0, // :260-261
  clusterScale: 1, clusterRotation: 0, // :280-281, and engineTree's cluster split
  // A surface part's clock angle (applyMountAngle :945, and every renderer's
  // num(child, 'angleOffset', 0)); an assembly's (:953).
  angleOffset: 0,
  radiusOffset: 0, // :952
  // Set only with a count (applyLineInstances :911); with no count the part is
  // ONE button or lug, and the spacing means nothing.
  instanceSeparation: 0,
  // Unset shoulders are the kernel Transition's zero-initialised fields.
  shoulderRadius: 0, shoulderLength: 0, shoulderThickness: 0,
  foreShoulderRadius: 0, foreShoulderLength: 0, aftShoulderRadius: 0, aftShoulderLength: 0,
  spillHoleDiameter: 0, // no vent (treeModel's Cd scaling reads absent as 0)
  lineCount: 6, lineLength: 0.3, // :431-432
  // Unset, DeploymentConfiguration's own 200 m and 0 s (the .ork writer's too).
  deployAltitude: 200, deployDelay: 0,
  separationDelay: 0, // StageSeparationConfiguration's own
});

/** Type-specific blanks, which win over BLANK_BY_KEY. */
const BLANK_BY_TYPE: Record<string, Record<string, number>> = lookupTable<Record<string, number>>({
  trapezoidfinset: { finCount: finCountDefault('trapezoidfinset') },
  ellipticalfinset: { finCount: finCountDefault('ellipticalfinset') },
  freeformfinset: { finCount: finCountDefault('freeformfinset') },
  tubefinset: { finCount: finCountDefault('tubefinset') },
  // Kernel RailButton / LaunchLug: instanceCount = 1 (lineInstanceCount's too).
  railbutton: { instanceCount: 1 },
  launchlug: { instanceCount: 1 },
  podset: { instanceCount: 2 }, // :950
  parallelstage: { instanceCount: 2 },
  // treeModel's protuberance lowering: an absent count is one, an absent plate angle 45°.
  protuberance: { count: 1, plateAngle: Math.PI / 4 },
});

/**
 * WHAT A BLANK NUMERIC FIELD FLIES, where that is ONE known value (SI), or
 * undefined where it is not — an "auto" Cd the kernel computes, a density that
 * is the part type's default material.
 *
 * The property panel shows it as the blank box's placeholder and steps the
 * spinner and the arrow keys from it (seam review of audit 2026-09-22). The
 * audit had made a blank field with no figure behind it inert — seeding an
 * "auto" Cd from 0 replaced the whole computed drag — which is right, and
 * stands; but a blank on a part just added is usually NOT figureless: a new fin
 * set's cant flies 0, a new canopy's lines fly 6, and a set saved with no count
 * flies 3 fins. Those went dead too, with nothing on screen saying what the
 * blank meant. Before the audit, ▴ on a new canopy's lines committed ONE line.
 */
export function blankValue(type: EditorComponentType | string, key: string): number | undefined {
  const byType = BLANK_BY_TYPE[type];
  if (byType && Object.hasOwn(byType, key)) return byType[key];
  return BLANK_BY_KEY[key];
}
