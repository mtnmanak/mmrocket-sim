import { strFromU8, unzipSync } from 'fflate';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { asStageNodes, freshId, mountsIn } from '../tree/treeModel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { CLUSTER_POINTS, clusterOffsets } from '../tree/cluster.js';
import { resolveAssemblyRadius } from '../tree/assembly.js';
import { axialLength, startFromPosition } from '../tree/position.js';
import { escapeXml as esc, xmlNum as num, xmlText as text } from './xmlUtil.js';
import { shapeParamDefault } from './orkFile.js';
import type { OrkExportMotor, OrkMotorRef, OrkTreeImportResult } from './orkFile.js';
import { applyPresetLinks, type PendingPresetLink, type Preset } from './presets.js';

/**
 * RockSim (.rkt) design import/export — Phase 3 "file imports and exports".
 *
 * The format knowledge comes from the desktop's own RockSim reader/writer
 * (info.openrocket.core.file.rocksim, 24.12) — element names, unit constants
 * and quirks mirror it deliberately. Key facts:
 * - Lengths are MILLIMETERS; OD/ID/BaseDia/etc are DIAMETERS (our model
 *   stores meters and radii — ÷1000 and ÷2000 on import).
 * - Angles are already radians; masses are grams.
 * - RockSim has exactly 3 stage slots, TOP-DOWN: Stage3Parts = sustainer,
 *   Stage2Parts, Stage1Parts. StageCount says how many are real.
 * - <Ring> covers centering ring/bulkhead/engine block/tube coupler via
 *   <UsageCode>; an inner tube is a <BodyTube> with <IsInsideTube>1.
 * - Positions: <Xb> + <LocationMode> (0 = from parent front, 1 = absolute
 *   from nose tip, 2 = from parent rear WITH the sign flipped vs ours).
 *
 * One deliberate improvement over the desktop: RockSim files carry motor
 * designations (<StageNEngines>/<EngineSet>, EngineCode linked to the mount
 * by MountSerialNo). The desktop drops them; we return them so the app can
 * auto-load the motors from the bundled database.
 */

// RockSim → SI conversion divisors (desktop RockSimCommonConstants).
const LEN = 1000; // mm → m
const RAD = 2000; // mm diameter → m radius

/**
 * RockSim's `<MotorDia>` (file units) for a mount node — through `mountBore`,
 * which is the one definition of what a mount's bore IS.
 *
 * These were the last two sites still hand-rolling `or − (thickness ?? 0.0005)`
 * after that arithmetic was centralized. It matters for a sub-minimum
 * `caseAirframe` design, where the motor case IS the airframe and the fit
 * reference is the tube's OUTER diameter: the hand-rolled form exported a
 * 29 mm mount as ~28 mm, understating the very motor the rocket is built
 * around in any tool that reads the file. Each call site keeps its own default
 * radius, which is all the two ever really differed by.
 */
const motorDia = (n: ComponentNode, defaultOuterRadius: number): number => {
  const or = typeof n['outerRadius'] === 'number' ? n['outerRadius'] as number : defaultOuterRadius;
  return mountBore({ ...n, outerRadius: or }) / 2 * RAD;
};
const MASS = 1000; // g → kg

/** Transient marker: BaseExtensionLen (m) parked on a cone until the chain pass runs. */
const PENDING_BASE_EXT = '__rktBaseExt';

const NOSE_SHAPES: Record<string, string> = {
  '0': 'conical', '1': 'ogive', '2': 'ellipsoid', '3': 'ellipsoid',
  '4': 'power', '5': 'parabolic', '6': 'haack',
};
const NOSE_SHAPE_TO_CODE: Record<string, number> = {
  conical: 0, ogive: 1, ellipsoid: 3, power: 4, parabolic: 5, haack: 6,
};
/**
 * The three shapes whose RockSim `<ShapeParameter>` means the same thing
 * OpenRocket's does. Desktop parity: NoseConeHandler.java:96-107 and
 * TransitionHandler.java:102-107 read it only for these, and
 * AbstractTransitionDTO.java:72-76 writes it only for these. RockSim emits the
 * tag on EVERY cone and transition, but for the other shapes its value is a
 * different quantity on a different scale — 51 corpus nose cones carry an ogive
 * ShapeParameter of 4.2, outside OpenRocket's 0–1 ogive range — so transferring
 * it either way "causes oddities" (the desktop's own words).
 */
const RKT_PARAM_SHAPES = ['power', 'haack', 'parabolic'];

/**
 * RockSim `<ShapeParameter>` → node['shapeParameter'], for a cone OR a
 * transition. The transition branch never called this and the exponent was
 * silently replaced by the kernel default — Exa.rkt's two power transitions
 * carry 0.21 and 0.13 against a default of 0.5, which measured +15.3 % on CD at
 * M0.3 and −6.5 % on stability once the file's own numbers are used.
 *
 * Out-of-range values are NOT clamped here: carved Transition.java:360 clamps to
 * the shape's own min/max, so the haack 0.76 in Glencoe Jupiter C.rkt lands at
 * 1/3 exactly where the desktop lands it.
 *
 * Must be called AFTER node['shape'] is set — the gate reads it.
 */
const readShapeParameter = (el: Element, node: ComponentNode): void => {
  const sp = num(el, 'ShapeParameter', NaN);
  if (!Number.isNaN(sp) && RKT_PARAM_SHAPES.includes(node['shape'] as string)) {
    node['shapeParameter'] = sp;
  }
};

/**
 * The value to put in `<ShapeParameter>`, exactly as the desktop computes it
 * (AbstractTransitionDTO.java:42 field default 0.0 plus the :72-76 gate): the
 * component's own parameter for power/haack/parabolic, and a literal 0 for every
 * other shape. Writing our 0–1 ogive parameter into RockSim's ogive field would
 * put a foreign quantity there (see RKT_PARAM_SHAPES); 0 is both what the desktop
 * writes and what RockSim itself writes — 90 of 93 ogive transitions and 550 of
 * 613 ogive cones in the corpus carry 0.
 *
 * The fallback for a GATED shape stays the KERNEL default, never 0: a power-law
 * part exported with exponent 0 re-imports as a blunt cylinder.
 */
const rktShapeParameter = (shape: string, value: unknown): number =>
  RKT_PARAM_SHAPES.includes(shape)
    ? (typeof value === 'number' ? value : shapeParamDefault(shape))
    : 0;

const CROSS_SECTIONS: Record<string, string> = { '0': 'square', '1': 'rounded', '2': 'airfoil' };
const CROSS_SECTION_TO_CODE: Record<string, number> = { square: 0, rounded: 1, airfoil: 2 };
const FINISH_FROM_CODE: Record<string, string> = {
  '0': 'polished', '1': 'smooth', '2': 'normal', '3': 'unfinished',
};
const FINISH_TO_CODE = (finish: unknown): number => {
  switch (finish) {
    case 'polished': case 'finishpolished': return 0;
    case 'smooth': return 1;
    case 'rough': case 'unfinished': return 3;
    default: return 2;
  }
};

// ============================ IMPORT ============================

export function importRkt(data: ArrayBuffer | string, opts?: { presets?: readonly Preset[] }): OrkTreeImportResult {
  let xml: string;
  if (typeof data === 'string') {
    xml = data;
  } else {
    const bytes = new Uint8Array(data);
    xml = bytes[0] === 0x50 && bytes[1] === 0x4b
      ? strFromU8(Object.values(unzipSync(bytes))[0]!)
      : strFromU8(bytes);
  }
  // Old RockSim (pre-9) wrote a BINARY design format, signature "[[RS001024RS]]"
  // in the first bytes. Neither we nor desktop OpenRocket can read it, but it IS
  // a real RockSim file — a tenth of the vendor .rkt files in circulation are
  // still this dialect (every Public Missiles kit in a 939-file survey,
  // 2026-08-22). Saying "XML parse error" there reads as "your file is corrupt"
  // and leaves the user nowhere, so name it and say what to do instead.
  if (xml.startsWith('[[RS') || xml.slice(0, 64).includes('[[RS001024RS]]')) {
    throw new Error(
      'This is an older BINARY RockSim file, not the XML .rkt this app reads. '
      + 'Open it in RockSim and re-save (RockSim 9 writes XML), or export it as '
      + '.ork — either opens here.',
    );
  }
  // RockSim files may lack an XML declaration and can carry stray BOMs.
  xml = xml.replace(/^﻿?/, '');
  // Some DOM parsers (notably the test environment's) reject CDATA sections;
  // RockSim only uses them for plain text (PartDesc etc.) — inline-escape.
  xml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not a valid RockSim file (XML parse error)');
  }
  const design = doc.querySelector('RockSimDocument > DesignInformation > RocketDesign');
  if (!design) throw new Error('Not a RockSim design file (missing RocketDesign)');

  const notes: string[] = [];
  const ignored = new Set<string>();
  /** Parts whose <PartMfg>/<PartNo> may name a catalogue row - resolved after the tree is built. */
  const pendingLinks: PendingPresetLink[] = [];
  /** Nodes that kept a measured mass or CG desktop OpenRocket would discard. */
  const keptWithoutCGFlag = new Set<ComponentNode>();
  /** Mass objects pinned onto the point the file states, rather than spread over <Len>. */
  let pinnedMassObjects = 0;
  /** RockSim SerialNo → our node id (links EngineSets to mounts). */
  const serialToNode = new Map<string, ComponentNode>();
  /** Off-axis inner tubes: node → cross-section offset (m), for cluster
   *  reconstruction (RockSim has no cluster concept — files carry N separate
   *  tubes at RadialLoc/RadialAngle). */
  const radialByNode = new Map<ComponentNode, { y: number; z: number }>();

  const name = text(design, ':scope > Name') ?? 'Imported RockSim rocket';
  const stageCount = Math.max(1, Math.min(3, num(design, 'StageCount', 1)));

  /**
   * The design-level weighed mass and balance point (issues-2026-08-23b #1).
   *
   * RockSim states these on <RocketDesign>, never on a part — it is the whole
   * rocket's measured weight, and 67 files of the owner's readable corpus carry
   * one. We used to drop every one. Note the inconsistent element names: the
   * sustainer's CG is <Stage3CG> but the lower stages' are <StageNCGAlone>.
   *
   * TWO DELIBERATE DIVERGENCES FROM DESKTOP, both the owner's ruling:
   *
   * 1. We gate on <UseKnownMass>. Desktop's reader tests only `stage3Mass > 0`
   *    (RockSimHandler.java:221) and never looks at the flag, while desktop's
   *    own WRITER sets it correctly (StageDTO.java:46-49) — reader and writer
   *    disagree, so this is a bug, not a convention. 19 corpus files carry a
   *    stale non-zero mass with the flag off, and they are template leftovers
   *    repeated verbatim across unrelated designs (28.3495 g = exactly 1 oz;
   *    1814.37 g = 4 lb; 73.7088 g appears in three different rockets).
   *    Applying mcr_hawk_mim23a.rkt's would import a ~678 g rocket as 28 g.
   *
   * 2. We do not pin the stage. Desktop applies it as a stage override with
   *    SUBCOMPONENTS ON, which stops every per-part mass contributing (the
   *    breakdown becomes decoration) and leaves the kernel summing the
   *    children's moments of inertia for a mass that is no longer theirs. The
   *    pair goes to the Design tab's "Measured mass & CG" box instead: the user
   *    sees the discrepancy and adds it as real ballast in one click, or
   *    doesn't. RockSim's stage mass excludes the motor, which is exactly what
   *    that box wants.
   */
  const stageMassFlag = num(design, 'UseKnownMass', 0) === 1;
  const statedMassG = num(design, 'Stage3Mass', 0);
  const statedCgMm = num(design, 'Stage3CG', 0);
  let measured: { massKg: number | null; cgM: number | null } | undefined;
  if (stageMassFlag && statedMassG > 0) {
    const massKg = statedMassG / MASS;
    const cgM = statedCgMm > 0 ? statedCgMm / LEN : null;
    if (stageCount > 1) {
      // A per-stage weight has no single meaning in a whole-rocket box, and
      // exactly one corpus file is multi-stage. Report it rather than guess.
      notes.push(
        `This ${stageCount}-stage file states a measured mass per stage `
        + `(sustainer ${statedMassG} g). Measured mass & CG on the Design tab `
        + 'covers the whole rocket, so nothing was filled in — enter what you '
        + 'weighed there if you want it applied.');
    } else {
      measured = { massKg, cgM };
      notes.push(
        `This file states a measured mass of ${statedMassG} g`
        + (cgM !== null ? ` balancing ${statedCgMm} mm from the nose tip` : '')
        + '. It is filled into Measured mass & CG on the Design tab, which '
        + 'reports the gap against your parts and can add it as ballast — '
        + 'nothing has been applied to the simulation yet. (Desktop OpenRocket '
        + 'pins the whole stage to it instead, which stops the individual part '
        + 'masses counting.)');
    }
  }

  const readCommon = (el: Element, node: ComponentNode) => {
    const nm = text(el, ':scope > Name');
    if (nm) node.name = nm;
    // RockSim names the catalogue part on every component - <PartMfg> is
    // "Custom" when it was not picked from one. Recorded here and resolved once
    // the whole tree is read (applyPresetLinks), so "the file left it unset" is
    // judged against everything the file said about the part. Desktop
    // OpenRocket's RockSim loader ignores both tags; the owner's own Wildman
    // .rkt carries <PartMfg>Fruity Chutes</PartMfg><PartNo>29185</PartNo> on a
    // chute whose <DragCoefficient> is RockSim's 0.75 "auto" - exactly the
    // case this closes (ruled 2026-09-03).
    const mfg = text(el, ':scope > PartMfg');
    const partNo = text(el, ':scope > PartNo');
    if (mfg && partNo && mfg.trim().toLowerCase() !== 'custom' && partNo.trim()) {
      pendingLinks.push({ node, manufacturer: mfg.trim(), partNo: partNo.trim() });
    }
    const serial = text(el, ':scope > SerialNo');
    if (serial) serialToNode.set(serial, node);
    const densityType = num(el, 'DensityType', 0);
    const density = num(el, 'Density', 0);
    if (densityType === 0 && density > 0) node.density = density;
    const mat = text(el, ':scope > Material');
    if (mat) node['materialName'] = mat;
    const finish = FINISH_FROM_CODE[String(Math.round(num(el, 'FinishCode', NaN)))];
    if (finish && finish !== 'normal') node['finish'] = finish;
    // Measured mass and measured CG are read INDEPENDENTLY (issue 2026-08-23a):
    // "I think the correct behavior is that UseKnownMass and UseKnownCG are
    //  treated independently. If either has a value entered, we use the entered
    //  value, if there is no value, we use the computed value. I am not sure
    //  why we would throw out a value just because the other one is set or not
    //  set."
    // Desktop couples them (BaseHandler.java:94-98 → setOverride: UseKnownCG=1
    // sets BOTH overrides, 0 discards both), which loses the weight of a part
    // the builder weighed but never balanced. Nothing here touches the physics
    // — only which numbers the file is believed to be stating.
    //
    // The catch is that RockSim's format is lopsided. <UseKnownMass> is a
    // DESIGN-level element: in a 939-file survey of real designs (2026-08-23)
    // it appears at most ONCE per file, inside <RocketDesign> beside
    // <Stage3Mass>, never inside a part. So a part states a known mass in one
    // of two dialects:
    //   1. a part-level <UseKnownMass> — what WE write on export, and what any
    //      writer that distinguishes the two would write. Read strictly.
    //   2. no such element — RockSim's own dialect, where UseKnownCG=1 has to
    //      keep meaning "both are known": reading it as CG-only would discard
    //      5,626 weighed masses in that same survey.
    // Dialect 2 is left EXACTLY as it was. It is tempting to also believe a
    // value whose flag is off when RockSim's own <CalcMass> sits beside it and
    // disagrees, but that is a heuristic: in the same survey 201 parts look
    // genuinely weighed that way while 303 hold a stale copy of the computed
    // number that must NOT become an override, and no rule in the file
    // separates them with certainty. Silently pinning a mass nobody measured
    // changes simulated apogee with nothing on screen, so that call is the
    // owner's to make, not ours.
    const flagCG = num(el, 'UseKnownCG', 0) === 1;
    const massFlag = num(el, 'UseKnownMass', NaN);
    const flagMass = Number.isFinite(massFlag) ? massFlag === 1 : flagCG;
    const km = num(el, 'KnownMass', 0);
    const kcg = num(el, 'KnownCG', 0);
    const useMass = km > 0 && flagMass;
    const useCG = kcg > 0 && flagCG;
    if (useMass) node['overrideMass'] = km / MASS;
    if (useCG) node['overrideCGX'] = kcg / LEN;
    // Desktop applies neither unless UseKnownCG is 1, so anything kept with
    // that flag off is a value it would have silently discarded. Say so.
    if (!flagCG && (useMass || useCG)) keptWithoutCGFlag.add(node);
  };

  /**
   * Recovery-device material, converted the way the desktop's
   * RecoveryDeviceHandler.computeDensity does. RockSim stores a chute as a BULK
   * density plus a <Thickness>; this app (and the kernel) want a SURFACE
   * density in kg/m². Without the conversion every imported chute silently fell
   * back to the built-in ripstop-nylon default: TubeFins2.rkt's 6.87 g chute
   * was billed at 19.6 g, and the error scales with canopy area.
   *
   * DensityType (RockSimCommonConstants): 0 = bulk (kg/m³, × thickness),
   * 1 = surface (kg/m², ÷ 0.1), 2 = line (kg/m, × 1 — NOT the surface divisor).
   */
  const readRecoveryMaterial = (el: Element, node: ComponentNode, kind: 'surface' | 'line') => {
    const densityType = Math.round(num(el, 'DensityType', 0));
    const density = num(el, 'Density', 0);
    if (!(density > 0)) return;
    let si: number;
    if (densityType === 0) {
      // Bulk kg/m³ × thickness (mm → m) = kg/m².
      const thickness = num(el, 'Thickness', 0) / LEN;
      if (!(thickness > 0)) return;
      si = density * thickness;
    } else if (densityType === 2) {
      // LINE density: RockSim's kg/m IS OpenRocket's kg/m -
      // ROCKSIM_TO_OPENROCKET_LINE_DENSITY = 1 (RockSimCommonConstants.java:116;
      // BaseHandler.computeDensity divides by it). Until v0.097 this branch took
      // the surface divisor too, so every imported shock cord weighed exactly
      // 10x the file: 2,4-D.rkt's 136.08 g cord landed as 1360.78 g - 24.5 % of
      // that rocket's dry mass, sitting in the sustainer.
      si = density;
    } else {
      si = density / 0.1;
    }
    if (!(si > 0)) return;
    const mat = text(el, ':scope > Material');
    if (kind === 'line') {
      node['lineDensity'] = si;
      if (mat) node['lineMaterialName'] = mat;
    } else {
      node['surfaceDensity'] = si;
      if (mat) node['surfaceMaterialName'] = mat;
    }
    // A bulk density stamped by readCommon is dead weight on these components —
    // nothing reads node.density for a recovery device, and leaving it invites
    // the next reader to think it means something.
    delete node['density'];
  };

  const readPosition = (el: Element, node: ComponentNode) => {
    const mode = Math.round(num(el, 'LocationMode', 0));
    const xb = num(el, 'Xb', 0) / LEN;
    const method: ComponentPosition['method'] =
      mode === 1 ? 'absolute' : mode === 2 ? 'bottom' : 'top';
    // RockSim's rear-referenced Xb points INTO the parent; ours points aft.
    node.position = { method, offset: mode === 2 ? -xb : xb };
  };

  const tubeThickness = (el: Element): number =>
    Math.max(0, (num(el, 'OD', 0) - num(el, 'ID', 0)) / 2 / LEN);

  /**
   * Flatten a <SubAssembly> (any depth): its attached parts join the chain
   * that `add` appends to. RockSim allows sub-assemblies both at stage level
   * and inside AttachedParts.
   */
  const flattenSubAssembly = (el: Element, parent: ComponentNode | null, add: (n: ComponentNode) => void) => {
    notes.push(`Sub-assembly “${text(el, ':scope > Name') ?? 'unnamed'}” flattened into its parent.`);
    const wrap = el.querySelector(':scope > AttachedParts');
    for (const sub of Array.from(wrap?.children ?? [])) {
      if (sub.tagName === 'SubAssembly') {
        flattenSubAssembly(sub, parent, add);
        continue;
      }
      const node = convertPart(sub, parent);
      if (node) add(node);
    }
  };

  const convertAttached = (el: Element, parentNode: ComponentNode) => {
    const wrap = el.querySelector(':scope > AttachedParts');
    if (!wrap) return;
    for (const child of Array.from(wrap.children)) {
      if (child.tagName === 'SubAssembly') {
        flattenSubAssembly(child, parentNode, (n) => {
          parentNode.children = [...(parentNode.children ?? []), n];
        });
        continue;
      }
      const node = convertPart(child, parentNode);
      if (node) {
        parentNode.children = [...(parentNode.children ?? []), node];
      }
    }
  };

  const convertPart = (el: Element, parent: ComponentNode | null): ComponentNode | null => {
    const tag = el.tagName;
    const mk = (type: ComponentNode['type']): ComponentNode => {
      const node: ComponentNode = { type, id: freshId() };
      readCommon(el, node);
      readPosition(el, node);
      return node;
    };
    switch (tag) {
      case 'NoseCone': {
        const n = mk('nosecone');
        n['length'] = num(el, 'Len', 70) / LEN;
        n['aftRadius'] = num(el, 'BaseDia', 24) / RAD;
        n['thickness'] = num(el, 'WallThickness', 2) / LEN;
        n['shape'] = NOSE_SHAPES[String(Math.round(num(el, 'ShapeCode', 1)))] ?? 'ellipsoid';
        readShapeParameter(el, n);
        if (Math.round(num(el, 'ConstructionType', 1)) === 0) n['filled'] = true;
        const shoulderLen = num(el, 'ShoulderLen', 0);
        if (shoulderLen > 0) {
          n['shoulderLength'] = shoulderLen / LEN;
          n['shoulderRadius'] = num(el, 'ShoulderOD', 0) / RAD;
          n['shoulderThickness'] = n['filled'] === true
            ? (n['shoulderRadius'] as number)
            : (n['thickness'] as number);
        }
        // RockSim's <BaseExtensionLen>: a cylinder at BaseDia, aft of the cone.
        // The file's own <Station> chain proves it — 4in WM Extreme.rkt has
        // Len 495 + BaseExt 14.0005 and the next part's Station is 509;
        // rocksimTestRocket1.rkt has 396.875 + 66.675 = 463.55, exact to the digit —
        // and so does its own <CalcMass>, which only reconciles with the extension
        // billed. Desktop OpenRocket 24.12 has NO constant for the element anywhere
        // in its source, so it imports these rockets short; diverging from it here is
        // deliberate and is stated in the import note below.
        // Parked on the node and turned into a real body tube by the chain pass,
        // which is the only place that knows which chain this cone belongs to.
        const baseExt = num(el, 'BaseExtensionLen', 0) / LEN;
        if (baseExt > 1e-6) n[PENDING_BASE_EXT] = baseExt;
        convertAttached(el, n);
        return n;
      }
      case 'Transition': {
        const n = mk('transition');
        n['length'] = num(el, 'Len', 40) / LEN;
        n['foreRadius'] = num(el, 'FrontDia', 24) / RAD;
        n['aftRadius'] = num(el, 'RearDia', 24) / RAD;
        n['thickness'] = num(el, 'WallThickness', 2) / LEN;
        n['shape'] = NOSE_SHAPES[String(Math.round(num(el, 'ShapeCode', 0)))] ?? 'conical';
        // Desktop reads it for transitions too (TransitionHandler.java:102-107,
        // the exact mirror of NoseConeHandler.java:96-107); this branch never did.
        readShapeParameter(el, n);
        if (Math.round(num(el, 'ConstructionType', 1)) === 0) n['filled'] = true;
        const fsl = num(el, 'FrontShoulderLen', 0);
        if (fsl > 0) {
          n['foreShoulderLength'] = fsl / LEN;
          n['foreShoulderRadius'] = num(el, 'FrontShoulderDia', 0) / RAD;
        }
        const rsl = num(el, 'RearShoulderLen', 0);
        if (rsl > 0) {
          n['aftShoulderLength'] = rsl / LEN;
          n['aftShoulderRadius'] = num(el, 'RearShoulderDia', 0) / RAD;
        }
        convertAttached(el, n);
        return n;
      }
      case 'BodyTube': {
        // Inside AttachedParts a <BodyTube> is an inner tube (desktop rule).
        const inside = parent !== null || num(el, 'IsInsideTube', 0) === 1;
        const n = mk(inside ? 'innertube' : 'bodytube');
        n['length'] = num(el, 'Len', 100) / LEN;
        n['outerRadius'] = num(el, 'OD', 24) / RAD;
        n['thickness'] = tubeThickness(el);
        // Inner tube OR a min-diameter body tube — both are real mounts now
        // (kernel BodyTube implements MotorMount, same as the desktop).
        if (num(el, 'IsMotorMount', 0) === 1) {
          n['motorMount'] = true;
          const overhang = num(el, 'EngineOverhang', 0) / LEN;
          if (overhang !== 0) n['motorOverhang'] = overhang;
        }
        // Radial placement (RadialAngle is radians): remembered so identical
        // sibling tubes can be regrouped into one tagged cluster below.
        const radialLoc = num(el, 'RadialLoc', 0) / LEN;
        if (inside && radialLoc > 0) {
          const ra = num(el, 'RadialAngle', 0);
          radialByNode.set(n, { y: radialLoc * Math.cos(ra), z: radialLoc * Math.sin(ra) });
        }
        convertAttached(el, n);
        return n;
      }
      case 'Ring': {
        const usage = Math.round(num(el, 'UsageCode', 0));
        const type = usage === 1 ? 'bulkhead' : usage === 2 ? 'engineblock'
          : usage === 4 ? 'tubecoupler' : 'centeringring';
        const n = mk(type);
        n['length'] = num(el, 'Len', 2) / LEN;
        const od = num(el, 'OD', 0);
        // Every ring kind takes the OD the FILE states, not the kernel's automatic
        // radius. Desktop's RingHandler sets OD on all four (bulkhead, engine block,
        // coupler, centering ring); we set it on two, so an engine block reached the
        // kernel automatic and sized itself to the parent's bore. Measured on
        // TubeFins2.rkt: the file says OD 17.78 mm (r 8.890) while the automatic
        // radius from its parent inner tube (OR 9.3472 / wall 0.3302) is 9.017 mm —
        // 1.4 % in radius, ~1.6 % in mass, and unbounded if the block is hung on a
        // body tube instead of a mount. Harmless until the walls became real (the
        // post-attach ordering fix); now it is the size.
        if (od > 0) {
          n['outerRadius'] = od / RAD;
        }
        const id = num(el, 'ID', 0);
        if (type === 'centeringring' && id > 0) n['innerRadius'] = id / RAD;
        if ((type === 'engineblock' || type === 'tubecoupler') && od > 0) {
          n['thickness'] = tubeThickness(el) || 0.001;
        }
        return n;
      }
      case 'FinSet':
      case 'CustomFinSet': {
        const shapeCode = tag === 'CustomFinSet' ? 2 : Math.round(num(el, 'ShapeCode', 0));
        // RockSim allows a FinSet inside a Transition's AttachedParts, but the
        // kernel (like desktop OpenRocket) accepts ONLY freeform fins there —
        // a trapezoid/elliptical set makes buildTree throw and the whole
        // imported design loses its mass, CG, CP and Simulate. The desktop
        // converts the planform instead (FreeformFinSet.convertFinSet); so do
        // we, exactly as the RASAero importer already does (rasaeroFile.ts:87).
        const onTransition = parent?.type === 'transition';
        const type = onTransition || shapeCode === 2 ? 'freeformfinset'
          : shapeCode === 1 ? 'ellipticalfinset' : 'trapezoidfinset';
        const n = mk(type);
        n['finCount'] = Math.round(num(el, 'FinCount', 3));
        n['thickness'] = num(el, 'Thickness', 3) / LEN;
        const cs = CROSS_SECTIONS[String(Math.round(num(el, 'TipShapeCode', 0)))];
        if (cs && cs !== 'square') n['crossSection'] = cs;
        if (type === 'trapezoidfinset') {
          n['rootChord'] = num(el, 'RootChord', 50) / LEN;
          n['tipChord'] = num(el, 'TipChord', 30) / LEN;
          n['sweep'] = num(el, 'SweepDistance', 0) / LEN;
          n['height'] = num(el, 'SemiSpan', 30) / LEN;
        } else if (type === 'ellipticalfinset') {
          n['rootChord'] = num(el, 'RootChord', 50) / LEN;
          n['height'] = num(el, 'SemiSpan', 30) / LEN;
        } else if (onTransition && shapeCode !== 2) {
          // Converted from a trapezoid/elliptical set: synthesize the same
          // planform as an explicit outline so nothing about the shape changes.
          const rootChord = num(el, 'RootChord', 50) / LEN;
          const height = num(el, 'SemiSpan', 30) / LEN;
          if (shapeCode === 1) {
            // Quarter-ellipse sampled as a polyline, matching the desktop's
            // conversion of an elliptical set.
            const STEPS = 16;
            const pts: [number, number][] = [[0, 0]];
            for (let i = 1; i <= STEPS; i++) {
              const t = (i / STEPS) * (Math.PI / 2);
              pts.push([rootChord / 2 - (rootChord / 2) * Math.cos(t), height * Math.sin(t)]);
            }
            for (let i = STEPS - 1; i >= 1; i--) {
              const t = (i / STEPS) * (Math.PI / 2);
              pts.push([rootChord / 2 + (rootChord / 2) * Math.cos(t), height * Math.sin(t)]);
            }
            pts.push([rootChord, 0]);
            n['points'] = pts;
          } else {
            const tipChord = num(el, 'TipChord', 30) / LEN;
            const sweep = num(el, 'SweepDistance', 0) / LEN;
            // A zero tip chord (a triangular fin) must collapse to ONE tip
            // point: repeating it makes a zero-length edge that the kernel
            // reports as a self-intersection through a %g format TeaVM lacks,
            // which aborts the whole build. Same guard as rasaeroFile.ts.
            n['points'] = tipChord > 1e-9
              ? [[0, 0], [sweep, height], [sweep + tipChord, height], [rootChord, 0]]
              : [[0, 0], [sweep, height], [rootChord, 0]];
          }
          const note = 'Fins on a transition were converted to a freeform outline (same '
            + 'planform) — OpenRocket only allows freeform fins on a transition.';
          if (!notes.includes(note)) notes.push(note);
        } else {
          n['points'] = parsePointList(text(el, ':scope > PointList') ?? '');
        }
        const tabLen = num(el, 'TabLength', 0);
        const tabDepth = num(el, 'TabDepth', 0);
        if (tabLen > 0 && tabDepth > 0) {
          n['tabLength'] = tabLen / LEN;
          n['tabHeight'] = tabDepth / LEN;
          n['tabOffset'] = num(el, 'TabOffset', 0) / LEN;
          n['tabOffsetMethod'] = 'top';
        }
        // Fin cant (radians — same convention the desktop exporter writes;
        // its importer drops this, so we're a step ahead of desktop parity).
        const cant = num(el, 'CantAngle', 0);
        if (cant !== 0) n['cant'] = cant;
        // Set rotation about the body axis (RockSim RadialAngle, radians).
        const finRot = num(el, 'RadialAngle', 0);
        if (finRot !== 0) n['rotation'] = finRot;
        return n;
      }
      case 'LaunchLug': {
        const n = mk('launchlug');
        n['length'] = num(el, 'Len', 50) / LEN;
        n['outerRadius'] = num(el, 'OD', 5) / RAD;
        n['thickness'] = tubeThickness(el) || 0.0004;
        return n;
      }
      case 'TubeFinSet': {
        const n = mk('tubefinset');
        n['finCount'] = Math.round(num(el, 'TubeCount', 6));
        n['length'] = num(el, 'Len', 100) / LEN;
        n['outerRadius'] = num(el, 'OD', 24) / RAD;
        // Desktop sets the wall ONLY when <ID> is actually present
        // (TubeFinSetHandler.java:89-92); with no ID it leaves the kernel's
        // BodyTube.addChild inherit standing. We used to write OD/2 — a SOLID tube —
        // which was harmless only while the bridge threw the value away. Now that the
        // wall really reaches the kernel, an absent <ID> would fly a solid rod.
        // <ID>0</ID> IS meaningful and stays: RockSim writes a solid tube that way.
        if (text(el, ':scope > ID') !== null) n['thickness'] = tubeThickness(el);
        const tubeRot = num(el, 'RadialAngle', 0);
        if (tubeRot !== 0) n['rotation'] = tubeRot;
        return n;
      }
      case 'Parachute': {
        const n = mk('parachute');
        n['diameter'] = num(el, 'Dia', 300) / LEN;
        const cd = num(el, 'DragCoefficient', 0);
        if (cd > 0 && cd !== 0.75) n['cd'] = cd;
        const lines = Math.round(num(el, 'ShroudLineCount', 0));
        if (lines > 0) {
          n['lineCount'] = lines;
          n['lineLength'] = num(el, 'ShroudLineLen', 300) / LEN;
        }
        const spill = num(el, 'SpillHoleDia', 0);
        if (spill > 0) n['spillHoleDiameter'] = spill / LEN;
        readRecoveryMaterial(el, n, 'surface');
        return n;
      }
      case 'Streamer': {
        const n = mk('streamer');
        n['stripLength'] = num(el, 'Len', 500) / LEN;
        n['stripWidth'] = num(el, 'Width', 50) / LEN;
        // 0.75 is RockSim's "auto" default — keep our auto instead of pinning it.
        const cd = num(el, 'DragCoefficient', 0);
        if (cd > 0 && cd !== 0.75) n['cd'] = cd;
        readRecoveryMaterial(el, n, 'surface');
        return n;
      }
      case 'MassObject': {
        const isCord = Math.round(num(el, 'TypeCode', 0)) === 1;
        const n = mk(isCord ? 'shockcord' : 'masscomponent');
        if (isCord) {
          n['cordLength'] = num(el, 'Len', 300) / LEN;
          readRecoveryMaterial(el, n, 'line');
        } else {
          n['mass'] = num(el, 'KnownMass', 0) / MASS;
          // RockSim's <Len> on a mass object is NOT geometry. RockSim treats a
          // mass object as a POINT at <Xb> and does not show a length in its own
          // UI — desktop says so at MassObjectHandler.java:29-39 — and all 28
          // TypeCode-0 objects across our 14-file corpus write <KnownCG> == <Xb>,
          // i.e. the point, whatever <Len> says. Taken at face value it breaks two
          // things: our kernel puts a MassObject's CG at length/2
          // (MassObject.java:230-231), and a Len can exceed the whole rocket
          // (Mach 3.rkt states 7620 mm inside a 1652 mm rocket), which then drives
          // the Length stat tile and the pitch inertia ((3r^2+L^2)/12).
          // Keep the raw value for export fidelity; simulate a body that fits
          // inside its parent; pin the CG on the point.
          const rawLen = num(el, 'Len', 20) / LEN;
          n['rocksimLen'] = rawLen;
          const parentLen = typeof parent?.['length'] === 'number' ? (parent['length'] as number) : 0;
          n['length'] = parentLen > 0 ? Math.min(rawLen, parentLen) : rawLen;
        }
        // Its KnownMass became the component's real mass either way, so no MASS
        // override survived here and nothing diverged from desktop.
        delete n['overrideMass'];
        if (isCord) {
          // Shock cords keep today's behaviour: the kernel's 0.025 m default packed
          // length puts their CG at most 12.5 mm off, and changing it drags in the
          // cord-mass question (format audit row 19) that is not this fix.
          delete n['overrideCGX'];
        } else {
          // overrideCGX is measured from the component's FORE end
          // (MassCalculation.java:444-445). LocationMode 0/1 map to TOP/ABSOLUTE,
          // whose fore end sits on the point, so the pin is 0 — which is exactly
          // what desktop does (MassObjectHandler.java:107). LocationMode 2 maps to
          // BOTTOM, which anchors the AFT end on the point, so the pin is the
          // component's own length. Desktop pins 0 there too and lands a full
          // length forward of the file's own <Station>; we deliberately do not
          // copy that. Measured on Mach 3.rkt, this reproduces all four of its
          // <Station> values (225.425 / 422.275 / 665.48 / 814.705 mm) to 0.01 mm.
          n['overrideCGX'] = n.position?.method === 'bottom' ? (n['length'] as number) : 0;
          pinnedMassObjects += 1;
        }
        keptWithoutCGFlag.delete(n);
        return n;
      }
      case 'ExternalPod': {
        // Desktop PodHandler semantics: single instance, FREE radius from
        // the parent centerline, RadialAngle in radians; a Detachable pod is
        // a strap-on booster (ParallelStage).
        const detachable = Math.round(num(el, 'Detachable', 0)) === 1;
        const n = mk(detachable ? 'parallelstage' : 'podset');
        n['instanceCount'] = 1;
        n['radiusMethod'] = 'free';
        n['radiusOffset'] = num(el, 'RadialLoc', 0) / LEN;
        const ra = num(el, 'RadialAngle', 0);
        if (ra !== 0) n['angleOffset'] = ra;
        if (detachable) {
          n['angleMethod'] = 'relative';
          n['separationEvent'] = 'ejection';
          n['separationDelay'] = 0;
        }
        // RockSim allows the pod's chain both directly under the pod and
        // inside AttachedParts (desktop handles both) — collect from both.
        const chain: ComponentNode[] = [];
        const CHAIN_TAGS = ['NoseCone', 'BodyTube', 'Transition'];
        for (const sub of Array.from(el.children)) {
          if (CHAIN_TAGS.includes(sub.tagName)) {
            const kid = convertPart(sub, null);
            if (kid) chain.push(kid);
          } else if (sub.tagName === 'AttachedParts') {
            for (const sub2 of Array.from(sub.children)) {
              if (CHAIN_TAGS.includes(sub2.tagName)) {
                const kid = convertPart(sub2, null);
                if (kid) chain.push(kid);
              }
            }
          }
        }
        n.children = chain;
        notes.push(`External pod “${n.name ?? 'Pod'}” imported as ${detachable ? 'a strap-on booster (parallel stage)' : 'a pod set'}.`);
        return n;
      }
      case 'RingTail':
        // The desktop importer has no RingTail handler either — parity.
        ignored.add(tag);
        return null;
      default:
        ignored.add(tag);
        return null;
    }
  };

  // Stage slots are TOP-DOWN: Stage3Parts is the sustainer.
  const slotNames = ['Stage3Parts', 'Stage2Parts', 'Stage1Parts'].slice(0, stageCount);
  const components: ComponentNode[] = slotNames.map((slot, i) => {
    const stage: ComponentNode = {
      type: 'stage',
      id: freshId(),
      name: i === 0 ? 'Sustainer' : stageCount === 2 || i === 1 ? 'Booster' : `Booster ${i}`,
      children: [],
    };
    const slotEl = design.querySelector(`:scope > ${slot}`);
    for (const el of Array.from(slotEl?.children ?? [])) {
      if (el.tagName === 'SubAssembly') {
        flattenSubAssembly(el, null, (n) => stage.children!.push(n));
        continue;
      }
      const node = convertPart(el, null);
      if (node) stage.children!.push(node);
    }
    return stage;
  });

  if (components.every((s) => (s.children ?? []).length === 0)) {
    throw new Error('No supported components found in this RockSim design.');
  }

  // ---- Cluster reconstruction ----
  // RockSim files carry a cluster as N separate inner tubes at radial
  // positions. Regroup identical siblings whose offsets fit one of the
  // kernel's cluster patterns into ONE tagged cluster tube (motor serials of
  // the dropped twins re-point at the kept tube). Unmatched layouts stay as
  // separate tubes (with a note) — our schema has no off-axis single tube.
  const matchCluster = (
    pts: { y: number; z: number }[], tubeR: number,
  ): { pattern: string; scale: number; rotation: number } | null => {
    const eps = 1e-6;
    const p = pts.map((q) => ({ x: q.y, y: q.z }));
    for (const [pattern, flat] of Object.entries(CLUSTER_POINTS)) {
      if (pattern === 'single' || flat.length / 2 !== p.length) continue;
      const u: { x: number; y: number }[] = [];
      for (let i = 0; i < flat.length; i += 2) u.push({ x: flat[i]!, y: flat[i + 1]! });
      const uNZ = u.filter((q) => Math.hypot(q.x, q.y) > eps);
      const pNZ = p.filter((q) => Math.hypot(q.x, q.y) > eps);
      if (uNZ.length !== pNZ.length || uNZ.length === 0) continue;
      const su = uNZ.reduce((s, q) => s + Math.hypot(q.x, q.y), 0) / uNZ.length;
      const sp = pNZ.reduce((s, q) => s + Math.hypot(q.x, q.y), 0) / pNZ.length;
      const sep = sp / su;
      if (!(sep > 0)) continue;
      const tol = Math.max(0.15 * sep, 1e-4);
      const u0 = uNZ[0]!;
      for (const cand of pNZ) {
        if (Math.abs(Math.hypot(cand.x, cand.y) - Math.hypot(u0.x, u0.y) * sep) > tol) continue;
        const phi = Math.atan2(cand.y, cand.x) - Math.atan2(u0.y, u0.x);
        const cos = Math.cos(phi);
        const sin = Math.sin(phi);
        const used = new Set<number>();
        let ok = true;
        for (const q of u) {
          const tx = (q.x * cos - q.y * sin) * sep;
          const ty = (q.x * sin + q.y * cos) * sep;
          const idx = p.findIndex((pp, i) => !used.has(i) && Math.hypot(pp.x - tx, pp.y - ty) <= tol);
          if (idx < 0) { ok = false; break; }
          used.add(idx);
        }
        if (ok) {
          const rot = Math.atan2(Math.sin(phi), Math.cos(phi)); // normalize (−π, π]
          return { pattern, scale: sep / (2 * tubeR), rotation: rot };
        }
      }
    }
    return null;
  };
  const reconstructClusters = (nodes: ComponentNode[]) => {
    for (const parentNode of nodes) {
      const kids = parentNode.children ?? [];
      // TOLERANT grouping: RockSim rounds the same physical tube differently
      // between copies (the owner's Darkstar cluster: OD 79.38 on tube 1 vs 79.375
      // on tubes 2–6), so an exact-key match split the ring and killed the
      // reconstruction. Tubes group when length/radius agree within 1% and
      // axial position within 1 mm.
      const groups: ComponentNode[][] = [];
      const near = (a: number, b: number, rel: number, abs: number) =>
        Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
      const nnum2 = (n: ComponentNode, key: string): number =>
        typeof n[key] === 'number' ? (n[key] as number) : 0;
      for (const kid of kids) {
        if (kid.type !== 'innertube') continue;
        const g = groups.find((grp) => {
          const ref = grp[0]!;
          return (ref.position?.method ?? '') === (kid.position?.method ?? '')
            && near(nnum2(ref, 'length'), nnum2(kid, 'length'), 0.01, 1e-4)
            && near(nnum2(ref, 'outerRadius'), nnum2(kid, 'outerRadius'), 0.01, 5e-5)
            && near(ref.position?.offset ?? 0, kid.position?.offset ?? 0, 0, 0.001);
        });
        if (g) g.push(kid);
        else groups.push([kid]);
      }
      for (const g of groups.values()) {
        if (g.length < 2 || !g.some((t) => radialByNode.has(t))) continue;
        const tubeR = typeof g[0]!['outerRadius'] === 'number' ? (g[0]!['outerRadius'] as number) : 0.0095;
        const m = matchCluster(g.map((t) => radialByNode.get(t) ?? { y: 0, z: 0 }), tubeR);
        if (!m) {
          notes.push(`${g.length} identical off-axis tubes in “${parentNode.name ?? parentNode.type}” don't fit a known cluster pattern — imported as separate centerline tubes.`);
          continue;
        }
        // Keep the tube that carries children (our own exports put them on the
        // first copy); default to the first.
        const keep = g.find((t) => (t.children ?? []).length > 0) ?? g[0]!;
        keep['cluster'] = m.pattern;
        keep['clusterScale'] = Number(m.scale.toFixed(4));
        if (Math.abs(m.rotation) > 1e-4) keep['clusterRotation'] = m.rotation;
        keep.name = keep.name?.replace(/ \(\d+\)$/, '');
        const dropped = new Set(g.filter((t) => t !== keep));
        for (const [serial, node] of serialToNode) {
          if (dropped.has(node)) serialToNode.set(serial, keep);
        }
        parentNode.children = (parentNode.children ?? []).filter((k) => !dropped.has(k));
        notes.push(`Cluster: ${g.length} identical motor tubes in “${parentNode.name ?? parentNode.type}” imported as one ${m.pattern} cluster.`);
      }
      reconstructClusters(parentNode.children ?? []);
    }
  };
  reconstructClusters(components);

  // ---- Fin de-collision (2026-08-05d) ----
  // RockSim renders interleaved fin sets without storing an angle, so tube
  // fins + straight fins routinely arrive at the SAME rotation — physically
  // impossible. Any fin-type set that axially overlaps an earlier set at the
  // same angle gets rotated by half the earlier set's pitch (adjustable
  // afterwards via the set's Rotation field).
  const deCollideFins = (nodes: ComponentNode[]) => {
    for (const parentNode of nodes) {
      const kids = parentNode.children ?? [];
      const finSets = kids.filter((k) => k.type.endsWith('finset'));
      if (finSets.length >= 2) {
        const pLen = typeof parentNode['length'] === 'number' ? (parentNode['length'] as number) : 0.2;
        const range = (k: ComponentNode): [number, number] => {
          const len = axialLength(k);
          const start = startFromPosition(
            (k.position ?? { method: 'top', offset: 0 }) as ComponentPosition, len, pLen);
          return [start, start + len];
        };
        const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
        const rotOf = (k: ComponentNode) => (typeof k['rotation'] === 'number' ? (k['rotation'] as number) : 0);
        for (let i = 1; i < finSets.length; i++) {
          const me = finSets[i]!;
          const clash = finSets.slice(0, i).find((other) =>
            Math.abs(rotOf(other) - rotOf(me)) < 1e-6 && overlaps(range(other), range(me)));
          if (clash) {
            const count = Math.max(1, Math.round(
              typeof clash['finCount'] === 'number' ? (clash['finCount'] as number) : 3));
            me['rotation'] = rotOf(me) + Math.PI / count;
            notes.push(`“${me.name ?? me.type}” sat at the same angle as “${clash.name ?? clash.type}” — rotated ${Math.round(180 / count)}° to interleave (fine-tune via the set's Rotation field).`);
          }
        }
      }
      deCollideFins(kids);
    }
  };
  deCollideFins(components);
  readDeploymentEvents(doc, serialToNode, notes);
  applyPresetLinks(pendingLinks, opts?.presets, notes);

  // A nose cone's <BaseExtensionLen> becomes a real body tube directly behind it.
  // Runs AFTER applyPresetLinks so a catalogue row has already filled the cone's
  // density and material, which the extension inherits.
  let extCount = 0;
  /** Insert the parked extension after every nose cone in ONE chain. Deliberately not recursive. */
  const insertBaseExtensions = (chain: ComponentNode[] | undefined) => {
    if (!chain) return;
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i]!;
      if (n.type !== 'nosecone') continue;
      const len = typeof n[PENDING_BASE_EXT] === 'number' ? (n[PENDING_BASE_EXT] as number) : 0;
      // Deleted on read, so a node reached twice by the pod walk is harmless.
      delete n[PENDING_BASE_EXT];
      if (!(len > 1e-6)) continue;
      const or = typeof n['aftRadius'] === 'number' ? (n['aftRadius'] as number) : 0;
      const tube = {
        type: 'bodytube',
        id: freshId(),
        name: `${n.name ?? 'Nose cone'} base extension`,
        length: len,
        outerRadius: or, // BaseDia/2 — the extension has no diameter of its own
        // A SOLID cone (ConstructionType 0 → filled) has a SOLID extension. The app
        // has no `filled` for a body tube: ComponentFactory builds
        // `new BodyTube(len, radius, thickness)` and never calls setFilled (it does
        // so only for the nose and transition cases). Express solid as
        // thickness = outerRadius, which carved BodyTube.java:248-252 turns into
        // innerRadius 0. Copying the cone's WallThickness instead gives a ZERO-MASS
        // tube: 8 of the 9 solid corpus cones state WallThickness 0, and
        // PELTZER-Warp-7.rkt then reads 32.97 g against RockSim's own CalcMass of
        // 38.63 g, where the solid form gives 38.631 g.
        thickness: n['filled'] === true ? or : (typeof n['thickness'] === 'number' ? n['thickness'] : 0),
        position: { method: 'top', offset: 0 },
        // Durable marker so the .rkt exporter can fold it back into
        // <BaseExtensionLen>. NOT shape-matched the way the RASAero importer
        // recognises its synthesised parts: "a body tube right behind the nose cone
        // at the cone's base diameter" is the commonest real airframe there is, and
        // folding a user's payload bay into this element would orphan its children.
        // The marker is not a schema field, so a .ork round trip drops it and a later
        // .rkt export writes an honest <BodyTube> — same geometry, different
        // decomposition. Do not "fix" that.
        rktBaseExtension: true,
      } as unknown as ComponentNode;
      if (typeof n['density'] === 'number') (tube as Record<string, unknown>)['density'] = n['density'];
      if (n['materialName']) (tube as Record<string, unknown>)['materialName'] = n['materialName'];
      if (n['finish']) (tube as Record<string, unknown>)['finish'] = n['finish'];
      // RockSim's <KnownMass> is the mass of the WHOLE part, extension included, so a
      // pinned cone must not gain mass here. ComponentFactory gates the override on
      // NaN rather than truthiness, so a literal 0 is a real override.
      if (typeof n['overrideMass'] === 'number') (tube as Record<string, unknown>)['overrideMass'] = 0;
      chain.splice(i + 1, 0, tube);
      i++; extCount++;
    }
  };
  /**
   * Every CHAIN in the tree: each stage's, and each pod / parallel stage's AT ANY
   * DEPTH. A RockSim <ExternalPod> normally sits in a <BodyTube>'s <AttachedParts>,
   * so its chain hangs off a body tube, not off the stage. Deliberately NOT
   * descending into a plain AttachedParts chain: an external cylinder has no meaning
   * as an internal sibling.
   */
  const insertInPods = (nodes: ComponentNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'podset' || n.type === 'parallelstage') insertBaseExtensions(n.children);
      insertInPods(n.children);
    }
  };
  for (const stage of components) { insertBaseExtensions(stage.children); insertInPods(stage.children); }

  if (ignored.size) {
    notes.push(`Ignored unsupported RockSim components: ${[...ignored].join(', ')}.`);
  }
  if (keptWithoutCGFlag.size) {
    const n = keptWithoutCGFlag.size;
    notes.push(`${n} part${n === 1 ? ' states' : 's state'} a measured mass or balance point that the `
      + `file's “known CG” flag says to ignore — applied ${n === 1 ? 'it' : 'them'}. Desktop `
      + 'OpenRocket discards a measured mass unless the CG is measured too.');
  }
  if (extCount) {
    notes.push(`${extCount} nose cone${extCount === 1 ? ' has' : 's have'} a cylindrical base `
      + "extension (RockSim's BaseExtensionLen) — added as a body tube of the same diameter "
      + 'directly behind the cone, so the rocket is its true length and everything aft of the cone '
      + "sits where the file's own station numbers put it. Desktop OpenRocket drops this and "
      + 'imports the rocket short. Where the cone states a measured mass, that mass already covers '
      + 'the extension, so the added tube carries none of its own.');
  }
  if (pinnedMassObjects) {
    const n = pinnedMassObjects;
    notes.push(`${n} mass object${n === 1 ? '' : 's'} placed at the exact point the file states. `
      + 'RockSim stores a length for a mass object but treats it as a point, so '
      + `${n === 1 ? 'its balance point is' : 'their balance points are'} pinned there and shown `
      + 'as a CG override.');
  }

  // Motors: the desktop DROPS these; we read EngineCode + MountSerialNo so
  // the app can auto-load them from the bundled motor database. Real RockSim
  // files often carry STALE serial links (renumbered after edits) — fall
  // back to the first motor mount of the EngineSet's stage.
  const motors: Record<string, OrkMotorRef> = {};
  let firstMotor: OrkMotorRef | undefined;
  for (const engineSet of Array.from(doc.querySelectorAll('EngineSet'))) {
    const code = text(engineSet, ':scope > EngineCode');
    if (!code) continue;
    const mountSerial = text(engineSet, ':scope > MountSerialNo');
    let mount = mountSerial ? serialToNode.get(mountSerial) : undefined;
    if (!mount || mount['motorMount'] !== true) {
      // Stale serial: Stage3Engines→stage 0, Stage2Engines→1, Stage1Engines→2.
      const slotMatch = engineSet.parentElement?.tagName.match(/^Stage(\d)Engines$/);
      const stageIdx = slotMatch ? 3 - Number(slotMatch[1]) : 0;
      mount = mountsIn(components[stageIdx]?.children ?? [])[0];
    }
    if (!mount?.id) continue;
    // RockSim's <IgnitionDelay> is an offset from the STAGE BELOW'S BURNOUT, not
    // from liftoff. Dropping it entirely (what we did before) made every .rkt
    // motor {automatic, 0}, which on an upper stage means the stage below's
    // EJECTION CHARGE — so a staged design lit its sustainer off the wrong event
    // and ignored the file's timer.
    //
    // Three independent confirmations, because getting this backwards moves a
    // sustainer by tens of seconds:
    //  1. `2,4-D.rkt` stores three RockSim result sets for the same design. Two
    //     differ ONLY in the sustainer's IgnitionDelay (0 vs 10 s) and their
    //     stored <TimeToBurnout> differs by exactly 10.0000 s. Liftoff-relative
    //     cannot produce that — a sustainer lit at t=10 would still be burning
    //     inside the booster's burn, and the later burnout would be the
    //     booster's, identical in both.
    //  2. `SS Wild Bash 20260623v0.ork`, the same design saved by the same
    //     author, declares <ignitionevent>burnout</ignitionevent> on BOTH upper
    //     mounts and `launch` only on the bottom one.
    //  3. Desktop OpenRocket maps the identical concept the same way in its
    //     RASAero importer (SimulationHandler: stages below the top get
    //     IgnitionEvent.BURNOUT), and rasaeroFile.ts already follows it.
    //
    // Keyed on STAGE POSITION, not on the delay being non-zero: an upper stage
    // with an explicit 0 still means "at the stage below's burnout", which is a
    // different event from 'automatic'. The bottom stage is left 'automatic' —
    // the kernel resolves that to launch there — so single-stage .rkt files are
    // untouched.
    const ignitionDelay = num(engineSet, 'IgnitionDelay', 0);
    const isBottomStage = components.length <= 1
      || mountsIn(components[components.length - 1]?.children ?? []).some((m) => m.id === mount!.id);
    const ref: OrkMotorRef = {
      designation: code,
      manufacturer: text(engineSet, ':scope > EngineMfg') ?? 'unknown',
      diameter: 0, // unknown in the file — match by designation alone
      length: 0,
      delay: num(engineSet, 'EjectionDelay', 0),
      mountId: mount.id,
      ...(isBottomStage ? {} : { ignitionEvent: 'burnout' as const, ignitionDelay }),
    };
    motors[mount.id] = ref;
    firstMotor = firstMotor ?? ref;
  }

  return {
    name,
    tree: { name, components },
    motor: firstMotor,
    motors,
    ignored: [...ignored],
    notes,
    ...(measured ? { measured } : {}),
  };
}

/**
 * RockSim `<SimulationEventList>` → each recovery device's deployment trigger.
 *
 * WHY THIS EXISTS. Until v0.098 nothing read this list, so EVERY device fell to
 * the kernel default and a dual-deploy design flew with drogue and main opening
 * together at ejection. On Eric's own `4in WM Extreme.rkt` that is not his
 * rocket: the file says the main opens at 152.4 m (500 ft) and the drogue at
 * apogee, and simulating both from apogee gives a descent that never happens.
 * Three of the ten corpus files are dual-deploy (mains at 152.4 / 213.36 /
 * 237.744 m). Found by the 2026-09-03 format audit.
 *
 * THE TYPE CODES ARE NOT DOCUMENTED AND OPENROCKET NEVER READ THEM, so they are
 * pinned from the corpus rather than guessed — 13 `.rkt` files, 2026-09-03:
 *   1  → ejection charge      (TubeFins2's only chute; 2,4-D's 1st-stage streamer)
 *   2  → ejection + `DeplyTime` seconds  (2,4-D's 1st-stage main, DeplyTime 2)
 *   4  → apogee               (every drogue, and every single-chute sport model)
 *   5  → altitude, descending, at `DeployAltitude`  (every main: 152.4, 213.36,
 *        228.6, 237.744, 457.2 m — all plausible real main-deployment heights)
 *   0  → an EMPTY SLOT: RockSim writes a fixed-size array and pads it with
 *        `PartSerialNo` 0. Skipped, not mapped.
 *   28 → seen on four chutes of one file with no altitude or time. Meaning
 *        unknown, so it is LEFT ALONE (kernel default) and named in a note
 *        rather than guessed — a wrong deployment event is worse than none.
 *
 * FIRST SIMULATION WINS. RockSim stores several simulation slots and repeats the
 * whole event list in each, and they can disagree (2,4-D's serial 26 is type 2 /
 * 2 s in the first and type 5 / 152.4 m in the second). Taking the first match
 * per serial mirrors how the `.ork` reader takes launch conditions from the
 * file's FIRST `<simulation>`.
 *
 * NOT READ, deliberately: `TestType` / `TestCondition` / `TestValue*`, RockSim
 * Pro's multi-condition elaboration. `Type` + `DeployAltitude` + `DeplyTime` is
 * the simple pair every file agrees with; the Pro triplet has no analogue in our
 * one-trigger model, and inventing one would be a guess.
 */
const readDeploymentEvents = (
  doc: Document,
  serialToNode: Map<string, ComponentNode>,
  notes: string[],
): void => {
  const seen = new Set<string>();
  const unknown = new Set<number>();
  const applied: string[] = [];
  for (const ev of Array.from(doc.querySelectorAll('SimulationEvent'))) {
    const serial = text(ev, ':scope > PartSerialNo');
    if (!serial || serial === '0' || seen.has(serial)) continue;
    const node = serialToNode.get(serial);
    if (!node || (node.type !== 'parachute' && node.type !== 'streamer')) continue;
    const type = Math.round(num(ev, 'Type', 0));
    if (type === 0) continue;
    seen.add(serial);
    const label = node.name ?? node.type;
    switch (type) {
      case 1:
        node['deployEvent'] = 'ejection';
        applied.push(`${label} at the ejection charge`);
        break;
      case 2: {
        node['deployEvent'] = 'ejection';
        const delay = num(ev, 'DeplyTime', 0);
        if (delay > 0) node['deployDelay'] = delay;
        applied.push(`${label} at the ejection charge${delay > 0 ? ` + ${delay} s` : ''}`);
        break;
      }
      case 4:
        node['deployEvent'] = 'apogee';
        applied.push(`${label} at apogee`);
        break;
      case 5: {
        const alt = num(ev, 'DeployAltitude', 0);
        if (alt > 0) {
          node['deployEvent'] = 'altitude';
          node['deployAltitude'] = alt;
          applied.push(`${label} at ${Math.round(alt)} m`);
        } else {
          // Altitude trigger with no altitude: apogee is the only honest reading.
          node['deployEvent'] = 'apogee';
          applied.push(`${label} at apogee (the file asks for an altitude but names none)`);
        }
        break;
      }
      default:
        unknown.add(type);
        seen.delete(serial);
    }
  }
  if (applied.length) {
    notes.push(`Recovery deployment read from the file: ${applied.join('; ')}.`);
  }
  if (unknown.size) {
    notes.push(
      `${unknown.size === 1 ? 'One deployment trigger uses' : 'Some deployment triggers use'} a RockSim `
      + `code this app does not recognise (${[...unknown].sort((a, b) => a - b).join(', ')}); `
      + `${unknown.size === 1 ? 'that device keeps' : 'those devices keep'} the default trigger — `
      + 'check the deployment settings before flying.',
    );
  }
};

/** RockSim PointList: "x,y|x,y|…" in mm; reversed when RockSim-ordered. */
function parsePointList(raw: string): [number, number][] {
  const pts: [number, number][] = [];
  for (const pair of raw.split('|')) {
    if (!pair.trim()) continue;
    const [x, y] = pair.split(',').map((v) => Number(v));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // RockSim writes duplicate 0,0 points — drop them.
    if (pts.length > 0 && x === 0 && y === 0 && pts.some(([px, py]) => px === 0 && py === 0)) continue;
    pts.push([x! / LEN, y! / LEN]);
  }
  // Our order is leading-root → trailing-root; RockSim's is usually reversed.
  if (pts.length > 1 && pts[pts.length - 1]![0] === 0 && pts[pts.length - 1]![1] === 0) {
    pts.reverse();
  }
  return pts;
}

// ============================ EXPORT ============================

export interface RktExportInput {
  name: string;
  tree: RocketTree;
  motors?: Record<string, OrkExportMotor>;
  /**
   * Per-component computed mass (kg, override-aware) and CG-from-front (m),
   * keyed by node id — from the engine's componentInfo. RockSim keeps both
   * numbers in one part whatever the flags say, so a partial override (mass
   * without CG, or CG without mass) must export the CALCULATED other value;
   * without this map the un-overridden half exports as 0, which any reader
   * that couples the flags takes as "CG at the component's front" — a real
   * data error in RockSim.
   */
  compInfo?: Record<string, { mass: number; cgX: number }>;
}

export function exportRkt({ name, tree, motors, compInfo }: RktExportInput): string {
  const lines: string[] = [];
  const emit = (s: string) => lines.push(s);
  let serial = 0;
  /** node id → RockSim SerialNo (links motors back to mounts). */
  const nodeSerial = new Map<string, number>();

  const stagesIn = asStageNodes(tree);
  if (stagesIn.length > 3) {
    throw new Error('RockSim supports at most 3 stages.');
  }

  const nnum = (node: ComponentNode, key: string, fb: number): number =>
    typeof node[key] === 'number' ? (node[key] as number) : fb;

  // Parent of the part currently being emitted (set at emitPart dispatch).
  let curParent: ComponentNode | null = null;

  // Fold a synthesised base extension back into its cone's <BaseExtensionLen>.
  // Without this it goes out as a plain <BodyTube> and its `overrideMass: 0` is lost
  // on re-import — common() writes <KnownMass>0</KnownMass> and the import gate is
  // `km > 0 && flagMass`, so a legitimate zero is rejected and the mass recomputed.
  // Measured export→re-import without the fold: 4in WM Extreme 5308.2 → 5324.9 g;
  // 6in Goblin 9219.0 → 9719.4 (+5.4 %); rocksimTestRocket1 264.3 → 290.4 (+9.9 %).
  const baseExtOf = new Map<string, number>();
  const folded = new Set<ComponentNode>();
  const foldChain = (chain: ComponentNode[] | undefined) => {
    for (let i = 0; chain && i < chain.length; i++) {
      const a = chain[i]!;
      const b = chain[i + 1];
      if (a.type !== 'nosecone' || !a.id) continue; // no id = no map key; leave the tube alone
      if (!b || b.type !== 'bodytube' || b['rktBaseExtension'] !== true) continue;
      // Fold only a tube the user has not turned into something else — the element
      // carries a LENGTH and nothing more, so any other edit would die in the fold.
      const or = nnum(a, 'aftRadius', -1);
      if (Math.abs(nnum(b, 'outerRadius', -2) - or) > 1e-9) continue;
      const wantThickness = a['filled'] === true ? or : nnum(a, 'thickness', -2);
      if (Math.abs(nnum(b, 'thickness', -3) - wantThickness) > 1e-9) continue;
      if ((b.children ?? []).length) continue;
      if (typeof b['overrideMass'] === 'number' && b['overrideMass'] !== 0) continue;
      if (typeof b['overrideCGX'] === 'number' || typeof b['overrideCD'] === 'number') continue;
      baseExtOf.set(a.id, nnum(b, 'length', 0));
      folded.add(b);
    }
  };
  const foldInPods = (nodes: ComponentNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === 'podset' || n.type === 'parallelstage') foldChain(n.children);
      foldInPods(n.children);
    }
  };
  for (const s of stagesIn) { foldChain(s.children); foldInPods(s.children); }

  /**
   * RockSim `<LocationMode>` + `<Xb>` for a node. Extracted so the KnownCG line
   * above it can reach Xb: a MassObject's `<KnownCG>` IS its `<Xb>` (desktop
   * MassObjectDTO.java:38-39 overrides BasePartDTO to write exactly that, and all
   * 28 TypeCode-0 objects in our corpus agree). Uses curParent for 'middle'.
   */
  const rocksimXb = (node: ComponentNode): { mode: number; xb: number } => {
    const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
    const mode = pos.method === 'absolute' ? 1 : pos.method === 'bottom' ? 2 : 0;
    let xb = pos.method === 'bottom' ? -pos.offset : pos.offset;
    // RockSim has no "middle" mode — convert to front-referenced, mirroring
    // the desktop's BasePartDTO: xb = offset + (parentLen - componentLen)/2.
    if (pos.method === 'middle' && curParent) {
      const compLen = nnum(node, 'length', nnum(node, 'rootChord', 0));
      xb = pos.offset + (nnum(curParent, 'length', 0) - compLen) / 2;
    }
    return { mode, xb };
  };

  const common = (
    node: ComponentNode,
    dfltName: string,
    opts?: { knownMass?: number; useKnownCG?: boolean; knownCGIsXb?: boolean },
  ) => {
    const { mode, xb } = rocksimXb(node);
    serial += 1;
    // First write wins: cluster copies re-emit the same node — motor
    // references must point at the FIRST copy (the one carrying children).
    if (node.id && !nodeSerial.has(node.id)) nodeSerial.set(node.id, serial);
    const hasMassOv = typeof node['overrideMass'] === 'number';
    const hasCgOv = typeof node['overrideCGX'] === 'number';
    const override = hasMassOv || hasCgOv;
    const info = node.id ? compInfo?.[node.id] : undefined;
    // BOTH values are always real whenever either override exists: the
    // overridden one verbatim, the other from the computed component info. A 0
    // in the un-overridden field is the data error the compInfo map exists to
    // prevent, and it stays wrong even with the flag off — a reader is entitled
    // to look at the number regardless.
    const knownMass = opts?.knownMass
      ?? ((hasMassOv ? (node['overrideMass'] as number)
        : override ? info?.mass ?? 0 : 0) * MASS);
    emit(`<KnownMass>${knownMass}</KnownMass>`);
    // Density is KIND-specific, mirroring the desktop's BasePartDTO. Soft goods
    // never carry node.density — orkFile stores them as surfaceDensity (chute /
    // streamer) or lineDensity (shock cord) — so emitting the bulk key made
    // every recovery device export at Density 0, i.e. weightless in RockSim.
    // DensityType: 0 bulk, 1 surface, 2 line (RockSimCommonConstants). Surface is
    // x0.1 here and /0.1 on import; LINE IS x1 BOTH WAYS
    // (ROCKSIM_TO_OPENROCKET_LINE_DENSITY = 1). Until v0.097 it took the surface
    // factor too, so a shock cord left here 10x lighter than the design.
    if (node.type === 'parachute' || node.type === 'streamer') {
      emit(`<Density>${nnum(node, 'surfaceDensity', 0.067) * 0.1}</Density>`);
      emit('<DensityType>1</DensityType>');
      emit(`<Material>${esc(typeof node['surfaceMaterialName'] === 'string' ? (node['surfaceMaterialName'] as string) : 'Ripstop nylon')}</Material>`);
    } else if (node.type === 'shockcord') {
      emit(`<Density>${nnum(node, 'lineDensity', 0.0018)}</Density>`);
      emit('<DensityType>2</DensityType>');
      emit(`<Material>${esc(typeof node['lineMaterialName'] === 'string' ? (node['lineMaterialName'] as string) : 'Elastic cord')}</Material>`);
    } else {
      emit(`<Density>${nnum(node, 'density', 0)}</Density>`);
      emit('<DensityType>0</DensityType>');
      emit(`<Material>${esc(typeof node['materialName'] === 'string' ? (node['materialName'] as string) : 'custom')}</Material>`);
    }
    emit(`<Name>${esc(node.name ?? dfltName)}</Name>`);
    // The catalogue row this part came from, when it came from one - RockSim's
    // own convention (it writes "Custom" otherwise), and what our importer reads
    // back into a catalogue link.
    if (typeof node['presetManufacturer'] === 'string' && typeof node['presetPartNo'] === 'string') {
      emit(`<PartMfg>${esc(node['presetManufacturer'] as string)}</PartMfg>`);
      emit(`<PartNo>${esc(node['presetPartNo'] as string)}</PartNo>`);
    }
    // EXPORT IS DELIBERATELY UNCHANGED (issue 2026-08-23a). Splitting the flags
    // here — UseKnownCG=0 on a mass-only override, with the measured mass in
    // <KnownMass> — states the truth more precisely, and it is what our own
    // importer would prefer. It also loses data: RockSim and desktop
    // OpenRocket both couple the flags, so a 0 there makes them discard the
    // measured mass entirely. Today's UseKnownCG=1 gives desktop the right
    // mass AND a CG equal to the one it would have computed itself, so nothing
    // is wrong over there. Precision in our dialect is not worth a real user
    // losing a weight when they open the file somewhere else.
    const useKnown = opts?.useKnownCG ?? override;
    // A MassObject's KnownCG is its Xb, always. Desktop MassObjectDTO.java:38-39
    // overrides BasePartDTO with `setKnownCG(getXb()); setUseKnownCG(1)` for EVERY
    // MassObject, and RockSim's own files do the same (28 of 28 in the corpus).
    // Without this an app-authored mass component exported
    // `<KnownCG>0</KnownCG><UseKnownCG>1</UseKnownCG>` — telling RockSim its CG sits
    // at the component's own front — because App.tsx only fills compInfo for nodes
    // carrying exactly ONE of the two overrides, so `info?.cgX ?? 0` yielded 0.
    const knownCG = opts?.knownCGIsXb ? xb * LEN
      : hasCgOv ? (node['overrideCGX'] as number) * LEN
        : useKnown ? (info?.cgX ?? 0) * LEN : 0;
    emit(`<KnownCG>${knownCG}</KnownCG>`);
    emit(`<UseKnownCG>${useKnown ? 1 : 0}</UseKnownCG>`);
    emit(`<FinishCode>${FINISH_TO_CODE(node['finish'])}</FinishCode>`);
    emit(`<SerialNo>${serial}</SerialNo>`);
    emit(`<LocationMode>${mode}</LocationMode>`);
    emit(`<Xb>${xb * LEN}</Xb>`);
    // RockSim's computed mass/CG. Desktop writes both (BasePartDTO.java:84-85) and
    // — the load-bearing part — its IMPORTER pins any AIRFOIL fin set with
    // UseKnownCG=0 to them (FinSetHandler.java:299-309) from a field that defaults
    // to 0.0d. A .rkt from this app that omits <CalcMass> therefore opens in desktop
    // OpenRocket with EVERY airfoil fin set weighing zero grams: measured on the
    // committed fixture auto-radius-15.03.ork, an 829 g fin set — 10.7 % of that
    // rocket's dry mass — disappears and its stability is over-reported by 0.91 cal.
    // RockSim itself recomputes these and is unaffected. Desktop also uses <CalcMass>
    // as the zero-density fallback for a recovery device
    // (RecoveryDeviceHandler.java:79-101), which this can only improve.
    // `info.mass` is override-aware where desktop's getComponentMass() is not; that
    // makes desktop reproduce the number this app shows, and it is immaterial for fin
    // sets — an overridden set exports UseKnownCG=1, where desktop's airfoil branch
    // never runs. Real RockSim files put these right here, after <Xb>.
    if (info) {
      emit(`<CalcMass>${info.mass * MASS}</CalcMass>`);
      emit(`<CalcCG>${info.cgX * LEN}</CalcCG>`);
    }
  };

  const attached = (node: ComponentNode) => {
    emit('<AttachedParts>');
    for (const kid of node.children ?? []) emitPart(kid, node);
    emit('</AttachedParts>');
  };

  const emitInnerTube = (node: ComponentNode, radialLocM = 0, radialAngle = 0, suffix = '') => {
    emit('<BodyTube>');
    common(node, `Inner Tube${suffix}`);
    emit(`<OD>${nnum(node, 'outerRadius', 0.0095) * RAD}</OD>`);
    emit(`<ID>${(nnum(node, 'outerRadius', 0.0095) - nnum(node, 'thickness', 0.0005)) * RAD}</ID>`);
    emit(`<Len>${nnum(node, 'length', 0.07) * LEN}</Len>`);
    emit(`<IsMotorMount>${node['motorMount'] === true ? 1 : 0}</IsMotorMount>`);
    emit(`<MotorDia>${motorDia(node, 0.0095)}</MotorDia>`);
    emit(`<EngineOverhang>${nnum(node, 'motorOverhang', 0) * LEN}</EngineOverhang>`);
    emit('<IsInsideTube>1</IsInsideTube>');
    emit(`<RadialLoc>${radialLocM * LEN}</RadialLoc>`);
    emit(`<RadialAngle>${radialAngle}</RadialAngle>`);
    emit('<AttachedParts>');
    if (!suffix) for (const kid of node.children ?? []) emitPart(kid, node);
    emit('</AttachedParts>');
    emit('</BodyTube>');
  };

  const emitPart = (node: ComponentNode, parent: ComponentNode | null) => {
    // common() needs the parent's length for the middle-position conversion;
    // set before dispatch (every common() call happens inside this frame,
    // always before the recursive attached() walk).
    curParent = parent;
    switch (node.type) {
      case 'nosecone': {
        emit('<NoseCone>');
        common(node, 'Nose cone');
        emit(`<Len>${nnum(node, 'length', 0.07) * LEN}</Len>`);
        emit(`<BaseDia>${nnum(node, 'aftRadius', 0.012) * RAD}</BaseDia>`);
        emit(`<WallThickness>${nnum(node, 'thickness', 0.002) * LEN}</WallThickness>`);
        emit(`<ShapeCode>${NOSE_SHAPE_TO_CODE[String(node['shape'] ?? 'ogive')] ?? 1}</ShapeCode>`);
        emit(`<ShapeParameter>${rktShapeParameter(String(node['shape'] ?? 'ogive'), node['shapeParameter'])}</ShapeParameter>`);
        emit(`<ConstructionType>${node['filled'] === true ? 0 : 1}</ConstructionType>`);
        emit(`<ShoulderLen>${nnum(node, 'shoulderLength', 0) * LEN}</ShoulderLen>`);
        emit(`<ShoulderOD>${nnum(node, 'shoulderRadius', 0) * RAD}</ShoulderOD>`);
        // Emitted unconditionally (0 for a normal cone) — that is what RockSim
        // writes, and desktop parses it fine: its own test fixture
        // rocksimTestRocket1.rkt carries <BaseExtensionLen>66.675</BaseExtensionLen>.
        // Placed where RockSim's own files put it, after <ShoulderOD>.
        emit(`<BaseExtensionLen>${(baseExtOf.get(node.id ?? '') ?? 0) * LEN}</BaseExtensionLen>`);
        attached(node);
        emit('</NoseCone>');
        break;
      }
      case 'transition': {
        emit('<Transition>');
        common(node, 'Transition');
        emit(`<Len>${nnum(node, 'length', 0.04) * LEN}</Len>`);
        emit(`<FrontDia>${nnum(node, 'foreRadius', 0.012) * RAD}</FrontDia>`);
        emit(`<RearDia>${nnum(node, 'aftRadius', 0.009) * RAD}</RearDia>`);
        emit(`<WallThickness>${nnum(node, 'thickness', 0.002) * LEN}</WallThickness>`);
        emit(`<ShapeCode>${NOSE_SHAPE_TO_CODE[String(node['shape'] ?? 'conical')] ?? 0}</ShapeCode>`);
        // MUST follow <ShapeCode>: desktop's reader is SAX and its ShapeParameter
        // branch tests the shape type set when <ShapeCode> closed
        // (TransitionHandler.java:102-107). Emitted before it, desktop OpenRocket
        // silently drops the value. Our own reader is DOM-based and order-free,
        // so only the ordering test catches a mistake here.
        emit(`<ShapeParameter>${rktShapeParameter(String(node['shape'] ?? 'conical'), node['shapeParameter'])}</ShapeParameter>`);
        emit(`<ConstructionType>${node['filled'] === true ? 0 : 1}</ConstructionType>`);
        emit(`<FrontShoulderLen>${nnum(node, 'foreShoulderLength', 0) * LEN}</FrontShoulderLen>`);
        emit(`<FrontShoulderDia>${nnum(node, 'foreShoulderRadius', 0) * RAD}</FrontShoulderDia>`);
        emit(`<RearShoulderLen>${nnum(node, 'aftShoulderLength', 0) * LEN}</RearShoulderLen>`);
        emit(`<RearShoulderDia>${nnum(node, 'aftShoulderRadius', 0) * RAD}</RearShoulderDia>`);
        attached(node);
        emit('</Transition>');
        break;
      }
      case 'bodytube': {
        emit('<BodyTube>');
        common(node, 'Body tube');
        emit(`<OD>${nnum(node, 'outerRadius', 0.012) * RAD}</OD>`);
        emit(`<ID>${(nnum(node, 'outerRadius', 0.012) - nnum(node, 'thickness', 0.0005)) * RAD}</ID>`);
        emit(`<Len>${nnum(node, 'length', 0.2) * LEN}</Len>`);
        // Min-diameter: RockSim's BodyTube carries the same mount flag.
        emit(`<IsMotorMount>${node['motorMount'] === true ? 1 : 0}</IsMotorMount>`);
        if (node['motorMount'] === true) {
          emit(`<MotorDia>${motorDia(node, 0.012)}</MotorDia>`);
          emit(`<EngineOverhang>${nnum(node, 'motorOverhang', 0) * LEN}</EngineOverhang>`);
        }
        emit('<IsInsideTube>0</IsInsideTube>');
        attached(node);
        emit('</BodyTube>');
        break;
      }
      case 'innertube': {
        // Clusters: RockSim has no cluster concept — split into individual
        // tubes at the real cluster positions (the desktop does the same).
        const cluster = typeof node['cluster'] === 'string' ? (node['cluster'] as string) : undefined;
        const offsets = clusterOffsets(cluster, nnum(node, 'outerRadius', 0.0095),
          nnum(node, 'clusterScale', 1), nnum(node, 'clusterRotation', 0));
        if (offsets.length === 1) {
          emitInnerTube(node);
        } else {
          offsets.forEach((off, i) => {
            const r = Math.hypot(off.y, off.z);
            const angle = Math.atan2(off.z, off.y);
            emitInnerTube(node, r, angle, i === 0 ? '' : ` (${i + 1})`);
          });
        }
        break;
      }
      case 'centeringring': case 'bulkhead': case 'engineblock': case 'tubecoupler': {
        const usage = node.type === 'bulkhead' ? 1 : node.type === 'engineblock' ? 2
          : node.type === 'tubecoupler' ? 4 : 0;
        emit('<Ring>');
        common(node, 'Ring');
        const parentInner = parent
          ? nnum(parent, 'outerRadius', 0.012) - nnum(parent, 'thickness', 0.0005)
          : 0.012;
        const od = nnum(node, 'outerRadius', parentInner);
        emit(`<OD>${od * RAD}</OD>`);
        const id = node.type === 'bulkhead' ? 0
          : nnum(node, 'innerRadius', Math.max(0, od - nnum(node, 'thickness', 0.002)));
        emit(`<ID>${id * RAD}</ID>`);
        emit(`<Len>${nnum(node, 'length', 0.002) * LEN}</Len>`);
        emit(`<UsageCode>${usage}</UsageCode>`);
        emit('</Ring>');
        break;
      }
      case 'trapezoidfinset': case 'ellipticalfinset': case 'freeformfinset': {
        const isCustom = node.type === 'freeformfinset';
        emit(isCustom ? '<CustomFinSet>' : '<FinSet>');
        common(node, 'Fin set');
        emit(`<FinCount>${Math.round(nnum(node, 'finCount', 3))}</FinCount>`);
        emit(`<ShapeCode>${isCustom ? 2 : node.type === 'ellipticalfinset' ? 1 : 0}</ShapeCode>`);
        emit(`<Thickness>${nnum(node, 'thickness', 0.003) * LEN}</Thickness>`);
        emit(`<TipShapeCode>${CROSS_SECTION_TO_CODE[String(node['crossSection'] ?? 'square')] ?? 0}</TipShapeCode>`);
        if (node.type === 'trapezoidfinset') {
          emit(`<RootChord>${nnum(node, 'rootChord', 0.05) * LEN}</RootChord>`);
          emit(`<TipChord>${nnum(node, 'tipChord', 0.03) * LEN}</TipChord>`);
          emit(`<SweepDistance>${nnum(node, 'sweep', 0) * LEN}</SweepDistance>`);
          emit(`<SemiSpan>${nnum(node, 'height', 0.03) * LEN}</SemiSpan>`);
        } else if (node.type === 'ellipticalfinset') {
          emit(`<RootChord>${nnum(node, 'rootChord', 0.05) * LEN}</RootChord>`);
          emit(`<SemiSpan>${nnum(node, 'height', 0.03) * LEN}</SemiSpan>`);
        } else {
          const pts = (node['points'] as [number, number][] | undefined) ?? [];
          // RockSim point order is the REVERSE of ours.
          const s = [...pts].reverse().map(([x, y]) => `${x * LEN},${y * LEN}`).join('|');
          emit(`<PointList>${s}${s ? '|' : ''}</PointList>`);
        }
        if (nnum(node, 'tabHeight', 0) > 0 && nnum(node, 'tabLength', 0) > 0) {
          emit(`<TabLength>${nnum(node, 'tabLength', 0) * LEN}</TabLength>`);
          emit(`<TabDepth>${nnum(node, 'tabHeight', 0) * LEN}</TabDepth>`);
          emit(`<TabOffset>${nnum(node, 'tabOffset', 0) * LEN}</TabOffset>`);
        }
        // Radians — matching the desktop's RockSim exporter (FinSetDTO).
        if (nnum(node, 'cant', 0) !== 0) {
          emit(`<CantAngle>${nnum(node, 'cant', 0)}</CantAngle>`);
        }
        if (nnum(node, 'rotation', 0) !== 0) {
          emit(`<RadialAngle>${nnum(node, 'rotation', 0)}</RadialAngle>`);
        }
        emit(isCustom ? '</CustomFinSet>' : '</FinSet>');
        break;
      }
      case 'podset': case 'parallelstage': {
        // RockSim pods are single-instance — split N instances into N
        // <ExternalPod>s around the ring (the desktop does the same);
        // parallel stages export as Detachable pods.
        const count = Math.max(1, Math.round(nnum(node, 'instanceCount', 1)));
        const parentR = curParent
          ? Math.max(nnum(curParent, 'outerRadius', 0), nnum(curParent, 'aftRadius', 0), 0.012)
          : 0.012;
        const centerR = resolveAssemblyRadius(node, parentR);
        const angle0 = nnum(node, 'angleOffset', 0);
        for (let i = 0; i < count; i++) {
          emit('<ExternalPod>');
          common(node, node.type === 'podset' ? 'Pod' : 'Booster');
          emit('<AutoCalcRadialDistance>0</AutoCalcRadialDistance>');
          emit('<AutoCalcRadialAngle>0</AutoCalcRadialAngle>');
          emit(`<Detachable>${node.type === 'parallelstage' ? 1 : 0}</Detachable>`);
          emit('<Removed>0</Removed>');
          emit(`<RadialLoc>${centerR * LEN}</RadialLoc>`);
          emit(`<RadialAngle>${angle0 + (2 * Math.PI * i) / count}</RadialAngle>`);
          emit('<AttachedParts>');
          // `folded` tubes went out inside their cone's <BaseExtensionLen>.
          for (const kid of node.children ?? []) { if (folded.has(kid)) continue; emitPart(kid, node); }
          emit('</AttachedParts>');
          emit('</ExternalPod>');
        }
        break;
      }
      case 'launchlug': {
        emit('<LaunchLug>');
        common(node, 'Launch lug');
        emit(`<OD>${nnum(node, 'outerRadius', 0.0022) * RAD}</OD>`);
        emit(`<ID>${(nnum(node, 'outerRadius', 0.0022) - nnum(node, 'thickness', 0.0003)) * RAD}</ID>`);
        emit(`<Len>${nnum(node, 'length', 0.05) * LEN}</Len>`);
        emit('</LaunchLug>');
        break;
      }
      case 'tubefinset': {
        emit('<TubeFinSet>');
        common(node, 'Tube fins');
        emit(`<TubeCount>${Math.round(nnum(node, 'finCount', 6))}</TubeCount>`);
        emit(`<MaxTubesAllowed>${Math.round(nnum(node, 'finCount', 6))}</MaxTubesAllowed>`);
        emit(`<OD>${nnum(node, 'outerRadius', 0.012) * RAD}</OD>`);
        emit(`<ID>${Math.max(0, nnum(node, 'outerRadius', 0.012) - nnum(node, 'thickness', 0.0005)) * RAD}</ID>`);
        emit(`<Len>${nnum(node, 'length', 0.1) * LEN}</Len>`);
        if (nnum(node, 'rotation', 0) !== 0) {
          emit(`<RadialAngle>${nnum(node, 'rotation', 0)}</RadialAngle>`);
        }
        emit('</TubeFinSet>');
        break;
      }
      case 'parachute': {
        emit('<Parachute>');
        common(node, 'Parachute');
        emit(`<Dia>${nnum(node, 'diameter', 0.3) * LEN}</Dia>`);
        emit(`<DragCoefficient>${nnum(node, 'cd', 0.75)}</DragCoefficient>`);
        emit(`<ShroudLineCount>${Math.round(nnum(node, 'lineCount', 6))}</ShroudLineCount>`);
        emit(`<ShroudLineLen>${nnum(node, 'lineLength', 0.3) * LEN}</ShroudLineLen>`);
        emit('<ChuteCount>1</ChuteCount>');
        emit(`<SpillHoleDia>${nnum(node, 'spillHoleDiameter', 0) * LEN}</SpillHoleDia>`);
        emit('</Parachute>');
        break;
      }
      case 'streamer': {
        emit('<Streamer>');
        common(node, 'Streamer');
        emit(`<Len>${nnum(node, 'stripLength', 0.5) * LEN}</Len>`);
        emit(`<Width>${nnum(node, 'stripWidth', 0.05) * LEN}</Width>`);
        emit(`<DragCoefficient>${nnum(node, 'cd', 0.75)}</DragCoefficient>`);
        emit('</Streamer>');
        break;
      }
      case 'shockcord': {
        emit('<MassObject>');
        common(node, 'Shock cord');
        emit('<TypeCode>1</TypeCode>');
        emit(`<Len>${nnum(node, 'cordLength', 0.3) * LEN}</Len>`);
        emit('</MassObject>');
        break;
      }
      case 'fairing': {
        // RockSim has no external-protuberance component — keep at least the
        // MASS so CG survives the export (aero effect is lost, documented).
        emit('<MassObject>');
        common(node, `${node.name ?? 'Camera shroud'} (mass only)`, {
          knownMass: nnum(node, 'mass', 0.03) * MASS, useKnownCG: true, knownCGIsXb: true,
        });
        emit('<TypeCode>0</TypeCode>');
        emit(`<Len>${nnum(node, 'length', 0.08) * LEN}</Len>`);
        emit('</MassObject>');
        break;
      }
      case 'masscomponent': {
        emit('<MassObject>');
        // KnownMass/UseKnownCG must be emitted ONCE (readers take the first
        // match) — pass the real mass through common() instead of duplicating.
        // An override, when set, IS the component's real mass — passing the
        // `mass` param unconditionally shipped the 10 g default for every
        // override-edited mass component (big CG error in RockSim).
        const massKg = typeof node['overrideMass'] === 'number'
          ? (node['overrideMass'] as number)
          : nnum(node, 'mass', 0);
        common(node, 'Mass', { knownMass: massKg * MASS, useKnownCG: true, knownCGIsXb: true });
        emit('<TypeCode>0</TypeCode>');
        // The file's OWN <Len> where we clamped one on import, so a .rkt round trip
        // returns the value RockSim wrote rather than the body we simulate.
        emit(`<Len>${nnum(node, 'rocksimLen', nnum(node, 'length', 0.02)) * LEN}</Len>`);
        emit('</MassObject>');
        break;
      }
      default:
        // stage handled by the caller; unknown types dropped (like the desktop)
        break;
    }
  };

  emit('<RockSimDocument>');
  emit('<FileVersion>4</FileVersion>');
  emit('<DesignInformation>');
  emit('<RocketDesign>');
  emit(`<Name>${esc(name)}</Name>`);
  emit(`<StageCount>${stagesIn.length}</StageCount>`);
  // Slots are top-down: our stage 0 (sustainer) = Stage3Parts.
  const slots = ['Stage3Parts', 'Stage2Parts', 'Stage1Parts'];
  for (let i = 0; i < 3; i++) {
    emit(`<${slots[i]}>`);
    if (i < stagesIn.length) {
      // `folded` tubes went out inside their cone's <BaseExtensionLen>.
      for (const node of stagesIn[i]!.children ?? []) { if (folded.has(node)) continue; emitPart(node, null); }
    }
    emit(`</${slots[i]}>`);
  }
  // Motors: the desktop exporter omits these; we write EngineSets so RockSim
  // (and our own re-import) sees the loaded motors.
  for (let i = 0; i < stagesIn.length; i++) {
    const stageMotorEntries = Object.entries(motors ?? {}).filter(([id]) =>
      (function inStage(nodes: ComponentNode[]): boolean {
        return nodes.some((n) => n.id === id || inStage(n.children ?? []));
      })(stagesIn[i]!.children ?? []));
    if (stageMotorEntries.length === 0) continue;
    emit(`<Stage${3 - i}Engines>`);
    for (const [id, m] of stageMotorEntries) {
      emit('<EngineSet>');
      emit('<EngineCount>1</EngineCount>');
      emit(`<EngineCode>${esc(m.designation)}</EngineCode>`);
      emit(`<EngineMfg>${esc(m.manufacturer ?? 'unknown')}</EngineMfg>`);
      emit(`<EjectionDelay>${m.delay}</EjectionDelay>`);
      // Staging timer, so a .rkt written here round-trips through our own
      // importer (and through RockSim) with its staging intact. RockSim
      // measures IgnitionDelay from the stage below's BURNOUT, which is exactly
      // what the importer maps to `ignitionEvent: 'burnout'` — so only a
      // burnout-triggered motor has a delay to write. A launch-stage motor, or
      // one on a different ignition event we cannot express in this format,
      // writes 0 (RockSim's own default).
      const rktIgnitionDelay = m.ignitionEvent === 'burnout' ? (m.ignitionDelay ?? 0) : 0;
      emit(`<IgnitionDelay>${rktIgnitionDelay}</IgnitionDelay>`);
      emit(`<MountSerialNo>${nodeSerial.get(id) ?? -1}</MountSerialNo>`);
      emit('</EngineSet>');
    }
    emit(`</Stage${3 - i}Engines>`);
  }
  emit('</RocketDesign>');
  emit('</DesignInformation>');
  emit('</RockSimDocument>');
  return lines.join('\n');
}

