import { unzipSync, strFromU8 } from 'fflate';
import type { NoseShape, RocketSpec } from '@online-openrocket/engine';

/**
 * .ork import/export (MVP subset: nose cone, body tube, trapezoid fin set,
 * inner-tube motor mount, parachute, single motor config).
 *
 * The XML structure is templated on a GOLDEN file produced by the real
 * OpenRocket 24.12 GeneralRocketSaver (engine-java/tools/GenerateOrk.java),
 * and exports are validated against the real GeneralRocketLoader. A .ork is
 * either a ZIP containing rocket.ork or bare XML — both are accepted on
 * import; export writes bare XML (the desktop loader sniffs and accepts it).
 */

export interface OrkImportResult {
  name: string;
  spec: RocketSpec;
  /** Motor reference stored in the file (no thrust data in .ork). */
  motor?: {
    designation: string;
    manufacturer: string;
    diameter: number;
    length: number;
    delay: number;
  };
  /** Elements we don't support yet, reported not silently dropped. */
  ignored: string[];
  /** Substitutions and defaults applied during import. */
  notes: string[];
}

// ---------------- import ----------------

export function importOrk(data: ArrayBuffer | string): OrkImportResult {
  let xml: string;
  if (typeof data === 'string') {
    xml = data;
  } else {
    const bytes = new Uint8Array(data);
    // ZIP magic "PK\x03\x04" → unzip and take the .ork entry.
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

  // Strip the optional XML declaration: OpenRocket writes it single-quoted,
  // which some parsers (happy-dom) reject; it carries no needed information.
  xml = xml.replace(/^﻿?\s*<\?xml[^?]*\?>/, '');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Not a valid .ork file (XML parse error)');
  }
  const rocketEl = doc.querySelector('openrocket > rocket');
  if (!rocketEl) throw new Error('Not a .ork file (missing <rocket>)');

  const ignored: string[] = [];
  const notes: string[] = [];
  const name = text(rocketEl, ':scope > name') ?? 'Imported rocket';

  // PERMISSIVE search-based import: find the best candidates anywhere in the
  // tree, synthesize defaults for anything missing, and REPORT every
  // substitution — real designs vary far more than the MVP's fixed layout.

  // Nose cone: first one anywhere.
  const noseEl = rocketEl.querySelector('nosecone');
  const noseCone: RocketSpec['noseCone'] = noseEl
    ? {
        length: num(noseEl, 'length', 0.07),
        aftRadius: num(noseEl, 'aftradius', 0.012),
        thickness: num(noseEl, 'thickness', 0.002),
        shape: (text(noseEl, ':scope > shape') ?? 'ogive') as NoseShape,
        materialDensity: matDensity(noseEl),
      }
    : { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' };
  if (!noseEl) notes.push('No nose cone found — using a default ogive.');

  // Body tube: prefer the one containing fins or a motor mount, else longest.
  const bodyEls = Array.from(rocketEl.querySelectorAll('bodytube'));
  const bodyEl =
    bodyEls.find((b) => b.querySelector('trapezoidfinset, motormount')) ??
    bodyEls.sort((a, b) => num(b, 'length', 0) - num(a, 'length', 0))[0];
  const bodyTube: RocketSpec['bodyTube'] = bodyEl
    ? {
        length: num(bodyEl, 'length', 0.3),
        outerRadius: num(bodyEl, 'radius', 0.012),
        thickness: num(bodyEl, 'thickness', 0.0003),
        materialDensity: matDensity(bodyEl),
      }
    : { length: 0.3, outerRadius: 0.012, thickness: 0.0003 };
  if (!bodyEl) notes.push('No body tube found — using a default tube.');
  if (bodyEls.length > 1) {
    notes.push(`Design has ${bodyEls.length} body tubes — imported the primary one (MVP supports one).`);
  }

  if (!noseEl && !bodyEls.length) {
    throw new Error('No nose cone or body tube found — not a rocket design this MVP can import.');
  }

  // Fins: first trapezoid set anywhere.
  const finEl = rocketEl.querySelector('trapezoidfinset');
  const fins: RocketSpec['fins'] = finEl
    ? {
        count: Math.round(num(finEl, 'fincount', 3)),
        rootChord: num(finEl, 'rootchord', 0.05),
        tipChord: num(finEl, 'tipchord', 0.03),
        sweep: num(finEl, 'sweeplength', 0.02),
        height: num(finEl, 'height', 0.03),
        thickness: num(finEl, 'thickness', 0.003),
        materialDensity: matDensity(finEl),
      }
    : { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 };
  if (!finEl) {
    const otherFins = rocketEl.querySelector('freeformfinset, ellipticalfinset, tubefinset');
    notes.push(otherFins
      ? `Fins are ${otherFins.tagName.replace('finset', '')} — the MVP only supports trapezoidal; using defaults.`
      : 'No trapezoid fin set found — using default fins.');
  }

  // Motor mount: an innertube acting as mount, else any component with a
  // <motormount> child (commonly the body tube itself), else defaults.
  const mountHostEl =
    Array.from(rocketEl.querySelectorAll('innertube')).find((t) => t.querySelector(':scope > motormount')) ??
    rocketEl.querySelector('innertube') ??
    rocketEl.querySelectorAll('motormount')[0]?.parentElement ??
    null;
  let motorMount: RocketSpec['motorMount'];
  if (mountHostEl && mountHostEl.tagName === 'innertube') {
    motorMount = {
      length: num(mountHostEl, 'length', 0.07),
      outerRadius: num(mountHostEl, 'outerradius', 0.0095),
      thickness: num(mountHostEl, 'thickness', 0.0005),
    };
  } else if (mountHostEl) {
    // e.g. minimum-diameter designs: the body tube IS the motor mount.
    const r = num(mountHostEl, 'radius', num(mountHostEl, 'outerradius', 0.0095));
    motorMount = { length: num(mountHostEl, 'length', 0.07), outerRadius: r, thickness: num(mountHostEl, 'thickness', 0.0005) };
    notes.push(`Motor mounts directly in the ${mountHostEl.tagName} — synthesized an equivalent mount tube.`);
  } else {
    motorMount = { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 };
    notes.push('No motor mount found — added a default 18 mm mount.');
  }

  // Motor reference: first configured motor anywhere.
  let motor: OrkImportResult['motor'];
  const motorEl = rocketEl.querySelector('motormount > motor');
  if (motorEl) {
    motor = {
      designation: text(motorEl, ':scope > designation') ?? 'unknown',
      manufacturer: text(motorEl, ':scope > manufacturer') ?? 'unknown',
      diameter: num(motorEl, 'diameter', 0.018),
      length: num(motorEl, 'length', 0.07),
      delay: num(motorEl, 'delay', 0),
    };
  }

  // Recovery: first parachute anywhere.
  let parachute: RocketSpec['parachute'];
  const chuteEl = rocketEl.querySelector('parachute');
  if (chuteEl) {
    const cdText = text(chuteEl, ':scope > cd');
    parachute = {
      diameter: num(chuteEl, 'diameter', 0.3),
      dragCoefficient: cdText && cdText !== 'auto' ? Number(cdText) : undefined,
    };
  } else {
    notes.push('No parachute found — the rocket will fly without recovery.');
  }

  // Report every component type present that the MVP does not model.
  const SUPPORTED = new Set(['nosecone', 'bodytube', 'trapezoidfinset', 'innertube', 'parachute',
    'stage', 'subcomponents', 'motormount', 'motor', 'ignitionconfiguration']);
  const seen = new Set<string>();
  for (const el of Array.from(rocketEl.querySelectorAll('subcomponents *'))) {
    const tag = el.tagName;
    if (!SUPPORTED.has(tag) && el.parentElement?.tagName === 'subcomponents' && !seen.has(tag)) {
      seen.add(tag);
      ignored.push(tag);
    }
  }

  return { name, spec: { noseCone, bodyTube, fins, motorMount, parachute }, motor, ignored, notes };
}

// ---------------- export ----------------

export interface OrkExportInput {
  name: string;
  spec: RocketSpec;
  motor?: { designation: string; manufacturer?: string; diameter: number; length: number; delay: number };
}

export function exportOrk({ name, spec, motor }: OrkExportInput): string {
  const configId = uuid();
  const mat = (density: number | undefined, fallbackName: string, fallbackDensity: number) =>
    density && density > 0
      ? `<material type="bulk" density="${density}" group="Custom">custom</material>`
      : `<material type="bulk" density="${fallbackDensity}" group="PaperProducts">${fallbackName}</material>`;

  const motorXml = motor
    ? `
                <motormount>
                  <ignitionevent>automatic</ignitionevent>
                  <ignitiondelay>0.0</ignitiondelay>
                  <overhang>0.0</overhang>
                  <motor configid="${configId}">
                    <type>single</type>
                    <manufacturer>${escapeXml(motor.manufacturer ?? 'custom')}</manufacturer>
                    <designation>${escapeXml(motor.designation)}</designation>
                    <diameter>${motor.diameter}</diameter>
                    <length>${motor.length}</length>
                    <delay>${motor.delay}</delay>
                  </motor>
                  <ignitionconfiguration configid="${configId}">
                    <ignitionevent>automatic</ignitionevent>
                    <ignitiondelay>0.0</ignitiondelay>
                  </ignitionconfiguration>
                </motormount>`
    : '';

  const chuteXml = spec.parachute
    ? `
              <parachute>
                <name>Parachute</name>
                <id>${uuid()}</id>
                <axialoffset method="top">0.0</axialoffset>
                <position type="top">0.0</position>
                <packedlength>0.025</packedlength>
                <packedradius>${spec.bodyTube.outerRadius}</packedradius>
                <radialposition>0.0</radialposition>
                <radialdirection>0.0</radialdirection>
                <cd>${spec.parachute.dragCoefficient ?? 'auto'}</cd>
                <material type="surface" density="0.067" group="Fabrics">Ripstop nylon</material>
                <deployevent>ejection</deployevent>
                <deployaltitude>200.0</deployaltitude>
                <deploydelay>0.0</deploydelay>
                <diameter>${spec.parachute.diameter}</diameter>
                <linecount>6</linecount>
                <linelength>0.3</linelength>
                <linematerial type="line" density="0.0018" group="ThreadsLines">Elastic cord (round 2 mm, 1/16 in)</linematerial>
              </parachute>`
    : '';

  return `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="Online OpenRocket">
  <rocket>
    <name>${escapeXml(name)}</name>
    <id>${uuid()}</id>
    <axialoffset method="absolute">0.0</axialoffset>
    <position type="absolute">0.0</position>
    <designtype>original</designtype>
    <motorconfiguration configid="${configId}" default="true">
      <stage number="0" active="true"/>
    </motorconfiguration>
    <referencetype>maximum</referencetype>

    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <id>${uuid()}</id>

        <subcomponents>
          <nosecone>
            <name>Nose Cone</name>
            <id>${uuid()}</id>
            <finish>normal</finish>
            ${mat(spec.noseCone.materialDensity, 'Cardboard', 680)}
            <length>${spec.noseCone.length}</length>
            <thickness>${spec.noseCone.thickness}</thickness>
            <shape>${spec.noseCone.shape ?? 'ogive'}</shape>
            <shapeparameter>1.0</shapeparameter>
            <aftradius>${spec.noseCone.aftRadius}</aftradius>
            <aftshoulderradius>0.0</aftshoulderradius>
            <aftshoulderlength>0.0</aftshoulderlength>
            <aftshoulderthickness>0.0</aftshoulderthickness>
            <aftshouldercapped>false</aftshouldercapped>
            <isflipped>false</isflipped>
          </nosecone>

          <bodytube>
            <name>Body Tube</name>
            <id>${uuid()}</id>
            <finish>normal</finish>
            ${mat(spec.bodyTube.materialDensity, 'Cardboard', 680)}
            <length>${spec.bodyTube.length}</length>
            <thickness>${spec.bodyTube.thickness}</thickness>
            <radius>${spec.bodyTube.outerRadius}</radius>

            <subcomponents>
              <trapezoidfinset>
                <name>Trapezoidal Fin Set</name>
                <id>${uuid()}</id>
                <instancecount>${spec.fins.count}</instancecount>
                <fincount>${spec.fins.count}</fincount>
                <radiusoffset method="surface">0.0</radiusoffset>
                <angleoffset method="relative">0.0</angleoffset>
                <rotation>0.0</rotation>
                <axialoffset method="bottom">0.0</axialoffset>
                <position type="bottom">0.0</position>
                <finish>normal</finish>
                ${mat(spec.fins.materialDensity, 'Cardboard', 680)}
                <thickness>${spec.fins.thickness}</thickness>
                <crosssection>square</crosssection>
                <cant>0.0</cant>
                <filletradius>0.0</filletradius>
                <filletmaterial type="bulk" density="680.0" group="PaperProducts">Cardboard</filletmaterial>
                <rootchord>${spec.fins.rootChord}</rootchord>
                <tipchord>${spec.fins.tipChord}</tipchord>
                <sweeplength>${spec.fins.sweep}</sweeplength>
                <height>${spec.fins.height}</height>
              </trapezoidfinset>

              <innertube>
                <name>Inner Tube</name>
                <id>${uuid()}</id>
                <axialoffset method="bottom">0.0</axialoffset>
                <position type="bottom">0.0</position>
                <material type="bulk" density="680.0" group="PaperProducts">Cardboard</material>
                <length>${spec.motorMount.length}</length>
                <radialposition>0.0</radialposition>
                <radialdirection>0.0</radialdirection>
                <outerradius>${spec.motorMount.outerRadius}</outerradius>
                <thickness>${spec.motorMount.thickness}</thickness>
                <clusterconfiguration>single</clusterconfiguration>
                <clusterscale>1.0</clusterscale>
                <clusterrotation>0.0</clusterrotation>${motorXml}
              </innertube>${chuteXml}
            </subcomponents>
          </bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>

  <simulations>
  </simulations>
</openrocket>
`;
}

// ---------------- helpers ----------------

function children(parent: Element, wrapper: string): Element[] {
  const wrap = parent.querySelector(`:scope > ${wrapper}`);
  return wrap ? Array.from(wrap.children) : [];
}

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
