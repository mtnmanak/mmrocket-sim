import { strFromU8 } from 'fflate';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import { asStageNodes, freshId } from '../tree/treeModel.js';
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
 *   blocks as launch weights, which we surface as notes rather than as
 *   fake component data. Each engine-carrying <Simulation> becomes a
 *   flight configuration (motors on each stage's aft-most tube, desktop
 *   SimulationHandler parity).
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
        break;
      }
      case 'BodyTube':
        sustainer.children!.push(mkTube(el, 'Body tube'));
        break;
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
        const prev = sustainer.children![sustainer.children!.length - 1];
        const prevAft = prev
          ? typeof prev['aftRadius'] === 'number' ? prev['aftRadius'] as number
            : typeof prev['outerRadius'] === 'number' ? prev['outerRadius'] as number
              : undefined
          : undefined;
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
        sustainer.children!.push(trans);
        break;
      }
      case 'FinCan':
        // The desktop models fin cans as overlapping pod assemblies, which we
        // don't support yet — the FIN geometry still matters aerodynamically.
        notes.push('RASAero fin can imported as a body tube with its fins (the sliding overlap is not modeled).');
        sustainer.children!.push(mkTube(el, 'Fin can'));
        break;
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
        stage.children!.push(mkTube(el, `${stage.name} body tube`));
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
  const unattached = new Set<string>();
  const sims = Array.from(doc.querySelectorAll('SimulationList > Simulation'));
  for (const [simIdx, sim] of sims.entries()) {
    const cfgMotors: Record<string, OrkMotorRef> = {};
    const separations: Record<string, OrkSeparationOverride> = {};
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
      cfgMotors[mount.id] = {
        designation: eng.designation,
        manufacturer: eng.manufacturer, // RASAero abbreviation (AT/CTI/…) — informational
        diameter: 0, // unknown in the file — match by designation alone
        length: 0,
        // RASAero requires apogee deployment, so the sustainer motor is
        // PLUGGED (the desktop sets Motor.PLUGGED_DELAY = +Inf).
        delay: stageIdx === 0 ? Infinity : eng.delay ?? 0,
        mountId: mount.id,
        ignitionEvent: stageIdx === stages.length - 1 ? 'automatic' : 'burnout',
        ignitionDelay: 'ignitionDelay' in slot ? num(sim, slot.ignitionDelay, 0) : 0,
      };
      if (stageIdx > 0 && 'include' in slot) { // include gate passed above
        separations[stage.id] = {
          separationEvent: 'burnout',
          separationDelay: num(sim, slot.separationDelay, 0),
        };
      }
    }
    if (Object.keys(cfgMotors).length === 0) continue; // engine-less sim: no configuration
    configs.push({
      id: `rasaero-sim-${simIdx + 1}`, name: null, isDefault: configs.length === 0,
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
  const bottomMountIds = new Set<string>();
  const collectMounts = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if (n['motorMount'] === true && n.id) bottomMountIds.add(n.id);
      collectMounts(n.children ?? []);
    }
  };
  collectMounts(bottomStage?.children ?? []);
  const flyable = configs.find((c) => Object.keys(c.motors).some((id) => bottomMountIds.has(id)));
  const chosen = flyable ?? configs[0];
  if (flyable && configs[0] && flyable !== configs[0]) {
    // The number the USER sees in the file, not the position in `configs` —
    // engine-less simulations are skipped above, so those two diverge as soon
    // as a file carries one. The id already encodes the file index.
    const n = flyable.id.replace('rasaero-sim-', '');
    const firstN = configs[0].id.replace('rasaero-sim-', '');
    notes.push(
      `Simulation ${firstN} in this file puts no motor on the launch stage, so it would not `
      + `leave the pad. Simulation ${n} was opened instead — switch under Flight configurations.`);
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

  // ---- design-level conditions table (Mach -> altitude) ----
  const machAlt = readMachAltTable(doc);

  // ---- what RASAero can't tell us (be honest, don't invent) ----
  notes.push('RASAero designs carry no material or wall data — walls default to 2 mm; review masses before trusting the numbers.');
  if (machAlt) {
    const topFt = Math.round(Math.max(...machAlt.map(([, a]) => a)) * FT);
    notes.push(`This file carries a Mach-Alt conditions table (${machAlt.length} point${machAlt.length === 1 ? '' : 's'}, `
      + `to ${topFt} ft) — pick it under Drag analysis → Conditions to sweep at the `
      + 'file’s altitudes instead of sea level.');
  }
  if (unattached.size) {
    notes.push(`Motors in the RASAero file with no stage tube to mount them on: ${[...unattached].join(', ')} — add a body tube and pick them from the database.`);
  }
  const firstSim = sims[0];
  if (firstSim && ['SustainerLaunchWt', 'SustainerCG', 'Booster1LaunchWt', 'Booster1CG', 'Booster2LaunchWt', 'Booster2CG']
    .some((tag) => num(firstSim, tag, 0) !== 0)) {
    notes.push('The RASAero simulation carries measured launch weights/CG — not applied to the stages; the 2 mm-wall masses above are what simulates.');
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
  // Per-stage ignition delay, index-aligned with stageEngines. RASAero holds one
  // number per stage and measures it from the stage below's burnout, which is
  // exactly what importCdx1 reads back as `ignitionEvent: 'burnout'`. Writing a
  // hard 0 here (what we used to do) silently dropped a staged design's timers
  // on every .CDX1 export.
  const stageIgnitionDelays: number[] = [];
  const stageEngines: (string | null)[] = stagesIn.map((st) => {
    if (!engineOn || !motors) { stageIgnitionDelays.push(0); return null; }
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
    stageIgnitionDelays.push(
      found?.ignitionEvent === 'burnout' ? (found.ignitionDelay ?? 0) : 0);
    if (!found) return null;
    const abbrev = rasaeroManufacturerAbbrev(found.manufacturer);
    return abbrev ? `${found.designation}  (${abbrev})` : null;
  });

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
    // The booster body starts after the shoulder (which slides into the
    // stage above in RASAero's model).
    emit(`<Location>${fmt((locM + shoulderLen) * IN)}</Location>`);
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
  emit('<SimulationList>');
  emit('<Simulation>');
  if (stageEngines[0]) emit(`<SustainerEngine>${esc(stageEngines[0])}</SustainerEngine>`);
  emit(`<SustainerLaunchWt>${stackWt(0)}</SustainerLaunchWt>`);
  emit('<SustainerNozzleDiameter>0</SustainerNozzleDiameter>');
  emit(`<SustainerCG>${stackCg(0)}</SustainerCG>`);
  emit(`<SustainerIgnitionDelay>${stageIgnitionDelays[0] ?? 0}</SustainerIgnitionDelay>`);
  if (stageEngines[1]) emit(`<Booster1Engine>${esc(stageEngines[1])}</Booster1Engine>`);
  emit(`<Booster1LaunchWt>${stackWt(1)}</Booster1LaunchWt>`);
  emit('<Booster1SeparationDelay>0</Booster1SeparationDelay>');
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
  emit('<Booster2Delay>0</Booster2Delay>');
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

