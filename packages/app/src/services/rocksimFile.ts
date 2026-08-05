import { strFromU8, unzipSync } from 'fflate';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { asStageNodes, freshId } from '../tree/treeModel.js';
import { CLUSTER_POINTS, clusterOffsets } from '../tree/cluster.js';
import { escapeXml as esc, xmlNum as num, xmlText as text } from './xmlUtil.js';
import { shapeParamDefault } from './orkFile.js';
import type { OrkExportMotor, OrkMotorRef, OrkTreeImportResult } from './orkFile.js';

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
const MASS = 1000; // g → kg

const NOSE_SHAPES: Record<string, string> = {
  '0': 'conical', '1': 'ogive', '2': 'ellipsoid', '3': 'ellipsoid',
  '4': 'power', '5': 'parabolic', '6': 'haack',
};
const NOSE_SHAPE_TO_CODE: Record<string, number> = {
  conical: 0, ogive: 1, ellipsoid: 3, power: 4, parabolic: 5, haack: 6,
};
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

export function importRkt(data: ArrayBuffer | string): OrkTreeImportResult {
  let xml: string;
  if (typeof data === 'string') {
    xml = data;
  } else {
    const bytes = new Uint8Array(data);
    xml = bytes[0] === 0x50 && bytes[1] === 0x4b
      ? strFromU8(Object.values(unzipSync(bytes))[0]!)
      : strFromU8(bytes);
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
  /** RockSim SerialNo → our node id (links EngineSets to mounts). */
  const serialToNode = new Map<string, ComponentNode>();
  /** Off-axis inner tubes: node → cross-section offset (m), for cluster
   *  reconstruction (RockSim has no cluster concept — files carry N separate
   *  tubes at RadialLoc/RadialAngle). */
  const radialByNode = new Map<ComponentNode, { y: number; z: number }>();

  const name = text(design, ':scope > Name') ?? 'Imported RockSim rocket';
  const stageCount = Math.max(1, Math.min(3, num(design, 'StageCount', 1)));

  const readCommon = (el: Element, node: ComponentNode) => {
    const nm = text(el, ':scope > Name');
    if (nm) node.name = nm;
    const serial = text(el, ':scope > SerialNo');
    if (serial) serialToNode.set(serial, node);
    const densityType = num(el, 'DensityType', 0);
    const density = num(el, 'Density', 0);
    if (densityType === 0 && density > 0) node.density = density;
    const mat = text(el, ':scope > Material');
    if (mat) node['materialName'] = mat;
    const finish = FINISH_FROM_CODE[String(Math.round(num(el, 'FinishCode', NaN)))];
    if (finish && finish !== 'normal') node['finish'] = finish;
    // UseKnownCG=1 overrides BOTH mass and CG (RockSim couples them).
    if (num(el, 'UseKnownCG', 0) === 1) {
      const km = num(el, 'KnownMass', 0);
      if (km > 0) node['overrideMass'] = km / MASS;
      const kcg = num(el, 'KnownCG', 0);
      if (kcg > 0) node['overrideCGX'] = kcg / LEN;
    }
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
        const sp = num(el, 'ShapeParameter', NaN);
        if (!Number.isNaN(sp) && ['power', 'haack', 'parabolic'].includes(n['shape'] as string)) {
          n['shapeParameter'] = sp;
        }
        if (Math.round(num(el, 'ConstructionType', 1)) === 0) n['filled'] = true;
        const shoulderLen = num(el, 'ShoulderLen', 0);
        if (shoulderLen > 0) {
          n['shoulderLength'] = shoulderLen / LEN;
          n['shoulderRadius'] = num(el, 'ShoulderOD', 0) / RAD;
          n['shoulderThickness'] = n['filled'] === true
            ? (n['shoulderRadius'] as number)
            : (n['thickness'] as number);
        }
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
        if (od > 0 && (type === 'centeringring' || type === 'tubecoupler')) {
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
        const type = shapeCode === 2 ? 'freeformfinset'
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
        n['thickness'] = tubeThickness(el);
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
        if (num(el, 'SpillHoleDia', 0) > 0) {
          notes.push('Parachute spill holes are not supported — ignored.');
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
        return n;
      }
      case 'MassObject': {
        const isCord = Math.round(num(el, 'TypeCode', 0)) === 1;
        const n = mk(isCord ? 'shockcord' : 'masscomponent');
        if (isCord) {
          n['cordLength'] = num(el, 'Len', 300) / LEN;
        } else {
          n['mass'] = num(el, 'KnownMass', 0) / MASS;
          n['length'] = num(el, 'Len', 20) / LEN;
        }
        delete n['overrideMass'];
        delete n['overrideCGX'];
        return n;
      }
      case 'ExternalPod':
      case 'RingTail':
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
      const groups = new Map<string, ComponentNode[]>();
      for (const kid of kids) {
        if (kid.type !== 'innertube') continue;
        const gk = [
          Number(kid['length'] ?? 0).toFixed(6),
          Number(kid['outerRadius'] ?? 0).toFixed(6),
          kid.position?.method ?? '',
          Number(kid.position?.offset ?? 0).toFixed(6),
        ].join('|');
        const g = groups.get(gk) ?? [];
        g.push(kid);
        groups.set(gk, g);
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
  if (ignored.size) {
    notes.push(`Ignored unsupported RockSim components: ${[...ignored].join(', ')}.`);
  }

  // Motors: the desktop DROPS these; we read EngineCode + MountSerialNo so
  // the app can auto-load them from the bundled motor database. Real RockSim
  // files often carry STALE serial links (renumbered after edits) — fall
  // back to the first motor mount of the EngineSet's stage.
  const motors: Record<string, OrkMotorRef> = {};
  let firstMotor: OrkMotorRef | undefined;
  const mountsIn = (nodes: ComponentNode[]): ComponentNode[] => {
    const out: ComponentNode[] = [];
    for (const n of nodes) {
      if ((n.type === 'innertube' || n.type === 'bodytube') && n['motorMount'] === true) out.push(n);
      out.push(...mountsIn(n.children ?? []));
    }
    return out;
  };
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
    const ref: OrkMotorRef = {
      designation: code,
      manufacturer: text(engineSet, ':scope > EngineMfg') ?? 'unknown',
      diameter: 0, // unknown in the file — match by designation alone
      length: 0,
      delay: num(engineSet, 'EjectionDelay', 0),
      mountId: mount.id,
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
  };
}

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
}

export function exportRkt({ name, tree, motors }: RktExportInput): string {
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

  const common = (node: ComponentNode, dfltName: string, opts?: { knownMass?: number; useKnownCG?: boolean }) => {
    serial += 1;
    // First write wins: cluster copies re-emit the same node — motor
    // references must point at the FIRST copy (the one carrying children).
    if (node.id && !nodeSerial.has(node.id)) nodeSerial.set(node.id, serial);
    const override = typeof node['overrideMass'] === 'number' || typeof node['overrideCGX'] === 'number';
    const knownMass = opts?.knownMass
      ?? (typeof node['overrideMass'] === 'number' ? (node['overrideMass'] as number) * MASS : 0);
    emit(`<KnownMass>${knownMass}</KnownMass>`);
    emit(`<Density>${nnum(node, 'density', 0)}</Density>`);
    emit('<DensityType>0</DensityType>');
    emit(`<Material>${esc(typeof node['materialName'] === 'string' ? (node['materialName'] as string) : 'custom')}</Material>`);
    emit(`<Name>${esc(node.name ?? dfltName)}</Name>`);
    emit(`<KnownCG>${typeof node['overrideCGX'] === 'number' ? (node['overrideCGX'] as number) * LEN : 0}</KnownCG>`);
    emit(`<UseKnownCG>${(opts?.useKnownCG ?? override) ? 1 : 0}</UseKnownCG>`);
    emit(`<FinishCode>${FINISH_TO_CODE(node['finish'])}</FinishCode>`);
    emit(`<SerialNo>${serial}</SerialNo>`);
    const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
    const mode = pos.method === 'absolute' ? 1 : pos.method === 'bottom' ? 2 : 0;
    let xb = pos.method === 'bottom' ? -pos.offset : pos.offset;
    // RockSim has no "middle" mode — convert to front-referenced, mirroring
    // the desktop's BasePartDTO: xb = offset + (parentLen - componentLen)/2.
    if (pos.method === 'middle' && curParent) {
      const compLen = nnum(node, 'length', nnum(node, 'rootChord', 0));
      xb = pos.offset + (nnum(curParent, 'length', 0) - compLen) / 2;
    }
    emit(`<LocationMode>${mode}</LocationMode>`);
    emit(`<Xb>${xb * LEN}</Xb>`);
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
    emit(`<MotorDia>${(nnum(node, 'outerRadius', 0.0095) - nnum(node, 'thickness', 0.0005)) * RAD}</MotorDia>`);
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
        // Fallback mirrors the kernel default — writing 0 for a power-law nose
        // degenerates it to a blunt cylinder on re-import (Haack war story).
        emit(`<ShapeParameter>${nnum(node, 'shapeParameter', shapeParamDefault(String(node['shape'] ?? 'ogive')))}</ShapeParameter>`);
        emit(`<ConstructionType>${node['filled'] === true ? 0 : 1}</ConstructionType>`);
        emit(`<ShoulderLen>${nnum(node, 'shoulderLength', 0) * LEN}</ShoulderLen>`);
        emit(`<ShoulderOD>${nnum(node, 'shoulderRadius', 0) * RAD}</ShoulderOD>`);
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
          emit(`<MotorDia>${(nnum(node, 'outerRadius', 0.012) - nnum(node, 'thickness', 0.0005)) * RAD}</MotorDia>`);
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
        emit(isCustom ? '</CustomFinSet>' : '</FinSet>');
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
        common(node, 'Mass', { knownMass: massKg * MASS, useKnownCG: true });
        emit('<TypeCode>0</TypeCode>');
        emit(`<Len>${nnum(node, 'length', 0.02) * LEN}</Len>`);
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
      for (const node of stagesIn[i]!.children ?? []) emitPart(node, null);
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

