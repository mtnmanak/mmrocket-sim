import { unzipSync, strFromU8 } from 'fflate';
import type { ComponentNode, ComponentPosition, ComponentType, RocketTree } from '@online-openrocket/engine';
import { asStageNodes, freshId } from '../tree/treeModel.js';
import { escapeXml, xmlText as text } from './xmlUtil.js';

/**
 * .ork import/export for full component trees (P2.5 — all 17 editor types).
 *
 * XML structure/element names are taken from GOLDEN files produced by the
 * real OpenRocket 24.12 GeneralRocketSaver (engine-java/tools/GenerateOrk
 * `generate` + `kitchensink`), and exports are validated against the real
 * GeneralRocketLoader. A .ork is either a ZIP containing rocket.ork or bare
 * XML — both are accepted; export writes bare XML.
 */

export interface OrkMotorRef {
  designation: string;
  manufacturer: string;
  diameter: number;
  length: number;
  delay: number;
  /** Editor node id of the mount it was attached to. */
  mountId?: string;
  /** Kernel ignition-event name (automatic|launch|ejectioncharge|burnout|never). */
  ignitionEvent?: string;
  ignitionDelay?: number;
}

export interface OrkTreeImportResult {
  name: string;
  tree: RocketTree;
  /** First motor found (legacy callers). */
  motor?: OrkMotorRef;
  /** EVERY mount's motor, keyed by the mount's editor node id. */
  motors: Record<string, OrkMotorRef>;
  ignored: string[];
  notes: string[];
}

// ============================ IMPORT ============================

export function importOrk(data: ArrayBuffer | string): OrkTreeImportResult {
  let xml: string;
  if (typeof data === 'string') {
    xml = data;
  } else {
    const bytes = new Uint8Array(data);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const entries = unzipSync(bytes);
      const entryName = Object.keys(entries).find((n) => n.endsWith('.ork'))
        ?? Object.keys(entries)[0];
      if (!entryName) throw new Error('Empty .ork archive');
      xml = strFromU8(entries[entryName]!);
    } else {
      xml = strFromU8(bytes);
    }
  }

  // OpenRocket writes a single-quoted XML declaration; some parsers reject it.
  xml = xml.replace(/^﻿?\s*<\?xml[^?]*\?>/, '');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not a valid .ork file (XML parse error)');
  }
  const rocketEl = doc.querySelector('openrocket > rocket');
  if (!rocketEl) throw new Error('Not a .ork file (missing <rocket>)');

  const ignored = new Set<string>();
  const notes: string[] = [];
  let motor: OrkMotorRef | undefined;
  const motors: Record<string, OrkMotorRef> = {};

  const name = text(rocketEl, ':scope > name') ?? 'Imported rocket';
  const stages = Array.from(rocketEl.querySelectorAll(':scope > subcomponents > stage'));
  if (stages.length === 0) throw new Error('No stage found');

  const readMotor = (el: Element, node: ComponentNode) => {
    const mountEl = el.querySelector(':scope > motormount');
    if (!mountEl) return;
    // Any tube with a <motormount> IS a mount — an inner tube, or a body tube
    // on a minimum-diameter rocket (kernel BodyTube implements MotorMount,
    // same as the desktop). The flag survives even with no motor loaded.
    node['motorMount'] = true;
    // Motor overhang (m): aft protrusion past the mount — min-diameter practice.
    const overhang = num(mountEl, 'overhang', 0);
    if (overhang !== 0) node['motorOverhang'] = overhang;
    const motorEl = mountEl.querySelector(':scope > motor');
    if (!motorEl) return;
    // Ignition: the per-config block wins over the bare default (desktop
    // writes defaults bare, overrides in <ignitionconfiguration>).
    const igEl = mountEl.querySelector(':scope > ignitionconfiguration') ?? mountEl;
    const ref: OrkMotorRef = {
      designation: text(motorEl, ':scope > designation') ?? 'unknown',
      manufacturer: text(motorEl, ':scope > manufacturer') ?? 'unknown',
      diameter: num(motorEl, 'diameter', 0.018),
      length: num(motorEl, 'length', 0.07),
      delay: num(motorEl, 'delay', 0),
      mountId: node.id,
      ignitionEvent: text(igEl, ':scope > ignitionevent') ?? undefined,
      ignitionDelay: num(igEl, 'ignitiondelay', 0),
    };
    if (node.id) {
      motors[node.id] = ref;
    }
    if (!motor) motor = ref;
  };

  const convertElement = (el: Element): ComponentNode | null => {
    const tag = el.tagName;
    const base = (type: ComponentType, withPosition: boolean): ComponentNode => {
      const node: ComponentNode = { type, id: freshId() };
      const nm = text(el, ':scope > name');
      if (nm) node.name = nm;
      const density = matDensity(el);
      if (density !== undefined) node.density = density;
      const matName = matName_(el, 'bulk');
      if (matName) node['materialName'] = matName;
      const fin = text(el, ':scope > finish');
      if (fin && fin !== 'normal') node['finish'] = fin;
      const om = num(el, 'overridemass', NaN);
      if (!Number.isNaN(om)) node['overrideMass'] = om;
      const ocg = num(el, 'overridecg', NaN);
      if (!Number.isNaN(ocg)) node['overrideCGX'] = ocg;
      const ocd = num(el, 'overridecd', NaN);
      if (!Number.isNaN(ocd)) node['overrideCD'] = ocd;
      if (withPosition) {
        const pos = readPosition(el);
        if (pos) node.position = pos;
      }
      return node;
    };

    switch (tag) {
      case 'nosecone': {
        const n = base('nosecone', false);
        n['length'] = num(el, 'length', 0.07);
        n['aftRadius'] = num(el, 'aftradius', 0.012);
        // Desktop writes <thickness>filled</thickness> for solid components.
        if (text(el, ':scope > thickness') === 'filled') {
          n['filled'] = true;
        } else {
          n['thickness'] = num(el, 'thickness', 0.002);
        }
        n['shape'] = text(el, ':scope > shape') ?? 'ogive';
        n['shapeParameter'] = num(el, 'shapeparameter', shapeParamDefault(String(n['shape'])));
        const shR = num(el, 'aftshoulderradius', 0);
        const shL = num(el, 'aftshoulderlength', 0);
        if (shR > 0) n['shoulderRadius'] = shR;
        if (shL > 0) n['shoulderLength'] = shL;
        const shT = num(el, 'aftshoulderthickness', 0);
        if (shT > 0) n['shoulderThickness'] = shT;
        if (text(el, ':scope > aftshouldercapped') === 'true') n['shoulderCapped'] = true;
        return n;
      }
      case 'transition': {
        const n = base('transition', false);
        n['length'] = num(el, 'length', 0.04);
        const fore = num(el, 'foreradius', NaN);
        const aft = num(el, 'aftradius', NaN);
        if (!Number.isNaN(fore)) n['foreRadius'] = fore;
        if (!Number.isNaN(aft)) n['aftRadius'] = aft;
        if (text(el, ':scope > thickness') === 'filled') {
          n['filled'] = true;
        } else {
          n['thickness'] = num(el, 'thickness', 0.002);
        }
        n['shape'] = text(el, ':scope > shape') ?? 'conical';
        n['shapeParameter'] = num(el, 'shapeparameter', shapeParamDefault(String(n['shape'])));
        for (const [side, key] of [['fore', 'foreShoulder'], ['aft', 'aftShoulder']] as const) {
          const r = num(el, `${side}shoulderradius`, 0);
          const l = num(el, `${side}shoulderlength`, 0);
          if (r > 0) n[`${key}Radius`] = r;
          if (l > 0) n[`${key}Length`] = l;
          const th = num(el, `${side}shoulderthickness`, 0);
          if (th > 0) n[`${key}Thickness`] = th;
        }
        return n;
      }
      case 'bodytube': {
        const n = base('bodytube', false);
        n['length'] = num(el, 'length', 0.3);
        n['outerRadius'] = num(el, 'radius', 0.012);
        n['thickness'] = num(el, 'thickness', 0.0005);
        readMotor(el, n);
        return n;
      }
      case 'trapezoidfinset': {
        const n = base('trapezoidfinset', true);
        n['finCount'] = Math.round(num(el, 'fincount', 3));
        n['rootChord'] = num(el, 'rootchord', 0.05);
        n['tipChord'] = num(el, 'tipchord', 0.03);
        n['sweep'] = num(el, 'sweeplength', 0.02);
        n['height'] = num(el, 'height', 0.03);
        n['thickness'] = num(el, 'thickness', 0.003);
        const cantDeg = num(el, 'cant', 0);
        if (cantDeg !== 0) n['cant'] = (cantDeg * Math.PI) / 180;
        const cs = text(el, ':scope > crosssection');
        if (cs && cs !== 'square') n['crossSection'] = cs;
        readFinTabs(el, n);
        return n;
      }
      case 'freeformfinset': {
        const n = base('freeformfinset', true);
        n['finCount'] = Math.round(num(el, 'fincount', 3));
        n['thickness'] = num(el, 'thickness', 0.003);
        const cantDegF = num(el, 'cant', 0);
        if (cantDegF !== 0) n['cant'] = (cantDegF * Math.PI) / 180;
        const csF = text(el, ':scope > crosssection');
        if (csF && csF !== 'square') n['crossSection'] = csF;
        readFinTabs(el, n);
        const ptEls = Array.from(el.querySelectorAll(':scope > finpoints > point'));
        // A missing x/y attribute must SKIP the point (Number(null) is 0,
        // which would silently drop a vertex onto the origin).
        const pts = ptEls
          .filter((pt) => pt.getAttribute('x') !== null && pt.getAttribute('y') !== null)
          .map((pt) => [Number(pt.getAttribute('x')), Number(pt.getAttribute('y'))] as [number, number])
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (pts.length >= 3) n['points'] = pts;
        return n;
      }
      case 'ellipticalfinset': {
        const n = base('ellipticalfinset', true);
        n['finCount'] = Math.round(num(el, 'fincount', 3));
        n['rootChord'] = num(el, 'rootchord', 0.05);
        n['height'] = num(el, 'height', 0.03);
        n['thickness'] = num(el, 'thickness', 0.003);
        const cantDegE = num(el, 'cant', 0);
        if (cantDegE !== 0) n['cant'] = (cantDegE * Math.PI) / 180;
        const csE = text(el, ':scope > crosssection');
        if (csE && csE !== 'square') n['crossSection'] = csE;
        readFinTabs(el, n);
        return n;
      }
      case 'tubefinset': {
        const n = base('tubefinset', true);
        n['finCount'] = Math.round(num(el, 'fincount', 6));
        n['length'] = num(el, 'length', 0.1);
        const r = num(el, 'radius', NaN);
        if (!Number.isNaN(r)) n['outerRadius'] = r;
        return n;
      }
      case 'innertube': {
        const n = base('innertube', true);
        n['length'] = num(el, 'length', 0.07);
        n['outerRadius'] = num(el, 'outerradius', 0.0095);
        n['thickness'] = num(el, 'thickness', 0.0005);
        // Cluster (desktop stores rotation in DEGREES; we keep radians).
        const cluster = text(el, ':scope > clusterconfiguration');
        if (cluster && cluster !== 'single') {
          n['cluster'] = cluster;
          n['clusterScale'] = num(el, 'clusterscale', 1);
          n['clusterRotation'] = (num(el, 'clusterrotation', 0) * Math.PI) / 180;
        }
        readMotor(el, n);
        return n;
      }
      case 'tubecoupler': {
        const n = base('tubecoupler', true);
        n['length'] = num(el, 'length', 0.05);
        n['thickness'] = num(el, 'thickness', 0.0005);
        return n;
      }
      case 'centeringring': {
        const n = base('centeringring', true);
        n['length'] = num(el, 'length', 0.002);
        return n;
      }
      case 'bulkhead': {
        const n = base('bulkhead', true);
        n['length'] = num(el, 'length', 0.003);
        return n;
      }
      case 'engineblock': {
        const n = base('engineblock', true);
        n['length'] = num(el, 'length', 0.005);
        n['thickness'] = num(el, 'thickness', 0.001);
        return n;
      }
      case 'launchlug': {
        const n = base('launchlug', true);
        n['length'] = num(el, 'length', 0.05);
        n['outerRadius'] = num(el, 'radius', 0.0022);
        n['thickness'] = num(el, 'thickness', 0.0003);
        return n;
      }
      case 'railbutton': {
        const n = base('railbutton', true);
        n['outerDiameter'] = num(el, 'outerdiameter', 0.0097);
        return n;
      }
      case 'parachute': {
        const n = base('parachute', true);
        n['diameter'] = num(el, 'diameter', 0.3);
        const cdText = text(el, ':scope > cd');
        if (cdText && cdText !== 'auto') n['cd'] = Number(cdText);
        n['lineCount'] = Math.round(num(el, 'linecount', 6));
        n['lineLength'] = num(el, 'linelength', 0.3);
        readSoftMaterial(el, n, 'surface', 'surfaceDensity', 'surfaceMaterialName');
        readSoftMaterial(el, n, 'line', 'lineDensity', 'lineMaterialName', ':scope > linematerial');
        readDeployment(el, n);
        return n;
      }
      case 'streamer': {
        const n = base('streamer', true);
        n['stripLength'] = num(el, 'striplength', 0.5);
        n['stripWidth'] = num(el, 'stripwidth', 0.05);
        const cdText = text(el, ':scope > cd');
        if (cdText && cdText !== 'auto') n['cd'] = Number(cdText);
        readSoftMaterial(el, n, 'surface', 'surfaceDensity', 'surfaceMaterialName');
        readDeployment(el, n);
        return n;
      }
      case 'shockcord': {
        const n = base('shockcord', true);
        n['cordLength'] = num(el, 'cordlength', 0.3);
        readSoftMaterial(el, n, 'line', 'lineDensity', 'lineMaterialName');
        return n;
      }
      case 'masscomponent': {
        const n = base('masscomponent', true);
        n['mass'] = num(el, 'mass', 0.01);
        n['length'] = num(el, 'packedlength', 0.02);
        n['radius'] = num(el, 'packedradius', 0.005);
        return n;
      }
      case 'podset':
      case 'parallelstage':
      case 'boosterset': {
        // <boosterset> is the legacy alias for <parallelstage>. The nested
        // nose/body/fin chain imports via convertChildren (the caller recurses).
        const asmType: ComponentType = tag === 'podset' ? 'podset' : 'parallelstage';
        const n = base(asmType, true); // name + overrides + axialoffset/position
        n['instanceCount'] = Math.round(num(el, 'instancecount', 2));
        const radEl = el.querySelector(':scope > radiusoffset');
        if (radEl) {
          const rv = Number(radEl.textContent?.trim());
          n['radiusOffset'] = Number.isFinite(rv) ? rv : 0; // metres, no conversion
          n['radiusMethod'] = (radEl.getAttribute('method') ?? 'relative').toLowerCase() === 'free'
            ? 'free' : 'relative';
        }
        const angEl = el.querySelector(':scope > angleoffset');
        if (angEl) {
          const av = Number(angEl.textContent?.trim());
          n['angleOffset'] = (Number.isFinite(av) ? av : 0) * Math.PI / 180; // deg → rad, like cant
          if (asmType === 'parallelstage') {
            n['angleMethod'] = (angEl.getAttribute('method') ?? 'relative').toLowerCase() === 'fixed'
              ? 'fixed' : 'relative';
          }
        }
        if (asmType === 'parallelstage') {
          // Same separation read as a booster <stage> — per-config wins over bare.
          const sepEl = el.querySelector(':scope > separationconfiguration') ?? el;
          const ev = text(sepEl, ':scope > separationevent');
          if (ev && ev !== 'ejection') n['separationEvent'] = ev;
          const delay = num(sepEl, 'separationdelay', 0);
          if (delay !== 0) n['separationDelay'] = delay;
          const alt = num(sepEl, 'separationaltitude', NaN);
          if (!Number.isNaN(alt) && alt !== 200) n['separationAltitude'] = alt;
        }
        return n;
      }
      default:
        return null;
    }
  };

  const convertChildren = (parentEl: Element): ComponentNode[] => {
    const out: ComponentNode[] = [];
    const wrap = parentEl.querySelector(':scope > subcomponents');
    if (!wrap) return out;
    for (const el of Array.from(wrap.children)) {
      const node = convertElement(el);
      if (node === null) {
        ignored.add(el.tagName);
        continue;
      }
      const kids = convertChildren(el);
      if (kids.length > 0) node.children = kids;
      out.push(node);
    }
    return out;
  };

  // EVERY stage imports (Release C) — each becomes a stage node carrying its
  // separation config (desktop writes defaults bare under <stage>).
  const components: ComponentNode[] = stages.map((stageEl, i) => {
    const stage: ComponentNode = {
      type: 'stage',
      id: freshId(),
      name: text(stageEl, ':scope > name') ?? (i === 0 ? 'Sustainer' : `Booster ${i}`),
    };
    // RASAero power-on base-drag input (metres) — every stage, incl. sustainer.
    const nozzle = num(stageEl, 'nozzleexitdiameter', NaN);
    if (!Number.isNaN(nozzle) && nozzle > 0) stage['nozzleExitDiameter'] = nozzle;
    if (i > 0) {
      // Like ignition: the per-config block overrides the bare defaults
      // (desktop writes defaults bare, overrides in <separationconfiguration>).
      const sepEl = stageEl.querySelector(':scope > separationconfiguration') ?? stageEl;
      const ev = text(sepEl, ':scope > separationevent');
      if (ev && ev !== 'ejection') stage['separationEvent'] = ev;
      const delay = num(sepEl, 'separationdelay', 0);
      if (delay !== 0) stage['separationDelay'] = delay;
      const alt = num(sepEl, 'separationaltitude', NaN);
      if (!Number.isNaN(alt) && alt !== 200) stage['separationAltitude'] = alt;
    }
    const kids = convertChildren(stageEl);
    if (kids.length > 0) stage.children = kids;
    return stage;
  });
  if (components.every((s) => (s.children ?? []).length === 0)) {
    throw new Error('No supported components found in this design.');
  }
  if (ignored.size) {
    notes.push(`Ignored unsupported components: ${[...ignored].join(', ')}.`);
  }

  return { name, tree: { name, components }, motor, motors, ignored: [...ignored], notes };
}

// ============================ EXPORT ============================

export interface OrkExportMotor {
  designation: string;
  manufacturer?: string;
  diameter: number;
  length: number;
  delay: number;
  /** Kernel ignition-event name (automatic|launch|ejectioncharge|burnout|never). */
  ignitionEvent?: string;
  ignitionDelay?: number;
}

export interface OrkTreeExportInput {
  name: string;
  tree: RocketTree;
  /** Motors keyed by mount node id (Release C: one per mount). */
  motors?: Record<string, OrkExportMotor>;
  /** Legacy single-motor form (tests/back-compat). */
  motor?: OrkExportMotor;
  mountId?: string | null;
}

export function exportOrk({ name, tree, motors, motor, mountId }: OrkTreeExportInput): string {
  const motorMap: Record<string, OrkExportMotor> = { ...(motors ?? {}) };
  if (motor && mountId && !motorMap[mountId]) motorMap[mountId] = motor;
  const configId = uuid();
  const lines: string[] = [];
  const emit = (depth: number, s: string) => lines.push('  '.repeat(depth) + s);

  const material = (depth: number, node: ComponentNode, kind: 'bulk' | 'surface' | 'line' = 'bulk') => {
    if (kind === 'bulk') {
      const name = typeof node['materialName'] === 'string' ? (node['materialName'] as string) : 'custom';
      if (typeof node.density === 'number' && node.density > 0) {
        emit(depth, `<material type="bulk" density="${node.density}">${escapeXml(name)}</material>`);
      } else {
        emit(depth, '<material type="bulk" density="680.0" group="PaperProducts">Cardboard</material>');
      }
    } else if (kind === 'surface') {
      if (typeof node['surfaceDensity'] === 'number') {
        const name = typeof node['surfaceMaterialName'] === 'string'
          ? (node['surfaceMaterialName'] as string) : 'custom';
        emit(depth, `<material type="surface" density="${node['surfaceDensity']}">${escapeXml(name)}</material>`);
      } else {
        emit(depth, '<material type="surface" density="0.067" group="Fabrics">Ripstop nylon</material>');
      }
    } else {
      if (typeof node['lineDensity'] === 'number') {
        const name = typeof node['lineMaterialName'] === 'string'
          ? (node['lineMaterialName'] as string) : 'custom';
        emit(depth, `<material type="line" density="${node['lineDensity']}">${escapeXml(name)}</material>`);
      } else {
        emit(depth, '<material type="line" density="0.0018" group="ThreadsLines">Elastic cord (round 2 mm, 1/16 in)</material>');
      }
    }
  };

  const position = (depth: number, node: ComponentNode, dflt: ComponentPosition['method'] = 'top') => {
    const pos = (node.position ?? { method: dflt, offset: 0 }) as ComponentPosition;
    emit(depth, `<axialoffset method="${pos.method}">${pos.offset}</axialoffset>`);
    emit(depth, `<position type="${pos.method}">${pos.offset}</position>`);
  };

  const header = (depth: number, node: ComponentNode, fallback: string) => {
    emit(depth, `<name>${escapeXml(node.name ?? fallback)}</name>`);
    emit(depth, `<id>${uuid()}</id>`);
    overrides(depth, node);
  };

  // Mass/CG/Cd overrides, exactly as the desktop RocketComponentSaver writes them.
  const overrides = (depth: number, node: ComponentNode) => {
    if (typeof node['overrideMass'] === 'number') {
      emit(depth, `<overridemass>${node['overrideMass']}</overridemass>`);
      emit(depth, '<overridesubcomponentsmass>false</overridesubcomponentsmass>');
    }
    if (typeof node['overrideCGX'] === 'number') {
      emit(depth, `<overridecg>${node['overrideCGX']}</overridecg>`);
      emit(depth, '<overridesubcomponentscg>false</overridesubcomponentscg>');
    }
    if (typeof node['overrideCD'] === 'number') {
      emit(depth, `<overridecd>${node['overrideCD']}</overridecd>`);
      emit(depth, '<overridesubcomponentscd>false</overridesubcomponentscd>');
    }
  };

  const finishXml = (depth: number, node: ComponentNode) => {
    // finish (like shape/crosssection/cluster below) is file-sourced free
    // text on import — escape it or a crafted file breaks the re-export.
    emit(depth, `<finish>${escapeXml(String(node['finish'] ?? 'normal'))}</finish>`);
  };

  // Fin tabs — written like the desktop's FinSetSaver: only when both depth
  // and length are nonzero, with the legacy relativeto spelling first
  // (front/center/end, OR 15.03 compat) then the modern one (top/middle/
  // bottom); readers apply the last occurrence.
  const finTabsXml = (depth: number, node: ComponentNode) => {
    const h = n(node, 'tabHeight', 0);
    const len = n(node, 'tabLength', 0);
    if (h <= 0 || len <= 0) return;
    const method = typeof node['tabOffsetMethod'] === 'string'
      ? (node['tabOffsetMethod'] as string) : 'middle';
    const legacy = method === 'top' ? 'front' : method === 'bottom' ? 'end' : 'center';
    const offset = n(node, 'tabOffset', 0);
    emit(depth, `<tabheight>${h}</tabheight>`);
    emit(depth, `<tablength>${len}</tablength>`);
    emit(depth, `<tabposition relativeto="${legacy}">${offset}</tabposition>`);
    emit(depth, `<tabposition relativeto="${method}">${offset}</tabposition>`);
  };

  // The desktop encodes "solid" as <thickness>filled</thickness>.
  const thicknessXml = (depth: number, node: ComponentNode, fb: number) => {
    emit(depth, node['filled'] === true
      ? '<thickness>filled</thickness>'
      : `<thickness>${typeof node['thickness'] === 'number' ? node['thickness'] : fb}</thickness>`);
  };

  // m may be absent: a mount with no motor loaded still writes <motormount>
  // so the mount flag survives the round trip (desktop does the same).
  const motorMountXml = (depth: number, m?: OrkExportMotor, overhangM = 0) => {
    const ev = m?.ignitionEvent ?? 'automatic';
    const evDelay = m?.ignitionDelay ?? 0;
    emit(depth, '<motormount>');
    emit(depth + 1, `<ignitionevent>${escapeXml(ev)}</ignitionevent>`);
    emit(depth + 1, `<ignitiondelay>${evDelay}</ignitiondelay>`);
    emit(depth + 1, `<overhang>${overhangM}</overhang>`);
    if (m) {
      emit(depth + 1, `<motor configid="${configId}">`);
      emit(depth + 2, '<type>single</type>');
      emit(depth + 2, `<manufacturer>${escapeXml(m.manufacturer ?? 'custom')}</manufacturer>`);
      emit(depth + 2, `<designation>${escapeXml(m.designation)}</designation>`);
      emit(depth + 2, `<diameter>${m.diameter}</diameter>`);
      emit(depth + 2, `<length>${m.length}</length>`);
      emit(depth + 2, `<delay>${m.delay}</delay>`);
      emit(depth + 1, '</motor>');
      emit(depth + 1, `<ignitionconfiguration configid="${configId}">`);
      emit(depth + 2, `<ignitionevent>${escapeXml(ev)}</ignitionevent>`);
      emit(depth + 2, `<ignitiondelay>${evDelay}</ignitiondelay>`);
      emit(depth + 1, '</ignitionconfiguration>');
    }
    emit(depth, '</motormount>');
  };

  const n = (node: ComponentNode, key: string, fb: number): number =>
    typeof node[key] === 'number' ? (node[key] as number) : fb;

  // Engine defaults from Transition.Shape.defaultParameter() — writing any
  // other fallback silently reshapes the nose (haack's default is 0, not 1).
  const shapeParamXml = (depth: number, node: ComponentNode) => {
    const dflt = shapeParamDefault(String(node['shape'] ?? 'ogive'));
    emit(depth, `<shapeparameter>${n(node, 'shapeParameter', dflt)}</shapeparameter>`);
  };

  const emitChildren = (node: ComponentNode, depth: number) => {
    const kids = node.children ?? [];
    if (kids.length === 0) return;
    emit(depth, '<subcomponents>');
    for (const kid of kids) {
      emitNode(kid, depth + 1);
    }
    emit(depth, '</subcomponents>');
  };

  const emitNode = (node: ComponentNode, depth: number) => {
    const t = node.type;
    const open = (tag: string) => emit(depth, `<${tag}>`);
    const close = (tag: string) => {
      emitChildren(node, depth + 1);
      emit(depth, `</${tag}>`);
    };

    switch (t) {
      case 'nosecone': {
        open('nosecone');
        header(depth + 1, node, 'Nose Cone');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.07)}</length>`);
        thicknessXml(depth + 1, node, 0.002);
        emit(depth + 1, `<shape>${escapeXml(String(node['shape'] ?? 'ogive'))}</shape>`);
        emit(depth + 1, '<shapeclipped>false</shapeclipped>');
        shapeParamXml(depth + 1, node);
        emit(depth + 1, `<aftradius>${n(node, 'aftRadius', 0.012)}</aftradius>`);
        emit(depth + 1, `<aftshoulderradius>${n(node, 'shoulderRadius', 0)}</aftshoulderradius>`);
        emit(depth + 1, `<aftshoulderlength>${n(node, 'shoulderLength', 0)}</aftshoulderlength>`);
        emit(depth + 1, `<aftshoulderthickness>${n(node, 'shoulderThickness', 0)}</aftshoulderthickness>`);
        emit(depth + 1, `<aftshouldercapped>${node['shoulderCapped'] === true}</aftshouldercapped>`);
        emit(depth + 1, '<isflipped>false</isflipped>');
        close('nosecone');
        break;
      }
      case 'transition': {
        open('transition');
        header(depth + 1, node, 'Transition');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.04)}</length>`);
        thicknessXml(depth + 1, node, 0.002);
        emit(depth + 1, `<shape>${escapeXml(String(node['shape'] ?? 'conical'))}</shape>`);
        emit(depth + 1, '<shapeclipped>false</shapeclipped>');
        shapeParamXml(depth + 1, node);
        emit(depth + 1, `<foreradius>${typeof node['foreRadius'] === 'number' ? node['foreRadius'] : 'auto'}</foreradius>`);
        emit(depth + 1, `<aftradius>${typeof node['aftRadius'] === 'number' ? node['aftRadius'] : 'auto'}</aftradius>`);
        for (const side of ['fore', 'aft'] as const) {
          const key = side === 'fore' ? 'foreShoulder' : 'aftShoulder';
          emit(depth + 1, `<${side}shoulderradius>${n(node, `${key}Radius`, 0)}</${side}shoulderradius>`);
          emit(depth + 1, `<${side}shoulderlength>${n(node, `${key}Length`, 0)}</${side}shoulderlength>`);
          emit(depth + 1, `<${side}shoulderthickness>${n(node, `${key}Thickness`, 0)}</${side}shoulderthickness>`);
          emit(depth + 1, `<${side}shouldercapped>false</${side}shouldercapped>`);
        }
        close('transition');
        break;
      }
      case 'bodytube': {
        open('bodytube');
        header(depth + 1, node, 'Body Tube');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.3)}</length>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0005)}</thickness>`);
        emit(depth + 1, `<radius>${n(node, 'outerRadius', 0.012)}</radius>`);
        // Min-diameter: the body tube itself is the motor mount.
        if (node['motorMount'] === true || (node.id && motorMap[node.id])) {
          motorMountXml(depth + 1, node.id ? motorMap[node.id] : undefined, n(node, 'motorOverhang', 0));
        }
        close('bodytube');
        break;
      }
      case 'trapezoidfinset': {
        open('trapezoidfinset');
        header(depth + 1, node, 'Trapezoidal Fin Set');
        emit(depth + 1, `<instancecount>${n(node, 'finCount', 3)}</instancecount>`);
        emit(depth + 1, `<fincount>${n(node, 'finCount', 3)}</fincount>`);
        emit(depth + 1, '<radiusoffset method="surface">0.0</radiusoffset>');
        emit(depth + 1, '<angleoffset method="relative">0.0</angleoffset>');
        emit(depth + 1, '<rotation>0.0</rotation>');
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${escapeXml(String(node['crossSection'] ?? 'square'))}</crosssection>`);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        finTabsXml(depth + 1, node);
        emit(depth + 1, '<filletradius>0.0</filletradius>');
        emit(depth + 1, '<filletmaterial type="bulk" density="680.0" group="PaperProducts">Cardboard</filletmaterial>');
        emit(depth + 1, `<rootchord>${n(node, 'rootChord', 0.05)}</rootchord>`);
        emit(depth + 1, `<tipchord>${n(node, 'tipChord', 0.03)}</tipchord>`);
        emit(depth + 1, `<sweeplength>${n(node, 'sweep', 0.02)}</sweeplength>`);
        emit(depth + 1, `<height>${n(node, 'height', 0.03)}</height>`);
        close('trapezoidfinset');
        break;
      }
      case 'freeformfinset': {
        open('freeformfinset');
        header(depth + 1, node, 'Freeform Fin Set');
        emit(depth + 1, `<instancecount>${n(node, 'finCount', 3)}</instancecount>`);
        emit(depth + 1, `<fincount>${n(node, 'finCount', 3)}</fincount>`);
        emit(depth + 1, '<radiusoffset method="surface">0.0</radiusoffset>');
        emit(depth + 1, '<angleoffset method="relative">0.0</angleoffset>');
        emit(depth + 1, '<rotation>0.0</rotation>');
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${escapeXml(String(node['crossSection'] ?? 'square'))}</crosssection>`);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        finTabsXml(depth + 1, node);
        emit(depth + 1, '<filletradius>0.0</filletradius>');
        emit(depth + 1, '<filletmaterial type="bulk" density="680.0" group="PaperProducts">Cardboard</filletmaterial>');
        emit(depth + 1, '<finpoints>');
        const ffPts = (node['points'] as [number, number][] | undefined) ?? [];
        for (const [px, py] of ffPts) {
          emit(depth + 2, `<point x="${px}" y="${py}"/>`);
        }
        emit(depth + 1, '</finpoints>');
        close('freeformfinset');
        break;
      }
      case 'ellipticalfinset': {
        open('ellipticalfinset');
        header(depth + 1, node, 'Elliptical Fin Set');
        emit(depth + 1, `<instancecount>${n(node, 'finCount', 3)}</instancecount>`);
        emit(depth + 1, `<fincount>${n(node, 'finCount', 3)}</fincount>`);
        emit(depth + 1, '<radiusoffset method="surface">0.0</radiusoffset>');
        emit(depth + 1, '<angleoffset method="relative">0.0</angleoffset>');
        emit(depth + 1, '<rotation>0.0</rotation>');
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${escapeXml(String(node['crossSection'] ?? 'square'))}</crosssection>`);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        finTabsXml(depth + 1, node);
        emit(depth + 1, '<filletradius>0.0</filletradius>');
        emit(depth + 1, '<filletmaterial type="bulk" density="680.0" group="PaperProducts">Cardboard</filletmaterial>');
        emit(depth + 1, `<rootchord>${n(node, 'rootChord', 0.05)}</rootchord>`);
        emit(depth + 1, `<height>${n(node, 'height', 0.03)}</height>`);
        close('ellipticalfinset');
        break;
      }
      case 'tubefinset': {
        open('tubefinset');
        header(depth + 1, node, 'Tube Fin Set');
        emit(depth + 1, `<instancecount>${n(node, 'finCount', 6)}</instancecount>`);
        emit(depth + 1, `<fincount>${n(node, 'finCount', 6)}</fincount>`);
        emit(depth + 1, '<radiusoffset method="coaxial">0.0</radiusoffset>');
        emit(depth + 1, '<angleoffset method="fixed">0.0</angleoffset>');
        emit(depth + 1, '<rotation>0.0</rotation>');
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<radius>${typeof node['outerRadius'] === 'number' ? node['outerRadius'] : 'auto'}</radius>`);
        emit(depth + 1, `<length>${n(node, 'length', 0.1)}</length>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0005)}</thickness>`);
        close('tubefinset');
        break;
      }
      case 'innertube': {
        open('innertube');
        header(depth + 1, node, 'Inner Tube');
        position(depth + 1, node, 'bottom');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.07)}</length>`);
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, `<outerradius>${n(node, 'outerRadius', 0.0095)}</outerradius>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0005)}</thickness>`);
        // Desktop stores cluster rotation in DEGREES; we keep radians inside.
        emit(depth + 1, `<clusterconfiguration>${escapeXml(typeof node['cluster'] === 'string' ? (node['cluster'] as string) : 'single')}</clusterconfiguration>`);
        emit(depth + 1, `<clusterscale>${n(node, 'clusterScale', 1)}</clusterscale>`);
        emit(depth + 1, `<clusterrotation>${(n(node, 'clusterRotation', 0) * 180) / Math.PI}</clusterrotation>`);
        if (node['motorMount'] === true || (node.id && motorMap[node.id])) {
          motorMountXml(depth + 1, node.id ? motorMap[node.id] : undefined, n(node, 'motorOverhang', 0));
        }
        close('innertube');
        break;
      }
      case 'tubecoupler': {
        open('tubecoupler');
        header(depth + 1, node, 'Tube Coupler');
        position(depth + 1, node, 'bottom');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.05)}</length>`);
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, '<outerradius>auto</outerradius>');
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0005)}</thickness>`);
        close('tubecoupler');
        break;
      }
      case 'centeringring':
      case 'bulkhead': {
        open(t);
        header(depth + 1, node, t === 'bulkhead' ? 'Bulkhead' : 'Centering Ring');
        emit(depth + 1, '<instancecount>1</instancecount>');
        emit(depth + 1, '<instanceseparation>0.0</instanceseparation>');
        position(depth + 1, node, 'bottom');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.002)}</length>`);
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, '<outerradius>auto</outerradius>');
        if (t === 'centeringring') emit(depth + 1, '<innerradius>auto</innerradius>');
        close(t);
        break;
      }
      case 'engineblock': {
        open('engineblock');
        header(depth + 1, node, 'Engine Block');
        position(depth + 1, node, 'bottom');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.005)}</length>`);
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, '<outerradius>auto</outerradius>');
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.001)}</thickness>`);
        close('engineblock');
        break;
      }
      case 'launchlug': {
        open('launchlug');
        header(depth + 1, node, 'Launch Lug');
        emit(depth + 1, '<instancecount>1</instancecount>');
        emit(depth + 1, '<instanceseparation>0.0</instanceseparation>');
        emit(depth + 1, '<angleoffset method="relative">180.0</angleoffset>');
        emit(depth + 1, '<radialdirection>180.0</radialdirection>');
        position(depth + 1, node, 'middle');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<radius>${n(node, 'outerRadius', 0.0022)}</radius>`);
        emit(depth + 1, `<length>${n(node, 'length', 0.05)}</length>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0003)}</thickness>`);
        close('launchlug');
        break;
      }
      case 'railbutton': {
        open('railbutton');
        header(depth + 1, node, 'Rail Button');
        emit(depth + 1, '<instancecount>1</instancecount>');
        emit(depth + 1, '<instanceseparation>0.0</instanceseparation>');
        emit(depth + 1, '<angleoffset method="relative">180.0</angleoffset>');
        position(depth + 1, node, 'middle');
        finishXml(depth + 1, node);
        emit(depth + 1, '<material type="bulk" density="1420.0" group="Plastics">Delrin</material>');
        emit(depth + 1, `<outerdiameter>${n(node, 'outerDiameter', 0.0097)}</outerdiameter>`);
        emit(depth + 1, '<innerdiameter>0.008</innerdiameter>');
        emit(depth + 1, '<height>0.0097</height>');
        emit(depth + 1, '<baseheight>0.002</baseheight>');
        emit(depth + 1, '<flangeheight>0.002</flangeheight>');
        emit(depth + 1, '<screwheight>0.0</screwheight>');
        close('railbutton');
        break;
      }
      case 'parachute': {
        open('parachute');
        header(depth + 1, node, 'Parachute');
        position(depth + 1, node, 'top');
        emit(depth + 1, '<packedlength>0.025</packedlength>');
        emit(depth + 1, '<packedradius>0.0125</packedradius>');
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, `<cd>${typeof node['cd'] === 'number' ? node['cd'] : 'auto'}</cd>`);
        material(depth + 1, node, 'surface');
        emit(depth + 1, `<deployevent>${escapeXml(String(node['deployEvent'] ?? 'ejection'))}</deployevent>`);
        emit(depth + 1, `<deployaltitude>${n(node, 'deployAltitude', 200)}</deployaltitude>`);
        emit(depth + 1, `<deploydelay>${n(node, 'deployDelay', 0)}</deploydelay>`);
        emit(depth + 1, `<diameter>${n(node, 'diameter', 0.3)}</diameter>`);
        emit(depth + 1, `<linecount>${n(node, 'lineCount', 6)}</linecount>`);
        emit(depth + 1, `<linelength>${n(node, 'lineLength', 0.3)}</linelength>`);
        if (typeof node['lineDensity'] === 'number') {
          const lname = typeof node['lineMaterialName'] === 'string' ? (node['lineMaterialName'] as string) : 'custom';
          emit(depth + 1, `<linematerial type="line" density="${node['lineDensity']}">${escapeXml(lname)}</linematerial>`);
        } else {
          emit(depth + 1, '<linematerial type="line" density="0.0018" group="ThreadsLines">Elastic cord (round 2 mm, 1/16 in)</linematerial>');
        }
        close('parachute');
        break;
      }
      case 'streamer': {
        open('streamer');
        header(depth + 1, node, 'Streamer');
        position(depth + 1, node, 'top');
        emit(depth + 1, '<packedlength>0.025</packedlength>');
        emit(depth + 1, '<packedradius>0.0125</packedradius>');
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, `<cd>${typeof node['cd'] === 'number' ? node['cd'] : 'auto'}</cd>`);
        material(depth + 1, node, 'surface');
        emit(depth + 1, `<deployevent>${escapeXml(String(node['deployEvent'] ?? 'ejection'))}</deployevent>`);
        emit(depth + 1, `<deployaltitude>${n(node, 'deployAltitude', 200)}</deployaltitude>`);
        emit(depth + 1, `<deploydelay>${n(node, 'deployDelay', 0)}</deploydelay>`);
        emit(depth + 1, `<striplength>${n(node, 'stripLength', 0.5)}</striplength>`);
        emit(depth + 1, `<stripwidth>${n(node, 'stripWidth', 0.05)}</stripwidth>`);
        close('streamer');
        break;
      }
      case 'shockcord': {
        open('shockcord');
        header(depth + 1, node, 'Shock Cord');
        position(depth + 1, node, 'top');
        emit(depth + 1, '<packedlength>0.025</packedlength>');
        emit(depth + 1, '<packedradius>0.0125</packedradius>');
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, `<cordlength>${n(node, 'cordLength', 0.3)}</cordlength>`);
        material(depth + 1, node, 'line');
        close('shockcord');
        break;
      }
      case 'masscomponent': {
        open('masscomponent');
        header(depth + 1, node, 'Mass Component');
        position(depth + 1, node, 'top');
        emit(depth + 1, `<packedlength>${n(node, 'length', 0.02)}</packedlength>`);
        emit(depth + 1, `<packedradius>${n(node, 'radius', 0.005)}</packedradius>`);
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        emit(depth + 1, `<mass>${n(node, 'mass', 0.01)}</mass>`);
        emit(depth + 1, '<masscomponenttype>masscomponent</masscomponenttype>');
        close('masscomponent');
        break;
      }
      case 'podset':
      case 'parallelstage': {
        open(t);
        header(depth + 1, node, t === 'podset' ? 'Pod set' : 'Booster');
        // ComponentAssembly: NO <color>/<linestyle>/<radialdirection> — the
        // desktop savers suppress all three for assemblies.
        emit(depth + 1, `<instancecount>${n(node, 'instanceCount', 2)}</instancecount>`);
        const rMethod = node['radiusMethod'] === 'free' ? 'free' : 'relative';
        emit(depth + 1, `<radiusoffset method="${rMethod}">${n(node, 'radiusOffset', 0)}</radiusoffset>`); // metres
        const aMethod = node['angleMethod'] === 'fixed' ? 'fixed' : 'relative';
        // angleOffset is stored in radians → DEGREES on disk (same as cant).
        emit(depth + 1, `<angleoffset method="${aMethod}">${(n(node, 'angleOffset', 0) * 180) / Math.PI}</angleoffset>`);
        position(depth + 1, node, 'bottom');
        if (t === 'parallelstage') {
          // Same separation block a booster <stage> writes (bare default + config).
          const ev = typeof node['separationEvent'] === 'string' ? (node['separationEvent'] as string) : 'ejection';
          const delay = typeof node['separationDelay'] === 'number' ? (node['separationDelay'] as number) : 0;
          const alt = typeof node['separationAltitude'] === 'number' ? (node['separationAltitude'] as number) : 200;
          const sep = (d: number) => {
            emit(d, `<separationevent>${escapeXml(ev)}</separationevent>`);
            emit(d, `<separationaltitude>${alt}</separationaltitude>`);
            emit(d, `<separationdelay>${delay}</separationdelay>`);
          };
          sep(depth + 1);
          emit(depth + 1, `<separationconfiguration configid="${configId}">`);
          sep(depth + 2);
          emit(depth + 1, '</separationconfiguration>');
        }
        close(t);
        break;
      }
    }
  };

  emit(0, "<?xml version='1.0' encoding='utf-8'?>");
  emit(0, '<openrocket version="1.10" creator="Online OpenRocket">');
  emit(1, '<rocket>');
  emit(2, `<name>${escapeXml(name)}</name>`);
  emit(2, `<id>${uuid()}</id>`);
  emit(2, '<axialoffset method="absolute">0.0</axialoffset>');
  emit(2, '<position type="absolute">0.0</position>');
  emit(2, '<designtype>original</designtype>');
  // Stage nodes at the top level export as sibling <stage> blocks (the
  // desktop model); legacy flat trees wrap into one implicit stage.
  const stageNodes = asStageNodes(tree);
  emit(2, `<motorconfiguration configid="${configId}" default="true">`);
  for (let i = 0; i < stageNodes.length; i++) {
    emit(3, `<stage number="${i}" active="true"/>`);
  }
  emit(2, '</motorconfiguration>');
  emit(2, '<referencetype>maximum</referencetype>');
  emit(2, '<subcomponents>');
  for (let i = 0; i < stageNodes.length; i++) {
    const st = stageNodes[i]!;
    emit(3, '<stage>');
    emit(4, `<name>${escapeXml(st.name ?? (i === 0 ? 'Sustainer' : `Booster ${i}`))}</name>`);
    emit(4, `<id>${uuid()}</id>`);
    // RASAero power-on base-drag input (metres, no conversion). Non-standard
    // element (OpenRocket desktop ignores it); only emitted when set > 0 so a
    // plain design round-trips exactly. Applies to every stage incl. sustainer.
    if (typeof st['nozzleExitDiameter'] === 'number' && (st['nozzleExitDiameter'] as number) > 0) {
      emit(4, `<nozzleexitdiameter>${st['nozzleExitDiameter']}</nozzleexitdiameter>`);
    }
    if (i > 0) {
      // Separation (lower stages only) — desktop writes the DEFAULT params
      // bare, then a per-config block (AxialStageSaver).
      const ev = typeof st['separationEvent'] === 'string' ? (st['separationEvent'] as string) : 'ejection';
      const delay = typeof st['separationDelay'] === 'number' ? (st['separationDelay'] as number) : 0;
      const alt = typeof st['separationAltitude'] === 'number' ? (st['separationAltitude'] as number) : 200;
      const sep = (d: number) => {
        emit(d, `<separationevent>${escapeXml(ev)}</separationevent>`);
        emit(d, `<separationaltitude>${alt}</separationaltitude>`);
        emit(d, `<separationdelay>${delay}</separationdelay>`);
      };
      sep(4);
      emit(4, `<separationconfiguration configid="${configId}">`);
      sep(5);
      emit(4, '</separationconfiguration>');
    }
    emit(4, '<subcomponents>');
    for (const node of st.children ?? []) {
      emitNode(node, 5);
    }
    emit(4, '</subcomponents>');
    emit(3, '</stage>');
  }
  emit(2, '</subcomponents>');
  emit(1, '</rocket>');
  emit(1, '<simulations>');
  emit(1, '</simulations>');
  emit(0, '</openrocket>');
  return lines.join('\n') + '\n';
}

// ============================ helpers ============================

function num(el: Element, tag: string, fallback: number): number {
  const t = text(el, `:scope > ${tag}`);
  // Values like "auto 0.012" carry an automatic flag + last value.
  const v = t ? Number(t.split(/\s+/).pop()) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

function matDensity(el: Element): number | undefined {
  const m = el.querySelector(':scope > material');
  if (!m || m.getAttribute('type') !== 'bulk') return undefined;
  const d = Number(m.getAttribute('density'));
  return Number.isFinite(d) && d > 0 ? d : undefined;
}

/** Material NAME if it's a real name (not the "custom" placeholder). */
function matName_(el: Element, type: string, selector = ':scope > material'): string | undefined {
  const m = el.querySelector(selector);
  if (!m || m.getAttribute('type') !== type) return undefined;
  const name = m.textContent?.trim();
  return name && name.toLowerCase() !== 'custom' ? name : undefined;
}

/** Surface/line material density+name for recovery devices and cords. */
function readSoftMaterial(el: Element, node: ComponentNode, kind: 'surface' | 'line',
    densityKey: string, nameKey: string, selector = ':scope > material'): void {
  const m = el.querySelector(selector);
  if (!m || m.getAttribute('type') !== kind) return;
  const d = Number(m.getAttribute('density'));
  if (Number.isFinite(d) && d > 0) node[densityKey] = d;
  const name = matName_(el, kind, selector);
  if (name) node[nameKey] = name;
}

/**
 * Fin tabs: <tabheight>, <tablength>, <tabposition relativeto="...">. Desktop
 * files carry TWO tabposition elements (legacy front/center/end + modern
 * top/middle/bottom) — like the desktop reader, the last one wins.
 */
function readFinTabs(el: Element, node: ComponentNode): void {
  const h = num(el, 'tabheight', 0);
  const len = num(el, 'tablength', 0);
  if (h <= 0 || len <= 0) return;
  node['tabHeight'] = h;
  node['tabLength'] = len;
  const positions = Array.from(el.querySelectorAll(':scope > tabposition'));
  const last = positions[positions.length - 1];
  if (last) {
    const rel = (last.getAttribute('relativeto') ?? 'middle').toLowerCase();
    const method = rel.includes('front') || rel === 'top' ? 'top'
      : rel.includes('end') || rel === 'bottom' ? 'bottom'
      : 'middle';
    node['tabOffsetMethod'] = method;
    const v = Number(last.textContent?.trim());
    node['tabOffset'] = Number.isFinite(v) ? v : 0;
  }
}

/** Mirrors Transition.Shape.defaultParameter() in the carved kernel. */
function shapeParamDefault(shape: string): number {
  switch (shape) {
    case 'ogive':
    case 'parabolic':
      return 1.0;
    case 'power':
      return 0.5;
    default:
      return 0.0; // conical, ellipsoid, haack
  }
}

function readDeployment(el: Element, node: ComponentNode): void {
  const event = text(el, ':scope > deployevent');
  if (event) node['deployEvent'] = event;
  if (text(el, ':scope > deployaltitude') !== null) {
    node['deployAltitude'] = num(el, 'deployaltitude', 200);
  }
  if (text(el, ':scope > deploydelay') !== null) {
    node['deployDelay'] = num(el, 'deploydelay', 0);
  }
}

function readPosition(el: Element): ComponentPosition | undefined {
  // Modern files write <axialoffset method="...">; OpenRocket ≤ 15.03 wrote
  // only <position type="..."> — fall back to it or old files lose every
  // fin/lug/inner-tube offset.
  const off = el.querySelector(':scope > axialoffset') ?? el.querySelector(':scope > position');
  if (!off) return undefined;
  const method = (off.getAttribute('method') ?? off.getAttribute('type') ?? 'top') as ComponentPosition['method'];
  const offset = Number(off.textContent ?? '0');
  if (!['top', 'middle', 'bottom', 'absolute'].includes(method)) return undefined;
  return { method, offset: Number.isFinite(offset) ? offset : 0 };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16));
}
