import { strFromU8 } from 'fflate';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { asStageNodes, freshId } from '../tree/treeModel.js';
import { escapeXml as esc, xmlNum as num, xmlText as text } from './xmlUtil.js';
import type { OrkMotorRef, OrkTreeImportResult } from './orkFile.js';

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
 *   fake component data.
 * - Nose shapes are strings ("Tangent Ogive", "Von Karman Ogive"…), mapped
 *   with the desktop's shape parameters.
 */

const IN = 39.37; // inches per meter (the desktop's OPENROCKET_TO_RASAERO_LENGTH)
const FT = 3.28084;
const LB = 2.20462262;

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

// ============================ IMPORT ============================

export function importCdx1(data: ArrayBuffer | string): OrkTreeImportResult {
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
      fin['points'] = [[0, 0], [sweep, height], [sweep + tipChord, height], [rootChord, 0]];
    } else {
      fin['rootChord'] = rootChord;
      fin['tipChord'] = tipChord;
      fin['sweep'] = sweep;
      fin['height'] = height;
    }
    const cs = CROSS_SECTIONS[text(finEl, ':scope > AirfoilSection') ?? ''];
    if (cs && cs !== 'square') fin['crossSection'] = cs;
    if (finish && finish !== 'normal') fin['finish'] = finish;
    parentNode.children = [...(parentNode.children ?? []), fin];
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
        sustainer.children!.push(nose);
        break;
      }
      case 'BodyTube':
        sustainer.children!.push(mkTube(el, 'Body tube'));
        break;
      case 'Transition':
      case 'BoatTail': {
        const trans: ComponentNode = {
          type: 'transition', id: freshId(),
          name: el.tagName === 'BoatTail' ? 'Boat tail' : 'Transition',
          length: num(el, 'Length', 2) / IN,
          foreRadius: num(el, 'Diameter', 4) / IN / 2,
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

  // ---- what RASAero can't tell us (be honest, don't invent) ----
  notes.push('RASAero designs carry no material or wall data — walls default to 2 mm; review masses before trusting the numbers.');
  const engines: string[] = [];
  for (const sim of Array.from(doc.querySelectorAll('SimulationList > Simulation'))) {
    for (const tag of ['SustainerEngine', 'Booster1Engine', 'Booster2Engine']) {
      const e = text(sim, `:scope > ${tag}`);
      if (e && !engines.includes(e)) engines.push(e);
    }
    break; // first simulation is enough for the hint
  }
  if (engines.length > 0) {
    notes.push(`Motors in the RASAero file: ${engines.join(', ')} — RASAero designs have no motor mounts; add an inner tube (motor mount) and pick them from the database.`);
  }
  if (ignored.size) {
    notes.push(`Ignored RASAero elements: ${[...ignored].join(', ')}.`);
  }

  const name = (text(design, ':scope > Comments') ?? '').split('\n')[0]?.trim()
    || 'Imported RASAero rocket';
  const motors: Record<string, OrkMotorRef> = {}; // no mounts in RASAero files
  return { name, tree: { name, components: stages }, motors, ignored: [...ignored], notes };
}

// ============================ EXPORT ============================

export interface Cdx1ExportInput {
  name: string;
  tree: RocketTree;
  /** Loaded launch mass (kg) and CG (m), for the mandatory simulation block. */
  launchMassKg?: number;
  launchCgM?: number;
}

const FIN_MIN = 3;
const FIN_MAX = 8;

export function exportCdx1({ name, tree, launchMassKg, launchCgM }: Cdx1ExportInput): string {
  const stagesIn = asStageNodes(tree);
  if (stagesIn.length > 3) throw new Error('RASAero supports at most 3 stages.');

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
    // No <PartType> inside <Fin> — neither RASAero's own files nor the
    // desktop exporter write one, and RASAero's parser is rigid.
    emit('<Fin>');
    emit(`<Count>${count}</Count>`);
    emit(`<Chord>${fmt(plan.root * IN)}</Chord>`);
    emit(`<Span>${fmt(plan.height * IN)}</Span>`);
    emit(`<SweepDistance>${fmt(plan.sweep * IN)}</SweepDistance>`);
    emit(`<TipChord>${fmt(plan.tip * IN)}</TipChord>`);
    emit(`<Thickness>${fmt(nnum(fin, 'thickness', 0.003) * IN)}</Thickness>`);
    emit('<LERadius>0</LERadius>');
    emit(`<Location>${fmt(locIn)}</Location>`);
    emit(`<AirfoilSection>${cs === 'airfoil' ? 'Subsonic NACA' : cs === 'rounded' ? 'Rounded' : 'Square'}</AirfoilSection>`);
    emit('<FX1>0</FX1>');
    emit('<FX3>0</FX3>');
    emit('</Fin>');
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

  emit('<LaunchSite>');
  emit('<Altitude>0</Altitude>');
  emit('<Pressure>29.92</Pressure>');
  emit('<RodAngle>0</RodAngle>');
  emit('<RodLength>10</RodLength>');
  emit('<Temperature>59</Temperature>');
  emit('<WindSpeed>0</WindSpeed>');
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
  emit('<MachAlt></MachAlt>');

  // Simulation block: RASAero's loader (GetSimulations) dereferences EVERY
  // one of these nodes without null checks — its own files always carry all
  // 21 numeric/boolean children, even for a motorless single-stage design.
  // Our old 5-element "minimal" block crashed it with a NullReferenceException.
  // The *Engine elements are the only optional ones and must be OMITTED (not
  // written empty) when there is no motor — an empty name NREs the motor-list
  // lookup instead.
  emit('<SimulationList>');
  emit('<Simulation>');
  emit(`<SustainerLaunchWt>${fmt((launchMassKg ?? 0) * LB)}</SustainerLaunchWt>`);
  emit('<SustainerNozzleDiameter>0</SustainerNozzleDiameter>');
  emit(`<SustainerCG>${fmt((launchCgM ?? 0) * IN)}</SustainerCG>`);
  emit('<SustainerIgnitionDelay>0</SustainerIgnitionDelay>');
  emit('<Booster1LaunchWt>0</Booster1LaunchWt>');
  emit('<Booster1SeparationDelay>0</Booster1SeparationDelay>');
  emit('<Booster1IgnitionDelay>0</Booster1IgnitionDelay>');
  emit('<Booster1CG>0</Booster1CG>');
  emit('<Booster1NozzleDiameter>0</Booster1NozzleDiameter>');
  // IncludeBooster stays False: we export no engines, and a sim that claims a
  // booster without an engine is another null lookup waiting to happen. The
  // design-level UseBooster flags still carry the staged geometry.
  emit('<IncludeBooster1>False</IncludeBooster1>');
  emit('<Booster2LaunchWt>0</Booster2LaunchWt>');
  emit('<Booster2Delay>0</Booster2Delay>');
  emit('<Booster2CG>0</Booster2CG>');
  emit('<Booster2NozzleDiameter>0</Booster2NozzleDiameter>');
  emit('<IncludeBooster2>False</IncludeBooster2>');
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

