import { unzipSync, strFromU8 } from 'fflate';
import type { ComponentNode, ComponentPosition, ComponentType, RocketTree } from '@online-openrocket/engine';
import { freshId } from '../tree/treeModel.js';

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
}

export interface OrkTreeImportResult {
  name: string;
  tree: RocketTree;
  motor?: OrkMotorRef;
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

  const name = text(rocketEl, ':scope > name') ?? 'Imported rocket';
  const stages = Array.from(rocketEl.querySelectorAll(':scope > subcomponents > stage'));
  if (stages.length === 0) throw new Error('No stage found');
  if (stages.length > 1) {
    notes.push(`Design has ${stages.length} stages — imported the first (staging arrives in Phase 3).`);
  }

  const readMotor = (el: Element, node: ComponentNode, isInnerTube: boolean) => {
    const motorEl = el.querySelector(':scope > motormount > motor');
    if (!motorEl) return;
    if (isInnerTube) node['motorMount'] = true;
    if (!motor) {
      motor = {
        designation: text(motorEl, ':scope > designation') ?? 'unknown',
        manufacturer: text(motorEl, ':scope > manufacturer') ?? 'unknown',
        diameter: num(motorEl, 'diameter', 0.018),
        length: num(motorEl, 'length', 0.07),
        delay: num(motorEl, 'delay', 0),
        mountId: isInnerTube ? node.id : undefined,
      };
      if (!isInnerTube) {
        notes.push('Motor mounts directly in the body tube — assign it to an inner tube in the editor.');
      }
    }
  };

  const convertElement = (el: Element): ComponentNode | null => {
    const tag = el.tagName;
    const base = (type: ComponentType, withPosition: boolean): ComponentNode => {
      const node: ComponentNode = { type, id: freshId() };
      const nm = text(el, ':scope > name');
      if (nm) node.name = nm;
      const density = matDensity(el);
      if (density !== undefined) node.density = density;
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
        n['thickness'] = num(el, 'thickness', 0.002);
        n['shape'] = text(el, ':scope > shape') ?? 'ogive';
        n['shapeParameter'] = num(el, 'shapeparameter', 1.0);
        return n;
      }
      case 'transition': {
        const n = base('transition', false);
        n['length'] = num(el, 'length', 0.04);
        const fore = num(el, 'foreradius', NaN);
        const aft = num(el, 'aftradius', NaN);
        if (!Number.isNaN(fore)) n['foreRadius'] = fore;
        if (!Number.isNaN(aft)) n['aftRadius'] = aft;
        n['thickness'] = num(el, 'thickness', 0.002);
        n['shape'] = text(el, ':scope > shape') ?? 'conical';
        n['shapeParameter'] = num(el, 'shapeparameter', 1.0);
        return n;
      }
      case 'bodytube': {
        const n = base('bodytube', false);
        n['length'] = num(el, 'length', 0.3);
        n['outerRadius'] = num(el, 'radius', 0.012);
        n['thickness'] = num(el, 'thickness', 0.0005);
        readMotor(el, n, false);
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
        return n;
      }
      case 'ellipticalfinset': {
        const n = base('ellipticalfinset', true);
        n['finCount'] = Math.round(num(el, 'fincount', 3));
        n['rootChord'] = num(el, 'rootchord', 0.05);
        n['height'] = num(el, 'height', 0.03);
        n['thickness'] = num(el, 'thickness', 0.003);
        const csE = text(el, ':scope > crosssection');
        if (csE && csE !== 'square') n['crossSection'] = csE;
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
        readMotor(el, n, true);
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
        return n;
      }
      case 'streamer': {
        const n = base('streamer', true);
        n['stripLength'] = num(el, 'striplength', 0.5);
        n['stripWidth'] = num(el, 'stripwidth', 0.05);
        const cdText = text(el, ':scope > cd');
        if (cdText && cdText !== 'auto') n['cd'] = Number(cdText);
        return n;
      }
      case 'shockcord': {
        const n = base('shockcord', true);
        n['cordLength'] = num(el, 'cordlength', 0.3);
        return n;
      }
      case 'masscomponent': {
        const n = base('masscomponent', true);
        n['mass'] = num(el, 'mass', 0.01);
        n['length'] = num(el, 'packedlength', 0.02);
        n['radius'] = num(el, 'packedradius', 0.005);
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

  const components = convertChildren(stages[0]!);
  if (components.length === 0) {
    throw new Error('No supported components found in this design.');
  }
  if (ignored.size) {
    notes.push(`Ignored unsupported components: ${[...ignored].join(', ')}.`);
  }

  return { name, tree: { name, components }, motor, ignored: [...ignored], notes };
}

// ============================ EXPORT ============================

export interface OrkTreeExportInput {
  name: string;
  tree: RocketTree;
  motor?: { designation: string; manufacturer?: string; diameter: number; length: number; delay: number };
  /** Node id of the mount the motor is attached to. */
  mountId?: string | null;
}

export function exportOrk({ name, tree, motor, mountId }: OrkTreeExportInput): string {
  const configId = uuid();
  const lines: string[] = [];
  const emit = (depth: number, s: string) => lines.push('  '.repeat(depth) + s);

  const material = (depth: number, node: ComponentNode, kind: 'bulk' | 'surface' | 'line' = 'bulk') => {
    if (kind === 'bulk' && typeof node.density === 'number' && node.density > 0) {
      emit(depth, `<material type="bulk" density="${node.density}" group="Custom">custom</material>`);
    } else if (kind === 'bulk') {
      emit(depth, '<material type="bulk" density="680.0" group="PaperProducts">Cardboard</material>');
    } else if (kind === 'surface') {
      emit(depth, '<material type="surface" density="0.067" group="Fabrics">Ripstop nylon</material>');
    } else {
      emit(depth, '<material type="line" density="0.0018" group="ThreadsLines">Elastic cord (round 2 mm, 1/16 in)</material>');
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
  };

  const motorMountXml = (depth: number) => {
    if (!motor) return;
    emit(depth, '<motormount>');
    emit(depth + 1, '<ignitionevent>automatic</ignitionevent>');
    emit(depth + 1, '<ignitiondelay>0.0</ignitiondelay>');
    emit(depth + 1, '<overhang>0.0</overhang>');
    emit(depth + 1, `<motor configid="${configId}">`);
    emit(depth + 2, '<type>single</type>');
    emit(depth + 2, `<manufacturer>${escapeXml(motor.manufacturer ?? 'custom')}</manufacturer>`);
    emit(depth + 2, `<designation>${escapeXml(motor.designation)}</designation>`);
    emit(depth + 2, `<diameter>${motor.diameter}</diameter>`);
    emit(depth + 2, `<length>${motor.length}</length>`);
    emit(depth + 2, `<delay>${motor.delay}</delay>`);
    emit(depth + 1, '</motor>');
    emit(depth + 1, `<ignitionconfiguration configid="${configId}">`);
    emit(depth + 2, '<ignitionevent>automatic</ignitionevent>');
    emit(depth + 2, '<ignitiondelay>0.0</ignitiondelay>');
    emit(depth + 1, '</ignitionconfiguration>');
    emit(depth, '</motormount>');
  };

  const n = (node: ComponentNode, key: string, fb: number): number =>
    typeof node[key] === 'number' ? (node[key] as number) : fb;

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
        emit(depth + 1, '<finish>normal</finish>');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.07)}</length>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.002)}</thickness>`);
        emit(depth + 1, `<shape>${node['shape'] ?? 'ogive'}</shape>`);
        emit(depth + 1, '<shapeclipped>false</shapeclipped>');
        emit(depth + 1, `<shapeparameter>${n(node, 'shapeParameter', 1.0)}</shapeparameter>`);
        emit(depth + 1, `<aftradius>${n(node, 'aftRadius', 0.012)}</aftradius>`);
        emit(depth + 1, '<aftshoulderradius>0.0</aftshoulderradius>');
        emit(depth + 1, '<aftshoulderlength>0.0</aftshoulderlength>');
        emit(depth + 1, '<aftshoulderthickness>0.0</aftshoulderthickness>');
        emit(depth + 1, '<aftshouldercapped>false</aftshouldercapped>');
        emit(depth + 1, '<isflipped>false</isflipped>');
        close('nosecone');
        break;
      }
      case 'transition': {
        open('transition');
        header(depth + 1, node, 'Transition');
        emit(depth + 1, '<finish>normal</finish>');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.04)}</length>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.002)}</thickness>`);
        emit(depth + 1, `<shape>${node['shape'] ?? 'conical'}</shape>`);
        emit(depth + 1, '<shapeclipped>false</shapeclipped>');
        emit(depth + 1, `<shapeparameter>${n(node, 'shapeParameter', 1.0)}</shapeparameter>`);
        emit(depth + 1, `<foreradius>${typeof node['foreRadius'] === 'number' ? node['foreRadius'] : 'auto'}</foreradius>`);
        emit(depth + 1, `<aftradius>${typeof node['aftRadius'] === 'number' ? node['aftRadius'] : 'auto'}</aftradius>`);
        for (const side of ['fore', 'aft']) {
          emit(depth + 1, `<${side}shoulderradius>0.0</${side}shoulderradius>`);
          emit(depth + 1, `<${side}shoulderlength>0.0</${side}shoulderlength>`);
          emit(depth + 1, `<${side}shoulderthickness>0.0</${side}shoulderthickness>`);
          emit(depth + 1, `<${side}shouldercapped>false</${side}shouldercapped>`);
        }
        close('transition');
        break;
      }
      case 'bodytube': {
        open('bodytube');
        header(depth + 1, node, 'Body Tube');
        emit(depth + 1, '<finish>normal</finish>');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.3)}</length>`);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0005)}</thickness>`);
        emit(depth + 1, `<radius>${n(node, 'outerRadius', 0.012)}</radius>`);
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
        emit(depth + 1, '<finish>normal</finish>');
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${node['crossSection'] ?? 'square'}</crosssection>`);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        emit(depth + 1, '<filletradius>0.0</filletradius>');
        emit(depth + 1, '<filletmaterial type="bulk" density="680.0" group="PaperProducts">Cardboard</filletmaterial>');
        emit(depth + 1, `<rootchord>${n(node, 'rootChord', 0.05)}</rootchord>`);
        emit(depth + 1, `<tipchord>${n(node, 'tipChord', 0.03)}</tipchord>`);
        emit(depth + 1, `<sweeplength>${n(node, 'sweep', 0.02)}</sweeplength>`);
        emit(depth + 1, `<height>${n(node, 'height', 0.03)}</height>`);
        close('trapezoidfinset');
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
        emit(depth + 1, '<finish>normal</finish>');
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${node['crossSection'] ?? 'square'}</crosssection>`);
        emit(depth + 1, '<cant>0.0</cant>');
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
        emit(depth + 1, '<finish>normal</finish>');
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
        emit(depth + 1, '<clusterconfiguration>single</clusterconfiguration>');
        emit(depth + 1, '<clusterscale>1.0</clusterscale>');
        emit(depth + 1, '<clusterrotation>0.0</clusterrotation>');
        if (motor && mountId && node.id === mountId) {
          motorMountXml(depth + 1);
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
        emit(depth + 1, '<finish>normal</finish>');
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
        emit(depth + 1, '<finish>normal</finish>');
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
        emit(depth + 1, '<deployevent>ejection</deployevent>');
        emit(depth + 1, '<deployaltitude>200.0</deployaltitude>');
        emit(depth + 1, '<deploydelay>0.0</deploydelay>');
        emit(depth + 1, `<diameter>${n(node, 'diameter', 0.3)}</diameter>`);
        emit(depth + 1, `<linecount>${n(node, 'lineCount', 6)}</linecount>`);
        emit(depth + 1, `<linelength>${n(node, 'lineLength', 0.3)}</linelength>`);
        emit(depth + 1, '<linematerial type="line" density="0.0018" group="ThreadsLines">Elastic cord (round 2 mm, 1/16 in)</linematerial>');
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
        emit(depth + 1, '<deployevent>ejection</deployevent>');
        emit(depth + 1, '<deployaltitude>200.0</deployaltitude>');
        emit(depth + 1, '<deploydelay>0.0</deploydelay>');
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
  emit(2, `<motorconfiguration configid="${configId}" default="true">`);
  emit(3, '<stage number="0" active="true"/>');
  emit(2, '</motorconfiguration>');
  emit(2, '<referencetype>maximum</referencetype>');
  emit(2, '<subcomponents>');
  emit(3, '<stage>');
  emit(4, '<name>Sustainer</name>');
  emit(4, `<id>${uuid()}</id>`);
  emit(4, '<subcomponents>');
  for (const node of tree.components) {
    emitNode(node, 5);
  }
  emit(4, '</subcomponents>');
  emit(3, '</stage>');
  emit(2, '</subcomponents>');
  emit(1, '</rocket>');
  emit(1, '<simulations>');
  emit(1, '</simulations>');
  emit(0, '</openrocket>');
  return lines.join('\n') + '\n';
}

// ============================ helpers ============================

function text(el: Element, selector: string): string | null {
  return el.querySelector(selector)?.textContent?.trim() ?? null;
}

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

function readPosition(el: Element): ComponentPosition | undefined {
  const off = el.querySelector(':scope > axialoffset');
  if (!off) return undefined;
  const method = (off.getAttribute('method') ?? 'top') as ComponentPosition['method'];
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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
