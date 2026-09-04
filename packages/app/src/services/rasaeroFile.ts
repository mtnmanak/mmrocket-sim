import { strFromU8 } from 'fflate';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import { asStageNodes, freshId, mountsIn } from '../tree/treeModel.js';
import { findDbMotor, hasMassData } from './motorDb.js';
import { escapeXml as esc, xmlNum as num, xmlText as text } from './xmlUtil.js';
import type { OrkFlightConfig, OrkImportResult, OrkMotorRef, OrkSeparationOverride } from './orkFile.js';

/**
 * RASAero II (.CDX1) design import/export — Phase 3 "file imports and
 * exports". Format knowledge mirrors the desktop's file/rasaero package:
 * - Geometry in INCHES (÷39.37 → m), diameters not radii; angles degrees;
 *   altitudes feet; weights pounds.
 * - The airframe is a FLAT part list (NoseCone/BodyTube/Transition/FinCan/
 *   BoatTail/Booster), each with an absolute <Location>; fins nest inside
 *   their parent tube. A <Booster> element IS a lower stage.
 * - RASAero is aerodynamics-only: parts carry no material/mass data (the
 *   desktop fakes 2 mm walls; so do we) — masses/CG live in <Simulation>
 *   blocks as CUMULATIVE per-stage launch weights, applied as stage
 *   mass/CG overrides with the motor backed out (see the override block in
 *   importCdx1, desktop SimulationHandler parity). Each engine-carrying
 *   <Simulation> becomes a flight configuration (motors on each stage's
 *   aft-most tube, same parity).
 * - Nose shapes are strings ("Tangent Ogive", "Von Karman Ogive"…), mapped
 *   with the desktop's shape parameters.
 */

const IN = 39.37; // inches per meter (the desktop's OPENROCKET_TO_RASAERO_LENGTH)
const FT = 3.28084;
const LB = 2.20462262;
const MPH = 2.23694; // mph per m/s (the desktop's OPENROCKET_TO_RASAERO_SPEED)
const INHG = 33.8639; // hPa per in-Hg (RASAero's launch-site pressure unit)

const NOSE_SHAPES: Record<string, { shape: string; param?: number }> = {
  'Conical': { shape: 'conical' },
  'Tangent Ogive': { shape: 'ogive', param: 1 },
  'Von Karman Ogive': { shape: 'haack', param: 0 },
  'Power Law': { shape: 'power' },
  'LV-Haack': { shape: 'haack', param: 0.33 },
  'Parabolic': { shape: 'power', param: 0.5 },
  'Elliptical': { shape: 'ellipsoid' },
};

const CROSS_SECTIONS: Record<string, string> = {
  'Square': 'square', 'Rounded': 'rounded', 'Subsonic NACA': 'airfoil',
};

/**
 * RASAero's SUPERSONIC airfoil strings ↔ our airfoilSection ids (feature #4),
 * keyed lowercase. A matched section also sets crossSection 'airfoil' — the
 * desktop maps every non-Square/Rounded/NACA section to AIRFOIL, so that is
 * desktop parity with the section geometry kept on top.
 */
const AIRFOIL_SECTIONS: Record<string, string> = {
  'double wedge': 'doublewedge',
  'hexagonal blunt base': 'hexbluntbase',
  'hexagonal': 'hexagonal',
  'naca': 'naca',
  'biconvex': 'biconvex',
  'single wedge': 'singlewedge',
};
const SECTION_TO_AIRFOIL: Record<string, string> = {
  doublewedge: 'Double Wedge',
  hexbluntbase: 'Hexagonal Blunt Base',
  hexagonal: 'Hexagonal',
  naca: 'NACA',
  biconvex: 'Biconvex',
  singlewedge: 'Single Wedge',
};

/** RASAero's global surface strings ↔ our finish ids (desktop mapping, approx). */
const SURFACE_TO_FINISH: Record<string, string> = {
  'Smooth (Zero Roughness)': 'finishpolished',
  'Polished': 'finishpolished',
  'Sheet Metal': 'polished',
  'Smooth Paint': 'smooth',
  'Camouflage Paint': 'smooth',
  'Rough Camouflage Paint': 'normal',
  'Galvanized Metal': 'unfinished',
  'Cast Iron (Very Rough)': 'rough',
};
const FINISH_TO_SURFACE: Record<string, string> = {
  finishpolished: 'Polished',
  polished: 'Sheet Metal',
  smooth: 'Smooth Paint',
  normal: 'Rough Camouflage Paint',
  unfinished: 'Galvanized Metal',
  rough: 'Cast Iron (Very Rough)',
};

/**
 * Engine-string export gate — PROVEN against real RASAero II 2026-08-25.
 *
 * The test file below opened cleanly: no dialog, "Motor: J350W  (AT)",
 * Loaded Wt. (lb) 5.9966, CP 35.97 in (screenshot:
 * docs/User files/rasaero-engine-export-test.png). Kept as a named constant
 * rather than inlined, because the NRE risk below is real for any motor
 * RASAero's own database lacks — if a tester ever reports a crash on open,
 * this is the one line to flip back.
 *
 * RASAero II looks every exported engine name up in its own motor database and
 * throws a NullReferenceException when the name is missing (the same NRE family
 * as the sim-block crash documented at the SimulationList writer below). The
 * strings we write mirror the desktop exporter exactly —
 * RASAeroCommonConstants.OPENROCKET_TO_RASAERO_MOTOR emits
 * 'DESIGNATION  (ABBREV)' with TWO spaces, abbreviations per
 * OPENROCKET_TO_RASAERO_MANUFACTURER — and we only write manufacturers RASAero
 * documents (unmapped ones are omitted entirely, never guessed), but the
 * desktop also verifies each motor against RASAero's own engine list, which we
 * do not ship. One real-RASAero open test settled it.
 *
 * What that test did NOT cover is the booster path: the proven file is
 * single-stage — "docs/User files/rasaero-engine-export-test.CDX1" carries
 * <UseBooster1>False</UseBooster1> and no <Booster> part, so opening it said
 * nothing about a simulation that claims a booster. What a multi-stage export
 * writes into the per-stage weight/CG cells, and why, is documented at the
 * SimulationList writer below.
 *
 * Tests: rasaeroFile.test.ts, "RASAero engine export".
 */
export const CDX1_ENGINE_EXPORT = true;

/**
 * Our manufacturer names → RASAero's engine-file abbreviations, transcribed
 * from the desktop's RASAeroCommonConstants.OPENROCKET_TO_RASAERO_MANUFACTURER
 * (24.12, lines 419-468). Keys are matched against the desktop Manufacturer
 * registry's alternate names AND the thrustcurve.org abbrevs our motor
 * database uses (measured from the live metadata endpoint), normalized:
 * uppercase, periods/commas stripped, whitespace collapsed.
 */
const RASAERO_MFG: Array<[abbrev: string, names: string[]]> = [
  ['AT', ['AEROTECH', 'AT', 'ISP']],
  ['ES', ['ESTES', 'ESTES INDUSTRIES', 'ES', 'E']],
  ['AP', ['APOGEE', 'APOGEE COMPONENTS', 'AP']],
  ['QU', ['QUEST', 'QUEST AEROSPACE', 'QU', 'Q']],
  ['CTI', ['CESARONI', 'CESARONI TECHNOLOGY', 'CESARONI TECHNOLOGY INC',
    'CESARONI TECHNOLOGY INCORPORATED', 'CTI', 'CES', 'PRO38']],
  ['EM', ['ELLIS', 'ELLIS MOUNTAIN', 'EM']],
  ['Contrail', ['CONTRAIL', 'CONTRAIL ROCKETS', 'CONTRAIL ROCKET', 'CR']],
  ['RV', ['ROCKETVISION', 'ROCKETVISION FLIGHT-STAR', 'ROCKET VISION', 'RV']],
  ['RR', ['ROADRUNNER', 'ROADRUNNER ROCKETRY', 'RR']],
  ['SRS', ['SKYR', 'SKY RIPPER', 'SKYRIPPER', 'SKY RIPPER SYSTEMS', 'SRS']],
  ['LR', ['LOKI', 'LOKI RESEARCH', 'LR']],
  ['PML', ['PML', 'PUBLIC MISSILES', 'PUBLIC MISSILES LTD', 'PUBLIC MISSILES LIMITED']],
  ['KBA', ['KBA', 'KOSDON BY AEROTECH', 'KOSDON/AT', 'KOSDON/AEROTECH', 'K-AT']],
  ['GM', ['GORILLA', 'GORILLA ROCKET MOTORS', 'GORILLA MOTORS', 'GM']],
  ['RTW', ['RATT', 'RATT WORKS', 'RTW', 'RT']],
  ['HT', ['HYPERTEK', 'HT']],
  ['AMW', ['AMW', 'ANIMAL MOTOR WORKS', 'ANIMAL', 'AMW PROX', 'AMW/PROX']],
];
const RASAERO_MFG_LOOKUP: Record<string, string> = Object.fromEntries(
  RASAERO_MFG.flatMap(([abbrev, names]) => names.map((n) => [n, abbrev])));

/**
 * The RASAero abbreviation for one of our manufacturer strings (thrustcurve
 * abbrev, .ork/.eng full name, or an already-RASAero abbreviation), or null
 * when RASAero doesn't document the maker — writing a name RASAero's database
 * lacks is the NRE, so unknown means OMIT, never guess.
 */
export function rasaeroManufacturerAbbrev(mfg: string | undefined): string | null {
  if (!mfg) return null;
  const n = mfg.trim().toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
  // The desktop registers AeroTech under A/AT/AERO/AEROTECH × -RMS/-RCS/RCS-/
  // -APOGEE combinations; a prefix test covers them without enumerating.
  if (n.startsWith('AEROTECH') || n.startsWith('AT-') || n.startsWith('RCS-')) return 'AT';
  return RASAERO_MFG_LOOKUP[n] ?? null;
}

/**
 * A design-level **conditions table**: `[mach, altitude m]` pairs, ascending in
 * Mach. RASAero calls it the Mach-Alt table and uses it to evaluate each Mach
 * point of an aero run at a chosen altitude — which is how a published
 * wind-tunnel comparison is made at the tunnel's Reynolds number instead of at
 * sea level. It feeds `DragSweepOptions.machAlt` verbatim (the engine
 * interpolates linearly between rows and clamps outside them), and the
 * validation fixtures already carry the same tables by hand.
 *
 * A design property, not a component property: it describes the *air*, not the
 * rocket.
 */
export type MachAltTable = [number, number][];

/**
 * The file's `<MachAlt>` table in SI, Mach-ascending and deduplicated, or
 * undefined when the file carries none (three of the five bundled fixtures) or
 * an empty element (what our own exporter writes when it has no table).
 *
 * RASAero stores one `<Item>mach, altitude_ft</Item>` per row and **repeats the
 * whole table once per grid page**: ARCAS-Long carries 60 items that are ten
 * distinct pairs written six times over. Deduplication is therefore mandatory,
 * not tidiness — the engine's interpolator walks the rows assuming each Mach
 * appears once and ascending. First row wins for a repeated Mach.
 */
export function readMachAltTable(doc: Document): MachAltTable | undefined {
  const el = doc.querySelector('RASAeroDocument > MachAlt');
  if (!el) return undefined;
  const byMach = new Map<number, number>();
  for (const item of Array.from(el.querySelectorAll(':scope > Item'))) {
    const [machStr, altStr] = (item.textContent ?? '').split(',');
    if (altStr === undefined) continue;
    const mach = Number(machStr);
    const altFt = Number(altStr);
    // A negative Mach or a sub-sea-level altitude is not a row RASAero can
    // mean; dropping it beats handing the ISA model an altitude it clamps.
    if (!Number.isFinite(mach) || !Number.isFinite(altFt) || mach < 0 || altFt < 0) continue;
    if (!byMach.has(mach)) byMach.set(mach, altFt / FT);
  }
  if (byMach.size === 0) return undefined;
  return [...byMach.entries()].sort((a, b) => a[0] - b[0]).map(([m, alt]) => [m, alt]);
}

/**
 * What `importCdx1` returns: an `.ork` import result plus the RASAero-only
 * design-level conditions table. Nothing downstream is required to read it —
 * `machAlt` is optional, and the drag panel's default is still sea level.
 */
export interface Cdx1ImportResult extends OrkImportResult {
  /** The file's `<MachAlt>` conditions table (see {@link MachAltTable}). */
  machAlt?: MachAltTable;
}

// ============================ IMPORT ============================

export function importCdx1(data: ArrayBuffer | string): Cdx1ImportResult {
  const xml = (typeof data === 'string' ? data : strFromU8(new Uint8Array(data))).replace(/^﻿?/, '');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not a valid RASAero file (XML parse error)');
  }
  const design = doc.querySelector('RASAeroDocument > RocketDesign');
  if (!design) throw new Error('Not a RASAero design file (missing RocketDesign)');

  const notes: string[] = [];
  const ignored = new Set<string>();
  const finish = SURFACE_TO_FINISH[text(design, ':scope > Surface') ?? ''];

  const readFin = (parentEl: Element, parentNode: ComponentNode) => {
    const finEl = parentEl.querySelector(':scope > Fin');
    if (!finEl) return;
    const rootChord = num(finEl, 'Chord', 4) / IN;
    const tipChord = num(finEl, 'TipChord', 2) / IN;
    const sweep = num(finEl, 'SweepDistance', 1) / IN;
    const height = num(finEl, 'Span', 2) / IN;
    const locIn = num(finEl, 'Location', 0);
    // Fins on a transition/boat tail must be FREEFORM (same trapezoid
    // planform as points) — the kernel refuses trapezoid sets there, so the
    // desktop converts too.
    const onTransition = parentNode.type === 'transition';
    const fin: ComponentNode = {
      type: onTransition ? 'freeformfinset' : 'trapezoidfinset',
      id: freshId(),
      name: 'Fins',
      finCount: Math.max(1, Math.round(num(finEl, 'Count', 3))),
      thickness: num(finEl, 'Thickness', 0.125) / IN,
      // RASAero fin Location = front edge from the tube's BOTTOM.
      position: { method: 'bottom', offset: rootChord - locIn / IN },
    };
    if (onTransition) {
      // A zero tip chord (an ordinary triangular/delta fin, and RASAero's
      // default) would repeat the tip point. The kernel reads that zero-length
      // edge as a self-intersection and reports it through a Java %g format
      // that TeaVM does not implement, so the build died with "Unknown format
      // conversion: g" and the design lost CG, CP, stability and Simulate.
      // Collapse the tip to a single point instead.
      fin['points'] = tipChord > 1e-9
        ? [[0, 0], [sweep, height], [sweep + tipChord, height], [rootChord, 0]]
        : [[0, 0], [sweep, height], [rootChord, 0]];
    } else {
      fin['rootChord'] = rootChord;
      fin['tipChord'] = tipChord;
      fin['sweep'] = sweep;
      fin['height'] = height;
    }
    const sectionName = text(finEl, ':scope > AirfoilSection') ?? '';
    const airfoil = AIRFOIL_SECTIONS[sectionName.toLowerCase()];
    if (airfoil) {
      fin['airfoilSection'] = airfoil;
      fin['crossSection'] = 'airfoil';
      const ler = num(finEl, 'LERadius', 0);
      if (ler > 0) fin['finLeRadius'] = ler / IN;
      const fx1 = num(finEl, 'FX1', 0);
      if (fx1 > 0) fin['airfoilLeDiamond'] = fx1 / IN;
      if (airfoil === 'hexagonal') {
        const fx3 = num(finEl, 'FX3', 0);
        if (fx3 > 0) fin['airfoilTeDiamond'] = fx3 / IN;
      } else if (airfoil === 'doublewedge') {
        // A double wedge's TE chamfer is DERIVED: mean chord − FX1. The file's
        // <FX3> is a stale UI leftover — measured on a tester file, the true TE
        // (32.669 mm) equals (Chord+TipChord)/2 − FX1 exactly while its FX3
        // (0.465 in) matches nothing.
        const te = (rootChord + tipChord) / 2 - fx1 / IN;
        if (te > 0) fin['airfoilTeDiamond'] = te;
      }
    } else {
      const cs = CROSS_SECTIONS[sectionName];
      if (cs && cs !== 'square') fin['crossSection'] = cs;
    }
    if (finish && finish !== 'normal') fin['finish'] = finish;
    parentNode.children = [...(parentNode.children ?? []), fin];
  };

  /**
   * `<Protuberance>` → our `protuberance` components (§7.5e). RASAero stores a
   * TOTAL frontal area in square inches per class per tube ("the frontal areas
   * of all the … Protuberances are added up", Users Manual p. 25), plus up to
   * two inclined-flat-plate entries each with its own plate angle in degrees
   * measured from the body tube.
   *
   * A total area carries no shape, so each entry becomes ONE component whose
   * width and height are the side of the equal-area SQUARE — which is Rogers'
   * own convention for entering these ("the resulting final frontal area was
   * turned into a square (same diameter and height) rail guide", RASAero II
   * Comparisons with ARCAS CP and CD Data, slide 2). Length is cosmetic, so it
   * gets the same side: a cube-ish bump that draws sensibly and round-trips the
   * area exactly.
   */
  const readProtuberances = (el: Element, tube: ComponentNode, name: string): void => {
    const IN2 = IN * IN; // in² per m²
    const add = (areaIn2: number, dragClass: string, angleDeg: number, label: string) => {
      if (!(areaIn2 > 0)) return;
      const side = Math.sqrt(areaIn2 / IN2);
      const node: ComponentNode = {
        type: 'protuberance', id: freshId(), name: label,
        dragClass, width: side, height: side, length: side, count: 1, mass: 0,
        position: { method: 'middle', offset: 0 },
      } as unknown as ComponentNode;
      if (dragClass === 'plate') node['plateAngle'] = (angleDeg * Math.PI) / 180;
      tube.children = [...(tube.children ?? []), node];
    };
    for (const prot of Array.from(el.querySelectorAll(':scope > Protuberance'))) {
      add(num(prot, 'StreamlinedNoBaseDrag', 0), 'streamlined', 0, 'Protuberance (streamlined)');
      add(num(prot, 'StreamlinedWithBaseDrag', 0), 'streamlinedbase', 0, 'Protuberance (with base drag)');
      for (const i of [1, 2] as const) {
        add(num(prot, `InclinedPlate${i}FrontalArea`, 0), 'plate',
          num(prot, `InclinedPlate${i}Angle`, 0), `Protuberance (flat plate ${i})`);
      }
    }
    const made = (tube.children ?? []).filter((c) => (c.type as string) === 'protuberance');
    if (made.length > 0) {
      notes.push(`Imported ${made.length} RASAero protuberance${made.length === 1 ? '' : 's'} on ${name} `
        + `(${made.map((c) => `${((c['width'] as number) * (c['height'] as number) * IN2).toFixed(4)} in²`).join(', ')}) `
        + '— drag only, entered as equal-area squares; edit the shape in its properties.');
    }
  };

  const mkTube = (el: Element, name: string): ComponentNode => {
    const tube: ComponentNode = {
      type: 'bodytube',
      id: freshId(),
      name,
      length: num(el, 'Length', 12) / IN,
      outerRadius: num(el, 'Diameter', 4) / IN / 2,
      thickness: 0.002, // RASAero has no wall data — the desktop fakes 2 mm too
    };
    if (finish && finish !== 'normal') tube['finish'] = finish;
    readFin(el, tube);
    const lugD = num(el, 'LaunchLugDiameter', 0);
    const lugL = num(el, 'LaunchLugLength', 0);
    if (lugD > 0 && lugL > 0) {
      tube.children = [...(tube.children ?? []), {
        type: 'launchlug', id: freshId(), name: 'Launch lug',
        length: lugL / IN, outerRadius: lugD / IN / 2, thickness: 0.0005,
        position: { method: 'middle', offset: 0 },
      } as ComponentNode];
    }
    readProtuberances(el, tube, name);
    return tube;
  };

  // ---- sustainer (top-level flat list) ----
  const sustainer: ComponentNode = { type: 'stage', id: freshId(), name: 'Sustainer', children: [] };
  const stages: ComponentNode[] = [sustainer];

  /*
   * AXIAL STATION BOOKKEEPING — why a flat document-order chain is not enough.
   *
   * RASAero's part list is flat, but two of its part kinds OVERLAP the part in
   * front of them and so contribute NO length to the airframe:
   *  - <FinCan> is a tube that slides OVER the tube ahead of it. Desktop models
   *    it as an inline PodSet on that tube (FinCanHandler.java:46-58 ctor,
   *    :82-93 endHandler): instanceCount 1, RadiusMethod.FREE 0,
   *    AxialMethod.BOTTOM, holding a conical shoulder + the can tube.
   *  - <BoatTail> sitting above a <Booster> is recessed INTO that booster, so
   *    the booster starts where the boat tail starts (BoattailHandler.java:52-65).
   * Stacking either one end-to-end lengthened the rocket by its whole <Length>:
   * measured, MESOS_Last_Preflight_File imported 160.82 in against the 147.32 in
   * its own <Location> fields imply (+9.2 %), Complex.Two-Stage 74.00 against
   * 65.00 (+13.8 %), Show-off 25.34 against 22.00 (+15.2 %) — and every CP,
   * CG and stability number downstream of that length was wrong with it.
   *
   * `stationIn` is the running AFT station in inches — advanced by the parts
   * that really occupy length (nose, body tube, inline transition/boat tail,
   * and a whole booster stage), NOT by the two overlapping kinds. It exists to
   * cross-check <Booster><Location> (below) and to place a fin can that is not
   * flush with its host tube's aft end.
   * `stationAftRadius` is the airframe's outer radius AT that station, which is
   * the fin can's OD once a fin can is in play — the following transition's
   * fore radius has to come from there and not from the host tube it hides
   * (see the Transition/BoatTail branch).
   */
  let lastTube: ComponentNode | undefined; // last STAGE-LEVEL bodytube appended
  let stationAftRadius: number | undefined;
  let stationIn = 0;
  const hasBoosterEl = Array.from(design.children).some((e) => e.tagName === 'Booster');

  for (const el of Array.from(design.children)) {
    switch (el.tagName) {
      case 'NoseCone': {
        const shapeName = text(el, ':scope > Shape') ?? 'Tangent Ogive';
        const mapped = NOSE_SHAPES[shapeName] ?? { shape: 'ogive' };
        const nose: ComponentNode = {
          type: 'nosecone', id: freshId(), name: 'Nose cone',
          length: num(el, 'Length', 12) / IN,
          aftRadius: num(el, 'Diameter', 4) / IN / 2,
          thickness: 0.002,
          shape: mapped.shape,
        };
        const power = num(el, 'PowerLaw', NaN);
        const param = mapped.shape === 'power' && !Number.isNaN(power) ? power : mapped.param;
        if (param !== undefined) nose['shapeParameter'] = param;
        if (finish && finish !== 'normal') nose['finish'] = finish;
        const blunt = num(el, 'BluntRadius', 0);
        if (blunt > 0) {
          notes.push(`Ignored RASAero nose <BluntRadius> ${blunt} in — tip blunting is not modeled.`);
        }
        sustainer.children!.push(nose);
        stationIn += num(el, 'Length', 12);
        stationAftRadius = nose['aftRadius'] as number;
        break;
      }
      case 'BodyTube': {
        const tube = mkTube(el, 'Body tube');
        sustainer.children!.push(tube);
        lastTube = tube;
        stationIn += num(el, 'Length', 12);
        stationAftRadius = tube['outerRadius'] as number;
        break;
      }
      case 'Transition':
      case 'BoatTail': {
        // A .CDX1 transition takes its FRONT diameter implicitly from the part
        // in front of it; the stored <Diameter> just duplicates <RearDiameter>
        // (verified across the fixtures: Diameter 2.5 / RearDiameter 2.5 sitting
        // between a 3" and a 2.5" tube). Taking it literally turned every
        // mid-body transition into a cylinder and put a false step in the
        // airframe — wrong geometry feeding Barrowman CP and body drag, plus
        // spurious DISCONTINUITY warnings. Desktop OpenRocket resolves this with
        // setForeRadiusAutomatic(true); resolving from the preceding sibling is
        // the same thing, with <Diameter> kept only for a leading transition.
        //
        // …but the preceding SIBLING is no longer the preceding part once a fin
        // can moves into a pod: the chain's last child is then the HOST tube the
        // can hides, not the can. `stationAftRadius` is the airframe radius at
        // the current station and knows about the can; the sibling walk stays as
        // the fallback for a leading transition. Measured with the sibling walk
        // alone after the fin-can fix, Complex.Two-Stage's boat tail narrowed
        // from a 3.00 in front instead of 3.25 and MESOS's from 3.15 instead of
        // 3.21 — both contradicting the files' own <BoatTail><Diameter>.
        const prev = sustainer.children![sustainer.children!.length - 1];
        const prevAft = stationAftRadius ?? (prev
          ? typeof prev['aftRadius'] === 'number' ? prev['aftRadius'] as number
            : typeof prev['outerRadius'] === 'number' ? prev['outerRadius'] as number
              : undefined
          : undefined);
        const trans: ComponentNode = {
          type: 'transition', id: freshId(),
          name: el.tagName === 'BoatTail' ? 'Boat tail' : 'Transition',
          length: num(el, 'Length', 2) / IN,
          foreRadius: prevAft ?? num(el, 'Diameter', 4) / IN / 2,
          aftRadius: num(el, 'RearDiameter', 3) / IN / 2,
          thickness: 0.002,
          shape: 'conical', // RASAero transitions are always conical
        };
        if (finish && finish !== 'normal') trans['finish'] = finish;
        readFin(el, trans);
        // A <BoatTail> with a <Booster> below it is RECESSED into that booster:
        // the booster's shoulder starts where the boat tail starts, so the boat
        // tail occupies none of the axial chain. Desktop hangs it off the
        // previous body tube as an inline pod, TOP / hostTube.getLength()
        // (BoattailHandler.java:52-65) — that is exactly the node built here.
        // Verified against the corpus: Complex.Two-Stage's <Booster><Location>
        // 55 and Show-off's 19 both equal the aft station WITHOUT the boat tail,
        // and were 58 / 20 when we stacked it.
        //
        // DELIBERATE DEVIATION FROM DESKTOP: desktop pod-ises EVERY boat tail,
        // single-stage ones included (and inserts a phantom zero-length tube
        // when the previous child is a nose cone or transition, :66-75). We only
        // do it when a <Booster> follows. It is numerically free either way
        // (ARCAS-Long - 2 measures 53.5001 in / CG 37.4201 / CP 40.6627 /
        // 1.4412 cal inline AND pod-ised), but TreeSchematic.tsx computes the
        // drawing's totalLen from the TOP-LEVEL chain only, so a pod that
        // overhangs its host tube draws off the right edge and mis-scales the
        // whole schematic. Under this narrower rule no pod this importer builds
        // ever overhangs: the fin-can pod is bottom-flush, and a recessed boat
        // tail is always followed by a booster stage longer than it.
        if (el.tagName === 'BoatTail' && hasBoosterEl && lastTube) {
          lastTube.children = [...(lastTube.children ?? []), {
            type: 'podset', id: freshId(), name: 'Boat tail pod',
            instanceCount: 1, radiusOffset: 0, radiusMethod: 'free', angleOffset: 0,
            position: { method: 'top', offset: lastTube['length'] as number },
            children: [trans],
          } as unknown as ComponentNode];
          notes.push('The boat tail slides inside the booster below it, so it is imported as a pod on '
            + '“Body tube” — the booster starts where the boat tail starts, as it does in RASAero.');
          // stationIn, stationAftRadius and lastTube all stay where they were.
          break;
        }
        sustainer.children!.push(trans);
        stationIn += num(el, 'Length', 2);
        stationAftRadius = trans['aftRadius'] as number;
        break;
      }
      case 'FinCan': {
        // A RASAero fin can is a tube that slides OVER the tube in front of it,
        // not another tube stacked behind it. We used to push it through mkTube
        // as an ordinary stage-level body tube and say so in a note; that added
        // its whole <Length> to the airframe — 6 in on Complex.Two-Stage
        // (74.00 in against the file's own 65.00), 8 in on @Buckeye's MESOS
        // files (160.82 against 147.32), and dragged CP and stability with it.
        //
        // Desktop builds an inline PodSet on the previous body tube holding a
        // conical shoulder plus the can tube — FinCanHandler.java:46-58 sets
        // instanceCount 1, RadiusMethod.FREE radius 0, AxialMethod.BOTTOM and
        // angleOffset 0; :82-93 prepends the shoulder (fore = InsideDiameter/2,
        // aft = the can's own OD). A pod contributes no axial length, which is
        // the whole point.
        const canTube = mkTube(el, 'Fin can tube');
        if (!lastTube) {
          // No body tube ahead of it to slide over. Desktop THROWS here
          // (FinCanHandler.java:39-44); we keep the old flat behaviour rather
          // than refuse the file. No .CDX1 in the 54-design corpus does this.
          notes.push('This file’s fin can has no body tube in front of it to slide over, so it is '
            + 'imported as a plain body tube — it adds its own length to the rocket.');
          sustainer.children!.push(canTube);
          lastTube = canTube;
          stationIn += num(el, 'Length', 12);
          stationAftRadius = canTube['outerRadius'] as number;
          break;
        }
        const shLen = num(el, 'ShoulderLength', 0) / IN;
        const insideR = num(el, 'InsideDiameter', 0) / IN / 2;
        const podKids: ComponentNode[] = [];
        if (shLen > 0 && insideR > 0) {
          podKids.push({
            type: 'transition', id: freshId(), name: 'Fin can shoulder',
            length: shLen, foreRadius: insideR, aftRadius: canTube['outerRadius'] as number,
            thickness: 0.002, shape: 'conical',
          } as unknown as ComponentNode);
        }
        podKids.push(canTube);
        // Desktop hard-codes BOTTOM/0 and never reads <Location> or <Offset> —
        // RASAeroCommonConstants has no Offset constant at all, and
        // BaseHandler.java:52-53 parses <Location> into a field no handler
        // reads. Across the corpus <Offset> appears ONLY on <FinCan>, in three
        // designs, and is always −<Length> against a <Location> that is the HOST
        // TUBE'S AFT station (MESOS −8/8 at 66.85, Complex −6/6 at 55, Show-off
        // −2.34/2.34 at 8) — i.e. bottom-flush, desktop's answer exactly. So
        // honour the two fields only where they DISAGREE with flush, and say so
        // rather than silently trusting a convention nothing in the corpus
        // exercises.
        const locIn = num(el, 'Location', NaN);
        const offIn = num(el, 'Offset', NaN);
        const lenIn = num(el, 'Length', 12);
        let bottomOffM = 0;
        if (Number.isFinite(locIn) && Number.isFinite(offIn)) {
          const delta = (locIn + offIn + lenIn) - stationIn; // inches; 0 in every corpus file
          if (Math.abs(delta) > 0.001) {
            bottomOffM = delta / IN;
            notes.push(`This file’s fin can is not flush with the tube’s aft end — its <Location> ${locIn} `
              + `and <Offset> ${offIn} put it ${Math.abs(delta).toFixed(3)} in `
              + `${delta > 0 ? 'aft of' : 'ahead of'} that tube’s end. Imported that way; no RASAero file `
              + 'we hold does this, so check it.');
          }
        }
        lastTube.children = [...(lastTube.children ?? []), {
          type: 'podset', id: freshId(), name: 'Fin can',
          instanceCount: 1, radiusOffset: 0, radiusMethod: 'free', angleOffset: 0,
          position: { method: 'bottom', offset: bottomOffM },
          children: podKids,
        } as unknown as ComponentNode];
        notes.push('The RASAero fin can slides over the tube in front of it, so it is imported as a pod '
          + 'on “Body tube”, flush with that tube’s aft end — it adds no length. It shows in the tree '
          + 'as “Fin can”.');
        // The can's OD is the airframe radius at this station now — a following
        // boat tail narrows from IT, not from the tube it covers.
        stationAftRadius = canTube['outerRadius'] as number;
        // stationIn and lastTube deliberately unchanged: a pod occupies no chain.
        break;
      }
      case 'Booster': {
        const idx = stages.length;
        const stage: ComponentNode = {
          type: 'stage', id: freshId(),
          name: idx === 1 ? 'Booster' : `Booster ${idx}`, children: [],
        };
        const shoulderLen = num(el, 'ShoulderLength', 0);
        const insideDia = num(el, 'InsideDiameter', 0);
        if (shoulderLen > 0 && insideDia > 0) {
          stage.children!.push({
            type: 'transition', id: freshId(), name: `${stage.name} shoulder`,
            length: shoulderLen / IN,
            foreRadius: insideDia / IN / 2,
            aftRadius: num(el, 'Diameter', 4) / IN / 2,
            thickness: 0.002, shape: 'conical',
          } as ComponentNode);
        }
        const boosterTube = mkTube(el, `${stage.name} body tube`);
        stage.children!.push(boosterTube);
        const btLen = num(el, 'BoattailLength', 0);
        const btRear = num(el, 'BoattailRearDiameter', 0);
        if (btLen > 0 && btRear > 0) {
          stage.children!.push({
            type: 'transition', id: freshId(), name: `${stage.name} boat tail`,
            length: btLen / IN,
            foreRadius: num(el, 'Diameter', 4) / IN / 2,
            aftRadius: btRear / IN / 2,
            thickness: 0.002, shape: 'conical',
          } as ComponentNode);
        }
        stages.push(stage);
        /*
         * READ-ONLY cross-check, never a reposition. <Booster><Location> is the
         * SHOULDER start (2,4-D 70.875 with ShoulderLength 10; SS Wild Bash 47
         * then 83 = 47 + shoulder 3 + length 33), which is exactly `stationIn`
         * here once the fin can and a recessed boat tail have stopped inflating
         * it. Across the 54 distinct corpus designs it agrees to <0.001 in
         * EVERYWHERE except ThreeCarbYen-2018's second booster, whose stored
         * 170.625 sits 2.1875 in ahead of the stack — exactly booster 1's own
         * <ShoulderLength>, i.e. a cached <Location> RASAero never reflowed.
         * SS Wild Bash proves the opposite convention on the same shape, so the
         * corpus is 1-1 on the only two files that discriminate and desktop
         * breaks the tie: BoosterHandler.java:76-86 builds the shoulder as an
         * exposed Transition INSIDE the booster stage, which is what we build
         * above, and no desktop handler reads <Location> at all. So say the
         * numbers disagree and let the user decide; do not move the stage.
         */
        const boosterLocIn = num(el, 'Location', NaN);
        if (Number.isFinite(boosterLocIn) && Math.abs(boosterLocIn - stationIn) > 0.01) {
          notes.push(`${stage.name}: the file says it starts at ${boosterLocIn} in, but the parts above `
            + `it add up to ${stationIn.toFixed(3)} in. Built from the parts — a stale <Location> is the `
            + 'usual cause, but check this one against RASAero.');
        }
        stationIn += shoulderLen + num(el, 'Length', 12) + btLen;
        stationAftRadius = (btLen > 0 && btRear > 0)
          ? btRear / IN / 2
          : boosterTube['outerRadius'] as number;
        // A booster stage is its own axial chain — nothing above it can slide
        // over a lower stage, so lastTube must not survive into it.
        lastTube = undefined;
        break;
      }
      case 'Surface': case 'CD': case 'ModifiedBarrowman': case 'Turbulence':
      case 'SustainerNozzle': case 'Booster1Nozzle': case 'Booster2Nozzle':
      case 'UseBooster1': case 'UseBooster2': case 'Comments':
        break; // scalar design fields — Surface handled above, rest N/A
      default:
        ignored.add(el.tagName);
    }
  }

  if (stages.every((s) => (s.children ?? []).length === 0)) {
    throw new Error('No supported components found in this RASAero design.');
  }

  // ---- recovery: two indexed slots on <Recovery> ----
  const recovery = doc.querySelector('RASAeroDocument > Recovery');
  if (recovery) {
    const firstTube = sustainer.children!.find((c) => c.type === 'bodytube');
    for (const slot of [1, 2] as const) {
      if ((text(recovery, `:scope > Event${slot}`) ?? 'false').toLowerCase() !== 'true') continue;
      const eventType = text(recovery, `:scope > EventType${slot}`) ?? 'None';
      if (eventType === 'None') continue;
      const chute: ComponentNode = {
        type: 'parachute', id: freshId(),
        name: slot === 1 ? 'Drogue' : 'Main',
        diameter: num(recovery, `Size${slot}`, 36) / IN,
        cd: num(recovery, `CD${slot}`, 0) || undefined,
        deployEvent: eventType === 'Apogee' ? 'apogee' : 'altitude',
        position: { method: 'top', offset: 0.02 },
      } as ComponentNode;
      if (eventType === 'Altitude') {
        chute['deployAltitude'] = num(recovery, `Altitude${slot}`, 500) / FT;
      }
      if (firstTube) {
        firstTube.children = [...(firstTube.children ?? []), chute];
      } else {
        sustainer.children!.push(chute);
      }
    }
  }

  // ---- launch site: feet / °F / in-Hg / mph → SI (desktop LaunchSiteHandler) ----
  let launch: Partial<LaunchConditions> | undefined;
  const site = doc.querySelector('RASAeroDocument > LaunchSite');
  if (site) {
    launch = {};
    const alt = num(site, 'Altitude', NaN);
    if (!Number.isNaN(alt)) launch.launchAltitudeM = alt / FT;
    const temp = num(site, 'Temperature', NaN);
    if (!Number.isNaN(temp)) launch.temperatureC = (temp - 32) * 5 / 9;
    // RASAero writes <Pressure>0</Pressure> for "unset" — only >0 is a
    // reading. Unset means explicit ISA (null), never an ABSENT field: App
    // merges launch over the previous design's conditions, and an absent
    // pressure would let a stale barometric reading survive into this import.
    const press = num(site, 'Pressure', 0);
    launch.pressureHPa = press > 0 ? press * INHG : null;
    const rodAngle = num(site, 'RodAngle', NaN);
    if (!Number.isNaN(rodAngle)) launch.launchRodAngleDeg = rodAngle;
    const rodLen = num(site, 'RodLength', NaN); // FEET, unlike the part geometry
    if (!Number.isNaN(rodLen)) launch.launchRodLengthM = rodLen / FT;
    const wind = num(site, 'WindSpeed', NaN);
    if (!Number.isNaN(wind)) launch.windAverage = wind / MPH;
  }

  // ---- simulations → motors + flight configurations (desktop SimulationHandler) ----
  // Engine strings are 'DESIG  (MFG)'; a trailing -<digits|P> token on the
  // designation is a delay (AbstractMotorLoader.removeDelay strips it too).
  // 'NoThrust' is RASAero's placeholder for a stage flying without a motor.
  const parseEngine = (s: string): { designation: string; manufacturer: string; delay?: number } | null => {
    const parts = s.trim().split(/\s{2,}/);
    if (parts.length !== 2) return null;
    let designation = parts[0]!;
    let delay: number | undefined;
    const dm = designation.match(/-([0-9]+|[pP])$/);
    if (dm) {
      designation = designation.slice(0, designation.lastIndexOf('-'));
      delay = /^[0-9]+$/.test(dm[1]!) ? Number(dm[1]) : Infinity;
    }
    return { designation, manufacturer: parts[1]!.replace(/^\(|\)$/g, ''), delay };
  };
  /** RASAero's mount for a stage: its aft-most body tube (desktop getMotorMountForStage). */
  const aftTube = (stage: ComponentNode | undefined): ComponentNode | undefined => {
    const tubes = (stage?.children ?? []).filter((c) => c.type === 'bodytube');
    return tubes[tubes.length - 1];
  };

  const configs: OrkFlightConfig[] = [];
  // The file-order simulation number the USER sees in RASAero, keyed by config
  // id. Engine-less sims produce no configuration, so a config's position in
  // `configs` diverges from its number as soon as a file carries one — and the
  // notes below quote the number. Kept as data instead of being surgically
  // recovered from the id string, whose 'rasaero-sim-N' format is otherwise a
  // private naming choice.
  const simNumbers = new Map<string, number>();
  const unattached = new Set<string>();
  const sims = Array.from(doc.querySelectorAll('SimulationList > Simulation'));
  for (const [simIdx, sim] of sims.entries()) {
    const cfgMotors: Record<string, OrkMotorRef> = {};
    const separations: Record<string, OrkSeparationOverride> = {};
    const placed: { stageIdx: number; ref: OrkMotorRef }[] = [];
    const slots = [
      { engine: 'SustainerEngine', ignitionDelay: 'SustainerIgnitionDelay' },
      { engine: 'Booster1Engine', ignitionDelay: 'Booster1IgnitionDelay', separationDelay: 'Booster1SeparationDelay', include: 'IncludeBooster1' },
      { engine: 'Booster2Engine', separationDelay: 'Booster2Delay', include: 'IncludeBooster2' },
    ] as const;
    for (const [stageIdx, slot] of slots.entries()) {
      // The desktop passes IncludeBooster1/2 as enableMotorMount — a False
      // booster flies sustainer-only, its engine string notwithstanding.
      if ('include' in slot
          && (text(sim, `:scope > ${slot.include}`) ?? 'false').toLowerCase() !== 'true') {
        continue;
      }
      const engineStr = text(sim, `:scope > ${slot.engine}`);
      if (!engineStr || engineStr.includes('NoThrust')) continue;
      const eng = parseEngine(engineStr);
      const stage = stages[stageIdx];
      const mount = aftTube(stage);
      if (!eng || !stage?.id || !mount?.id) {
        unattached.add(engineStr);
        continue;
      }
      mount['motorMount'] = true;
      const ref: OrkMotorRef = {
        designation: eng.designation,
        manufacturer: eng.manufacturer, // RASAero abbreviation (AT/CTI/…) — informational
        diameter: 0, // unknown in the file — match by designation alone
        length: 0,
        // RASAero requires apogee deployment, so the sustainer motor is
        // PLUGGED (the desktop sets Motor.PLUGGED_DELAY = +Inf).
        delay: stageIdx === 0 ? Infinity : eng.delay ?? 0,
        mountId: mount.id,
        // Placeholder — which stage lights first is a property of the whole
        // simulation, not the slot; assigned after the slot loop below.
        ignitionEvent: 'burnout',
        ignitionDelay: 'ignitionDelay' in slot ? num(sim, slot.ignitionDelay, 0) : 0,
      };
      cfgMotors[mount.id] = ref;
      placed.push({ stageIdx, ref });
      if (stageIdx > 0 && 'include' in slot) { // include gate passed above
        separations[stage.id] = {
          separationEvent: 'burnout',
          separationDelay: num(sim, slot.separationDelay, 0),
        };
      }
    }
    if (placed.length === 0) continue; // engine-less sim: no configuration
    // Which motor lights at launch. Keying 'automatic' on the TREE's bottom
    // stage deadlocked any simulation that excludes it: stages come from PART
    // presence (a stage per <Booster>, the Use flags above only gate motors),
    // and the kernel resolves 'automatic' above the bottom stage as "previous
    // stage's ejection charge" — so a file whose every sim excludes the last
    // booster left even the sustainer waiting on a burnout that never comes,
    // and the kernel aborted "no motors ignited" with a chart of nothing.
    // Light the sim's own LOWEST motorized stage instead: 'automatic' when
    // that is the tree's bottom stage (desktop parity, unchanged), an explicit
    // 'launch' when an unpowered booster sits below it.
    const launchIdx = Math.max(...placed.map((p) => p.stageIdx));
    for (const p of placed) {
      if (p.stageIdx === launchIdx) {
        if (launchIdx === stages.length - 1) {
          p.ref.ignitionEvent = 'automatic';
        } else {
          // The slot-read delay dies with the rekeying: RASAero measures it
          // from the EXCLUDED stage below's burnout and ignores it when that
          // stage never flies — keeping it launch-relative would hold e.g. a
          // SustainerIgnitionDelay=8 rocket on the pad for 8 s of a flight
          // RASAero never produces. Same burnout-only guard the export side
          // applies to these fields.
          p.ref.ignitionEvent = 'launch';
          p.ref.ignitionDelay = 0;
        }
      }
    }
    const cfgId = `rasaero-sim-${simIdx + 1}`;
    simNumbers.set(cfgId, simIdx + 1);
    configs.push({
      id: cfgId, name: null, isDefault: configs.length === 0,
      motors: cfgMotors, deployments: {}, separations,
    });
  }
  // Which configuration to open. The first engine-carrying simulation is the
  // natural choice, but a RASAero file's first <Simulation> is often a
  // sustainer-only study — `<IncludeBooster1>False</IncludeBooster1>`, or a
  // booster engine string our parser cannot read — and the launch stage then has
  // no motor at all. The rocket sits on the pad: the kernel aborts with "no
  // motors ignited" and the user gets a chart of nothing, while a later
  // simulation in the same file flies. Prefer the first configuration that puts
  // a motor on the BOTTOM stage, which is the one that has to light first.
  const bottomStage = stages[stages.length - 1];
  // mountsIn's innertube/bodytube filter is vacuous on a tree this importer
  // built — the slot loop above sets `motorMount` on nothing but aftTube()'s
  // body tube — but keeping the shared walk means a future component type
  // gaining the flag behaves the same here as everywhere else.
  const bottomMountIds = new Set(
    mountsIn(bottomStage?.children ?? []).flatMap((m) => (m.id ? [m.id] : [])));
  const flyable = configs.find((c) => Object.keys(c.motors).some((id) => bottomMountIds.has(id)));
  const chosen = flyable ?? configs[0];
  if (flyable && configs[0] && flyable !== configs[0]) {
    const n = simNumbers.get(flyable.id)!;
    const firstN = simNumbers.get(configs[0].id)!;
    notes.push(
      `Simulation ${firstN} in this file puts no motor on the launch stage, so it would not `
      + `leave the pad. Simulation ${n} was opened instead — switch under Flight configurations.`);
  } else if (!flyable && chosen) {
    // NO simulation motors the bottom <Booster> at all — every Use flag is
    // False. RASAero flies those sims WITHOUT the booster; our tree keeps
    // every <Booster> part, so the launch keying above lights the lowest
    // motorized stage and the unpowered booster rides along. Say so, or the
    // extra stage reads as a bug when the numbers disagree with RASAero's.
    const n = simNumbers.get(chosen.id)!;
    const bottomName = bottomStage?.name ?? 'the bottom stage';
    notes.push(
      `No simulation in this file puts a motor on ${bottomName} — RASAero flies them without `
      + `it. Simulation ${n} was opened with its lowest motor igniting at launch, so ${bottomName} `
      + 'flies along unpowered. To match RASAero, delete that stage in the Design tab; to fly it '
      + 'powered, select its mount there and pick a motor.');
  }
  const motors: Record<string, OrkMotorRef> = { ...(chosen?.motors ?? {}) };
  const chosenConfigId = chosen?.id ?? null;
  const firstMotor = Object.values(motors)[0];
  // Bake the chosen configuration's separation onto its stage nodes, the way
  // importOrk does — App.applyImported applies configs, not stage settings, so
  // without this a fresh multi-stage import separates on the kernel default
  // (ejection charge, 0 s) instead of burnout + Booster1SeparationDelay.
  for (const [stageId, sep] of Object.entries(chosen?.separations ?? {})) {
    const stage = stages.find((s) => s.id === stageId);
    if (!stage) continue;
    if (sep.separationEvent && sep.separationEvent !== 'ejection') {
      stage['separationEvent'] = sep.separationEvent;
    }
    if (sep.separationDelay) stage['separationDelay'] = sep.separationDelay;
  }

  // ---- measured launch weight + CG -> stage mass/CG overrides ----
  /*
   * `<SustainerLaunchWt>` / `<SustainerCG>` and their Booster1/Booster2 twins
   * are the author's OWN as-flown numbers. We used to read them only to print
   * a note saying they were NOT applied, and fly the fabricated 2 mm-wall mass
   * distribution instead: over the 42-file TRF corpus that put 36 of the 39
   * files carrying a weight at under HALF their own stated loaded weight
   * (`OR vs RAS Test 1.CDX1` imported 2.020 lb against a stated 37.80 lb;
   * median 1.903 lb against 10.49 lb), which made the designs statically
   * UNSTABLE and is the cause behind 17 of the 72 flyable corpus designs
   * aborting — docs/research/trf-file-corpus-2026-08-25.md §1.
   *
   * Desktop OpenRocket 24.12 applies both, as a stage override covering the
   * subcomponents, with the motor backed out:
   * core/…/file/rasaero/importt/SimulationHandler.java:230-342 (mass) and
   * :344-524 (CG). This mirrors it. Two facts do all the work:
   *
   *  - The weights are CUMULATIVE STACK weights. SustainerLaunchWt is stage 0
   *    plus its motor; Booster1LaunchWt is stages 0-1 plus BOTH motors;
   *    Booster2LaunchWt is the whole stack plus all three. (Our own exporter
   *    documents the same convention at the SimulationList writer below, and
   *    RASAero's own two-stage file agrees: __fixtures__/Complex.Two-Stage.CDX1
   *    carries sustainer 4.06 lb against booster1 5.64 lb.) So a stage's own
   *    mass is its cumulative weight minus its motor minus the stack above it.
   *  - The CGs are cumulative AND motor-inclusive, so each is back-transformed
   *    twice: once against the stack above it, once against its own motor.
   *
   * The corpus proves the semantics to 0.1 %: `2,4-D.CDX1`'s sustainer
   * 13.3 lb − M1378LR 9.548 lb = 3.752 lb against the `.rkt` twin's own
   * `<Stage3Mass>` = 3.748 lb, and its booster 53.2 − N1000W 28.155 − 13.3 =
   * 11.745 lb against 11.700 lb.
   *
   * A WRONG override is worse than none — it looks authoritative and nothing
   * on screen can contradict it — so every branch below that cannot compute a
   * number it believes skips that stage, leaves today's behaviour in place,
   * and says so in the note.
   */

  /** Absolute x (m from the nose tip) of each stage's front — desktop's
   *  `stage.getPosition().x`. Stages stack AFTER one another (the kernel's
   *  default for an AxialStage, and this importer sets no stage position) and
   *  every stage child it builds is a length-carrying body component, so the
   *  running sum IS the stage front. */
  const nodeLength = (n: ComponentNode): number =>
    typeof n['length'] === 'number' ? (n['length'] as number) : 0;
  const stageLength = (st: ComponentNode | undefined): number =>
    (st?.children ?? []).reduce((sum, c) => sum + nodeLength(c), 0);
  const stageFrontX: number[] = [];
  for (let x = 0, i = 0; i < stages.length; i++) {
    stageFrontX.push(x);
    x += stageLength(stages[i]);
  }

  /**
   * The loaded mass and length of the motor the CHOSEN configuration puts on a
   * stage — our `getLaunchMass()`. `null` is desktop's `motor == null` (no
   * motor on that stage, so no motor term at all); `'unknown'` is a motor we
   * cannot weigh, which is NOT the same thing and must never be read as zero —
   * subtracting nothing would leave an unknown motor's mass inside the stage
   * override.
   *
   * The mass is the bundled catalog's `totalWeightG`, which is exactly what
   * the loaded motor will weigh in flight (`thrustcurve.ts` builds
   * `masses[0]` from it), so the override and the motor can never disagree.
   * 146 of the 1129 catalog entries publish no loaded weight — `hasMassData`
   * is the same guard the motor picker uses to disable those rows.
   */
  type StageMotor = { massKg: number; lengthM: number; label: string };
  const stageMotorOf = (stageIdx: number): StageMotor | null | 'absent' | 'unknown' => {
    const mount = aftTube(stages[stageIdx]);
    const ref = mount?.id ? chosen?.motors[mount.id] : undefined;
    if (!ref) return null;
    // RockSim/RASAero refs carry no motor diameter — match by designation
    // alone, the same call App.matchImportedMotor makes to load it.
    const db = findDbMotor(ref.designation);
    // NO catalog entry at all is not the same as an entry we cannot trust, and
    // the two must not skip together. With no entry App.matchImportedMotor
    // mounts NOTHING and says so, so the rocket really does fly with no motor
    // — which makes desktop's own `sustainerEngine == null` path (motor
    // weight 0, stated weight applied whole) exactly right, and is far closer
    // than the 2 mm-wall fabrication it replaces. Ten corpus designations land
    // here (J150-MY, M787, O4374, N5800-CS, ARA1200by9, ARA1100by8, L265-MY,
    // J326-LR, K1127LB, N2501-WH).
    if (!db) return 'absent';
    // An entry that exists but publishes no loaded weight (146 of 1129) is the
    // dangerous one and still skips: thrustcurve.ts takes `masses[0]` from the
    // DOWNLOADED file's header when it carries one, so this motor may well be
    // mounted WITH a real mass — and folding that unknown mass into the
    // airframe would be an authoritative-looking wrong number.
    if (!hasMassData(db) || !(db.length > 0)) return 'unknown';
    return { massKg: db.totalWeightG / 1000, lengthM: db.length / 1000, label: ref.designation };
  };

  /** Desktop `getCGFromCombinedCG` (SimulationHandler.java:487-492): the CG of
   *  B, given A's CG, the combined CG of A+B, and both masses. Callers must
   *  have checked `bMass > 0` — desktop does not, and divides by a stage mass
   *  of zero whenever the override above was skipped. */
  const cgFromCombined = (aMass: number, bMass: number, aCg: number, combinedCg: number): number =>
    combinedCg * (1 + aMass / bMass) - aCg * (aMass / bMass);

  /**
   * Desktop `getStageCGWithoutMotorCG` (:504-524). `combinedCg` is the CG of a
   * stage AND its motor measured from the nose tip; back the motor out to
   * leave the stage's own. Returns NaN when it cannot be done, never a guess.
   *
   * The motor's front sits at `mount front + mount length − motor length`
   * (BodyTube.getMotorPosition = `length − motorLength + overhang`, and this
   * importer sets no overhang), and its CG is half its length back — which is
   * literally the `cgX` our engine will use, `motor.length / 2000` in
   * thrustcurve.ts, i.e. desktop's `CGPoints[0].x`. Desktop's other branch
   * (`CGPoints` null or a single point) returns `combinedCg` unchanged and is
   * unreachable for a real thrust curve — every MotorSpec we build carries one
   * CG point per thrust sample — so only the branch below is mirrored.
   *
   * `stageMassKg` must be the OVERRIDDEN stage mass — desktop's comment at
   * :510 says the same thing about `stage.getMass()` — which is why each
   * stage's mass override is applied before its CG override below.
   */
  const cgWithoutMotor = (
    stageIdx: number, stageMassKg: number, motor: StageMotor | null, combinedCg: number,
  ): number => {
    if (!motor) return combinedCg;
    if (!(stageMassKg > 0)) return NaN; // no overridden mass to divide by
    const mount = aftTube(stages[stageIdx]);
    if (!mount) return combinedCg;
    let mountFrontX = stageFrontX[stageIdx] ?? 0;
    for (const c of stages[stageIdx]?.children ?? []) {
      if (c === mount) break;
      mountFrontX += nodeLength(c);
    }
    const motorFrontX = mountFrontX + nodeLength(mount) - motor.lengthM;
    return cgFromCombined(motor.massKg, stageMassKg, motorFrontX + motor.lengthM / 2, combinedCg);
  };

  const lbTxt = (kg: number): string => `${(kg * LB).toFixed(3)} lb`;
  const inTxt = (m: number): string => `${(m * IN).toFixed(2)} in`;

  // WHICH SIMULATION'S NUMBERS. Desktop applies the FIRST simulation that
  // carries them and ignores the rest. We deliberately differ: we apply the
  // CHOSEN configuration's, because the motor is backed out of these weights
  // and it has to be the motor we actually load — and `chosen` is often not
  // the first simulation (see the flyable-configuration pick above). Only
  // when NO simulation carries motors at all does the first simulation with
  // numbers win, and there is nothing to back out then.
  const carriesWeights = (sim: Element): boolean =>
    ['SustainerLaunchWt', 'SustainerCG', 'Booster1LaunchWt', 'Booster1CG',
      'Booster2LaunchWt', 'Booster2CG'].some((tag) => num(sim, tag, 0) !== 0);
  const chosenSimNr = chosen ? simNumbers.get(chosen.id) : undefined;
  const overrideSim = chosenSimNr !== undefined ? sims[chosenSimNr - 1] : sims.find(carriesWeights);
  /** Per-stage note fragments for what actually landed, and why anything didn't. */
  const massDetail: (string | undefined)[] = [];
  const cgDetail: (string | undefined)[] = [];
  const skipped: string[] = [];
  /** Stages whose stated weight was applied WITH an unidentified motor still in
   *  it — nothing is mounted there, so the figure is right for what flies, but
   *  the user has to know it is not a dry airframe mass. */
  const motorless: string[] = [];
  /** The overridden stage mass the CG pass divides by; undefined = not overridden. */
  const overrideMassKg: (number | undefined)[] = [];

  if (overrideSim) {
    // NaN stands in for desktop's `null` (element absent). 0 is RASAero's own
    // "not entered" and desktop skips it too — __fixtures__/ARCAS-Long - 2.CDX1
    // has SustainerLaunchWt 0, and Show-off.CDX1 keeps IncludeBooster1 True
    // over a 0 Booster1LaunchWt.
    const wt: [number, number, number] = [
      num(overrideSim, 'SustainerLaunchWt', NaN) / LB,
      num(overrideSim, 'Booster1LaunchWt', NaN) / LB,
      num(overrideSim, 'Booster2LaunchWt', NaN) / LB,
    ];
    const cg: [number, number, number] = [
      num(overrideSim, 'SustainerCG', NaN) / IN,
      num(overrideSim, 'Booster1CG', NaN) / IN,
      num(overrideSim, 'Booster2CG', NaN) / IN,
    ];
    const include: [boolean, boolean, boolean] = [true,
      (text(overrideSim, ':scope > IncludeBooster1') ?? 'false').toLowerCase() === 'true',
      (text(overrideSim, ':scope > IncludeBooster2') ?? 'false').toLowerCase() === 'true'];
    type SlotMotor = StageMotor | null | 'absent' | 'unknown';
    const motor: [SlotMotor, SlotMotor, SlotMotor] =
      [stageMotorOf(0), stageMotorOf(1), stageMotorOf(2)];
    const stageName = (i: number): string => stages[i]?.name ?? `Stage ${i}`;

    // Desktop runs every mass override and THEN every CG override. One pass
    // per stage is the same computation — a stage's CG needs only its OWN
    // overridden mass, plus the file's (not the override's) numbers for the
    // stack above — and it keeps each stage's two decisions and its one skip
    // message together. The mass still lands before the CG inside the
    // iteration, which is the ordering that actually matters.
    for (const i of [0, 1, 2] as const) {
      const st = stages[i];
      // Desktop gates both booster overrides on IncludeBooster1/2 — an
      // excluded booster's cells describe a stack it is not part of.
      if (!st || !include[i]) continue;
      // Cumulative weight/CG of everything above this stage. Stage 0 has
      // nothing above it; a booster needs the stage above to have stated a
      // weight at all (desktop's `sustainerLaunchWt == null` guard).
      const above = i === 0 ? 0 : wt[i - 1]!;
      const cgAbove = i === 0 ? 0 : cg[i - 1]!;
      // A 0 above is "not entered" too, and must disqualify the subtraction the
      // same way a 0 here does — this is a DELIBERATE divergence from desktop,
      // which guards booster1 on `sustainerLaunchWt == null` but not on
      // `== 0`. We have to be stricter because OUR OWN exporter writes 0 into
      // every stage above the last (see exportCdx1's stackWt: only the bottom
      // stage's cumulative vehicle is the whole rocket, so only its cells can
      // be filled). Reading that 0 back as a real weight subtracts nothing and
      // lands the ENTIRE stack mass on the booster alone, on top of the
      // sustainer's own fabricated mass — mass inflated, CG wrong, a stable
      // design flipped unstable, compounding on every import→export→import.
      const hasWt = Number.isFinite(wt[i]) && wt[i] !== 0
        && (i === 0 || (Number.isFinite(above) && above !== 0));
      const hasCg = cg[i] > 0 && (i === 0 || cgAbove > 0);
      if (!hasWt && !hasCg) continue;

      const slot = motor[i];
      if (slot === 'unknown') {
        // The entry exists but publishes no loaded weight, and the download may
        // still supply one — so this motor could be mounted with a real mass we
        // did not subtract. Applying the weight anyway would fold that mass
        // into the airframe.
        const ref = chosen?.motors[aftTube(st)?.id ?? ''];
        const stated = [hasWt ? lbTxt(wt[i]) : null, hasCg ? `CG ${inTxt(cg[i])}` : null]
          .filter((s): s is string => s !== null).join(' / ');
        skipped.push(`${stageName(i)}: “${ref?.designation ?? '?'}” isn’t in the motor database with a `
          + `loaded weight, so it can’t be taken back out of the stated ${stated}.`);
        continue;
      }
      // 'absent' takes desktop's engine-less path: nothing is mounted for this
      // stage, so there is no motor mass to subtract and the stated figures
      // describe the airframe as it will fly here.
      const m = slot === 'absent' ? null : slot;
      if (slot === 'absent' && hasWt) {
        const ref = chosen?.motors[aftTube(st)?.id ?? ''];
        motorless.push(`${stageName(i)}: “${ref?.designation ?? '?'}” isn’t in the motor database, so `
          + `no motor is loaded on it and the stated ${lbTxt(wt[i])} is used as it stands — `
          + 'it still includes that motor’s weight.');
      }

      // ---- mass (desktop applySustainer/Booster1/Booster2MassOverride) ----
      if (hasWt) {
        if (i > 0 && above > wt[i]) {
          // Desktop warns here and overrides with a mass of 0 (:286-288). A
          // zero-mass stage is exactly the authoritative-looking wrong number
          // this whole block exists to avoid, so we skip instead and say why.
          skipped.push(`${stageName(i)}: its ${lbTxt(wt[i])} is LESS than the ${lbTxt(above)} stated for `
            + 'the stack above it, which cannot be — the file’s weights disagree with themselves.');
        } else {
          const dry = wt[i] - (m?.massKg ?? 0) - above;
          if (dry > 0) {
            st['overrideMass'] = dry;
            st['overrideSubcomponentsMass'] = true;
            overrideMassKg[i] = dry;
            massDetail[i] = `${lbTxt(wt[i])}${m ? ` − ${m.label} ${lbTxt(m.massKg)}` : ''}`
              + `${above > 0 ? ` − ${lbTxt(above)} above` : ''} = ${lbTxt(dry)}`;
          } else {
            skipped.push(`${stageName(i)}: backing ${m ? `${m.label} (${lbTxt(m.massKg)}) ` : ''}`
              + `out of its ${lbTxt(wt[i])} leaves ${lbTxt(dry)}, which is not a mass.`);
          }
        }
      }

      // ---- CG (desktop applyCGOverrides, :353-475) ----
      if (!hasCg) continue;
      // The file's CG is of the whole stack down to here, so back-transform
      // against the stack above (desktop applyBooster1/2CGOverride) before
      // removing this stage's own motor. Stage 0 has no stack above it.
      let combined = cg[i];
      if (i > 0) {
        const ownStackMass = wt[i] - above;
        if (!(ownStackMass > 0)) continue; // guarded: desktop divides by this
        combined = cgFromCombined(above, ownStackMass, cgAbove, cg[i]);
      }
      const noseCg = cgWithoutMotor(i, overrideMassKg[i] ?? 0, m, combined);
      // Desktop references a booster's override to the front of the BOOSTER,
      // not to the nose (:427) — an override CG is always component-relative.
      const stageCg = noseCg - (stageFrontX[i] ?? 0);
      const len = stageLength(st);
      if (!(stageCg >= 0) || stageCg > len) {
        // Outside the stage's own extent is not a CG the file can mean — a
        // stage's mass is inside the stage. Either the file's numbers
        // disagree with each other or our airframe does not match the one
        // RASAero laid out, and in both cases the honest move is to leave the
        // computed CG alone. (Until v0.102 our airframe was the usual culprit:
        // stacking the fin can and the recessed boat tail end-to-end pushed
        // every booster stage aft of where RASAero puts it, which is what made
        // Complex.Two-Stage's booster CG land ahead of the booster's own front.
        // With the pods in place that file's override applies, and this branch
        // is back to meaning what it says.)
        skipped.push(`${stageName(i)}: its stated CG ${inTxt(cg[i])} works out to `
          + `${Number.isFinite(stageCg) ? inTxt(stageCg) : 'no computable place'} into a ${inTxt(len)} `
          + 'stage once the motor and the stack above are backed out, which is outside the stage.');
        continue;
      }
      st['overrideCGX'] = stageCg;
      st['overrideSubcomponentsCG'] = true;
      cgDetail[i] = `CG ${inTxt(stageCg)}${i > 0 ? ' from its own front' : ''}`;
    }
  }

  // Only when EVERY stage got both overrides is the 2 mm wall out of the
  // picture: one stage left on the computed mass or CG and the caveat still
  // applies to it. (RASAero holds at most three stages, so a longer tree could
  // only come from a file this importer misread — treat it as not covered.)
  const overrodeEveryStage = stages.length <= 3
    && stages.every((_, i) => overrideMassKg[i] !== undefined && cgDetail[i] !== undefined);

  // ---- design-level conditions table (Mach -> altitude) ----
  const machAlt = readMachAltTable(doc);

  // ---- what RASAero can't tell us (be honest, don't invent) ----
  notes.push(overrodeEveryStage
    ? 'RASAero designs carry no material or wall data — walls default to 2 mm, but every stage’s '
      + 'mass and CG come from the simulation’s measured launch weight below, so the wall default '
      + 'does not drive the numbers.'
    : 'RASAero designs carry no material or wall data — walls default to 2 mm; review masses before trusting the numbers.');
  if (machAlt) {
    const topFt = Math.round(Math.max(...machAlt.map(([, a]) => a)) * FT);
    notes.push(`This file carries a Mach-Alt conditions table (${machAlt.length} point${machAlt.length === 1 ? '' : 's'}, `
      + `to ${topFt} ft) — pick it under Drag analysis → Conditions to sweep at the `
      + 'file’s altitudes instead of sea level.');
  }
  if (unattached.size) {
    notes.push(`Motors in the RASAero file with no stage tube to mount them on: ${[...unattached].join(', ')} — add a body tube and pick them from the database.`);
  }
  // What the measured weight/CG actually did, per stage, in the file's own
  // units — and separately what it could not do. A number that changes has to
  // say so, and an override the user cannot see is exactly the failure this
  // block replaces.
  const appliedParts = stages.flatMap((st, i) => {
    const bits = [massDetail[i], cgDetail[i]].filter((s): s is string => s !== undefined);
    return bits.length > 0 ? [`${st.name ?? `Stage ${i}`} ${bits.join(', ')}`] : [];
  });
  if (appliedParts.length > 0) {
    const simTxt = chosenSimNr !== undefined ? `simulation ${chosenSimNr}` : 'the RASAero simulation';
    notes.push(`Applied from ${simTxt}, as stage overrides with the motor backed out (desktop OpenRocket `
      + `does the same): ${appliedParts.join('; ')}. Each replaces the computed mass or CG for that whole `
      + 'stage — clear it under Overrides to go back to the 2 mm-wall geometry.');
  }
  if (skipped.length > 0) {
    notes.push('NOT applied from the RASAero simulation, because the numbers don’t support an override '
      + `— these stages keep the computed 2 mm-wall mass and CG: ${skipped.join(' ')}`);
  }
  if (motorless.length > 0) {
    notes.push('Applied WITH the motor still included, because the file names a motor that isn’t in '
      + `the database — nothing is loaded on those stages: ${motorless.join(' ')}`);
  }
  if (ignored.size) {
    notes.push(`Ignored RASAero elements: ${[...ignored].join(', ')}.`);
  }

  const name = (text(design, ':scope > Comments') ?? '').split('\n')[0]?.trim()
    || 'Imported RASAero rocket';
  return {
    name, tree: { name, components: stages },
    ...(firstMotor ? { motor: firstMotor } : {}), motors,
    ignored: [...ignored], notes,
    ...(launch ? { launch } : {}),
    ...(machAlt ? { machAlt } : {}),
    configs, chosenConfigId,
  };
}

// ============================ EXPORT ============================

/** The slice of a motor assignment the engine-string writer reads — the .ork
    export map (OrkExportMotor) satisfies it verbatim, extra fields ignored. */
export interface Cdx1ExportEngine {
  designation: string;
  manufacturer?: string;
  /** Kernel ignition-event name; only 'burnout' has a delay RASAero can hold. */
  ignitionEvent?: string;
  /** Seconds after the stage below's burnout (RASAero's own semantics). */
  ignitionDelay?: number;
}

export interface Cdx1ExportInput {
  name: string;
  tree: RocketTree;
  /** Loaded launch mass (kg) and CG (m), for the mandatory simulation block. */
  launchMassKg?: number;
  launchCgM?: number;
  /** Launch panel conditions (SI) for <LaunchSite>; RASAero defaults when absent. */
  launch?: Partial<LaunchConditions>;
  /**
   * The design's Mach-Alt conditions table (SI), written back as `<MachAlt>`
   * rows in feet. Absent ⇒ the empty `<MachAlt></MachAlt>` element we have
   * always written, which is RASAero's "no table set".
   */
  machAlt?: MachAltTable;
  /**
   * Assigned motors keyed by mount node id — App's exportMotorsMap() works
   * verbatim. Only read when engine export is enabled (CDX1_ENGINE_EXPORT):
   * each stage's first mounted motor becomes its Engine string.
   */
  motors?: Record<string, Cdx1ExportEngine>;
  /** Engine-string override for tests and file generation; defaults to the
      CDX1_ENGINE_EXPORT gate. */
  engineExport?: boolean;
}

const FIN_MIN = 3;
const FIN_MAX = 8;

export function exportCdx1({ name, tree, launchMassKg, launchCgM, launch, motors, engineExport, machAlt }: Cdx1ExportInput): string {
  const stagesIn = asStageNodes(tree);
  if (stagesIn.length > 3) throw new Error('RASAero supports at most 3 stages.');

  // Per-stage engine strings, desktop format 'DESIGNATION  (ABBREV)' — two
  // spaces, the exact shape our own importer's parseEngine reads back. null =
  // no motor on the stage, or a manufacturer RASAero doesn't document (the
  // NRE risk: see CDX1_ENGINE_EXPORT). ON by default since 2026-08-25;
  // `engineExport: false` is the per-call opt-out (tests, file generation).
  const engineOn = engineExport ?? CDX1_ENGINE_EXPORT;
  // One record per stage: engine string plus its ignition delay, computed
  // TOGETHER so the two can never desync. RASAero holds one delay per stage
  // and measures it from the stage below's burnout, which is exactly what
  // importCdx1 reads back as `ignitionEvent: 'burnout'`. Writing a hard 0
  // (what we used to do) silently dropped a staged design's timers on every
  // .CDX1 export — and the first fix filled a parallel delays array by
  // side-effect pushes on each of the map's exit paths, one future
  // early-return away from writing Booster1's delay into the Sustainer cell.
  const stageSlots = stagesIn.map((st): { engine: string | null; ignitionDelay: number } => {
    if (!engineOn || !motors) return { engine: null, ignitionDelay: 0 };
    let found: Cdx1ExportEngine | undefined;
    const seek = (nodes: ComponentNode[]) => {
      for (const n of nodes) {
        if (found) return;
        if (n.id && motors[n.id]) { found = motors[n.id]; return; }
        seek(n.children ?? []);
      }
    };
    seek(st.children ?? []); // one engine per stage in RASAero — first mount wins
    // Only a burnout-triggered motor has a delay this format can express; a
    // launch-stage motor, or any other ignition event, writes RASAero's own 0.
    const ignitionDelay = found?.ignitionEvent === 'burnout' ? (found.ignitionDelay ?? 0) : 0;
    const abbrev = found ? rasaeroManufacturerAbbrev(found.manufacturer) : null;
    return {
      engine: found && abbrev ? `${found.designation}  (${abbrev})` : null,
      ignitionDelay,
    };
  });
  const stageEngines = stageSlots.map((s) => s.engine);
  const stageIgnitionDelays = stageSlots.map((s) => s.ignitionDelay);

  const nnum = (node: ComponentNode, key: string, fb: number): number =>
    typeof node[key] === 'number' ? (node[key] as number) : fb;
  const fmt = (v: number): string => {
    const s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  };
  const lines: string[] = [];
  const emit = (s: string) => lines.push(s);

  let locM = 0; // running absolute location (nose tip origin)

  /** Trapezoid planform of a fin set (m), or null when it has none. */
  const finPlanform = (fin: ComponentNode): { root: number; tip: number; sweep: number; height: number } | null => {
    if (fin.type === 'trapezoidfinset') {
      return {
        root: nnum(fin, 'rootChord', 0.05),
        tip: nnum(fin, 'tipChord', 0.03),
        sweep: nnum(fin, 'sweep', 0),
        height: nnum(fin, 'height', 0.03),
      };
    }
    if (fin.type === 'freeformfinset') {
      // Exact conversion for trapezoid-shaped outlines — including the ones
      // our own importer synthesizes for fins on transitions/boat tails.
      const pts = (fin['points'] as [number, number][] | undefined) ?? [];
      const eps = 1e-9;
      const flat = (v: number) => Math.abs(v) < eps;
      if (pts.length === 4 && flat(pts[0]![1]) && flat(pts[3]![1])
          && Math.abs(pts[1]![1] - pts[2]![1]) < eps && pts[1]![1] > 0
          && pts[2]![0] >= pts[1]![0] - eps) {
        return {
          root: pts[3]![0] - pts[0]![0],
          tip: pts[2]![0] - pts[1]![0],
          sweep: pts[1]![0] - pts[0]![0],
          height: pts[1]![1],
        };
      }
      if (pts.length === 3 && flat(pts[0]![1]) && flat(pts[2]![1]) && pts[1]![1] > 0) {
        return {
          root: pts[2]![0] - pts[0]![0],
          tip: 0,
          sweep: pts[1]![0] - pts[0]![0],
          height: pts[1]![1],
        };
      }
    }
    return null;
  };

  const finXml = (parent: ComponentNode): void => {
    const finSets = (parent.children ?? []).filter((c) => c.type.endsWith('finset'));
    if (finSets.length === 0) return;
    if (finSets.length > 1) {
      throw new Error('RASAero allows ONE fin set per tube — remove extras or export as .ork/.rkt.');
    }
    const fin = finSets[0]!;
    const plan = finPlanform(fin);
    if (!plan) {
      // Never drop fins silently — an aero program with no fins is a
      // radically different rocket.
      throw new Error(fin.type === 'freeformfinset'
        ? `RASAero fins are trapezoids — the freeform outline of “${fin.name ?? 'Fins'}” isn't a simple 3/4-point trapezoid. Simplify it or export as .ork/.rkt.`
        : `RASAero has no ${fin.type === 'ellipticalfinset' ? 'elliptical' : 'tube'} fins — “${fin.name ?? 'Fins'}” can't be exported. Use trapezoid fins or export as .ork/.rkt.`);
    }
    const count = Math.round(nnum(fin, 'finCount', 3));
    if (count < FIN_MIN || count > FIN_MAX) {
      throw new Error(`RASAero needs 3–8 fins per set (found ${count}). Adjust "${fin.name ?? 'Fins'}".`);
    }
    const pos = fin.position ?? { method: 'bottom', offset: 0 };
    // Convert any position method to a bottom-referenced offset (of the fin's
    // trailing edge vs the tube's aft end) — silently zeroing top/middle
    // offsets used to shift the fins to the tube bottom.
    const tubeLen = nnum(parent, 'length', 0);
    const bottomOffset = pos.method === 'bottom' ? pos.offset
      : pos.method === 'top' ? pos.offset + plan.root - tubeLen
      : pos.method === 'middle' ? pos.offset + (plan.root - tubeLen) / 2
      : 0; // 'absolute' has no tube-relative meaning here
    // Fin Location = front edge from the tube bottom (inches).
    const locIn = (plan.root - bottomOffset) * IN;
    const cs = String(fin['crossSection'] ?? 'square');
    // A supersonic airfoil section (feature #4) beats the plain cross section.
    // FX3 is only real for Hexagonal — RASAero derives the other TEs itself
    // (a double wedge's TE is mean chord − FX1, see the importer).
    const section = SECTION_TO_AIRFOIL[String(fin['airfoilSection'] ?? '')];
    // No <PartType> inside <Fin> — neither RASAero's own files nor the
    // desktop exporter write one, and RASAero's parser is rigid.
    emit('<Fin>');
    emit(`<Count>${count}</Count>`);
    emit(`<Chord>${fmt(plan.root * IN)}</Chord>`);
    emit(`<Span>${fmt(plan.height * IN)}</Span>`);
    emit(`<SweepDistance>${fmt(plan.sweep * IN)}</SweepDistance>`);
    emit(`<TipChord>${fmt(plan.tip * IN)}</TipChord>`);
    emit(`<Thickness>${fmt(nnum(fin, 'thickness', 0.003) * IN)}</Thickness>`);
    emit(`<LERadius>${section ? fmt(nnum(fin, 'finLeRadius', 0) * IN) : '0'}</LERadius>`);
    emit(`<Location>${fmt(locIn)}</Location>`);
    emit(`<AirfoilSection>${section ?? (cs === 'airfoil' ? 'Subsonic NACA' : cs === 'rounded' ? 'Rounded' : 'Square')}</AirfoilSection>`);
    emit(`<FX1>${section ? fmt(nnum(fin, 'airfoilLeDiamond', 0) * IN) : '0'}</FX1>`);
    emit(`<FX3>${fin['airfoilSection'] === 'hexagonal' ? fmt(nnum(fin, 'airfoilTeDiamond', 0) * IN) : '0'}</FX3>`);
    emit('</Fin>');
  };

  /**
   * `<Protuberance>` block for a body tube, the mirror of readProtuberances:
   * frontal areas summed per class into square inches, inclined flat plates
   * grouped by their plate angle into RASAero's two slots (largest area first).
   *
   * Emitted ONLY inside `<BodyTube>` — the one place a RASAero-written file is
   * known to carry it. `<Booster>` exposes the same protuberance-family fields
   * (LaunchLug/RailGuide/LaunchShoe) but no sample writes a `<Protuberance>`
   * there, and this parser is rigid (see the no-`<PartType>`-inside-`<Fin>`
   * note above), so a booster's protuberances drop — the same way the booster
   * block already drops launch lugs.
   */
  const protuberanceXml = (node: ComponentNode): void => {
    const IN2 = IN * IN; // in² per m²
    const prots = (node.children ?? []).filter((c) => (c.type as string) === 'protuberance');
    if (prots.length === 0) return;
    const areaOf = (p: ComponentNode) =>
      nnum(p, 'width', 0) * nnum(p, 'height', 0)
      * Math.max(1, Math.round(nnum(p, 'count', 1))) * IN2;
    let noBase = 0;
    let withBase = 0;
    const plates = new Map<number, number>(); // plate angle (deg, rounded) -> in²
    for (const p of prots) {
      const cls = String(p['dragClass'] ?? 'streamlinedbase');
      const a = areaOf(p);
      if (!(a > 0)) continue;
      if (cls === 'streamlined') noBase += a;
      else if (cls === 'plate') {
        const deg = Math.round((nnum(p, 'plateAngle', Math.PI / 4) * 180) / Math.PI * 100) / 100;
        plates.set(deg, (plates.get(deg) ?? 0) + a);
      } else withBase += a;
    }
    // RASAero has exactly two inclined-plate slots. With more distinct angles,
    // fold the smaller remainder into the nearest kept angle rather than drop
    // it — losing frontal area is losing drag, which is the defect this fixes.
    const sorted = [...plates.entries()].sort((a, b) => b[1] - a[1]);
    const kept = sorted.slice(0, 2);
    for (const [deg, a] of sorted.slice(2)) {
      let best = 0;
      for (let i = 1; i < kept.length; i++) {
        if (Math.abs(kept[i]![0] - deg) < Math.abs(kept[best]![0] - deg)) best = i;
      }
      kept[best]![1] += a;
    }
    emit('<Protuberance>');
    emit(`<StreamlinedNoBaseDrag>${fmt(noBase)}</StreamlinedNoBaseDrag>`);
    emit(`<StreamlinedWithBaseDrag>${fmt(withBase)}</StreamlinedWithBaseDrag>`);
    for (const i of [0, 1] as const) {
      const slot = kept[i];
      emit(`<InclinedPlate${i + 1}Angle>${slot ? fmt(slot[0]) : '0'}</InclinedPlate${i + 1}Angle>`);
      emit(`<InclinedPlate${i + 1}FrontalArea>${slot ? fmt(slot[1]) : '0'}</InclinedPlate${i + 1}FrontalArea>`);
    }
    emit('</Protuberance>');
  };

  const noseXml = (node: ComponentNode) => {
    const shape = String(node['shape'] ?? 'ogive');
    const param = nnum(node, 'shapeParameter', NaN);
    let rasShape: string;
    let powerLaw: number | null = null;
    if (shape === 'conical') rasShape = 'Conical';
    else if (shape === 'ogive') rasShape = 'Tangent Ogive';
    else if (shape === 'ellipsoid') rasShape = 'Elliptical';
    else if (shape === 'haack') rasShape = !Number.isNaN(param) && Math.abs(param - 0.33) < 0.01 ? 'LV-Haack' : 'Von Karman Ogive';
    else if (shape === 'power') { rasShape = 'Power Law'; powerLaw = Number.isNaN(param) ? 0.5 : param; }
    else throw new Error(`RASAero has no "${shape}" nose shape — use conical/ogive/ellipsoid/haack/power, or export as .ork/.rkt.`);
    const len = nnum(node, 'length', 0.07);
    emit('<NoseCone>');
    emit('<PartType>NoseCone</PartType>');
    emit(`<Length>${fmt(len * IN)}</Length>`);
    emit(`<Diameter>${fmt(nnum(node, 'aftRadius', 0.012) * 2 * IN)}</Diameter>`);
    emit(`<Shape>${rasShape}</Shape>`);
    emit('<BluntRadius>0</BluntRadius>');
    emit(`<Location>${fmt(locM * IN)}</Location>`);
    emit('<Color>Black</Color>');
    if (powerLaw !== null) emit(`<PowerLaw>${fmt(powerLaw)}</PowerLaw>`);
    emit('</NoseCone>');
    locM += len;
  };

  /**
   * The two RASAero parts that live in an INLINE POD on a body tube rather than
   * in the axial chain — a `<FinCan>` sliding over the tube, and a `<BoatTail>`
   * recessed into the booster below — written back out as siblings of the
   * `</BodyTube>` they hang off, in the corpus's own part order (fin can, then
   * boat tail).
   *
   * This is the mirror of the importer's fin-can and boat-tail branches, and it
   * has to exist in the same change: once those two stopped being stage-level
   * children, the stage walk below (nosecone|bodytube|transition) stopped seeing
   * them at all, and a Show-off round trip dropped from 6 parts to 5 — a new
   * silent data loss worse than the mis-stationed `<BodyTube>` it replaced.
   *
   * It also goes BEYOND desktop, which loses both on export: RocketDesignDTO.java
   * :87-120 walks `sustainer.getChild(i)` and handles only BodyTube, NoseCone
   * and Transition — a PodSet falls to the `else` and is reported as an export
   * error, so a desktop-imported fin can never comes back out. Round-tripping
   * our own import matters more here than matching that.
   *
   * `locM` must NOT move for either — a pod occupies no axial length, which is
   * the whole point of this item.
   */
  const podXml = (host: ComponentNode, hostLen: number) => {
    for (const pod of (host.children ?? []).filter((c) => (c.type as string) === 'podset')) {
      const kids = (pod.children ?? []).filter(
        (c) => c.type === 'bodytube' || c.type === 'transition',
      );
      const pos = pod.position ?? { method: 'bottom', offset: 0 };
      const canTube = kids.find((c) => c.type === 'bodytube');
      const shoulder = kids[0] !== canTube && kids[0]?.type === 'transition' ? kids[0] : undefined;
      if (canTube && (kids.length === 1 || (kids.length === 2 && shoulder
        && nnum(shoulder, 'foreRadius', 0) <= nnum(shoulder, 'aftRadius', 0)))) {
        // FIN CAN. <Location> is the HOST tube's aft station and <Offset> is the
        // can's front measured from it — negative, and exactly −<Length> when
        // the can is flush, which is what the three corpus fin cans all carry
        // (MESOS −8/8, Complex −6/6, Show-off −2.34/2.34).
        const canLen = nnum(canTube, 'length', 0.15);
        const chainLen = canLen + (shoulder ? nnum(shoulder, 'length', 0) : 0);
        // Any axial method → the can's aft end relative to the host's aft end.
        const bottomOff = pos.method === 'bottom' ? pos.offset
          : pos.method === 'top' ? pos.offset + chainLen - hostLen
            : pos.method === 'middle' ? pos.offset + (chainLen - hostLen) / 2
              : 0; // 'absolute' has no host-relative meaning here
        const lug = (canTube.children ?? []).find((c) => c.type === 'launchlug');
        emit('<FinCan>');
        emit('<PartType>FinCan</PartType>');
        emit(`<Length>${fmt(canLen * IN)}</Length>`);
        emit(`<Diameter>${fmt(nnum(canTube, 'outerRadius', 0.012) * 2 * IN)}</Diameter>`);
        emit(`<InsideDiameter>${fmt((shoulder ? nnum(shoulder, 'foreRadius', 0.012)
          : nnum(host, 'outerRadius', 0.012)) * 2 * IN)}</InsideDiameter>`);
        emit(`<LaunchLugDiameter>${fmt(lug ? nnum(lug, 'outerRadius', 0.0022) * 2 * IN : 0)}</LaunchLugDiameter>`);
        emit(`<LaunchLugLength>${fmt(lug ? nnum(lug, 'length', 0.05) * IN : 0)}</LaunchLugLength>`);
        emit('<RailGuideDiameter>0</RailGuideDiameter>');
        emit('<RailGuideHeight>0</RailGuideHeight>');
        emit('<LaunchShoeArea>0</LaunchShoeArea>');
        emit(`<Location>${fmt((locM + hostLen) * IN)}</Location>`);
        emit(`<ShoulderLength>${fmt((shoulder ? nnum(shoulder, 'length', 0) : 0) * IN)}</ShoulderLength>`);
        emit(`<Offset>${fmt((bottomOff - canLen) * IN)}</Offset>`);
        emit('<Color>Black</Color>');
        // No <Protuberance> here: no RASAero-written fin can in the 54-design
        // corpus carries one, and this parser is rigid — the same reasoning
        // that keeps the block out of <Booster>.
        finXml(canTube);
        emit('</FinCan>');
        continue;
      }
      const bt = kids.length === 1 && kids[0]!.type === 'transition' ? kids[0]! : undefined;
      if (bt && nnum(bt, 'foreRadius', 0) > nnum(bt, 'aftRadius', 0)) {
        // RECESSED BOAT TAIL. The importer builds it TOP / hostLen, so its
        // <Location> is the host tube's aft station — the same station the
        // <Booster> below it claims, which is exactly the overlap.
        const topOff = pos.method === 'top' ? pos.offset
          : pos.method === 'bottom' ? pos.offset + hostLen - nnum(bt, 'length', 0.04)
            : pos.method === 'middle' ? pos.offset + (hostLen - nnum(bt, 'length', 0.04)) / 2
              : 0;
        if (String(bt['shape'] ?? 'conical') !== 'conical') {
          throw new Error('RASAero boat tails must be conical — change the shape or export as .ork/.rkt.');
        }
        emit('<BoatTail>');
        emit('<PartType>BoatTail</PartType>');
        emit(`<Length>${fmt(nnum(bt, 'length', 0.04) * IN)}</Length>`);
        emit(`<Diameter>${fmt(nnum(bt, 'foreRadius', 0.012) * 2 * IN)}</Diameter>`);
        emit(`<RearDiameter>${fmt(nnum(bt, 'aftRadius', 0.009) * 2 * IN)}</RearDiameter>`);
        emit(`<Location>${fmt((locM + topOff) * IN)}</Location>`);
        emit('<Color>Black</Color>');
        finXml(bt); // RASAero boat tails carry fins too
        emit('</BoatTail>');
        continue;
      }
      // Any other pod (a real off-axis assembly the user built by hand) has no
      // RASAero representation and drops, the same way the stage walk drops
      // internals — RASAero's airframe is one axial chain plus these two.
    }
  };

  const tubeXml = (node: ComponentNode) => {
    const len = nnum(node, 'length', 0.2);
    emit('<BodyTube>');
    emit('<PartType>BodyTube</PartType>');
    emit(`<Length>${fmt(len * IN)}</Length>`);
    emit(`<Diameter>${fmt(nnum(node, 'outerRadius', 0.012) * 2 * IN)}</Diameter>`);
    const lug = (node.children ?? []).find((c) => c.type === 'launchlug');
    emit(`<LaunchLugDiameter>${fmt(lug ? nnum(lug, 'outerRadius', 0.0022) * 2 * IN : 0)}</LaunchLugDiameter>`);
    emit(`<LaunchLugLength>${fmt(lug ? nnum(lug, 'length', 0.05) * IN : 0)}</LaunchLugLength>`);
    emit('<RailGuideDiameter>0</RailGuideDiameter>');
    emit('<RailGuideHeight>0</RailGuideHeight>');
    emit('<LaunchShoeArea>0</LaunchShoeArea>');
    emit(`<Location>${fmt(locM * IN)}</Location>`);
    emit('<Color>Black</Color>');
    emit('<BoattailLength>0</BoattailLength>');
    emit('<BoattailRearDiameter>0</BoattailRearDiameter>');
    emit('<BoattailOffset>0</BoattailOffset>');
    emit('<Overhang>0</Overhang>');
    finXml(node);
    protuberanceXml(node);
    emit('</BodyTube>');
    podXml(node, len);
    locM += len;
  };

  const transitionXml = (node: ComponentNode) => {
    if (String(node['shape'] ?? 'conical') !== 'conical') {
      throw new Error('RASAero transitions must be conical — change the shape or export as .ork/.rkt.');
    }
    const len = nnum(node, 'length', 0.04);
    emit('<Transition>');
    emit('<PartType>Transition</PartType>');
    emit(`<Length>${fmt(len * IN)}</Length>`);
    emit(`<Diameter>${fmt(nnum(node, 'foreRadius', 0.012) * 2 * IN)}</Diameter>`);
    emit(`<RearDiameter>${fmt(nnum(node, 'aftRadius', 0.009) * 2 * IN)}</RearDiameter>`);
    emit(`<Location>${fmt(locM * IN)}</Location>`);
    emit('<Color>Black</Color>');
    finXml(node); // RASAero transitions/boat tails carry fins too
    emit('</Transition>');
    locM += len;
  };

  emit('<RASAeroDocument>');
  emit('<FileVersion>2</FileVersion>');
  emit('<RocketDesign>');

  // Sustainer chain (flat).
  for (const node of stagesIn[0]!.children ?? []) {
    if (node.type === 'nosecone') noseXml(node);
    else if (node.type === 'bodytube') tubeXml(node);
    else if (node.type === 'transition') transitionXml(node);
    // internals/others have no RASAero representation — silently external-only
  }

  // Boosters (each lower stage). A leading widening transition is the
  // shoulder into the stage above; a trailing narrowing one is the boat
  // tail — the same shapes our importer synthesizes, so this round-trips.
  for (let i = 1; i < stagesIn.length; i++) {
    const st = stagesIn[i]!;
    const kids = st.children ?? [];
    const tubes = kids.filter((c) => c.type === 'bodytube');
    if (tubes.length === 0) {
      throw new Error(`Stage "${st.name}" has no body tube — RASAero boosters need one.`);
    }
    const bodyLen = tubes.reduce((s, t) => s + nnum(t, 'length', 0.1), 0);
    const externals = kids.filter((c) => c.type === 'bodytube' || c.type === 'transition');
    const first = externals[0];
    const shoulder = first && first.type === 'transition'
      && nnum(first, 'foreRadius', 0) <= nnum(first, 'aftRadius', 0) ? first : null;
    const last = externals[externals.length - 1];
    const boattail = last && last !== shoulder && last.type === 'transition'
      && nnum(last, 'foreRadius', 0) > nnum(last, 'aftRadius', 0) ? last : null;
    const extraTrans = kids.filter((c) => c.type === 'transition' && c !== shoulder && c !== boattail);
    if (extraTrans.length > 0) {
      throw new Error(`RASAero boosters support only a shoulder and a boat tail — stage "${st.name}" has other transitions; export as .ork/.rkt.`);
    }
    const shoulderLen = shoulder ? nnum(shoulder, 'length', 0) : 0;
    const btLen = boattail ? nnum(boattail, 'length', 0) : 0;
    const finParents = kids.filter((c) => (c.children ?? []).some((k) => k.type.endsWith('finset')));
    if (finParents.length > 1) {
      throw new Error(`RASAero allows ONE fin set per booster — stage "${st.name}" has several; export as .ork/.rkt.`);
    }
    emit('<Booster>');
    emit('<PartType>Booster</PartType>');
    emit(`<Length>${fmt(bodyLen * IN)}</Length>`);
    emit(`<Diameter>${fmt(nnum(tubes[0]!, 'outerRadius', 0.012) * 2 * IN)}</Diameter>`);
    emit(`<InsideDiameter>${fmt((shoulder ? nnum(shoulder, 'foreRadius', 0.012) : nnum(tubes[0]!, 'outerRadius', 0.012)) * 2 * IN)}</InsideDiameter>`);
    emit('<LaunchLugDiameter>0</LaunchLugDiameter>');
    emit('<LaunchLugLength>0</LaunchLugLength>');
    emit('<RailGuideDiameter>0</RailGuideDiameter>');
    emit('<RailGuideHeight>0</RailGuideHeight>');
    emit('<LaunchShoeArea>0</LaunchShoeArea>');
    // <Booster><Location> is the SHOULDER START, not the body start. The corpus
    // says so unambiguously — 2,4-D 70.875 with ShoulderLength 10, 38-54 38.5
    // with 4, 50k 48 with 4, Rockoon 26 with 10, and SS Wild Bash's second
    // booster 83 = 47 + shoulder 3 + length 33 — and so does desktop's writer
    // (BoosterDTO.java:116 takes `stage.getChild(0)`, which IS the shoulder,
    // and :218 writes its ABSOLUTE axial offset as the Location). We used
    // to add the shoulder length here, on the theory that the shoulder slid up
    // into the stage above; it does not, and the round trip walked the booster
    // one shoulder aft on every export→import.
    emit(`<Location>${fmt(locM * IN)}</Location>`);
    emit('<Color>Black</Color>');
    emit(`<ShoulderLength>${fmt(shoulderLen * IN)}</ShoulderLength>`);
    emit('<NozzleExitDiameter>0</NozzleExitDiameter>');
    emit(`<BoattailLength>${fmt(btLen * IN)}</BoattailLength>`);
    emit(`<BoattailRearDiameter>${fmt(boattail ? nnum(boattail, 'aftRadius', 0) * 2 * IN : 0)}</BoattailRearDiameter>`);
    finXml(finParents[0] ?? tubes[0]!);
    emit('</Booster>');
    locM += shoulderLen + bodyLen + btLen;
  }

  // Global surface from the first finished external part.
  const surface = (() => {
    const walk = (nodes: ComponentNode[]): string | null => {
      for (const n of nodes) {
        if (typeof n['finish'] === 'string' && FINISH_TO_SURFACE[n['finish'] as string]) {
          return FINISH_TO_SURFACE[n['finish'] as string]!;
        }
        const hit = walk(n.children ?? []);
        if (hit) return hit;
      }
      return null;
    };
    return walk(stagesIn) ?? 'Rough Camouflage Paint';
  })();
  emit(`<Surface>${surface}</Surface>`);
  emit('<CD>0</CD>');
  emit('<ModifiedBarrowman>False</ModifiedBarrowman>');
  emit('<Turbulence>False</Turbulence>');
  emit('<SustainerNozzle>0</SustainerNozzle>');
  emit('<Booster1Nozzle>0</Booster1Nozzle>');
  emit('<Booster2Nozzle>0</Booster2Nozzle>');
  emit(`<UseBooster1>${stagesIn.length >= 2 ? 'True' : 'False'}</UseBooster1>`);
  emit(`<UseBooster2>${stagesIn.length === 3 ? 'True' : 'False'}</UseBooster2>`);
  emit(`<Comments>${esc(name)}</Comments>`);
  emit('</RocketDesign>');

  // Launch site back to RASAero units (feet / °F / in-Hg / mph). Pressure 0 is
  // RASAero's own "unset"; Temperature has no unset, so ISA null becomes 59 °F.
  emit('<LaunchSite>');
  emit(`<Altitude>${fmt((launch?.launchAltitudeM ?? 0) * FT)}</Altitude>`);
  emit(`<Pressure>${launch ? (launch.pressureHPa != null ? fmt(launch.pressureHPa / INHG) : '0') : '29.92'}</Pressure>`);
  emit(`<RodAngle>${fmt(launch?.launchRodAngleDeg ?? 0)}</RodAngle>`);
  emit(`<RodLength>${launch?.launchRodLengthM != null ? fmt(launch.launchRodLengthM * FT) : '10'}</RodLength>`);
  emit(`<Temperature>${launch?.temperatureC != null ? fmt(launch.temperatureC * 9 / 5 + 32) : '59'}</Temperature>`);
  emit(`<WindSpeed>${fmt((launch?.windAverage ?? 0) * MPH)}</WindSpeed>`);
  emit('</LaunchSite>');

  // Recovery: first two parachutes anywhere in the design.
  const chutes: ComponentNode[] = [];
  const findChutes = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if (n.type === 'parachute' && chutes.length < 2) chutes.push(n);
      findChutes(n.children ?? []);
    }
  };
  findChutes(stagesIn);
  // Recovery children are grouped BY FIELD (Altitude1, Altitude2, DeviceType1,
  // …) — the order RASAero itself writes. Our old per-slot interleaving
  // matched neither RASAero's files nor the desktop exporter.
  const slotVals = ([1, 2] as const).map((slot) => {
    const c = chutes[slot - 1];
    const ev = c ? String(c['deployEvent'] ?? 'apogee') : 'none';
    const evType = ev === 'apogee' ? 'Apogee' : ev === 'altitude' ? 'Altitude' : 'None';
    return {
      altitude: fmt(c && evType === 'Altitude' ? nnum(c, 'deployAltitude', 150) * FT : 0),
      deviceType: c ? 'Parachute' : 'None',
      event: c && evType !== 'None' ? 'True' : 'False',
      size: fmt(c ? nnum(c, 'diameter', 0.9) * IN : 0),
      eventType: c ? evType : 'None',
      cd: fmt(c ? nnum(c, 'cd', 0.75) : 0),
    };
  });
  emit('<Recovery>');
  for (const slot of [1, 2] as const) emit(`<Altitude${slot}>${slotVals[slot - 1]!.altitude}</Altitude${slot}>`);
  for (const slot of [1, 2] as const) emit(`<DeviceType${slot}>${slotVals[slot - 1]!.deviceType}</DeviceType${slot}>`);
  for (const slot of [1, 2] as const) emit(`<Event${slot}>${slotVals[slot - 1]!.event}</Event${slot}>`);
  for (const slot of [1, 2] as const) emit(`<Size${slot}>${slotVals[slot - 1]!.size}</Size${slot}>`);
  for (const slot of [1, 2] as const) emit(`<EventType${slot}>${slotVals[slot - 1]!.eventType}</EventType${slot}>`);
  for (const slot of [1, 2] as const) emit(`<CD${slot}>${slotVals[slot - 1]!.cd}</CD${slot}>`);
  emit('</Recovery>');
  // Mach-Alt conditions table. RASAero's own row text is 'mach, altitude_ft'
  // (one <Item> each, its editor repeating the block per grid page — we write
  // each row once, which our importer reads back identically). No table ⇒ the
  // empty element, which is what RASAero writes for "unset".
  if (machAlt && machAlt.length > 0) {
    emit('<MachAlt>');
    for (const [mach, altM] of machAlt) emit(`<Item>${fmt(mach)}, ${fmt(altM * FT)}</Item>`);
    emit('</MachAlt>');
  } else {
    emit('<MachAlt></MachAlt>');
  }

  // Simulation block: RASAero's loader (GetSimulations) dereferences EVERY
  // one of these nodes without null checks — its own files always carry all
  // 21 numeric/boolean children, even for a motorless single-stage design.
  // Our old 5-element "minimal" block crashed it with a NullReferenceException.
  // The *Engine elements are the only optional ones and must be OMITTED (not
  // written empty) when there is no motor — an empty name NREs the motor-list
  // lookup instead. With CDX1_ENGINE_EXPORT on, each stage's engine string is
  // written immediately before its LaunchWt, the desktop SimulationDTO field
  // order and the position RASAero's own files use.
  // The per-stage weight/CG cells are CUMULATIVE: each is the vehicle from the
  // nose down to and including that stage, at that stage's ignition — not the
  // stage on its own. Desktop parity (24.12 SimulationDTO, constructor cases
  // 0/1/2): SustainerLaunchWt = structure(stage 0) + the sustainer motor;
  // Booster1LaunchWt = structure(stages 0-1) + BOTH motors; Booster2LaunchWt =
  // the whole stack + all three. Its importer inverts exactly that
  // (SimulationHandler.applyBooster1MassOverride subtracts the booster motor
  // AND SustainerLaunchWt). A RASAero-written two-stage file agrees:
  // __fixtures__/Complex.Two-Stage.CDX1 carries sustainer 4.06 lb / CG
  // 35.96 in against booster1 5.64 lb / CG 43.06 in — heavier and further aft.
  //
  // We are handed ONE pair, the whole rocket's loaded mass and CG, so exactly
  // one stage's cells can be filled: the LAST stage's, the only one whose
  // cumulative vehicle IS the whole rocket. Single-stage output is therefore
  // unchanged (that stage is the sustainer — the 5.9966 lb file proven in
  // RASAero II); a two-stage design fills Booster1's cells and leaves the
  // sustainer's at 0. Writing the stack mass into SustainerLaunchWt instead
  // claimed the sustainer alone weighs the whole rocket, which the desktop
  // reads straight back as a sustainer heavier than the vehicle.
  //
  // 0 is RASAero's own "not entered", not an invention: its files use it for
  // unused cells (__fixtures__/ARCAS-Long - 2.CDX1 has SustainerLaunchWt 0;
  // Show-off.CDX1 keeps IncludeBooster1 True over a 0 Booster1LaunchWt, with
  // RASAero's own computed results beside it), and the desktop importer skips
  // the mass override when it reads 0. Filling every cell needs per-stage
  // masses, which nothing here has: componentInfo() reports a stage's
  // sectionMass but only a component's OWN CG (an AxialStage has no mass of
  // its own, so its CG says nothing), and Cdx1ExportEngine carries no motor
  // mass at all. That is a work item, not a one-line flip.
  const lastStage = stagesIn.length - 1;
  const stackWt = (i: number): string => fmt((i === lastStage ? (launchMassKg ?? 0) : 0) * LB);
  const stackCg = (i: number): string => fmt((i === lastStage ? (launchCgM ?? 0) : 0) * IN);
  // Per-stage separation timer, read back off the stage node where importCdx1
  // bakes it (separationEvent 'burnout' + the file's Booster1SeparationDelay /
  // Booster2Delay). RASAero counts the delay from the booster's own burnout,
  // so only a burnout separation is what these fields mean — any other event
  // writes RASAero's own 0, the same guard the ignition delays above apply.
  // A hard-coded 0 here (what we used to write) silently dropped a staged
  // design's separation timers on every .CDX1 export.
  const stageSeparationDelay = (i: number): string => {
    const st = stagesIn[i];
    return fmt(st && String(st['separationEvent'] ?? 'ejection') === 'burnout'
      ? nnum(st, 'separationDelay', 0) : 0);
  };
  emit('<SimulationList>');
  emit('<Simulation>');
  if (stageEngines[0]) emit(`<SustainerEngine>${esc(stageEngines[0])}</SustainerEngine>`);
  emit(`<SustainerLaunchWt>${stackWt(0)}</SustainerLaunchWt>`);
  emit('<SustainerNozzleDiameter>0</SustainerNozzleDiameter>');
  emit(`<SustainerCG>${stackCg(0)}</SustainerCG>`);
  emit(`<SustainerIgnitionDelay>${stageIgnitionDelays[0] ?? 0}</SustainerIgnitionDelay>`);
  if (stageEngines[1]) emit(`<Booster1Engine>${esc(stageEngines[1])}</Booster1Engine>`);
  emit(`<Booster1LaunchWt>${stackWt(1)}</Booster1LaunchWt>`);
  emit(`<Booster1SeparationDelay>${stageSeparationDelay(1)}</Booster1SeparationDelay>`);
  emit(`<Booster1IgnitionDelay>${stageIgnitionDelays[1] ?? 0}</Booster1IgnitionDelay>`);
  emit(`<Booster1CG>${stackCg(1)}</Booster1CG>`);
  emit('<Booster1NozzleDiameter>0</Booster1NozzleDiameter>');
  // IncludeBooster mirrors the desktop (mount present && is a motor mount):
  // True only when that stage got an engine string. A sim that claims a
  // booster without an engine is another null lookup waiting to happen. The
  // design-level UseBooster flags still carry the staged geometry.
  emit(`<IncludeBooster1>${stageEngines[1] ? 'True' : 'False'}</IncludeBooster1>`);
  if (stageEngines[2]) emit(`<Booster2Engine>${esc(stageEngines[2])}</Booster2Engine>`);
  emit(`<Booster2LaunchWt>${stackWt(2)}</Booster2LaunchWt>`);
  emit(`<Booster2Delay>${stageSeparationDelay(2)}</Booster2Delay>`);
  emit(`<Booster2CG>${stackCg(2)}</Booster2CG>`);
  emit('<Booster2NozzleDiameter>0</Booster2NozzleDiameter>');
  emit(`<IncludeBooster2>${stageEngines[2] ? 'True' : 'False'}</IncludeBooster2>`);
  emit('<FlightTime>0</FlightTime>');
  emit('<TimetoApogee>0</TimetoApogee>');
  emit('<MaxAltitude>0</MaxAltitude>');
  emit('<MaxVelocity>0</MaxVelocity>');
  emit('<OptimumWt>0</OptimumWt>');
  emit('<OptimumMaxAlt>0</OptimumMaxAlt>');
  emit('</Simulation>');
  emit('</SimulationList>');
  emit('</RASAeroDocument>');
  return lines.join('\n');
}

