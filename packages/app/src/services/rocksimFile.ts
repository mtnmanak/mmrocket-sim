import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { finOutlineProblem } from '../tree/finOutline.js';
import { asStageNodes, freshId, mountsIn } from '../tree/treeModel.js';
import { mountBore } from '../tree/scaleRocket.js';
import { CLUSTER_POINTS, clusterOffsets } from '../tree/cluster.js';
import { resolveAssemblyRadius } from '../tree/assembly.js';
import { axialLength, drawnExtent, startFromPosition } from '../tree/position.js';
import { sanitizeTree } from '../tree/sanitize.js';
import { finCountOf } from '../tree/counts.js';
import { MAX_FIN_POINTS, MAX_NESTING, TOO_DEEP_NESTING, TOO_MANY_FIN_POINTS, decodeXml, escapeXml as esc, lookupTable, parseDecimal, unreadableFinPoints, xmlNum, xmlText as text } from './xmlUtil.js';
import { unzipMember } from './zipMember.js';
import {
  autoDelaySaveNote, shapeParamDefault, type OrkExportMotor, type OrkFlightConfig, type OrkImportResult, type OrkMotorRef,
} from './orkFile.js';
import { applyPresetLinks, type PendingPresetLink, type Preset } from './presets.js';
import { findDbMotor } from './motorDb.js';
import { defaultDelay } from './thrustcurve.js';

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

/**
 * `xmlNum`'s shape. Every one-number field in an import is read through the
 * SAME recording reader importRkt builds (see its `num`; a <PointList> counts
 * its own unreadable pairs), so the module-level helpers below take it as a
 * parameter rather than calling xmlNum themselves — a field read there is a
 * field the unreadable-number note has to be able to name.
 */
type NumReader = (el: Element, tag: string, fb: number) => number;

/**
 * The outline a FreeformFinSet is born with in the kernel (carved
 * FreeformFinSet.java:30-34: (0,0) (0.025,0.05) (0.075,0.05) (0.05,0), metres)
 * — what a freeform set with no `points` flies. Given explicitly to a set whose
 * file outline is refused, so the fin that flies is the fin on screen.
 */
const KERNEL_DEFAULT_FIN_POINTS: readonly (readonly [number, number])[] = [
  [0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0],
];

const NOSE_SHAPES: Record<string, string> = lookupTable({
  '0': 'conical', '1': 'ogive', '2': 'ellipsoid', '3': 'ellipsoid',
  '4': 'power', '5': 'parabolic', '6': 'haack',
});
const NOSE_SHAPE_TO_CODE: Record<string, number> = lookupTable({
  conical: 0, ogive: 1, ellipsoid: 3, power: 4, parabolic: 5, haack: 6,
});
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
const readShapeParameter = (num: NumReader, el: Element, node: ComponentNode): void => {
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

const CROSS_SECTIONS: Record<string, string> = lookupTable({ '0': 'square', '1': 'rounded', '2': 'airfoil' });
const CROSS_SECTION_TO_CODE: Record<string, number> = lookupTable({ square: 0, rounded: 1, airfoil: 2 });
const FINISH_FROM_CODE: Record<string, string> = lookupTable({
  '0': 'polished', '1': 'smooth', '2': 'normal', '3': 'unfinished',
});
const FINISH_TO_CODE = (finish: unknown): number => {
  switch (finish) {
    case 'polished': case 'finishpolished': return 0;
    case 'smooth': return 1;
    case 'rough': case 'unfinished': return 3;
    default: return 2;
  }
};

// ============================ IMPORT ============================

export function importRkt(data: ArrayBuffer | string, opts?: { presets?: readonly Preset[] }): OrkImportResult {
  let xml: string;
  // Set when the bytes were not valid UTF-8 and named no other encoding (see
  // decodeXml): the first import note, once there are notes.
  let encodingNote: string | undefined;
  if (typeof data === 'string') {
    xml = data;
  } else {
    const bytes = new Uint8Array(data);
    // A zipped .rkt: take the .rkt MEMBER, bounded, the way the .ork importer
    // does. `Object.values(unzipSync(bytes))[0]!` took whatever sorted first in
    // the central directory and inflated every entry to get there — so a .rkt
    // zipped on macOS, where `__MACOSX/._design.rkt` rides alongside, decoded
    // an AppleDouble resource fork as XML and told the user their perfectly
    // good file was a parse error; and an archive with NO entries made that
    // non-null assertion hand `undefined` to strFromU8, surfacing as "Cannot
    // read properties of undefined". See zipMember.ts for the size cap.
    ({ xml, note: encodingNote } = decodeXml(bytes[0] === 0x50 && bytes[1] === 0x4b
      ? unzipMember(bytes, '.rkt', '.rkt')
      : bytes));
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
  // LINEAR, not a global lazy regex (2026-09-08 audit). The pattern
  // `/<!\[CDATA\[([\s\S]*?)\]\]>/g` re-scans to end-of-file once per UNCLOSED
  // opener, which is quadratic: measured 0.1 MB -> 5 ms, 0.5 MB -> 33 ms,
  // 2.0 MB -> 514 ms. A ~200 KB zipped `.rkt` legitimately inflates to the
  // 64 MiB `zipMember` allows, which is ~8 minutes of frozen main thread with
  // no abort and the user's unsaved design behind it — defeating the zip-bomb
  // cap one layer above.
  //
  // Scan opener → first terminator with indexOf, each search starting where
  // the last section ENDED, so every byte is visited once. That is exactly the
  // regex's reading: a section is closed by the first "]]>" after its own
  // opener, and a "<![CDATA[" inside it is just text — legal XML, since only
  // "]]>" ends a section. Splitting on every opener instead (audit 2026-09-22)
  // took that inner opener for a second section, left the real one
  // unterminated, and refused a valid file as "not a valid RockSim file". An
  // opener with no terminator after it is not a section, and neither is
  // anything after it (no later opener can find a "]]>" the first could not),
  // so the rest of the file passes through verbatim, as the regex left it.
  if (xml.includes('<![CDATA[')) {
    const OPEN = '<![CDATA[';
    const CLOSE = ']]>';
    let rebuilt = '';
    let at = 0;
    for (;;) {
      const open = xml.indexOf(OPEN, at);
      if (open < 0) break;
      const close = xml.indexOf(CLOSE, open + OPEN.length);
      if (close < 0) break;
      rebuilt += xml.slice(at, open) + xml.slice(open + OPEN.length, close)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      at = close + CLOSE.length;
    }
    xml = rebuilt + xml.slice(at);
  }
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not a valid RockSim file (XML parse error)');
  }
  const design = doc.querySelector('RockSimDocument > DesignInformation > RocketDesign');
  if (!design) throw new Error('Not a RockSim design file (missing RocketDesign)');

  const notes: string[] = encodingNote ? [encodingNote] : [];
  const ignored = new Set<string>();
  /**
   * Tag → the first raw text under it that is not a number. One entry per tag,
   * not per part, for the reason the RASAero reader gives: a file whose every
   * number is unreadable should get one sentence, not sixty.
   */
  const unreadable = new Map<string, string>();
  /**
   * `xmlNum` with the substitution made VISIBLE (audit 2026-09-22) — the
   * mechanism importCdx1 has had since the 2026-09-08 audit. xmlNum cannot
   * tell "absent" from "present but unreadable": both take the caller's
   * fallback, and this reader's fallbacks are real-looking parts, not
   * sentinels (a 24 mm tube, a 70 mm nose, a 300 mm chute), so `<OD>2,5</OD>`
   * imported a 24 mm tube and every downstream number was wrong with nothing
   * on screen to say so. ABSENT stays silent — RockSim omits fields routinely
   * — and unreadable is named once per tag in the notes at the end.
   */
  const num: NumReader = (el, tag, fb) => {
    // xmlNum's own three steps (xmlText, parseDecimal, the finite test), with
    // the failure recorded — inlined rather than wrapped, so a field costs one
    // selector query, not two: the import is query-bound on a deep tree.
    const raw = text(el, `:scope > ${tag}`);
    if (raw === null) return fb;
    const v = parseDecimal(raw);
    if (Number.isFinite(v)) return v;
    if (!unreadable.has(tag)) unreadable.set(tag, raw.slice(0, 40));
    return fb;
  };
  /** Parts whose <PartMfg>/<PartNo> may name a catalogue row - resolved after the tree is built. */
  const pendingLinks: PendingPresetLink[] = [];
  /** Nodes that kept a measured mass or CG desktop OpenRocket would discard. */
  const keptWithoutCGFlag = new Set<ComponentNode>();
  /** Mass objects pinned onto the point the file states, rather than spread over <Len>. */
  let pinnedMassObjects = 0;
  /** Airfoil fin sets pinned to RockSim's own CalcMass/CalcCG (desktop parity). */
  const airfoilPinned = new Set<ComponentNode>();
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

  // Parts nest at most MAX_NESTING levels below their stage, as in the .ork
  // importer; deeper ones are left out with a note (see MAX_NESTING). Uncapped
  // until the review of audit 2026-09-22: a .rkt 500 levels deep imported
  // whole in 1.2 s and saved as an 8.9 MB .ork, and 1,500 overflowed the
  // stack. `level` is the level convertPart is building at; a sub-assembly
  // flattens into its parent's level, so only real children go one deeper.
  let level = 1;
  let tooDeep = false;
  const oneLevelDown = (hasParts: boolean, convert: () => void): void => {
    if (level >= MAX_NESTING) {
      if (hasParts) tooDeep = true;
      return;
    }
    level++;
    try {
      convert();
    } finally {
      level--;
    }
  };

  const convertAttached = (el: Element, parentNode: ComponentNode) => {
    const wrap = el.querySelector(':scope > AttachedParts');
    if (!wrap) return;
    oneLevelDown(wrap.children.length > 0, () => {
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
    });
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
        readShapeParameter(num, el, n);
        // Written EITHER WAY, not only when solid (audit 2026-09-22): <ConstructionType>
        // is the file saying solid (0) or hollow (1), and a catalogue link
        // (applyPresetLinks) fills only what a file left unset — so a hollow part left
        // unset took the catalogue's `filled: true`, 19.6 g → 107.8 g on a Rocketarium
        // HIPS nose.
        n['filled'] = Math.round(num(el, 'ConstructionType', 1)) === 0;
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
        readShapeParameter(num, el, n);
        // Either way, for the reason on the NoseCone branch above.
        n['filled'] = Math.round(num(el, 'ConstructionType', 1)) === 0;
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
            // refuses as a self-intersection,
            // which aborts the whole build. Same guard as rasaeroFile.ts.
            n['points'] = tipChord > 1e-9
              ? [[0, 0], [sweep, height], [sweep + tipChord, height], [rootChord, 0]]
              : [[0, 0], [sweep, height], [rootChord, 0]];
          }
          const note = 'Fins on a transition were converted to a freeform outline (same '
            + 'planform) — OpenRocket only allows freeform fins on a transition.';
          if (!notes.includes(note)) notes.push(note);
        } else {
          // The same test the fin editor applies before it commits an outline:
          // at least three points, none repeated, no edge crossing another. A
          // crossing outline reaches the kernel's FreeformFinSet, which refuses
          // it, so the design blanks (with "Unknown format conversion: g" until
          // the kernel's %g log line was patched on 2026-09-22; by name since).
          // The v0.105 changelog said the importers already checked this; they
          // did not (only a synthesised zero-tip-chord case was caught). Now they do.
          const parsed = parsePointList(text(el, ':scope > PointList') ?? '');
          if (parsed.unreadable > 0) {
            const note = `Fin set "${n.name ?? 'freeform'}": ${unreadableFinPoints(parsed.unreadable)}`;
            if (!notes.includes(note)) notes.push(note);
          }
          const outlineProblem = parsed.problem ?? finOutlineProblem(parsed.pts);
          if (!outlineProblem) {
            n['points'] = parsed.pts;
          } else {
            // The default outline is WRITTEN, not implied (audit 2026-09-22).
            // Left with no points the node reached the kernel as a
            // FreeformFinSet with its own constructor outline — a 50 mm fin —
            // while the side view, the fin editor and every export drew
            // nothing, so the stability came from a fin the user could neither
            // see nor edit. The same outline, stated, flies the same numbers
            // and makes this note's "keeps a default outline" true on screen.
            n['points'] = KERNEL_DEFAULT_FIN_POINTS.map(([x, y]) => [x, y]);
            const note = `Fin set "${n.name ?? 'freeform'}": its outline was not used — ${outlineProblem} The set keeps a default outline; redraw it in the fin editor.`;
            if (!notes.includes(note)) notes.push(note);
          }
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
        // Desktop pins an AIRFOIL set's mass AND balance point to RockSim's own
        // computed numbers (FinSetHandler.java:299-309, via BaseHandler.setOverride
        // :186-195). RockSim's older dialect ignores the fin cross-section when it
        // weighs a fin while the kernel scales an airfoil's volume by 0.85
        // (FinSet.java:54, applied at :1722), so those sets import exactly 15 %
        // light: Mach2.rkt reads 19.905 g against the file's own 23.417 g. Newer
        // files carrying <UseConstThickness> model the section themselves and go the
        // other way — 2,4-D.rkt's two sets state 138.211 g and 519.951 g where this
        // app computes 277.390 g and 1060.069 g, 679 g of phantom fin mass on one
        // rocket. Either way the file's number is the one RockSim and desktop agree
        // on. Ruled ADOPT by Eric 2026-09-04; 271 sets across 195 of 939 designs.
        //
        // Desktop keys the skip on <UseKnownCG> alone; this keys it on whether
        // readCommon already set EITHER override, which is the same thing in
        // RockSim's own dialect and leaves the 2026-08-23a independent-flag ruling
        // intact. (0 of the 271 affected sets state a mass with the CG flag off.)
        //
        // TWO DELIBERATE DIVERGENCES, both refusals to copy a desktop bug: a
        // CalcMass of 0 is NOT pinned (desktop's field defaults to 0.0d and it
        // silently zeroes the set — 1 of the 271 would hit that), and a CalcCG of 0
        // leaves the CG computed rather than pinning it to the fin root.
        const calcMassG = num(el, 'CalcMass', 0);
        const calcCgMm = num(el, 'CalcCG', 0);
        if (n['crossSection'] === 'airfoil'
          && n['overrideMass'] === undefined && n['overrideCGX'] === undefined
          && calcMassG > 0) {
          n['overrideMass'] = calcMassG / MASS;
          if (calcCgMm > 0) n['overrideCGX'] = calcCgMm / LEN;
          airfoilPinned.add(n);
        }
        return n;
      }
      case 'LaunchLug': {
        const n = mk('launchlug');
        n['length'] = num(el, 'Len', 50) / LEN;
        n['outerRadius'] = num(el, 'OD', 5) / RAD;
        n['thickness'] = tubeThickness(el) || 0.0004;
        // Where the lug sits around the body (RockSim RadialAngle, RADIANS —
        // same convention this file already reads for tube fins and pods).
        // Dropped until v0.103, which is why Level 3 Rocket's two lugs, stored
        // at -1.0472 rad (-60 deg), came in with no angle at all and were flown
        // at the kernel's default of 180 — 120 degrees from where the builder
        // put them, on the one line the rail needs clear. Desktop reads it:
        // rocksim/importt/LaunchLugHandler.java:76-78 calls
        // lug.setAngleOffset(Double.parseDouble(content)) with no conversion.
        // Written unconditionally, zero included: after v0.103 an absent key
        // and an explicit 0 mean the same thing everywhere (drawings, .ork
        // writer, kernel bridge), so there is nothing to protect by skipping it.
        const lugAngle = num(el, 'RadialAngle', NaN);
        if (Number.isFinite(lugAngle)) n['angleOffset'] = lugAngle;
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
        // SHROUD LINES — their own material, in their own pair of tags, and
        // separate from the canopy's <Density>/<DensityType> that
        // readRecoveryMaterial just handled. Dropped until v0.113, so a chute
        // stating its line material was billed the kernel's DEFAULT line
        // density instead: rocksimTestRocket2.rkt's 16 lines × 1.35 m at
        // 0.00032972 are 7.1 g of line, and the default made them ~39 g —
        // +31.8 g of mass that is in no real rocket, on 15 of the 16 chutes in
        // the corpus.
        //
        // DESPITE THE TAG NAME, the value is kg/m, not kg/mm:
        // ROCKSIM_TO_OPENROCKET_LINE_DENSITY = 1 and desktop divides by it
        // (RockSimCommonConstants.java:116, ParachuteHandler.java:100-103).
        // The arithmetic agrees — kg/mm would make those 16 lines 7.1 kg.
        const lineDensity = num(el, 'ShroudLineMassPerMM', 0);
        if (lineDensity > 0) {
          n['lineDensity'] = lineDensity;
          const lineMat = text(el, ':scope > ShroudLineMaterial');
          if (lineMat) n['lineMaterialName'] = lineMat;
        }
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
          // Shock cords keep today's behaviour on the CG: the kernel's 0.025 m
          // default packed length puts theirs at most 12.5 mm off, and changing
          // it drags in the cord-mass question (format audit row 19) that is not
          // this fix.
          delete n['overrideCGX'];
          // THE WEIGHED MASS STAYS. The `delete n['overrideMass']` below used to
          // run for BOTH branches, under a comment claiming the file's
          // <KnownMass> had become the component's real mass — true only of the
          // non-cord branch, which assigns n['mass'] from it. This branch reads
          // no KnownMass at all: it takes a LINE DENSITY, and
          // readRecoveryMaterial returns with NONE when <Density> is 0, or when a
          // DensityType-0 cord states no <Thickness>. So a cord the builder
          // weighed (<UseKnownCG>1</UseKnownCG><KnownMass>25</KnownMass> beside
          // <Density>0</Density>) imported with its 25 g thrown away and nothing
          // in its place — it flew at the kernel's default line density, a real
          // CG shift in the recovery bay of a small model, and the unconditional
          // keptWithoutCGFlag.delete() below meant it was not even named in the
          // "kept without the CG flag" note. A node that no longer carries any
          // kept value still leaves that set.
          if (typeof n['overrideMass'] !== 'number') keptWithoutCGFlag.delete(n);
          return n;
        }
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
        // Its KnownMass became this component's real mass one line above, so the
        // override readCommon set from the SAME element is a duplicate and would
        // count the mass twice. Nothing diverges from desktop here.
        delete n['overrideMass'];
        // overrideCGX is measured from the component's FORE end
        // (MassCalculation.java:463-464). LocationMode 0/1 map to TOP/ABSOLUTE,
        // whose fore end sits on the point, so the pin is 0 — which is exactly
        // what desktop does (MassObjectHandler.java:107). LocationMode 2 maps to
        // BOTTOM, which anchors the AFT end on the point, so the pin is the
        // component's own length. Desktop pins 0 there too and lands a full
        // length forward of the file's own <Station>; we deliberately do not
        // copy that. Measured on Mach 3.rkt, this reproduces all four of its
        // <Station> values (225.425 / 422.275 / 665.48 / 814.705 mm) to 0.01 mm.
        n['overrideCGX'] = n.position?.method === 'bottom' ? (n['length'] as number) : 0;
        pinnedMassObjects += 1;
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
        // inside AttachedParts (desktop handles both) — collect from both, in
        // document order, then convert them ONE LEVEL DOWN: the pod's chain is
        // its children, so it counts against MAX_NESTING like attached parts.
        const chainEls: Element[] = [];
        const CHAIN_TAGS = ['NoseCone', 'BodyTube', 'Transition'];
        for (const sub of Array.from(el.children)) {
          if (CHAIN_TAGS.includes(sub.tagName)) {
            chainEls.push(sub);
          } else if (sub.tagName === 'AttachedParts') {
            for (const sub2 of Array.from(sub.children)) {
              if (CHAIN_TAGS.includes(sub2.tagName)) chainEls.push(sub2);
            }
          }
        }
        const chain: ComponentNode[] = [];
        oneLevelDown(chainEls.length > 0, () => {
          for (const sub of chainEls) {
            const kid = convertPart(sub, null);
            if (kid) chain.push(kid);
          }
        });
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
  // the dropped twins re-point at the kept tube). Tubes that fit no pattern,
  // or carry different motors, stay separate — and every tube that stays on
  // its own keeps its place off the axis (radialPosition / radialDirection,
  // below the reconstruction).
  //
  // THE PATTERN IS FITTED ABOUT THE TUBES' OWN CENTRE, not the rocket's axis
  // (seam review of audit 2026-09-22). Every kernel pattern is centred on the
  // tube's axis, and the kernel then sets the whole cluster off the rocket's
  // by the tube's radialPosition along its radialDirection
  // (InnerTube.getClusterPoints), which the .rkt writer has written since the
  // same audit. Fitted about the rocket's axis, such a cluster matched nothing
  // and came back as N separate tubes: a 3-ring 6 mm off the axis reopened as
  // three mounts carrying one motor between them. The offset found is handed
  // back as the tube's own radialPosition / radialDirection; one under 10 µm is
  // RockSim's rounding of a centred cluster, not a placement, and is dropped.
  const matchCluster = (
    pts: { y: number; z: number }[], tubeR: number,
  ): { pattern: string; scale: number; rotation: number; offset: { y: number; z: number } } | null => {
    const eps = 1e-6;
    const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    const cz = pts.reduce((a, q) => a + q.z, 0) / pts.length;
    const centred = Math.hypot(cy, cz) < 1e-5;
    const offset = centred ? { y: 0, z: 0 } : { y: cy, z: cz };
    const p = pts.map((q) => ({ x: q.y - offset.y, y: q.z - offset.z }));
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
          // The tubes sit at the unit pattern turned by +phi; the kernel turns
          // a pattern by MINUS its clusterRotation (cluster.ts clusterOffsets,
          // audit 2026-09-22), so the rotation that puts them back where the
          // file has them is −phi. +phi matched the old +rotation drawing and
          // round-tripped our own exports, but gave a real RockSim cluster a
          // rotation the kernel and desktop turn the other way.
          const rot = Math.atan2(Math.sin(-phi), Math.cos(-phi)); // normalize (−π, π]
          return { pattern, scale: sep / (2 * tubeR), rotation: rot, offset };
        }
      }
    }
    return null;
  };
  // The file's stored simulations — read here for the tubes' loadouts, and
  // again below, once the tubes are regrouped, for the configurations.
  const simEls = Array.from(doc.querySelectorAll('SimulationResults'));
  /** Per stored simulation, its engine sets and the tube each names, before any regrouping. */
  const simSets = simEls.map((sim) => Array.from(sim.querySelectorAll('EngineSet')).flatMap((el) => {
    const serial = text(el, ':scope > MountSerialNo');
    const node = serial ? serialToNode.get(serial) : undefined;
    return node ? [{ el, node }] : [];
  }));
  /** One engine set as a comparable string: code, maker and both delays, as numbers. */
  const setKey = (el: Element): string => {
    const norm = (tag: string): string => {
      const raw = text(el, `:scope > ${tag}`) ?? '';
      const v = parseDecimal(raw);
      return Number.isFinite(v) ? String(v) : raw.trim().toLowerCase();
    };
    return [text(el, ':scope > EngineCode') ?? '', text(el, ':scope > EngineMfg') ?? '',
      norm('EjectionDelay'), norm('IgnitionDelay')].join('|');
  };
  /**
   * Engine sets moved off the tube their MountSerialNo names, onto an
   * identical sibling — the repair in `groupLoadouts` — for readEngineSet.
   */
  const movedSets = new Map<Element, ComponentNode>();
  /**
   * How every simulation loads a group of identical tubes, and whether any two
   * of them differ. Tubes are merged into one cluster only when EVERY
   * simulation loads them alike.
   *
   * IDENTICAL TUBES ARE NOT IDENTICAL MOUNTS (seam review of audit 2026-09-22).
   * The regrouping looked at size and place alone, and the merged tube then
   * took ONE engine set per simulation, the last: 8 in Goblin 4 x 75mm.rkt's
   * simulation 90 (M2050X on two tubes, L1170FJ on the other two) opened as
   * L1170FJ × 4; Cluster Duck.rkt's alternating C6 and C6Q as C6Q × 6. Engine
   * sets outside any simulation — this app's own export before that audit,
   * which wrote one set for a whole cluster — are left out of the test, so
   * those files still merge.
   *
   * A tube holds one motor, so a simulation that names ONE tube in two of its
   * engine sets has a stale serial — 65 simulations in 13 corpus files, most
   * of them Public Missiles', do (EclipseB_38mmRedlineEllis.rkt: H148R at 30 s
   * and at 0 s, both on serial 22, with its twin tube carrying none). Within
   * a group the extra sets go, in file order, to the group's tubes that carry
   * none in that simulation: merged, the pair used to fly as two of the last;
   * apart, un-repaired, it would fly one.
   */
  const groupLoadouts = (g: ComponentNode[]): { differ: boolean; moves: Map<Element, ComponentNode> } => {
    const moves = new Map<Element, ComponentNode>();
    let differ = false;
    for (const sets of simSets) {
      const on = new Map<ComponentNode, Element[]>(g.map((t) => [t, []]));
      for (const { el, node } of sets) on.get(node)?.push(el);
      const empty = g.filter((t) => on.get(t)!.length === 0);
      for (const t of g) {
        const list = on.get(t)!;
        while (list.length > 1 && empty.length > 0) {
          const el = list.splice(1, 1)[0]!;
          const to = empty.shift()!;
          on.get(to)!.push(el);
          moves.set(el, to);
        }
      }
      if (new Set(g.map((t) => on.get(t)!.map(setKey).sort().join('\n'))).size > 1) differ = true;
    }
    return { differ, moves };
  };
  /** The kept tube of each merged cluster: its own RadialLoc is one copy's, not the cluster's place. */
  const mergedKeep = new Set<ComponentNode>();
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
        const where = parentNode.name ?? parentNode.type;
        // "Motor tubes" only when they are: LEM-M2B.ork's two nose-cone tubes,
        // written out and read back, were called that with no mount among them.
        const kind = g.some((t) => t['motorMount'] === true) ? 'motor tubes' : 'tubes';
        const loads = groupLoadouts(g);
        if (loads.differ) {
          for (const [el, to] of loads.moves) movedSets.set(el, to);
          notes.push(`${g.length} identical ${kind} in “${where}” carry different motors in the file's simulations, `
            + 'so each stays a mount of its own, where the file puts it — merged into one cluster, a '
            + 'simulation would fly one of those motors in every tube.');
          continue;
        }
        // ONE TUBE'S MASS IS NOT THE CLUSTER'S (review of the seam fixes). A
        // RockSim <KnownMass> is its own tube's — desktop, which reads a
        // cluster as N separate tubes, counts every one, as RockSim does — but
        // the kernel's override on a cluster tube is the WHOLE cluster's
        // (MassCalculation.calculateStructure weighs it at getOverrideMass(),
        // where a computed mass is multiplied by the instance count). The kept
        // tube took one copy's, so every merged cluster the file weighs flew
        // (N − 1) tubes light — the owner's 12in Darkstar six 892 g tubes as
        // one, 4.46 kg — and once tubes that carry different motors stayed
        // apart, 8 in Goblin 4 x 75mm.rkt weighed 1,325 g more or less by how
        // its simulations loaded them. A merged cluster carries the tubes'
        // masses added together; tubes the file weighs differently — one
        // weighed and another computed, or balanced at different points — have
        // no single cluster mass or balance point, and stay apart, each with
        // its own. (0 of the 20 weighed ring groups in the corpus do.)
        const weighedTubes = g.filter((t) => typeof t['overrideMass'] === 'number');
        const balance = new Set(g.map((t) => (typeof t['overrideCGX'] === 'number'
          ? Math.round((t['overrideCGX'] as number) * 1e4) : null))); // to 0.1 mm
        if ((weighedTubes.length > 0 && weighedTubes.length < g.length) || balance.size > 1) {
          for (const [el, to] of loads.moves) movedSets.set(el, to);
          notes.push(`${g.length} identical ${kind} in “${where}” are weighed differently in the file, so each `
            + 'stays a part of its own, where the file puts it — a cluster carries one mass and one balance '
            + 'point for all its tubes.');
          continue;
        }
        const tubeR = typeof g[0]!['outerRadius'] === 'number' ? (g[0]!['outerRadius'] as number) : 0.0095;
        const m = matchCluster(g.map((t) => radialByNode.get(t) ?? { y: 0, z: 0 }), tubeR);
        if (!m) {
          for (const [el, to] of loads.moves) movedSets.set(el, to);
          notes.push(`${g.length} identical off-axis ${kind} in “${where}” don't fit a known cluster pattern — imported as separate tubes, each where the file puts it.`);
          continue;
        }
        // Keep the tube that carries children (our own exports put them on the
        // first copy); default to the first.
        const keep = g.find((t) => (t.children ?? []).length > 0) ?? g[0]!;
        keep['cluster'] = m.pattern;
        keep['clusterScale'] = Number(m.scale.toFixed(4));
        let rotation = m.rotation;
        const off = Math.hypot(m.offset.y, m.offset.z);
        if (off > 0) {
          const dir = Math.atan2(m.offset.z, m.offset.y);
          keep['radialPosition'] = off;
          keep['radialDirection'] = dir;
          // The kernel turns the pattern by radialDirection − clusterRotation
          // (cluster.ts clusterOffsets), so the tube's own direction goes into
          // the rotation too, leaving each tube where the file has it.
          rotation = Math.atan2(Math.sin(rotation + dir), Math.cos(rotation + dir));
        }
        if (Math.abs(rotation) > 1e-4) keep['clusterRotation'] = rotation;
        keep.name = keep.name?.replace(/ \(\d+\)$/, '');
        // Summed in grams, as the file states them, so 4 × 441.75 reads "1767".
        const clusterG = weighedTubes.length > 0
          ? Number(g.reduce((a, t) => a + (t['overrideMass'] as number) * MASS, 0).toFixed(6)) : null;
        if (clusterG !== null) keep['overrideMass'] = clusterG / MASS;
        mergedKeep.add(keep);
        const dropped = new Set(g.filter((t) => t !== keep));
        for (const [serial, node] of serialToNode) {
          if (dropped.has(node)) serialToNode.set(serial, keep);
        }
        parentNode.children = (parentNode.children ?? []).filter((k) => !dropped.has(k));
        notes.push(`Cluster: ${g.length} identical ${kind} in “${where}” imported as one ${m.pattern} cluster`
          + `${off > 0 ? `, ${(off * LEN).toFixed(1)} mm off the centerline` : ''}.`
          + (clusterG !== null ? ` Its mass is the ${g.length} tube masses the file states, added together: ${clusterG} g.` : ''));
      }
      reconstructClusters(parentNode.children ?? []);
    }
  };
  reconstructClusters(components);
  // A TUBE ON ITS OWN OFF THE AXIS STAYS THERE (seam review of audit
  // 2026-09-22). The schema has carried an inner tube's radialPosition and
  // radialDirection all along (the Design tab's "Distance off centerline"),
  // and the .rkt writer has written them since that audit, but this reader put
  // every such tube back on the axis — a 12 mm / 50° tube reopened at 0 / 0
  // with no note. RockSim's RadialLoc is millimetres from the axis and its
  // RadialAngle the direction, in radians: the pair the kernel takes.
  for (const [node, c] of radialByNode) {
    if (mergedKeep.has(node)) continue;
    node['radialPosition'] = Math.hypot(c.y, c.z);
    node['radialDirection'] = Math.atan2(c.z, c.y);
  }

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
        // Start from the kernel's length, end from the drawn outline — the
        // same pair finAlign.ts uses, so an overhanging freeform tip still
        // counts as overlap while the station stays where the kernel puts it.
        const range = (k: ComponentNode): [number, number] => {
          const start = startFromPosition(
            (k.position ?? { method: 'top', offset: 0 }) as ComponentPosition, axialLength(k), pLen);
          return [start, start + drawnExtent(k)];
        };
        const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
        const rotOf = (k: ComponentNode) => (typeof k['rotation'] === 'number' ? (k['rotation'] as number) : 0);
        for (let i = 1; i < finSets.length; i++) {
          const me = finSets[i]!;
          const clash = finSets.slice(0, i).find((other) =>
            Math.abs(rotOf(other) - rotOf(me)) < 1e-6 && overlaps(range(other), range(me)));
          if (clash) {
            // The count that is DRAWN AND FLOWN (finCountOf, 1..8): this pass
            // runs before sanitizeTree clamps the stored one, and the raw count
            // turned a set beside a 12-tube TubeCount 15° where the 8 tubes
            // that fly need 22.5° (seam review of audit 2026-09-22; finAlign.ts
            // made the same change for the one-click pass).
            const count = finCountOf(clash);
            me['rotation'] = rotOf(me) + Math.PI / count;
            notes.push(`“${me.name ?? me.type}” sat at the same angle as “${clash.name ?? clash.type}” — rotated ${Math.round(180 / count)}° to interleave (fine-tune via the set's Rotation field).`);
          }
        }
      }
      deCollideFins(kids);
    }
  };
  deCollideFins(components);
  const appliedDeploy = readDeploymentEvents(doc, serialToNode, notes, num);
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
  if (tooDeep) notes.push(TOO_DEEP_NESTING);
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
  if (airfoilPinned.size) {
    const n = airfoilPinned.size;
    notes.push(`${n} airfoil fin set${n === 1 ? '' : 's'} took the mass and balance point RockSim `
      + `recorded for ${n === 1 ? 'it' : 'them'}. RockSim and OpenRocket weigh an airfoil fin `
      + "differently — on some files they disagree by a factor of two — so the file's own number "
      + 'is used, which is what desktop OpenRocket does. It sits in Override mass and Override CG '
      + "on each set; clear those to go back to the app's own calculation, which then follows any "
      + 'change you make to the fins.');
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
  /** Refs whose <EjectionDelay> was a RockSim sentinel, for the import note below. */
  const sentinelRefs = new Map<OrkMotorRef, 'plugged' | 'every' | 'every-auto' | 'every-unmatched'>();
  /** Stage index (0 = sustainer) of each mount, for the launch keying below. */
  const stageOfMount = new Map<string, number>();
  components.forEach((s, i) => {
    for (const m of mountsIn(s.children ?? [])) if (m.id) stageOfMount.set(m.id, i);
  });
  /** One <EngineSet> as a motor reference on its mount, or null when it names none. */
  const readEngineSet = (engineSet: Element): OrkMotorRef | null => {
    const code = text(engineSet, ':scope > EngineCode');
    if (!code) return null;
    const mountSerial = text(engineSet, ':scope > MountSerialNo');
    // A set the regrouping moved off a tube that already carried one (see
    // groupLoadouts) goes to the twin it was given.
    let mount = movedSets.get(engineSet) ?? (mountSerial ? serialToNode.get(mountSerial) : undefined);
    if (!mount || mount['motorMount'] !== true) {
      // Stale serial: Stage3Engines→stage 0, Stage2Engines→1, Stage1Engines→2.
      const slotMatch = engineSet.parentElement?.tagName.match(/^Stage(\d)Engines$/);
      const stageIdx = slotMatch ? 3 - Number(slotMatch[1]) : 0;
      mount = mountsIn(components[stageIdx]?.children ?? [])[0];
    }
    if (!mount?.id) return null;
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
    // untouched, UNLESS it states a delay: nothing burns below the bottom stage,
    // so RockSim counts that delay from launch — an air start (seam review of
    // audit 2026-09-22). It was dropped, so every such motor lit at liftoff,
    // although this app's own writer has written it since the same audit.
    // RockSim's stored results say so. In PELTZER - LOC Bruiser EXP
    // v2_1x54mm_6x29mm.rkt (one stage) simulations 5 and 6 differ only in the
    // H13ST cluster's IgnitionDelay, 1 s against 0, and their TimeToBurnout by
    // exactly 1.0000 s (16.4325 / 15.4325); simulation 2 burns six H115DM out
    // at 1.69375 s, and simulation 3, the same six at 2 s under an I599N, at
    // 3.69375 s — 2 s later, to the digit.
    const ignitionDelay = num(engineSet, 'IgnitionDelay', 0);
    const isBottomStage = components.length <= 1
      || mountsIn(components[components.length - 1]?.children ?? []).some((m) => m.id === mount!.id);
    const manufacturer = text(engineSet, ':scope > EngineMfg') ?? 'unknown';
    // RockSim's two negative <EjectionDelay> codes are sentinels, not delays —
    // see rktEjectionDelay. Resolved here, so no negative delay leaves the reader.
    const read = rktEjectionDelay(engineSet, num);
    const every = read === 'every' ? rktEveryDelay(code, manufacturer) : null;
    const ref: OrkMotorRef = {
      designation: code,
      manufacturer,
      diameter: 0, // unknown in the file — match by designation alone
      length: 0,
      // A motor the catalogue does not know has no list to take a delay from,
      // so it is kept PLUGGED: a .ork Save writes "none", which reopens with the
      // plugged warning, where the 0 s it held until the review of the seam
      // fixes (2026-09-22) reopened as an ordinary delay and would fire at
      // burnout the day the motor became loadable. The flag gives a .rkt its −1.
      delay: read === 'plugged' ? Infinity : read === 'every' ? (every?.delay ?? Infinity) : read,
      mountId: mount.id,
      ...(!isBottomStage ? { ignitionEvent: 'burnout' as const, ignitionDelay }
        : ignitionDelay > 0 ? { ignitionEvent: 'launch' as const, ignitionDelay } : {}),
      ...(every?.autoDelay ? { autoDelay: true as const } : {}),
      ...(read === 'every' ? { rktEveryDelay: true as const } : {}),
    };
    if (read === 'plugged') sentinelRefs.set(ref, 'plugged');
    else if (read === 'every') {
      sentinelRefs.set(ref, every === null ? 'every-unmatched' : every.autoDelay ? 'every-auto' : 'every');
    }
    return ref;
  };

  /*
   * ONE CONFIGURATION PER STORED SIMULATION (audit 2026-09-22), the way
   * importCdx1 reads a .CDX1's <Simulation>s. A .rkt keeps its motors inside
   * each <SimulationResults>, and a file's simulations disagree: 581 of the 600
   * corpus files with more than one engine-bearing simulation name different
   * motors in at least two. Every <EngineSet> in the file used to go into ONE
   * map, the last simulation to name a mount winning, so Estes/Loadstar.rkt (11
   * simulations) opened as a B6 booster under a B4 sustainer — a pairing none
   * of its simulations flies — and nothing said which simulation was used.
   *
   * Three departures from importCdx1, all for RockSim's shape. Simulations
   * with the SAME motor set fold into one configuration (RockSim files repeat
   * a simulation freely — Loadstar's [B6-6] six times, and one corpus file has
   * 186 engine-bearing simulations), keeping the first one's number and name.
   * Engine sets outside any <SimulationResults> — where this app's own .rkt
   * export wrote them until the same audit — read as one more set, first. And
   * a stage lit at launch over an unpowered one keeps its IgnitionDelay (below).
   */
  const simGroups: { number: number | null; name: string | null; sets: Element[] }[] = [];
  const loose = Array.from(doc.querySelectorAll('EngineSet')).filter((e) => !e.closest('SimulationResults'));
  if (loose.length) simGroups.push({ number: null, name: null, sets: loose });
  simEls.forEach((s, i) => {
    const sets = Array.from(s.querySelectorAll('EngineSet'));
    if (sets.length) {
      simGroups.push({ number: i + 1, name: text(s, ':scope > SimulationName'), sets });
    }
  });
  const configs: OrkFlightConfig[] = [];
  /** Per configuration: the simulation it came from (file order, 1-based; null = outside any). */
  const cfgSim = new Map<OrkFlightConfig, { number: number | null; name: string | null }>();
  const seenSets = new Map<string, OrkFlightConfig>();
  let engineSims = 0;
  for (const g of simGroups) {
    const cfgMotors: Record<string, OrkMotorRef> = {};
    for (const es of g.sets) {
      const ref = readEngineSet(es);
      if (ref?.mountId) cfgMotors[ref.mountId] = ref;
    }
    const entries = Object.entries(cfgMotors);
    if (entries.length === 0) continue;
    engineSims++;
    const stageOf = (mountId: string): number => stageOfMount.get(mountId) ?? 0;
    // Which motor lights at launch — importCdx1's rule. Keyed per mount on the
    // TREE's bottom stage above, a simulation that motors only the sustainer
    // of a two-stage file (Loadstar's [B6-6]) left it on 'burnout' of a
    // booster that never burns, and the kernel aborted "no motors ignited".
    // Its lowest motorized stage lights at launch instead, and each motor's
    // IgnitionDelay is KEPT, counted from launch: with no motor below it, that
    // is what RockSim flies. Its own stored result says so for the one corpus
    // simulation in this shape with a delay (audit 2026-09-22 review):
    // Scratch Builds/Blackhawk_2-stage.rkt, an empty booster slot under two
    // O5500X, one with IgnitionDelay 15 — TimeToBurnout 18.9975 s, i.e. lit
    // 15 s after launch plus its ~4 s burn. Zeroing it lit both at liftoff.
    // (importCdx1 zeroes it, rightly for RASAero, which ignores the delay when
    // the stage below never flies.)
    const lowest = Math.max(...entries.map(([id]) => stageOf(id)));
    if (lowest !== components.length - 1) {
      for (const [id, r] of entries) {
        if (stageOf(id) === lowest) r.ignitionEvent = 'launch';
      }
    }
    // The two "every delay" flags are part of the set: an Auto load flies 0 s
    // first and a kept unmatched −1 is plugged, so without them a simulation on
    // an explicit 0 s, or on RockSim's −2, would fold into one that is not.
    const key = entries.map(([id, r]) => [id, r.designation, r.manufacturer, r.delay,
      r.ignitionEvent ?? '', r.ignitionDelay ?? '', r.autoDelay ? 'auto' : '',
      r.rktEveryDelay ? 'every' : ''].join('|')).sort().join('\n');
    if (seenSets.has(key)) continue;
    const name = g.name?.trim() || null;
    const cfg: OrkFlightConfig = {
      id: g.number === null ? 'rocksim-design' : `rocksim-sim-${g.number}`,
      // RockSim names a simulation the user never named after its motors,
      // "[A8-0] [A8-5] ", and that would go stale here the moment a motor is
      // changed. Such a name is not kept, so configLabel names the
      // configuration from its motors, live, as desktop does an unnamed one;
      // the note below still quotes it. A name typed in RockSim is kept.
      name: name && !/^(\[[^\]]*\]\s*)+$/.test(name) ? name : null,
      isDefault: configs.length === 0,
      motors: cfgMotors, deployments: {}, separations: {},
    };
    seenSets.set(key, cfg);
    cfgSim.set(cfg, { number: g.number, name });
    configs.push(cfg);
  }
  // Which configuration to open: the first that puts a motor on the launch
  // stage, which is the one that has to light first — importCdx1's choice.
  // The reader cannot see the motor catalogue, so this is a first pick:
  // importApply.planImport opens another when this one's motors cannot load
  // and another's can (seam review of audit 2026-09-22 — 31 real designs,
  // seven of them the owner's, opened on a simulation that could not fly).
  const bottomIdx = components.length - 1;
  const motorsBottom = (c: OrkFlightConfig): boolean =>
    Object.keys(c.motors).some((id) => stageOfMount.get(id) === bottomIdx);
  const flyable = configs.find(motorsBottom);
  const chosen = flyable ?? configs[0];
  const simLabel = (c: OrkFlightConfig): string => {
    const s = cfgSim.get(c)!;
    const quoted = s.name ? ` (“${s.name}”)` : '';
    return s.number === null ? `The motors listed outside the file's simulations${quoted}` : `Simulation ${s.number}${quoted}`;
  };
  const bottomName = components[bottomIdx]?.name ?? 'the bottom stage';
  /**
   * The sentence saying which simulation was opened, as it reads when `c` is
   * the one. For the reader's own pick it is exactly the three cases this
   * wrote before planImport could re-pick; the fourth (`c` motors no bottom
   * stage while another simulation does) is reachable only through that re-pick.
   *
   * AND ONLY WHEN NOTHING THAT MOTORS THE BOTTOM STAGE FLIES (review of the
   * seam fixes). importApply's flyablePick prefers a configuration that motors
   * the bottom stage whenever one can leave the pad, so it lands on one that
   * does not only when every one that does has no loadable motor there. This
   * sentence used to end "switch under Flight configurations to fly one that
   * motors it" — to the configurations just passed over because they cannot
   * fly. It gives the same way out the no-booster case below does instead.
   */
  const openedNoteFor = (c: OrkFlightConfig): string | null => {
    if (components.length > 1 && !motorsBottom(c)) {
      return flyable
        ? `${simLabel(c)} puts no motor on ${bottomName}, and no simulation in this file that motors `
          + `${bottomName} has a motor there the app can load. It was opened with its lowest stage's motors `
          + `timed from launch, so ${bottomName} flies along unpowered. Delete that stage in the Design tab to `
          + 'fly without it, or select its mount there and pick a motor.'
        : `No simulation in this file puts a motor on ${bottomName}. ${simLabel(c)} was opened `
          + `with its lowest stage's motors timed from launch, so ${bottomName} flies along unpowered. Delete that `
          + 'stage in the Design tab to fly without it, or select its mount there and pick a motor.';
    }
    if (configs[0] && !motorsBottom(configs[0]) && c !== configs[0]) {
      return `${simLabel(configs[0])} in this file puts no motor on the launch stage, so it would not `
        + `leave the pad. ${simLabel(c)} was opened instead — switch under Flight configurations.`;
    }
    if (configs.length > 1) {
      return `This file stores ${engineSims} RockSim simulations with motors, in ${configs.length} `
        + `different motor sets; each set is a flight configuration here. ${simLabel(c)} was opened `
        + '— switch under Flight configurations.';
    }
    return null;
  };
  // RECOVERY IS NOT READ PER SIMULATION (audit 2026-09-22 review). Each
  // <SimulationResults> keeps its own event list as well as its motors, and
  // only the motors become the configuration: recovery is readDeploymentEvents'
  // — the file's first list, the design's own in 662 of the 685 corpus files
  // that carry one — in every configuration. When the simulation opened stored
  // something else, say so, rather than let "Simulation N was opened" imply its
  // recovery came too: AeroTech/aerotech_warthog.rkt's simulation 1 (E15-4)
  // deploys at the ejection charge where the design says 122 m. Read with
  // plain xmlNum: these numbers are compared, never used.
  const recoveryNoteFor = (c: OrkFlightConfig): string | null => {
    const simNumber = cfgSim.get(c)?.number;
    if (simNumber == null) return null;
    const own = new Map<string, string>();
    for (const ev of Array.from(simEls[simNumber - 1]!.querySelectorAll('SimulationEvent'))) {
      const serial = text(ev, ':scope > PartSerialNo');
      if (!serial || serial === '0' || own.has(serial)) continue;
      const node = serialToNode.get(serial);
      if (!node || (node.type !== 'parachute' && node.type !== 'streamer')) continue;
      const t = rktTrigger(ev, xmlNum);
      if (t === null || typeof t === 'number') continue;
      const a = appliedDeploy.get(serial);
      own.set(serial, a && a.deployEvent === t.deployEvent && a.deployDelay === t.deployDelay
        && a.deployAltitude === t.deployAltitude ? '' : `${node.name ?? node.type} ${t.says}`);
    }
    const differ = [...own.values()].filter(Boolean);
    return differ.length
      ? `${simLabel(c)} stored different recovery triggers from the ones read above: `
        + `${differ.join('; ')}. Recovery is not read per simulation, so every flight configuration here `
        + 'flies the ones read above — change a device’s deployment to fly the simulation’s.'
      : null;
  };
  const motors: Record<string, OrkMotorRef> = { ...(chosen?.motors ?? {}) };
  const firstMotor: OrkMotorRef | undefined = Object.values(motors)[0];
  const chosenConfigId = chosen?.id ?? null;

  // One note per motor that IS loaded — the opened configuration's, however
  // many stored simulations repeat its engine sets — and one per motor and
  // meaning, however many mounts carry it: a cluster built as separate mounts
  // carries one set each, and PELTZER_Swarm_JR.rkt's twelve E30 mounts gave
  // twelve identical lines (seam review of audit 2026-09-22).
  const sentinelNotesFor = (c: OrkFlightConfig): string[] => {
    const out: string[] = [];
    const sentinelNotes = new Map<string, { ref: OrkMotorRef; mounts: number }>();
    for (const ref of Object.values(c.motors)) {
      const kind = sentinelRefs.get(ref);
      if (!kind) continue;
      const key = `${kind}|${ref.manufacturer}|${ref.designation}|${ref.delay}`;
      const seen = sentinelNotes.get(key);
      if (seen) seen.mounts++;
      else sentinelNotes.set(key, { ref, mounts: 1 });
    }
    for (const { ref, mounts } of sentinelNotes.values()) {
      const kind = sentinelRefs.get(ref);
      const motor = `Motor ${ref.designation}${mounts > 1 ? ` (${mounts} mounts)` : ''}`;
      const asks = `${motor}: the file asks for RockSim's “every delay” run (EjectionDelay −1), `;
      if (kind === 'plugged') {
        out.push(`${motor}: plugged (no ejection charge — RockSim's EjectionDelay −2) — `
          + 'make sure recovery deploys on apogee/altitude, not the ejection charge.');
      } else if (kind === 'every') {
        // What the REFERENCE takes, never "loaded": 80 catalogue motors have no
        // thrust curve anywhere, and for those the matcher loads nothing and says
        // so right after this note. The reader cannot tell them apart — the
        // curves are a lazy bundle (review of the seam fixes, 2026-09-22).
        //
        // NOT "the one RockSim's own run reports", which it said until audit
        // 2026-09-23: RockSim flies the delays in ITS motor list and this takes
        // the catalogue's. NukeProMax.RKT's H128W run flies 6, 10 and 14 s and
        // ejects at 15.5 s; thrustcurve.org lists 4, 6, 8 and 10, so this takes 10.
        out.push(`${asks}which flies each listed delay in turn; `
          + (Number.isFinite(ref.delay)
            ? `this takes ${ref.delay} s, the motor browser’s own default for it: the longest delay the `
              + 'motor database lists. RockSim flies the delays in its own list, which can differ, so '
              + 'the delay its run reports may be another.'
            : 'the only option the motor database lists is plugged, so it is taken plugged.'));
      } else if (kind === 'every-auto') {
        out.push(`${asks}which flies each listed delay in turn; the motor database lists no numeric delay `
          + 'for it, so it is set to Auto (optimal), the motor browser’s own default for it.'
          // Auto re-flies the PRIMARY mount only (flightRunner.flyLaunch), as for
          // a browser pick, so the rest of a cluster built as separate mounts
          // flies the provisional 0 s: the Cheetah probe with its G135R mount
          // cloned twice deployed at burnout, 1.05 s (review of the seam fixes).
          // Worded for any of them, since the primary may sit in another stage.
          + (mounts > 1
            ? ` Auto re-flies the rocket's primary mount only: any of these ${mounts} that is not it flies the`
              + ' provisional 0 s, so its charge fires at burnout — give those a delay of their own.'
            : ''));
      } else if (kind === 'every-unmatched') {
        // Not "the database lists no delay": the motor matched nothing in it, so
        // nothing loads on the mount and there is no delay box to send the user
        // to. The reference is kept for Save, plugged, with the flag for a
        // .rkt's −1. "Matched nothing", not "isn't in" (review of audit
        // 2026-09-23): the matcher cannot tell a motor the catalogue lacks from
        // one it has under a name the file does not use.
        out.push(`${asks}which takes its delays from the motor's own list — and this motor matched nothing in `
          + 'the motor database, so there is no list to take one from. The reference is kept: a .rkt '
          + 'Save hands RockSim its −1 back, and a .ork, which has no “every delay”, gets it plugged.');
      }
    }
    return out;
  };
  // Every configuration's own notes, the opened one's in `notes` — in the
  // order they always came: which simulation, its recovery, its sentinels.
  const configNotes: Record<string, string[]> = {};
  const configSources: Record<string, string> = {};
  for (const c of configs) {
    configNotes[c.id] = [openedNoteFor(c), recoveryNoteFor(c), ...sentinelNotesFor(c)]
      .filter((n): n is string => n !== null);
    configSources[c.id] = simLabel(c);
  }
  if (chosen) notes.push(...configNotes[chosen.id]!);

  // Last, because the engine-set and deployment readers above record into the
  // same map. No cause is claimed: none of the 843 readable corpus files carries
  // a non-decimal number, so there is no evidence of what writes one.
  if (unreadable.size > 0) {
    notes.push(`Could not read ${unreadable.size} number${unreadable.size === 1 ? '' : 's'} in this file, `
      + 'so the import used its own default instead — check these before trusting any result: '
      + `${[...unreadable].map(([tag, raw]) => `<${tag}> “${raw}”`).join(', ')}. `
      + 'A number here must be a plain decimal with a period (2.5, not 2,5).');
  }

  return {
    name,
    // The limits table (audit 2026-09-22), applied where its notes still reach
    // the import banner: a <FinCount> of 70000 made the side view throw and took
    // the whole app down, a <TubeCount> of 100000 held the 3D view for 19 s, and
    // a <ShroudLineCount> of 1000000 made a 540 kg parachute. Each repair is
    // named in one note.
    tree: sanitizeTree({ name, components }, notes),
    motor: firstMotor,
    motors,
    ignored: [...ignored],
    notes,
    ...(measured ? { measured } : {}),
    configs,
    chosenConfigId,
    configSources,
    configNotes,
  };
}

/**
 * RockSim's plugged sentinel for <EjectionDelay> — what RockSim itself writes,
 * and what the exporter below writes for a plugged motor.
 */
const RKT_PLUGGED_DELAY = -2;
/** RockSim's "every delay" sentinel — see rktEjectionDelay. */
const RKT_EVERY_DELAY = -1;

/**
 * An engine set's <EjectionDelay>: a delay in seconds, or one of RockSim's two
 * SENTINELS (audit 2026-09-22), which until then were passed through as delays.
 *
 * Neither is documented; both are pinned from the 939-file corpus
 * (G:/Documents/Dropbox/Rocksim Designs) by the NAME RockSim gives the stored
 * simulation that carries each:
 *   −2 → "[A8-P]", "[A8-None]", "[A8-Plugged]": no ejection charge. 3,250 sets.
 *   −1 → "[H128W-*]": RockSim's multi-delay run, which flies EVERY listed delay
 *        (<MultiDelayCount>3, <DelayTime>6.,10.,14.) and reports the longest as
 *        its <TimeToEject>. 1,113 sets.
 * As delays, both scheduled the charge before burnout, so the kernel fired it AT
 * burnout: 159 of the 939 files load a motor with one, 64 of them with a
 * recovery device on the ejection charge (Apogee_Avion/Avion.rkt,
 * Wildman/darkstar4.rkt), and the reference C6 rocket's apogee fell from 331.8
 * to 168.1 m. Any other negative is read as plugged too: a delay cannot be one.
 *
 * The literal "Infinity" is plugged as well. This app's own .rkt export wrote
 * it for a plugged motor through v0.137, and Number() of it is not finite, so
 * xmlNum read it back as 0 s — every chute on ejection then deployed at burnout.
 */
function rktEjectionDelay(engineSet: Element, num: NumReader): number | 'plugged' | 'every' {
  const raw = text(engineSet, ':scope > EjectionDelay');
  if (raw !== null && /^\+?inf/i.test(raw)) return 'plugged';
  const v = num(engineSet, 'EjectionDelay', 0);
  if (Math.round(v) === -1) return 'every';
  return v < 0 ? 'plugged' : v;
}

/**
 * What RockSim's "every delay" (−1) loads as: the motor browser's default pick
 * for the catalogue motor, so an imported motor starts where a picked one
 * would. That is its longest prescribed delay in the CATALOGUE, which need not
 * be the delay RockSim's own multi-delay run reports: that run flies the list
 * in RockSim's motor data (an H128W: 6, 10 and 14 s there, 4–10 s at
 * thrustcurve.org, so RockSim reports 14 and this takes 10). For a motor that
 * lists NO numeric delay
 * (KBA's letter-coded "M" / "S,M,L" since the row-363 fix), it is "Auto (optimal)":
 * the flag, plus the browser's provisional first flight. `defaultDelay` is null
 * only when `delayOptions` is empty, so that flight — the browser's
 * `finite[finite.length - 1] ?? 0` — is 0 s; App then re-flies at the optimum.
 * This read recorded 0 s as the DELAY until the seam review of audit
 * 2026-09-22, so the charge fired at burnout (the Cheetah with a G135R
 * deployed at 250.9 m/s, against 0.87 m/s on Auto).
 *
 * Matched the way motorMatch will match the same reference (designation and
 * maker, no diameter: a .rkt carries none). null when the catalogue has no
 * such motor, which the reader keeps plugged. Exported for the test that pins
 * it to the browser.
 */
export function rktEveryDelay(
  designation: string, manufacturer: string,
): { delay: number; autoDelay?: true } | null {
  const m = findDbMotor(designation, undefined, undefined, manufacturer);
  if (!m) return null;
  const dflt = defaultDelay(m);
  return dflt !== null ? { delay: dflt } : { delay: 0, autoDelay: true };
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
 * file's FIRST `<simulation>`. In practice the first list is usually the
 * design's own, under <RocketDesign> ahead of every simulation's — 662 of the
 * 685 corpus files that carry one (audit 2026-09-22 review) — and it applies
 * in every flight configuration; importRkt says when the one opened differs.
 *
 * NOT READ, deliberately: `TestType` / `TestCondition` / `TestValue*`, RockSim
 * Pro's multi-condition elaboration. `Type` + `DeployAltitude` + `DeplyTime` is
 * the simple pair every file agrees with; the Pro triplet has no analogue in our
 * one-trigger model, and inventing one would be a guess.
 *
 * Returns what it applied, per part serial, so the caller can compare the
 * opened simulation's own list against it.
 */
const readDeploymentEvents = (
  doc: Document,
  serialToNode: Map<string, ComponentNode>,
  notes: string[],
  num: NumReader,
): Map<string, RktTrigger> => {
  const seen = new Map<string, RktTrigger>();
  const unknown = new Set<number>();
  const applied: string[] = [];
  for (const ev of Array.from(doc.querySelectorAll('SimulationEvent'))) {
    const serial = text(ev, ':scope > PartSerialNo');
    if (!serial || serial === '0' || seen.has(serial)) continue;
    const node = serialToNode.get(serial);
    if (!node || (node.type !== 'parachute' && node.type !== 'streamer')) continue;
    const t = rktTrigger(ev, num);
    if (t === null) continue;
    if (typeof t === 'number') {
      unknown.add(t);
      continue;
    }
    seen.set(serial, t);
    node['deployEvent'] = t.deployEvent;
    if (t.deployDelay !== undefined) node['deployDelay'] = t.deployDelay;
    if (t.deployAltitude !== undefined) node['deployAltitude'] = t.deployAltitude;
    applied.push(`${node.name ?? node.type} ${t.says}`);
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
  return seen;
};

/** One <SimulationEvent>'s trigger, as readDeploymentEvents applies it. */
interface RktTrigger {
  deployEvent: 'ejection' | 'apogee' | 'altitude';
  deployDelay?: number;
  deployAltitude?: number;
  /** For a note: "at apogee", "at 152 m", … */
  says: string;
}

/**
 * The type codes readDeploymentEvents documents, for ONE event: null for the
 * empty slot (type 0), the code itself when it is not one of them. Split out
 * (audit 2026-09-22 review) so the opened simulation's own list can be read
 * the same way and compared.
 */
function rktTrigger(ev: Element, num: NumReader): RktTrigger | number | null {
  const type = Math.round(num(ev, 'Type', 0));
  switch (type) {
    case 0:
      return null;
    case 1:
      return { deployEvent: 'ejection', says: 'at the ejection charge' };
    case 2: {
      const delay = num(ev, 'DeplyTime', 0);
      return delay > 0
        ? { deployEvent: 'ejection', deployDelay: delay, says: `at the ejection charge + ${delay} s` }
        : { deployEvent: 'ejection', says: 'at the ejection charge' };
    }
    case 4:
      return { deployEvent: 'apogee', says: 'at apogee' };
    case 5: {
      const alt = num(ev, 'DeployAltitude', 0);
      // Altitude trigger with no altitude: apogee is the only honest reading.
      return alt > 0
        ? { deployEvent: 'altitude', deployAltitude: alt, says: `at ${Math.round(alt)} m` }
        : { deployEvent: 'apogee', says: 'at apogee (the file asks for an altitude but names none)' };
    }
    default:
      return type;
  }
}

/**
 * RockSim PointList: "x,y|x,y|…" in mm; reversed when RockSim-ordered.
 *
 * Returns the outline, or `problem` when the list is too long to read — then
 * with NO points, because the caller must not fly the first 5,000 of a longer
 * outline (see MAX_FIN_POINTS). `unreadable` counts the pairs left out because
 * they were not two decimals, for the caller's note.
 */
function parsePointList(raw: string): { pts: [number, number][]; problem?: string; unreadable: number } {
  const pts: [number, number][] = [];
  let unreadable = 0;
  // The cap counts every PAIR the file wrote, skipped ones included, and the
  // list is walked with indexOf rather than split. Audit 2026-09-22: the cap
  // was tested only before a push, and each duplicate `0,0` ran `pts.some`
  // over every kept point WITHOUT growing `pts` — so a 4,998-point outline
  // followed by `0,0` pairs never met the cap, at ~20 µs a pair: 3.5 s for
  // 0.85 MB, minutes for the 64 MiB a zipped .rkt may inflate to. And past the
  // cap the list was truncated, so the partial outline flew with no note
  // (leading-to-trailing order) or drew a misleading "last point must be aft"
  // (RockSim's reversed order). `.ork` refused it; now both do. The `+ 1`
  // leaves room for the duplicate closing 0,0 RockSim writes.
  let pairs = 0;
  let sawOrigin = false;
  for (let at = 0; at <= raw.length;) {
    let bar = raw.indexOf('|', at);
    if (bar < 0) bar = raw.length;
    const pair = raw.slice(at, bar);
    at = bar + 1;
    if (!pair.trim()) continue;
    if (++pairs > MAX_FIN_POINTS + 1) return { pts: [], problem: TOO_MANY_FIN_POINTS, unreadable: 0 };
    const fields = pair.split(',', 3);
    // BOTH fields must be present and non-blank — parseDecimal reads a blank
    // as NaN. `Number('')` was 0, so a malformed pair like "1,1|,,|2,2" used
    // to yield a real [0, 0] vertex in the middle of the outline, which
    // usually then made it self-intersect, and the note blamed the outline
    // rather than the field (2026-09-08 audit). Decimal only, like xmlNum.
    // Such a pair is left out and COUNTED, and the caller says so — the
    // desktop warns and skips it too ("Invalid fin point pair." / "Fin point
    // not in numeric format."); skipped silently, as it was until audit
    // 2026-09-22, the fin flew with a vertex missing and nothing said.
    const x = fields.length < 2 ? NaN : parseDecimal(fields[0]);
    const y = fields.length < 2 ? NaN : parseDecimal(fields[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      unreadable++;
      continue;
    }
    // RockSim writes duplicate 0,0 points — drop them. A flag, not a scan of
    // the kept points: that scan was the quadratic above.
    if (x === 0 && y === 0) {
      if (sawOrigin) continue;
      sawOrigin = true;
    }
    pts.push([x / LEN, y / LEN]);
  }
  if (pts.length > MAX_FIN_POINTS) return { pts: [], problem: TOO_MANY_FIN_POINTS, unreadable: 0 };
  // Our order is leading-root → trailing-root; RockSim's is usually reversed.
  if (pts.length > 1 && pts[pts.length - 1]![0] === 0 && pts[pts.length - 1]![1] === 0) {
    pts.reverse();
  }
  return { pts, unreadable };
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
  /**
   * Filled with what the file cannot say — one sentence each, for the Save
   * note. A .rkt is lossy by design (App's onSaveRkt never marks the design
   * saved), but a loss that changes how the rocket FLIES when the file is
   * opened again is said out loud rather than left to be found at the field.
   */
  notes?: string[];
}

export function exportRkt({ name, tree, motors, compInfo, notes }: RktExportInput): string {
  const lines: string[] = [];
  const emit = (s: string) => lines.push(s);
  let serial = 0;
  /** node id → RockSim SerialNo (links motors back to mounts). */
  const nodeSerial = new Map<string, number>();
  /** Mount node id → the SerialNo of every copy written (cluster tubes, pod instances). */
  const mountCopies = new Map<string, number[]>();

  const stagesIn = asStageNodes(tree);
  if (stagesIn.length > 3) {
    // The FORMAT is the limit, not the application: every .rkt seen here
    // writes three fixed Stage1/2/3 element families rather than a repeating
    // stage element, so there is nowhere for a fourth to go.
    throw new Error('A .rkt file holds at most 3 stages.');
  }

  const nnum = (node: ComponentNode, key: string, fb: number): number =>
    typeof node[key] === 'number' ? (node[key] as number) : fb;

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
   * RockSim `<LocationMode>` + `<Xb>` for a node's FORE end (aft end in mode 2,
   * which measures forward from the parent's rear).
   *
   * The parent is PASSED, never remembered (audit 2026-09-22). A module-level
   * `curParent`, set on each emitPart dispatch, was stale by the time a cluster
   * wrote copies 2..N or a pod set wrote instances 2..N: the first copy's
   * children had re-set it on their way through. "Middle of parent" then
   * resolved against the last child's parent — a cluster's copy 2 went out at
   * Xb 0 while copy 1 sat centred, and on re-open the copies no longer grouped
   * and became separate centreline tubes, with no note.
   */
  const rocksimXb = (node: ComponentNode, parent: ComponentNode | null): { mode: number; xb: number } => {
    const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
    const mode = pos.method === 'absolute' ? 1 : pos.method === 'bottom' ? 2 : 0;
    let xb = pos.method === 'bottom' ? -pos.offset : pos.offset;
    // RockSim has no "middle" mode — convert to front-referenced, mirroring
    // the desktop's BasePartDTO: xb = offset + (parentLen - componentLen)/2.
    if (pos.method === 'middle' && parent) {
      const compLen = nnum(node, 'length', nnum(node, 'rootChord', 0));
      xb = pos.offset + (nnum(parent, 'length', 0) - compLen) / 2;
    }
    return { mode, xb };
  };

  const common = (
    node: ComponentNode,
    parent: ComponentNode | null,
    dfltName: string,
    opts?: {
      knownMass?: number;
      useKnownCG?: boolean;
      /**
       * Write the part as RockSim's POINT mass: `<Xb>` on its CG and
       * `<KnownCG>` equal to that `<Xb>`. `cg` is measured from the part's own
       * front (m), `length` is its body length (m). See the MassObject branches.
       */
      point?: { cg: number; length: number };
      /**
       * How many RockSim parts this node goes out as — a cluster's tubes. Its
       * override and computed mass are the whole cluster's; each part's
       * <KnownMass> and <CalcMass> is its own share.
       */
      copies?: number;
    },
  ) => {
    const { mode, xb: xbEnd } = rocksimXb(node, parent);
    // A point mass sits at its CG (audit 2026-09-22). RockSim reads a
    // <MassObject> as a point at <Xb>, and so does this app's importer (it pins
    // overrideCGX on that point), so the point must BE the CG. It was the fore
    // end: a 150 mm av bay reached RockSim, and this app on re-open, 75 mm
    // forward of where it sits. In mode 2 Xb counts forward from the parent's
    // rear to the part's AFT end, and the CG is (length − cg) further forward.
    // A RockSim-imported mass object is pinned at its fore end (mode 0/1) or aft
    // end (mode 2), so its Xb comes back out unchanged. A deliberate divergence
    // from desktop, whose MassObjectDTO writes the fore end exactly as this
    // did (BasePartDTO.java:95-105, then setKnownCG(getXb())) and so hands
    // RockSim the same misplaced point. Summed in millimetres,
    // so 200 + 10 writes "210" rather than the metre sum's 210.00000000000003.
    const pt = opts?.point;
    const shift = !pt ? 0 : mode === 2 ? pt.length - pt.cg : pt.cg;
    const xbMm = xbEnd * LEN + shift * LEN;
    serial += 1;
    // First write wins: cluster copies re-emit the same node — motor
    // references must point at the FIRST copy (the one carrying children).
    if (node.id && !nodeSerial.has(node.id)) nodeSerial.set(node.id, serial);
    // And EVERY copy of a mount, for its engine sets: a cluster's tubes and a
    // pod set's instances each carry a motor, and RockSim wants one set each.
    if (node.id && node['motorMount'] === true) {
      const copies = mountCopies.get(node.id);
      if (copies) copies.push(serial);
      else mountCopies.set(node.id, [serial]);
    }
    const hasMassOv = typeof node['overrideMass'] === 'number';
    const hasCgOv = typeof node['overrideCGX'] === 'number';
    const override = hasMassOv || hasCgOv;
    const info = node.id ? compInfo?.[node.id] : undefined;
    // BOTH values are always real whenever either override exists: the
    // overridden one verbatim, the other from the computed component info. A 0
    // in the un-overridden field is the data error the compInfo map exists to
    // prevent, and it stays wrong even with the flag off — a reader is entitled
    // to look at the number regardless.
    //
    // ONE COPY'S SHARE (review of the seam fixes). A cluster goes out as one
    // <BodyTube> per tube, each re-emitting the same node, and the kernel's
    // override and computed mass on a cluster tube are the whole cluster's
    // (componentInfo's getMass) where RockSim's <KnownMass> and <CalcMass> are
    // the one tube's. Written whole on every copy, a 300 g 3-ring reached
    // RockSim and desktop — which read the tubes as three parts — at 900 g,
    // and this app's reader, adding the tubes back together, would say so too.
    const share = opts?.copies ?? 1;
    const knownMass = opts?.knownMass
      ?? ((hasMassOv ? (node['overrideMass'] as number)
        : override ? info?.mass ?? 0 : 0) * MASS) / share;
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
    const knownCG = pt ? xbMm
      : hasCgOv ? (node['overrideCGX'] as number) * LEN
        : useKnown ? (info?.cgX ?? 0) * LEN : 0;
    emit(`<KnownCG>${knownCG}</KnownCG>`);
    emit(`<UseKnownCG>${useKnown ? 1 : 0}</UseKnownCG>`);
    emit(`<FinishCode>${FINISH_TO_CODE(node['finish'])}</FinishCode>`);
    emit(`<SerialNo>${serial}</SerialNo>`);
    emit(`<LocationMode>${mode}</LocationMode>`);
    emit(`<Xb>${xbMm}</Xb>`);
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
      emit(`<CalcMass>${(info.mass * MASS) / share}</CalcMass>`);
      emit(`<CalcCG>${info.cgX * LEN}</CalcCG>`);
    }
  };

  const attached = (node: ComponentNode) => {
    emit('<AttachedParts>');
    for (const kid of node.children ?? []) emitPart(kid, node);
    emit('</AttachedParts>');
  };

  const emitInnerTube = (
    node: ComponentNode, parent: ComponentNode | null, radialLocM = 0, radialAngle = 0, suffix = '', copies = 1,
  ) => {
    emit('<BodyTube>');
    common(node, parent, `Inner Tube${suffix}`, { copies });
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
    // common() takes `parent` for the middle-position conversion — passed on
    // every call, never held in a variable the children re-set (see rocksimXb).
    switch (node.type) {
      case 'nosecone': {
        emit('<NoseCone>');
        common(node, parent, 'Nose cone');
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
        common(node, parent, 'Transition');
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
        common(node, parent, 'Body tube');
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
        // Each tube where the KERNEL puts it (InnerTube.getClusterPoints): the
        // pattern turned by clusterRotation − radialDirection, plus the tube's
        // own offset of radialPosition along radialDirection. This used to pass
        // neither angle nor offset (audit 2026-09-22, row 358, from review), so
        // a clustered tube with its own direction was written unturned, and any
        // tube set off the axis — clustered or single — was written ON it.
        const rp = nnum(node, 'radialPosition', 0);
        const rd = nnum(node, 'radialDirection', 0);
        const centres = clusterOffsets(cluster, nnum(node, 'outerRadius', 0.0095),
          nnum(node, 'clusterScale', 1), nnum(node, 'clusterRotation', 0), { radialDirection: rd })
          .map((off) => ({ y: off.y + rp * Math.cos(rd), z: off.z + rp * Math.sin(rd) }));
        // RockSim's RadialLoc/RadialAngle; an on-axis centre is written 0/0.
        const polar = (c: { y: number; z: number }): [number, number] => {
          const r = Math.hypot(c.y, c.z);
          return r > 0 ? [r, Math.atan2(c.z, c.y)] : [0, 0];
        };
        if (centres.length === 1) {
          emitInnerTube(node, parent, ...polar(centres[0]!));
        } else {
          centres.forEach((c, i) => emitInnerTube(node, parent, ...polar(c), i === 0 ? '' : ` (${i + 1})`, centres.length));
        }
        break;
      }
      case 'centeringring': case 'bulkhead': case 'engineblock': case 'tubecoupler': {
        const usage = node.type === 'bulkhead' ? 1 : node.type === 'engineblock' ? 2
          : node.type === 'tubecoupler' ? 4 : 0;
        emit('<Ring>');
        common(node, parent, 'Ring');
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
        common(node, parent, 'Fin set');
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
        const parentR = parent
          ? Math.max(nnum(parent, 'outerRadius', 0), nnum(parent, 'aftRadius', 0), 0.012)
          : 0.012;
        const centerR = resolveAssemblyRadius(node, parentR);
        const angle0 = nnum(node, 'angleOffset', 0);
        for (let i = 0; i < count; i++) {
          emit('<ExternalPod>');
          common(node, parent, node.type === 'podset' ? 'Pod' : 'Booster');
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
        common(node, parent, 'Launch lug');
        emit(`<OD>${nnum(node, 'outerRadius', 0.0022) * RAD}</OD>`);
        emit(`<ID>${(nnum(node, 'outerRadius', 0.0022) - nnum(node, 'thickness', 0.0003)) * RAD}</ID>`);
        emit(`<Len>${nnum(node, 'length', 0.05) * LEN}</Len>`);
        // The clock angle around the body, in RADIANS — desktop's own mapping
        // (rocksim/export/LaunchLugDTO.java:39 setRadialAngle(getAngleOffset()),
        // read straight back by importt/LaunchLugHandler.java:76). Omitted
        // until v0.103, so a lug the user had angled came back out at RockSim's
        // 0 and every .rkt this app wrote lost that half of the placement.
        emit(`<RadialAngle>${nnum(node, 'angleOffset', 0)}</RadialAngle>`);
        emit('</LaunchLug>');
        break;
      }
      case 'tubefinset': {
        emit('<TubeFinSet>');
        common(node, parent, 'Tube fins');
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
        common(node, parent, 'Parachute');
        emit(`<Dia>${nnum(node, 'diameter', 0.3) * LEN}</Dia>`);
        emit(`<DragCoefficient>${nnum(node, 'cd', 0.75)}</DragCoefficient>`);
        emit(`<ShroudLineCount>${Math.round(nnum(node, 'lineCount', 6))}</ShroudLineCount>`);
        emit(`<ShroudLineLen>${nnum(node, 'lineLength', 0.3) * LEN}</ShroudLineLen>`);
        // The other half of the same defect: desktop writes both
        // (ParachuteDTO.java:56-63, density × 1) and we wrote neither, so a
        // chute exported from here reached RockSim with weightless lines.
        // Emitted only when the design states a line density — inventing one
        // would hand RockSim a number no part of this design ever carried.
        if (typeof node['lineDensity'] === 'number' && (node['lineDensity'] as number) > 0) {
          emit(`<ShroudLineMassPerMM>${node['lineDensity'] as number}</ShroudLineMassPerMM>`);
          const lineMat = typeof node['lineMaterialName'] === 'string'
            ? (node['lineMaterialName'] as string) : '';
          if (lineMat) emit(`<ShroudLineMaterial>${esc(lineMat)}</ShroudLineMaterial>`);
        }
        emit('<ChuteCount>1</ChuteCount>');
        emit(`<SpillHoleDia>${nnum(node, 'spillHoleDiameter', 0) * LEN}</SpillHoleDia>`);
        emit('</Parachute>');
        break;
      }
      case 'streamer': {
        emit('<Streamer>');
        common(node, parent, 'Streamer');
        emit(`<Len>${nnum(node, 'stripLength', 0.5) * LEN}</Len>`);
        emit(`<Width>${nnum(node, 'stripWidth', 0.05) * LEN}</Width>`);
        emit(`<DragCoefficient>${nnum(node, 'cd', 0.75)}</DragCoefficient>`);
        emit('</Streamer>');
        break;
      }
      case 'shockcord': {
        emit('<MassObject>');
        common(node, parent, 'Shock cord');
        emit('<TypeCode>1</TypeCode>');
        emit(`<Len>${nnum(node, 'cordLength', 0.3) * LEN}</Len>`);
        emit('</MassObject>');
        break;
      }
      case 'fairing': {
        // RockSim has no external-protuberance component — keep at least the
        // MASS so CG survives the export (aero effect is lost, documented).
        emit('<MassObject>');
        // A point at the shroud's CG. The kernel flies it as a strake fin
        // (treeModel engineTree), whose CG sits off the middle when one end is
        // streamlined and the other is not, so the kernel's own CG leads; half
        // the length is the symmetric case, for a caller with no compInfo.
        const shroudLen = nnum(node, 'length', 0.08);
        common(node, parent, `${node.name ?? 'Camera shroud'} (mass only)`, {
          knownMass: nnum(node, 'mass', 0.03) * MASS, useKnownCG: true,
          point: { cg: (node.id ? compInfo?.[node.id]?.cgX : undefined) ?? shroudLen / 2, length: shroudLen },
        });
        emit('<TypeCode>0</TypeCode>');
        emit(`<Len>${shroudLen * LEN}</Len>`);
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
        // A point at the component's CG, measured from its own front: the
        // stated override (a RockSim import pins one on the file's point),
        // else the kernel's, else the body's middle — where the kernel puts a
        // MassObject's CG (MassObject.java:230-231) and where App's compInfo
        // would say it is.
        const bodyLen = nnum(node, 'length', 0.02);
        const cg = typeof node['overrideCGX'] === 'number' ? (node['overrideCGX'] as number)
          : (node.id ? compInfo?.[node.id]?.cgX : undefined) ?? bodyLen / 2;
        common(node, parent, 'Mass', {
          knownMass: massKg * MASS, useKnownCG: true, point: { cg, length: bodyLen },
        });
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
  emit('</RocketDesign>');
  emit('</DesignInformation>');
  // Motors: the desktop exporter omits these; we write EngineSets so RockSim
  // (and our own re-import) sees the loaded motors — WHERE RockSim keeps them
  // (audit 2026-09-22). This used to write the <StageNEngines> blocks directly
  // under <RocketDesign>, a place no RockSim-written file uses: in the 939-file
  // corpus, all 676 files that carry a motor keep their engine sets in
  // RockSimDocument > SimulationResultsList > SimulationResults, after
  // </DesignInformation>, with all three <StageNEngines> present even when a
  // slot is empty, and every engine set in the field order below. So one
  // simulation, the loaded motors, in that shape. NOT verified in RockSim
  // itself: a RockSim-written simulation has about 140 children (results,
  // launch conditions, events; 141 in Estes/Loadstar.rkt) where this writes
  // four, and whether RockSim reads the motors of a block without the rest is
  // unknown here. It is RockSim's own placement, which
  // the old one was not. No motor, no block, as before.
  const stageMotors = [0, 1, 2].map((i) => (i >= stagesIn.length ? [] : Object.entries(motors ?? {}).filter(([id]) =>
    (function inStage(nodes: ComponentNode[]): boolean {
      return nodes.some((n) => n.id === id || inStage(n.children ?? []));
    })(stagesIn[i]!.children ?? []))));
  if (stageMotors.some((s) => s.length > 0)) {
    emit('<SimulationResultsList>');
    emit('<SimulationResults>');
    // Staging timer, so a .rkt written here round-trips through our own
    // importer (and through RockSim) with its staging intact. RockSim
    // measures IgnitionDelay from the stage below's BURNOUT, which is exactly
    // what the importer maps to `ignitionEvent: 'burnout'`. On the LOWEST
    // stage carrying a motor nothing below it burns, and RockSim counts the
    // delay from launch — its stored results show it above an empty booster
    // slot (Blackhawk_2-stage.rkt) and on single-stage air-start clusters
    // (8 in Goblin 4 x 75mm.rkt: K828FJ at 3.2 s, TimeToBurnout 5.70 s) — so
    // a 'launch' motor there writes its delay too (audit 2026-09-22 review),
    // and the importer reads it back as 'launch' on the bottom stage and above
    // an empty one alike.
    //
    // EVERY EVENT ROCKSIM CAN SAY, SAID (seam review of the same audit). The
    // writer took only 'burnout', and 'launch' on the lowest stage, so the
    // kernel's default — 'automatic' — lost its delay everywhere: fx 38-54
    // 2-stage.CDX1's M1350W on automatic/12 s flew IGNITION@12.00 and reopened
    // from a .rkt at 0.00. 'automatic' is the kernel's LAUNCH on the bottom
    // stage and on a strap-on (AxialStage / ParallelStage.isLaunchStage), and
    // there it is written as a launch. Above it, 'automatic' is the EJECTION
    // CHARGE of the stage directly below (IgnitionEvent.EJECTION_CHARGE), which
    // RockSim cannot name — but when every motor on that stage has the same
    // finite delay d, its charge fires d s after its burnout, so the file says
    // d + delay after burnout and the flight is the same. What is left —
    // launch above the pad stage, burnout or a charge on the pad stage (where
    // nothing burns below: the kernel never lights it), a charge below whose
    // motors disagree or are plugged, and 'never' — RockSim has no words for,
    // and each is named in `notes` with what the file says instead.
    const lowestSlot = Math.max(...[0, 1, 2].filter((i) => stageMotors[i]!.length > 0));
    const bottomSlot = stagesIn.length - 1;
    const strapOn = (id: string): boolean => {
      const walk = (nodes: ComponentNode[], inStrap: boolean): boolean | null => {
        for (const n of nodes) {
          const here = inStrap || n.type === 'parallelstage';
          if (n.id === id) return here;
          const found = walk(n.children ?? [], here);
          if (found !== null) return found;
        }
        return null;
      };
      return walk(stagesIn.flatMap((s) => s.children ?? []), false) === true;
    };
    /** The one finite ejection delay every motor on slot `i + 1` shares, else null. */
    const sharedDelayBelow = (i: number): number | null => {
      const below = stageMotors[i + 1] ?? [];
      const delays = new Set(below.map(([, m]) => (m.rktEveryDelay ? NaN : m.delay)));
      const [d] = delays;
      return below.length > 0 && delays.size === 1 && d !== undefined && Number.isFinite(d) ? d : null;
    };
    /**
     * Every motor on slot `i + 1` plugged. A plugged motor fires no charge —
     * the kernel schedules EJECTION_CHARGE only for a motor that has one
     * (BasicEventSimulationEngine, BURNOUT: `motorState.hasEjectionCharge()`)
     * — so a stage above waiting for one never lights in this app, while the
     * .rkt lights it at that burnout. One plugged motor does share one delay,
     * 'plugged', which the note used to deny (review of the seam fixes).
     */
    const pluggedBelow = (i: number): number => {
      const below = stageMotors[i + 1] ?? [];
      return below.every(([, m]) => !m.rktEveryDelay && !Number.isFinite(m.delay)) ? below.length : 0;
    };
    const writtenIgnition = new Map<string, number>();
    const lostIgnition = new Set<string>();
    for (const i of [0, 1, 2]) {
      for (const [id, m] of stageMotors[i]!) {
        const delay = m.ignitionDelay ?? 0;
        const raw = m.ignitionEvent ?? 'automatic';
        const event = raw !== 'automatic' ? raw
          : i === bottomSlot || strapOn(id) ? 'launch' : 'ejectioncharge';
        const shared = event === 'ejectioncharge' && i !== lowestSlot ? sharedDelayBelow(i) : null;
        const said = i === lowestSlot ? event === 'launch'
          : event === 'burnout' || shared !== null;
        // Summed in whole microseconds, so 0.1 + 0.2 writes "0.3".
        writtenIgnition.set(id, shared !== null ? Math.round((shared + delay) * 1e6) / 1e6 : delay);
        if (said) continue;
        const after = i === lowestSlot ? 'after launch' : 'after the burnout of the stage below';
        const what = event === 'never' ? 'is set never to light'
          : event === 'launch' ? 'lights at launch, above the stage that leaves the pad'
            : event === 'burnout' ? 'lights on the burnout of the stage below'
              : 'lights on the ejection charge of the stage below';
        const plugged = event === 'ejectioncharge' && i !== lowestSlot ? pluggedBelow(i) : 0;
        const why = i === lowestSlot && (event === 'burnout' || event === 'ejectioncharge')
          ? ' — which never comes on the stage that leaves the pad, so it does not light here either'
          : plugged > 0 ? `, whose motor${plugged === 1 ? ' is' : 's are all'} plugged — with no charge to fire, it does not light here either`
            : event === 'ejectioncharge' ? ', whose motors do not share one ejection delay' : '';
        lostIgnition.add(`“${m.designation}” ${what}${why}. RockSim times the stage that leaves the pad from `
          + `launch and every other stage from the burnout of the one below, so the .rkt lights it ${delay} s ${after}.`);
      }
    }
    notes?.push(...lostIgnition);
    const rktIgnitionDelay = (id: string): number => writtenIgnition.get(id) ?? 0;
    // AUTO DELAY BACK AS RockSim's "EVERY DELAY" (seam review of audit
    // 2026-09-22). A motor whose listing gives no numeric delay (KBA's letter
    // codes) is loaded on Auto from RockSim's −1 (rktEveryDelay), and a Save
    // wrote its provisional 0 s, which reopened as a charge at burnout. −1
    // reads back as Auto; a motor that lists delays would read −1 back as its
    // longest instead, so it keeps the delay App hands over and the Save says
    // so (autoDelaySaveNote).
    const everyDelay = (m: OrkExportMotor): boolean => m.rktEveryDelay === true
      || (m.autoDelay === true && rktEveryDelay(m.designation, m.manufacturer ?? 'unknown')?.autoDelay === true);
    for (const i of [0, 1, 2]) {
      for (const [, m] of stageMotors[i]!) {
        const said = everyDelay(m) ? null : autoDelaySaveNote(m, '.rkt');
        if (said) notes?.push(said);
      }
    }
    // RockSim names a simulation by its motors, the stage that leaves the pad
    // first: one bracket per stage, a cluster's motors comma-separated inside
    // it, "-P" for plugged ("-*" for a kept "every delay" −1, as RockSim names
    // that run — see rktEjectionDelay), a non-zero IgnitionDelay after the
    // ejection delay, and a trailing space after each bracket — "[B6-0] [A8-5] "
    // is Loadstar's B6 booster under its A8 sustainer, "[O5500X-0-15, O5500X-0] "
    // Blackhawk's pair with one lit 15 s late. Of the corpus names this spells
    // exactly for two or more stages, all 129 put the bottom stage first and
    // none the sustainer (audit 2026-09-22 review: it was sustainer first, one
    // bracket per motor). One entry per MOTOR, as RockSim writes it — a
    // 3-tube cluster of A8-3 is Semroc-Defender.rkt's "[A8-3, A8-3, A8-3] " —
    // so a cluster or a pod set names each of its copies.
    const copiesOf = (id: string): number[] => mountCopies.get(id) ?? [nodeSerial.get(id) ?? -1];
    const simName = [2, 1, 0].filter((i) => stageMotors[i]!.length > 0).map((i) => `[${stageMotors[i]!.flatMap(([id, m]) => {
      const ign = rktIgnitionDelay(id);
      const entry = `${m.designation}-${everyDelay(m) ? '*' : Number.isFinite(m.delay) ? m.delay : 'P'}${ign ? `-${ign}` : ''}`;
      return copiesOf(id).map(() => entry);
    }).join(', ')}] `).join('');
    emit(`<SimulationName>${esc(simName)}</SimulationName>`);
    // Bottom slot first, as RockSim writes them: Stage1Engines is the stage
    // that leaves the pad, Stage3Engines the sustainer (our stage 0).
    for (const slot of [1, 2, 3]) {
      emit(`<Stage${slot}Engines>`);
      // ONE ENGINE SET PER TUBE (seam review of audit 2026-09-22). A cluster
      // went out as N IsMotorMount tubes and ONE set on the first copy, so
      // RockSim, which lists a set per tube — every one of the 14,434 sets in
      // the 939-file corpus says <EngineCount>1</EngineCount>, and a cluster's
      // tubes each carry one (Quest_Quad_Runner.rkt: four B4-4, serials 3, 13,
      // 15, 17) — flew one motor where the design flies N. This app's own
      // importer hid it for an on-axis cluster by merging the tubes back, and
      // could not once the tubes were written at their true off-axis place:
      // three came back as three mounts carrying one motor between them.
      for (const [id, m] of stageMotors[3 - slot]!) {
        for (const copySerial of copiesOf(id)) {
          emit('<EngineSet>');
          emit('<EngineCount>1</EngineCount>');
          emit(`<EngineCode>${esc(m.designation)}</EngineCode>`);
          emit(`<IgnitionDelay>${rktIgnitionDelay(id)}</IgnitionDelay>`);
          emit(`<EngineMfg>${esc(m.manufacturer ?? 'unknown')}</EngineMfg>`);
          emit(`<MountSerialNo>${copySerial}</MountSerialNo>`);
          // Never "Infinity" (audit 2026-09-22): a plugged motor is RockSim's own −2,
          // which RockSim reads as plugged and so does our importer (rktEjectionDelay).
          // A reference nothing loaded that the file gave RockSim's "every delay"
          // goes back as the −1 it came in as (OrkMotorRef.rktEveryDelay), and
          // so does an Auto motor with no numeric delay (everyDelay above).
          emit(`<EjectionDelay>${everyDelay(m) ? RKT_EVERY_DELAY
            : Number.isFinite(m.delay) ? m.delay : RKT_PLUGGED_DELAY}</EjectionDelay>`);
          emit('</EngineSet>');
        }
      }
      emit(`</Stage${slot}Engines>`);
    }
    emit('</SimulationResults>');
    emit('</SimulationResultsList>');
  }
  emit('</RockSimDocument>');
  return lines.join('\n');
}

