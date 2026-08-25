import { unzipSync, strFromU8 } from 'fflate';
import type { ComponentNode, ComponentPosition, ComponentType, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import { asStageNodes, freshId } from '../tree/treeModel.js';
import { shapeIsClippable, shapeParamDefault } from '../tree/shapeProfile.js';
import { escapeXml, xmlText as text } from './xmlUtil.js';

// Re-export: rocksimFile.ts (and historical callers) import it from here.
export { shapeParamDefault };

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
  /**
   * Desktop motor identity, carried verbatim for write-back: a matching
   * <digest> is the desktop matcher's silent-success tier, rescuing even a
   * wrong manufacturer/type (ThrustCurveMotorSetDatabase.findMotors).
   */
  digest?: string;
  /** Desktop <type> (single|reload|hybrid), verbatim from the file. */
  motorType?: string;
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
  /**
   * Launch conditions from the file's FIRST <simulation>'s <conditions> —
   * only the fields the file actually carried (temperature/pressure are set
   * to null when the file declares the ISA standard atmosphere).
   */
  launch?: Partial<LaunchConditions>;
  /**
   * What the builder weighed and balanced (SI; airframe only, motor out), for
   * the Design tab's "Measured mass & CG" box. Absent when the file carries
   * neither number. See the export side for why this lives in the file.
   */
  measured?: { massKg: number | null; cgM: number | null };
}

/** One rocket-level <motorconfiguration> declaration. */
export interface OrkFlightConfig {
  id: string;
  /** Desktop writes <name> only when the user renamed the configuration. */
  name: string | null;
  isDefault: boolean;
  /**
   * THIS configuration's per-mount motors (Stage B presets), keyed by the
   * mount's editor node id from the same parse, resolved with the same
   * default/override semantics as the chosen config. A mount with no motor
   * for this configuration simply has no entry.
   */
  motors: Record<string, OrkMotorRef>;
  /**
   * THIS configuration's <deploymentconfiguration> overrides, keyed by the
   * recovery device's editor node id. Carried so a save can write every
   * configuration's recovery settings back — without it, the configuration the
   * user opened became the file's new default for ALL of them, which could
   * leave another configuration's chute set to deploy at the wrong time.
   */
  deployments: Record<string, OrkDeployOverride>;
  /**
   * THIS configuration's <separationconfiguration> per booster stage / pod set,
   * keyed by the stage's editor node id. Separation is per-configuration just
   * like motors and deployment: a real posted design sets "never" on all seven
   * of its named configurations while the bare tags under <stage> still carry
   * desktop's default "ejection", and its DEFAULT configuration declares no
   * block at all. Capturing only the opened configuration meant switching to
   * another one kept the old separation, so an M motor with a 0 s delay tore
   * the stages apart at burnout and lost two thirds of the altitude.
   */
  separations: Record<string, OrkSeparationOverride>;
}

/** One configuration's separation settings for one stage. */
export interface OrkSeparationOverride {
  separationEvent?: string;
  separationDelay?: number;
  separationAltitude?: number;
}

/**
 * A human label for a flight configuration. Desktop writes `<name>` only when
 * the user renamed one, so most configurations have none — and the picker was
 * rendering the raw GUID, which is what a first-time user saw as their very
 * first screen after choosing a file. (CT-Concep98-External-Fincan.ork, posted
 * to the beta thread, carries TEN.) Desktop substitutes the motor set for a
 * nameless configuration; so do we.
 */
export function configLabel(c: { name: string | null; motors: Record<string, { designation: string }> }): string {
  if (c.name) return c.name;
  const designations = Object.values(c.motors).map((m) => m.designation).filter(Boolean);
  return designations.length ? `[${designations.join(', ')}]` : 'No motors';
}

/** One <deploymentconfiguration> block's fields (all optional, as in the file). */
export interface OrkDeployOverride {
  deployEvent?: string;
  deployAltitude?: number;
  deployDelay?: number;
}

/**
 * importOrk's result: OrkTreeImportResult (the shape importRkt/importCdx1
 * also produce) plus the .ork flight-configuration table, so a caller can
 * offer a picker and re-import with `{ configId }`.
 */
export interface OrkImportResult extends OrkTreeImportResult {
  /** Declared flight configurations in file order (empty when none). */
  configs: OrkFlightConfig[];
  /**
   * The configuration whose motors/ignition/deployment/separation were
   * applied — opts.configId when it names a declared config, else the
   * default="true" one, else the first declared; null when the file
   * declares none (legacy first-element reads).
   */
  chosenConfigId: string | null;
}

// ============================ IMPORT ============================

export function importOrk(data: ArrayBuffer | string, opts?: { configId?: string }): OrkImportResult {
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

  // File-format version as major*100+minor (NEVER Number("1.10") — that is
  // 1.1, which would order 1.10 BELOW 1.4). The desktop only honours motor
  // <digest>s from format 1.4 on: the digest algorithm changed at 1.4, so a
  // 1.2/1.3 file carries old-algorithm digests the desktop itself ignores.
  // Re-emitting one inside our version="1.10" wrapper would make the desktop
  // trust it and raise a spurious "differing thrust curve" warning.
  const versionMatch = /^(\d+)\.(\d+)/.exec(
    doc.documentElement.getAttribute('version') ?? '');
  const fileVersion = versionMatch
    ? Number(versionMatch[1]) * 100 + Number(versionMatch[2])
    : 0;
  const digestsTrusted = fileVersion >= 104;

  const ignored = new Set<string>();
  const notes: string[] = [];
  let motor: OrkMotorRef | undefined;
  const motors: Record<string, OrkMotorRef> = {};

  const name = text(rocketEl, ':scope > name') ?? 'Imported rocket';

  // The builder's weighed mass and balance point (our extension; see export).
  // A nonsense value is dropped rather than imported: this drives a "your
  // build is 60 g heavy" readout, and a negative or unparseable number would
  // make that readout lie.
  const measuredNum = (tag: string): number | null => {
    const raw = text(rocketEl, `:scope > ${tag}`);
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const measuredMassKg = measuredNum('measuredmass');
  const measuredCgM = measuredNum('measuredcg');
  const measured = measuredMassKg !== null || measuredCgM !== null
    ? { massKg: measuredMassKg, cgM: measuredCgM }
    : undefined;

  const stages = Array.from(rocketEl.querySelectorAll(':scope > subcomponents > stage'));
  if (stages.length === 0) throw new Error('No stage found');

  // ---- automatic dimensions (see makeAutoRadii) -------------------------
  const autoRadii = makeAutoRadii(rocketEl);
  const autoInferred: { name: string; radius: number }[] = [];
  // Carries the radius each name ACTUALLY got, not just the name: the fallback
  // is 25 mm for a centreline component and 5 mm for a mass object (see
  // autoDim below), and the note has to state the number this reader used.
  const autoUnresolved: { el: Element; name: string; radius: number }[] = [];
  /**
   * A dimension the desktop may write as a number, as `auto <lastvalue>`, or
   * as a BARE `auto`. The first two parse to the number the desktop itself had
   * resolved; the third has to be resolved here, from the neighbouring
   * component, because `ComponentFactory` has no automatic path for it.
   *
   * A resolved value is always a NUMBER on the node, never an omission: the 2D
   * schematic, the 3D mesh and the aft view all fall back to hard 12 mm/9 mm
   * defaults for a missing radius, so a 4-inch airframe would draw as a stub
   * (docs/testing/findings-2026-08-22-import-fidelity.md item 6).
   */
  const autoDim = (el: Element, tag: string, fallback: number,
      resolve: (el: Element) => number,
      // What an UNRESOLVABLE automatic radius becomes. Centreline components
      // take the desktop's own 25 mm SymmetricComponent.DEFAULT_RADIUS; a mass
      // object keeps this reader's existing fallback, so nothing moves for a
      // file we cannot do better on.
      autoFallback = DEFAULT_AUTO_RADIUS): number => {
    const raw = text(el, `:scope > ${tag}`);
    if (raw === null) return fallback;
    const last = Number(raw.trim().split(/\s+/).pop());
    if (Number.isFinite(last)) return last; // plain number, or `auto <lastvalue>`
    if (!/^auto\b/i.test(raw.trim())) return fallback; // unparseable — unchanged
    const label = text(el, ':scope > name') ?? el.tagName;
    const r = resolve(el);
    if (r > 0) {
      autoInferred.push({ name: label, radius: r });
      return r;
    }
    autoUnresolved.push({ el, name: label, radius: autoFallback });
    return autoFallback;
  };

  // Flight-configuration table: rocket-level <motorconfiguration> blocks
  // (optional <name>, optional default="true" — desktop 24.12
  // MotorConfigurationHandler).
  const configEls = Array.from(rocketEl.querySelectorAll(':scope > motorconfiguration'));
  const configs: OrkFlightConfig[] = configEls
    .map((c) => ({
      id: c.getAttribute('configid') ?? '',
      name: text(c, ':scope > name'),
      isDefault: c.getAttribute('default') === 'true',
      motors: {},
      deployments: {},
      separations: {},
    }))
    .filter((c) => c.id !== '');
  const requested = opts?.configId;
  const chosenConfigId =
    (requested != null && configs.some((c) => c.id === requested) ? requested : null)
    ?? configs.find((c) => c.isDefault)?.id
    ?? configs[0]?.id
    ?? null;

  // The chosen configuration's child of `el` by tag name (per-config motor
  // or override block). With no declared configs, the first such child —
  // hand-rolled files may key <motor configid>s without declarations, and
  // first-in-document-order is the long-standing read for them.
  const configScoped = (el: Element, tag: string): Element | null =>
    chosenConfigId === null
      ? el.querySelector(`:scope > ${tag}`)
      : Array.from(el.children).find(
          (c) => c.tagName === tag && c.getAttribute('configid') === chosenConfigId) ?? null;

  /**
   * Record EVERY configuration's <deploymentconfiguration> for this recovery
   * device, not just the chosen one. Export replays them so opening config A
   * and saving cannot rewrite config B's recovery settings (see
   * OrkFlightConfig.deployments).
   */
  const captureDeployments = (el: Element, node: ComponentNode): void => {
    for (const c of configs) {
      const block = Array.from(el.children).find(
        (x) => x.tagName === 'deploymentconfiguration' && x.getAttribute('configid') === c.id);
      // Fall back to the BARE tags for a configuration that declares no block
      // of its own. Recording the resolved value (not "nothing") is what makes
      // the round-trip safe: on save the bare defaults are rewritten from the
      // configuration the user opened, so a config that silently inherited the
      // old defaults would otherwise inherit the NEW ones instead.
      const src = block ?? el;
      const o: OrkDeployOverride = {};
      const event = text(src, ':scope > deployevent');
      if (event) o.deployEvent = event;
      if (text(src, ':scope > deployaltitude') !== null) o.deployAltitude = num(src, 'deployaltitude', 200);
      if (text(src, ':scope > deploydelay') !== null) o.deployDelay = num(src, 'deploydelay', 0);
      if (Object.keys(o).length > 0 && node.id) c.deployments[node.id] = o;
    }
  };

  /**
   * Record EVERY configuration's <separationconfiguration> for this stage, the
   * way captureDeployments does for recovery devices — resolved against the
   * bare tags, so a configuration that declares no block of its own carries the
   * value it actually flies with rather than "nothing".
   */
  const captureSeparations = (el: Element, node: ComponentNode): void => {
    for (const c of configs) {
      const block = Array.from(el.children).find(
        (x) => x.tagName === 'separationconfiguration' && x.getAttribute('configid') === c.id);
      const src = block ?? el;
      const o: OrkSeparationOverride = {};
      const event = text(src, ':scope > separationevent');
      if (event) o.separationEvent = event;
      if (text(src, ':scope > separationdelay') !== null) {
        o.separationDelay = num(src, 'separationdelay', 0);
      }
      if (text(src, ':scope > separationaltitude') !== null) {
        o.separationAltitude = num(src, 'separationaltitude', 200);
      }
      if (Object.keys(o).length > 0 && node.id) c.separations[node.id] = o;
    }
  };

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
    // ONE configuration's motor+ignition off this mount. Plugged motors (no
    // ejection charge): the desktop writes the literal string "none"
    // (Motor.PLUGGED_DELAY). Represent as Infinity — the kernel treats a
    // +Inf ejection delay as "never fires", matching the desktop.
    const resolveRef = (motorEl: Element, igEl: Element): OrkMotorRef => {
      const delayText = text(motorEl, ':scope > delay');
      // Pre-1.4 digests use the old algorithm — never carry them (see
      // digestsTrusted above). <type>/<manufacturer> are version-independent.
      const digest = digestsTrusted ? text(motorEl, ':scope > digest') : null;
      const motorType = text(motorEl, ':scope > type');
      return {
        designation: text(motorEl, ':scope > designation') ?? 'unknown',
        manufacturer: text(motorEl, ':scope > manufacturer') ?? 'unknown',
        diameter: num(motorEl, 'diameter', 0.018),
        length: num(motorEl, 'length', 0.07),
        delay: delayText === 'none' ? Infinity : num(motorEl, 'delay', 0),
        ...(digest ? { digest } : {}),
        ...(motorType ? { motorType } : {}),
        mountId: node.id,
        ignitionEvent: text(igEl, ':scope > ignitionevent') ?? undefined,
        ignitionDelay: num(igEl, 'ignitiondelay', 0),
      };
    };
    // Stage B: EVERY declared configuration's motor rides along as a preset
    // (its own ignition override winning over the bare defaults, same as the
    // chosen read below). Quiet — only the chosen config's notes surface.
    if (node.id) {
      for (const cfg of configs) {
        const byId = (tag: string) => Array.from(mountEl.children).find(
          (c) => c.tagName === tag && c.getAttribute('configid') === cfg.id);
        const cfgMotorEl = byId('motor');
        if (!cfgMotorEl) continue; // no motor for this config here — empty
        cfg.motors[node.id] = resolveRef(cfgMotorEl, byId('ignitionconfiguration') ?? mountEl);
      }
    }
    // A mount with no motor for the chosen configuration imports empty.
    const motorEl = configScoped(mountEl, 'motor');
    if (!motorEl) return;
    // Ignition: the chosen config's block wins over the bare default
    // (desktop writes defaults bare, overrides in <ignitionconfiguration>).
    const ref = resolveRef(motorEl, configScoped(mountEl, 'ignitionconfiguration') ?? mountEl);
    if (!Number.isFinite(ref.delay)) {
      notes.push(
        `Motor ${ref.designation}: plugged (no ejection charge) — make sure recovery deploys on apogee/altitude, not the ejection charge.`);
    }
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
      readOverrides(el, node);
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
        // A nose cone's <aftradius> is its BASE radius, and OpenRocket 15.03
        // could write it as a bare `auto` (Wildman Mach 2 this one.ork).
        n['aftRadius'] = autoDim(el, 'aftradius', 0.012, autoRadii.aft);
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
        // An ABSENT radius stays absent: ComponentFactory turns that into
        // setFore/AftRadiusAutomatic(true) and the kernel resolves it against
        // the built tree, which is right. A PRESENT bare `auto` is resolved
        // here instead — the kernel would agree, but the schematic, the 3D
        // mesh and the property panel all need a number to show.
        if (text(el, ':scope > foreradius') !== null) {
          n['foreRadius'] = autoDim(el, 'foreradius', 0.012, autoRadii.fore);
        }
        if (text(el, ':scope > aftradius') !== null) {
          n['aftRadius'] = autoDim(el, 'aftradius', 0.009, autoRadii.aft);
        }
        if (text(el, ':scope > thickness') === 'filled') {
          n['filled'] = true;
        } else {
          n['thickness'] = num(el, 'thickness', 0.002);
        }
        n['shape'] = text(el, ':scope > shape') ?? 'conical';
        n['shapeParameter'] = num(el, 'shapeparameter', shapeParamDefault(String(n['shape'])));
        // <shapeclipped>: clipped vs full profile (ellipsoid/power/haack).
        // Forwarded to the kernel bridge as 'clipped'; absent keeps the
        // kernel default (clipped, matching the desktop).
        const clip = text(el, ':scope > shapeclipped');
        if (clip === 'true' || clip === 'false') n['clipped'] = clip === 'true';
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
        // THE auto-radius bug: OpenRocket 15.03 writes a bare `auto` here and
        // num()'s trailing-token parse made that the 12 mm fallback, so a
        // 6-inch airframe imported as a pencil and carried ~3x the drag.
        n['outerRadius'] = autoDim(el, 'radius', 0.012, autoRadii.bodyTube);
        n['thickness'] = num(el, 'thickness', 0.0005);
        readMotor(el, n);
        // Extension tag: sub-minimum flag (motor case is the airframe).
        if (text(el, ':scope > caseairframe') === 'true') n['caseAirframe'] = true;
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
        readAirfoil(el, n);
        readFinTabs(el, n);
        readFinRotation(el, n);
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
        readAirfoil(el, n);
        readFinTabs(el, n);
        readFinRotation(el, n);
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
        readAirfoil(el, n);
        readFinTabs(el, n);
        readFinRotation(el, n);
        return n;
      }
      case 'tubefinset': {
        const n = base('tubefinset', true);
        n['finCount'] = Math.round(num(el, 'fincount', 6));
        n['length'] = num(el, 'length', 0.1);
        const r = num(el, 'radius', NaN);
        if (!Number.isNaN(r)) n['outerRadius'] = r;
        const th = num(el, 'thickness', NaN);
        if (!Number.isNaN(th)) n['thickness'] = th;
        readFinRotation(el, n);
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
        // Our extension tag: the mount's physical motor-length limit.
        const mml = num(el, 'maxmotorlength', 0);
        if (mml > 0) n['maxMotorLength'] = mml;
        readMotor(el, n);
        return n;
      }
      case 'tubecoupler': {
        const n = base('tubecoupler', true);
        n['length'] = num(el, 'length', 0.05);
        n['thickness'] = num(el, 'thickness', 0.0005);
        readRingRadii(el, n);
        return n;
      }
      case 'centeringring': {
        const n = base('centeringring', true);
        n['length'] = num(el, 'length', 0.002);
        readRingRadii(el, n);
        readInstances(el, n);
        return n;
      }
      case 'bulkhead': {
        const n = base('bulkhead', true);
        n['length'] = num(el, 'length', 0.003);
        readRingRadii(el, n);
        readInstances(el, n);
        return n;
      }
      case 'engineblock': {
        const n = base('engineblock', true);
        n['length'] = num(el, 'length', 0.005);
        n['thickness'] = num(el, 'thickness', 0.001);
        readRingRadii(el, n);
        return n;
      }
      case 'launchlug': {
        const n = base('launchlug', true);
        n['length'] = num(el, 'length', 0.05);
        n['outerRadius'] = num(el, 'radius', 0.0022);
        n['thickness'] = num(el, 'thickness', 0.0003);
        readInstances(el, n);
        return n;
      }
      case 'railbutton': {
        const n = base('railbutton', true);
        n['outerDiameter'] = num(el, 'outerdiameter', 0.0097);
        readInstances(el, n);
        return n;
      }
      // Our extension component (2026-08-05b #18) — the desktop warns about
      // the unknown element and skips it.
      case 'fairing': {
        const n = base('fairing', true);
        n['length'] = num(el, 'length', 0.08);
        n['width'] = num(el, 'width', 0.025);
        n['height'] = num(el, 'height', 0.02);
        const fs = text(el, ':scope > fairingshape');
        if (fs) n['fairingShape'] = fs;
        n['mass'] = num(el, 'mass', 0.03);
        return n;
      }
      /**
       * Our extension component (RASAero protuberance, §7.5e) — same contract
       * as <fairing> above: our reader round-trips it, desktop OpenRocket
       * warns about the unknown element and skips it.
       *
       * Read DEFENSIVELY. Everything is optional and every number is checked
       * finite and in range before it lands, because these values feed a drag
       * coefficient: a NaN width or a negative count would poison the whole
       * design's CD, not just this component's.
       */
      case 'protuberance': {
        const n = base('protuberance' as ComponentType, true);
        const pos = (key: string, fb: number): number => {
          const v = num(el, key, fb);
          return Number.isFinite(v) && v >= 0 ? v : fb;
        };
        n['width'] = pos('width', 0.02);
        n['height'] = pos('height', 0.01);
        n['length'] = pos('length', 0.06);
        n['mass'] = pos('mass', 0);
        const count = Math.round(pos('count', 1));
        n['count'] = count >= 1 && count <= 1000 ? count : 1;
        const cls = text(el, ':scope > dragclass');
        n['dragClass'] = cls === 'streamlined' || cls === 'plate' ? cls : 'streamlinedbase';
        // Radians on this side of the file boundary; clamped to 0..90°.
        const ang = num(el, 'plateangle', NaN);
        n['plateAngle'] = Number.isFinite(ang)
          ? Math.min(Math.PI / 2, Math.max(0, ang))
          : Math.PI / 4;
        const cd = num(el, 'cdfrontal', NaN);
        if (Number.isFinite(cd) && cd >= 0) n['cdFrontal'] = cd;
        return n;
      }
      case 'parachute': {
        const n = base('parachute', true);
        n['diameter'] = num(el, 'diameter', 0.3);
        // <cd>auto</cd> stays automatic (the kernel's own CD_AUTOMATIC path).
        // Anything unparseable is dropped rather than stored as NaN — a NaN Cd
        // reaches the descent solver and poisons the whole trajectory.
        readAutoCd(el, n);
        n['lineCount'] = Math.round(num(el, 'linecount', 6));
        n['lineLength'] = num(el, 'linelength', 0.3);
        readSoftMaterial(el, n, 'surface', 'surfaceDensity', 'surfaceMaterialName');
        readSoftMaterial(el, n, 'line', 'lineDensity', 'lineMaterialName', ':scope > linematerial');
        // <deploymentconfiguration> only overrides when a config was chosen —
        // with no declarations the bare tags stay the whole story (a stray
        // block in an undeclared file was never read, keep it that way).
        readDeployment(el, n, chosenConfigId === null ? null : configScoped(el, 'deploymentconfiguration'));
        captureDeployments(el, n);
        // Our extension tag (desktop warns-and-ignores) — spill hole diameter.
        const spill = num(el, 'spillholediameter', 0);
        if (spill > 0) n['spillHoleDiameter'] = spill;
        return n;
      }
      case 'streamer': {
        const n = base('streamer', true);
        n['stripLength'] = num(el, 'striplength', 0.5);
        n['stripWidth'] = num(el, 'stripwidth', 0.05);
        readAutoCd(el, n);
        readSoftMaterial(el, n, 'surface', 'surfaceDensity', 'surfaceMaterialName');
        readDeployment(el, n, chosenConfigId === null ? null : configScoped(el, 'deploymentconfiguration'));
        captureDeployments(el, n);
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
        // MassObject:packedradius is automatic-capable too (the cavity it sits
        // in — MassObject.getMaxParentRadius). No aero effect, but it sets the
        // packed cylinder's rotational inertia and how the mass draws.
        n['radius'] = autoDim(el, 'packedradius', 0.005, autoRadii.packed, 0.005);
        // Preserve-through: what KIND of mass this is (altimeter, payload…).
        // No mass/CG effect, but the desktop shows it and users set it there.
        const mct = text(el, ':scope > masscomponenttype');
        if (mct && mct !== 'masscomponent') n['massComponentType'] = mct;
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
          // Same separation read as a booster <stage> — the chosen config's
          // block wins over the bare defaults.
          const sepEl = configScoped(el, 'separationconfiguration') ?? el;
          const ev = text(sepEl, ':scope > separationevent');
          if (ev && ev !== 'ejection') n['separationEvent'] = ev;
          const delay = num(sepEl, 'separationdelay', 0);
          if (delay !== 0) n['separationDelay'] = delay;
          const alt = num(sepEl, 'separationaltitude', NaN);
          if (!Number.isNaN(alt) && alt !== 200) n['separationAltitude'] = alt;
          captureSeparations(el, n);
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
    // A stage carries mass/CG/Cd overrides like any other component. NOT via
    // base(), which would clobber the Sustainer/Booster name fallback above and
    // pull <material>/<finish> onto a stage that has neither.
    readOverrides(stageEl, stage);
    // RASAero power-on base-drag input (metres) — every stage, incl. sustainer.
    const nozzle = num(stageEl, 'nozzleexitdiameter', NaN);
    if (!Number.isNaN(nozzle) && nozzle > 0) stage['nozzleExitDiameter'] = nozzle;
    if (i > 0) {
      // Like ignition: the chosen config's block overrides the bare defaults
      // (24.12 writes a <separationconfiguration> for EVERY config id).
      const sepEl = configScoped(stageEl, 'separationconfiguration') ?? stageEl;
      const ev = text(sepEl, ':scope > separationevent');
      if (ev && ev !== 'ejection') stage['separationEvent'] = ev;
      const delay = num(sepEl, 'separationdelay', 0);
      if (delay !== 0) stage['separationDelay'] = delay;
      const alt = num(sepEl, 'separationaltitude', NaN);
      if (!Number.isNaN(alt) && alt !== 200) stage['separationAltitude'] = alt;
      captureSeparations(stageEl, stage);
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

  // Say when a dimension was INFERRED. The user opened an archived file and got
  // a number nobody typed; without this note the only clue that anything was
  // reconstructed is that the rocket happens to look right.
  const nameList = (names: string[]): string => {
    const uniq = [...new Set(names)];
    return uniq.length > 4
      ? `${uniq.slice(0, 4).join(', ')} and ${uniq.length - 4} more`
      : uniq.join(', ');
  };
  if (autoInferred.length > 0) {
    const k = autoInferred.length;
    const dias = [...new Set(autoInferred.map((a) => (a.radius * 2000).toFixed(1)))]
      .map((mm) => `${mm} mm`).join(' / ');
    notes.push(
      `${k} component${k === 1 ? '' : 's'} (${nameList(autoInferred.map((a) => a.name))}) `
      + 'had an automatic diameter with no value stored — how OpenRocket 15.03 and earlier '
      + `wrote one. ${k === 1 ? 'It was' : 'They were'} sized from the neighbouring component `
      + `the way OpenRocket does (${dias}); saving writes that number rather than “auto”. `
      + 'Worth a check against your build.');
  }
  if (autoUnresolved.length > 0) {
    // Group by the fallback each name ACTUALLY got. A centreline component
    // takes the desktop's own 25 mm SymmetricComponent.DEFAULT_RADIUS; a mass
    // object takes this reader's 5 mm (autoDim's autoFallback). Printing one
    // diameter for the whole list named a number the mass never got.
    const byFallback = new Map<number, string[]>();
    for (const a of autoUnresolved) {
      const names = byFallback.get(a.radius);
      if (names) names.push(a.name);
      else byFallback.set(a.radius, [a.name]);
    }
    // Only 25 mm is OpenRocket's own number. Crediting the 5 mm one to the
    // desktop too would just move the false claim to the other clause.
    const clauses = [...byFallback].map(([radius, names]) => {
      const mm = `${(radius * 2000).toFixed(0)} mm`;
      const verb = new Set(names).size === 1 ? 'uses' : 'use';
      return radius === DEFAULT_AUTO_RADIUS
        ? `${nameList(names)} ${verb} OpenRocket’s own ${mm} default`
        : `${nameList(names)} ${verb} a ${mm} default`;
    });
    // Count COMPONENTS, not entries: a transition with both radii automatic
    // and unresolvable pushes twice for the one component — while two tubes
    // that share OpenRocket's default "Body tube" name are still two, which
    // keying on the NAME collapsed into one (the common case: the desktop
    // default-names every tube "Body tube").
    const k = new Set(autoUnresolved.map((a) => a.el)).size;
    notes.push(
      `${k} component${k === 1 ? '' : 's'} had an automatic diameter and no neighbour to `
      + `take one from, so ${clauses.join('; ')}. `
      + `Set the diameter${k === 1 ? '' : 's'} before simulating.`);
  }

  // Honesty notes for the two things this reader now PRESERVES but the
  // simulation does not yet act on. Saying so beats a silent discrepancy —
  // both change mass, and mass changes the stability the user is designing to.
  const allNodes: ComponentNode[] = [];
  // Fin fillets used to be preserved but not bridged to the kernel, and this
  // reader said so in a note. As of the fillet bridge the epoxy is counted in
  // mass and CG like desktop's, so the note is gone rather than reworded — it
  // would now be false, and a false claim about mass costs more than silence.
  const collect = (ns: ComponentNode[]) => {
    for (const nd of ns) { allNodes.push(nd); collect(nd.children ?? []); }
  };
  collect(components);
  const instanced = allNodes.filter(
    (nd) => typeof nd['instanceCount'] === 'number' && (nd['instanceCount'] as number) > 1
      && nd.type !== 'parallelstage' && nd.type !== 'podset');
  if (instanced.length > 0) {
    notes.push(
      `${instanced.length} component${instanced.length === 1 ? '' : 's'} in this design `
        + `(${[...new Set(instanced.map((nd) => nd.name ?? nd.type))].join(', ')}) `
        + 'repeat as multiple instances. The file keeps every instance, but the '
        + 'drawing and the simulation currently show one.',
    );
  }

  // Multi-config notes: the chosen configuration's values were applied by
  // the config-scoped reads above — say which one, and how to get another.
  if (configs.length > 1) {
    const mountMotorEls = Array.from(rocketEl.querySelectorAll('motormount > motor'));
    if (mountMotorEls.length === 0) {
      // Declared configs but no <motor> in any mount: the pick changed no
      // motors — claiming one was opened would send the user hunting for a
      // motor that isn't loaded (the mounts are all empty).
      notes.push(
        `File declares ${configs.length} flight configurations but carried no motors to import.`);
    } else {
      const chosen = configs.find((c) => c.id === chosenConfigId)!;
      // Names the configuration that actually loaded and where to change it.
      // This replaced a modal that asked the user to choose before showing
      // them anything — see App.tsx onOpenOrk. Says "the file's default"
      // explicitly, because that is the fact a desktop OpenRocket user is
      // checking for.
      // (This whole block is already inside `configs.length > 1`, so there is
      // no single-configuration case to branch on here.)
      notes.push(
        `Opened “${configLabel(chosen)}”${chosen.isDefault ? ', the file’s default' : ''} `
        + `flight configuration (${configs.length} in the file). Switch between them `
        + `under Motors & Launch → Flight configurations.`);
    }
    // Stage activeness (<stage active="false">) is not applied (Stage C) —
    // warn when the chosen configuration would actually ground a stage.
    const chosenEl = configEls.find((c) => c.getAttribute('configid') === chosenConfigId);
    if (chosenEl && Array.from(chosenEl.querySelectorAll(':scope > stage'))
        .some((s) => s.getAttribute('active') === 'false')) {
      notes.push(
        'This configuration deactivates one or more stages — stage activeness isn’t applied here, so all stages fly in the simulation.');
    }
  } else if (configs.length === 0) {
    // Hand-rolled files may key <motor configid>s without declaring the
    // configs. Those kept the legacy first-motor read, so keep the legacy
    // honesty note: the rest were silently dropped.
    const strayIds = new Set<string>();
    for (const m of Array.from(rocketEl.getElementsByTagName('motor'))) {
      const id = m.getAttribute('configid');
      if (id) strayIds.add(id);
    }
    if (strayIds.size > 1) {
      const keptId = Array.from(rocketEl.querySelectorAll('motormount > motor'))
        .map((m) => m.getAttribute('configid'))
        .find((id) => id !== null);
      notes.push(
        `File has ${strayIds.size} flight configurations — kept “${keptId ?? 'the first'}”; the other ${strayIds.size - 1} ${strayIds.size - 1 === 1 ? 'was' : 'were'} not imported.`);
    }
  }

  const launch = readLaunchConditions(doc, notes, chosenConfigId);

  return {
    name, tree: { name, components }, motor, motors, configs, chosenConfigId,
    ignored: [...ignored], notes, ...(launch ? { launch } : {}),
    ...(measured ? { measured } : {}),
  };
}

/**
 * Launch conditions from the FIRST <simulation>'s <conditions> (the desktop
 * saves one block per simulation; the app has a single launch panel). Units
 * per the desktop OpenRocketSaver: rod angle in DEGREES, wind speeds m/s,
 * altitude m, temperature KELVIN, pressure PASCAL. <wind model="average"> is
 * the modern form; the bare windaverage/windturbulence pair — turbulence
 * stored as the INTENSITY ratio stddev/average — is the ≤23.09 legacy form
 * the desktop still writes alongside it.
 */
function readLaunchConditions(
  doc: Document, notes: string[], chosenConfigId?: string | null,
): Partial<LaunchConditions> | undefined {
  // A .ork carries one <simulation> per flight configuration, and they are NOT
  // in configuration order. Taking the first one applied whichever site that
  // simulation was set up for — one real file's other five simulations declare
  // standard ISA at 3 m while its default declares a 24 °C Florida afternoon,
  // worth 1.15 % of apogee. Match the configuration actually being opened, and
  // keep the first as the fallback for files that name no configid.
  const simEls = Array.from(doc.querySelectorAll('openrocket > simulations > simulation'));
  const forChosen = chosenConfigId
    ? simEls.find((s) => text(s, ':scope > conditions > configid') === chosenConfigId)
    : undefined;
  const simEl = forChosen ?? simEls[0];
  const condEl = simEl?.querySelector(':scope > conditions');
  if (!condEl) return undefined;
  const launch: Partial<LaunchConditions> = {};

  const rodLen = num(condEl, 'launchrodlength', NaN);
  if (!Number.isNaN(rodLen)) launch.launchRodLengthM = rodLen;
  const rodAngle = num(condEl, 'launchrodangle', NaN);
  if (!Number.isNaN(rodAngle)) launch.launchRodAngleDeg = rodAngle;

  const windEls = Array.from(condEl.querySelectorAll(':scope > wind'));
  // Honesty: a MultiLevel wind profile (24.x altitude-layered winds) is not
  // modeled here — the average-wind settings below are what actually gets
  // imported, and the flyer must hear that their simulated winds changed.
  const windModelType = text(condEl, ':scope > windmodeltype');
  // <windmodeltype> names the model the simulation ACTUALLY used. OpenRocket
  // 24.12 writes a <wind model="multilevel"> block whenever any level exists,
  // active or not, so scanning the blocks cried wolf on ordinary files: both
  // designs posted to the beta thread declare "Average" and still tripped it,
  // telling a first-time user his simulation inputs had silently changed when
  // nothing had. Only fall back to scanning when the file states no type.
  const multilevel = windModelType
    ? windModelType.toLowerCase() === 'multilevel'
    : windEls.some((w) => (w.getAttribute('model') ?? '').toLowerCase() === 'multilevel');
  if (multilevel) {
    notes.push(
      'The file’s simulation used a multilevel wind profile (winds varying with altitude), which this app doesn’t model — its average-wind settings were imported instead.');
  }
  const windEl = windEls.find((w) => w.getAttribute('model') === 'average');
  let avg = windEl ? num(windEl, 'speed', NaN) : NaN;
  if (Number.isNaN(avg)) avg = num(condEl, 'windaverage', NaN);
  if (!Number.isNaN(avg)) launch.windAverage = avg;
  let sd = windEl ? num(windEl, 'standarddeviation', NaN) : NaN;
  if (Number.isNaN(sd)) {
    const turb = num(condEl, 'windturbulence', NaN);
    if (!Number.isNaN(turb) && !Number.isNaN(avg)) sd = turb * avg;
  }
  if (!Number.isNaN(sd)) launch.windStdDev = sd;

  const alt = num(condEl, 'launchaltitude', NaN);
  if (!Number.isNaN(alt)) launch.launchAltitudeM = alt;
  const lat = num(condEl, 'launchlatitude', NaN);
  if (!Number.isNaN(lat)) launch.latitudeDeg = lat;

  const atmEl = condEl.querySelector(':scope > atmosphere');
  if (atmEl) {
    if (atmEl.getAttribute('model') === 'isa') {
      // ISA standard: null means "blank = standard" in LaunchConditions.
      launch.temperatureC = null;
      launch.pressureHPa = null;
    } else {
      const tK = num(atmEl, 'basetemperature', NaN);
      if (!Number.isNaN(tK)) launch.temperatureC = tK - 273.15;
      const pPa = num(atmEl, 'basepressure', NaN);
      if (!Number.isNaN(pPa)) launch.pressureHPa = pPa / 100;
    }
  }

  const step = num(condEl, 'timestep', NaN);
  if (Number.isFinite(step) && step > 0) launch.timeStepS = step;

  const gm = text(condEl, ':scope > geodeticmethod');
  if (gm && gm !== 'spherical') {
    notes.push(
      `Simulation used the “${gm}” geodetic model — this app simulates a spherical Earth.`);
  }

  return Object.keys(launch).length > 0 ? launch : undefined;
}

// ============================ EXPORT ============================

export interface OrkExportMotor {
  designation: string;
  manufacturer?: string;
  /** Desktop <type> (single|reload|hybrid); omitted from the file when unknown. */
  type?: string;
  /** Desktop motor digest, carried from import — its silent-match tier. */
  digest?: string;
  diameter: number;
  length: number;
  delay: number;
  /** Kernel ignition-event name (automatic|launch|ejectioncharge|burnout|never). */
  ignitionEvent?: string;
  ignitionDelay?: number;
}

/** One flight configuration to write (Stage B) — the stable id from import. */
export interface OrkExportConfig {
  id: string;
  /** Written as <name> only when non-null (desktop writes renamed configs only). */
  name: string | null;
  isDefault: boolean;
  /** This configuration's motors keyed by mount node id. */
  motors: Record<string, OrkExportMotor>;
  /**
   * This configuration's recovery-deployment overrides keyed by recovery-device
   * node id, as captured at import. The ACTIVE configuration's values come from
   * the live tree instead; these keep every OTHER configuration intact.
   */
  deployments?: Record<string, OrkDeployOverride>;
  /**
   * This configuration's stage separation, keyed by stage node id, as captured
   * at import. The ACTIVE configuration's values come from the live tree; these
   * keep every OTHER configuration intact, exactly as `deployments` does.
   */
  separations?: Record<string, OrkSeparationOverride>;
}

export interface OrkTreeExportInput {
  name: string;
  tree: RocketTree;
  /** Motors keyed by mount node id (Release C: one per mount). */
  motors?: Record<string, OrkExportMotor>;
  /** Legacy single-motor form (tests/back-compat). */
  motor?: OrkExportMotor;
  mountId?: string | null;
  /** Launch-site conditions — written as one <simulation> when present. */
  launch?: LaunchConditions;
  /**
   * Stage B multi-config save. Absent/empty keeps the classic single
   * minted-config output. When supplied, every configuration is written with
   * its stable id; the ACTIVE one's motors come from `motors` (the live
   * working set — in-app edits persist into it), the rest from their own map.
   */
  configs?: OrkExportConfig[];
  /** Which config the working set (`motors`) came from; null = none/custom. */
  activeConfigId?: string | null;
  /**
   * The user's weighed mass and balance point (SI, airframe only). Written
   * only when at least one is set, so a design that never used the feature
   * produces exactly the file it did before.
   */
  measured?: { massKg: number | null; cgM: number | null };
}

export function exportOrk({
  name, tree, motors, motor, mountId, launch, configs, activeConfigId, measured,
}: OrkTreeExportInput): string {
  const motorMap: Record<string, OrkExportMotor> = { ...(motors ?? {}) };
  if (motor && mountId && !motorMap[mountId]) motorMap[mountId] = motor;
  // The configurations to write. Classic path (no configs): ONE minted
  // config carrying the working set — exactly the pre-Stage-B output.
  const active = configs?.find((c) => c.id === activeConfigId) ?? null;
  const writeConfigs: Array<{
    id: string;
    name: string | null;
    motors: Record<string, OrkExportMotor>;
    /** null for the ACTIVE config: its deployment comes from the live tree. */
    deployments: Record<string, OrkDeployOverride> | null;
    /** null for the ACTIVE config: its separation comes from the live tree. */
    separations: Record<string, OrkSeparationOverride> | null;
  }> =
    configs && configs.length > 0
      ? configs.map((c) => ({
        id: c.id,
        name: c.name,
        motors: c === active ? motorMap : c.motors,
        deployments: c === active ? null : (c.deployments ?? {}),
        separations: c === active ? null : (c.separations ?? {}),
      }))
      : [{ id: uuid(), name: null, motors: motorMap, deployments: null, separations: null }];
  // Active = none but motors loaded: mint an extra config carrying the live
  // set, unnamed (the desktop renders unnamed configs as their motor list).
  const minted = configs && configs.length > 0 && !active && Object.keys(motorMap).length > 0
    ? { id: uuid(), name: null, motors: motorMap, deployments: null, separations: null }
    : null;
  if (minted) writeConfigs.push(minted);
  // default="true" (also what <simulation> references): the active config,
  // else the minted custom one, else the original default.
  const defaultId = active?.id ?? minted?.id
    ?? (configs && configs.length > 0
      ? (configs.find((c) => c.isDefault)?.id ?? configs[0]!.id)
      : writeConfigs[0]!.id);
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

  // A ring/coupler radius: the author's number when they set one, `auto`
  // otherwise — writing `auto` unconditionally overwrote their dimensions in
  // their own file the first time they hit Save.
  const ringRadii = (depth: number, node: ComponentNode, withInner: boolean) => {
    const or = node['outerRadius'];
    emit(depth, `<outerradius>${typeof or === 'number' && or > 0 ? or : 'auto'}</outerradius>`);
    if (!withInner) return;
    const ir = node['innerRadius'];
    emit(depth, `<innerradius>${typeof ir === 'number' && ir >= 0 ? ir : 'auto'}</innerradius>`);
  };

  // Mass/CG/Cd overrides, exactly as the desktop RocketComponentSaver writes them.
  const overrides = (depth: number, node: ComponentNode) => {
    const sub = (key: string) => (node[key] === true ? 'true' : 'false');
    if (typeof node['overrideMass'] === 'number') {
      emit(depth, `<overridemass>${node['overrideMass']}</overridemass>`);
      emit(depth, `<overridesubcomponentsmass>${sub('overrideSubcomponentsMass')}</overridesubcomponentsmass>`);
    }
    if (typeof node['overrideCGX'] === 'number') {
      emit(depth, `<overridecg>${node['overrideCGX']}</overridecg>`);
      emit(depth, `<overridesubcomponentscg>${sub('overrideSubcomponentsCG')}</overridesubcomponentscg>`);
    }
    if (typeof node['overrideCD'] === 'number') {
      emit(depth, `<overridecd>${node['overrideCD']}</overridecd>`);
      emit(depth, `<overridesubcomponentscd>${sub('overrideSubcomponentsCD')}</overridesubcomponentscd>`);
    }
  };

  // RASAero feature #4: supersonic airfoil section — our extension tags,
  // written only when set (the desktop loader warns-and-continues on them).
  const airfoilXml = (depth: number, node: ComponentNode) => {
    const section = node['airfoilSection'];
    if (typeof section === 'string' && section) {
      emit(depth, `<airfoilsection>${escapeXml(section)}</airfoilsection>`);
    }
    for (const [key, tag] of [
      ['airfoilLeDiamond', 'airfoillediamond'],
      ['airfoilTeDiamond', 'airfoiltediamond'],
      ['finLeRadius', 'finleradius'],
    ] as const) {
      const v = node[key];
      if (typeof v === 'number' && v > 0) emit(depth, `<${tag}>${v}</${tag}>`);
    }
  };

  /**
   * Per-configuration recovery deployment. The ACTIVE configuration (and the
   * classic single-config path) takes its values from the live tree — those are
   * already written as the bare defaults just above, so its block simply
   * repeats them. Every OTHER configuration replays what it carried in from
   * import. Without this, saving after opening one configuration rewrote every
   * configuration's recovery settings to the opened one's — a chute set to pop
   * at apogee in config A could come back deploying at 300 m.
   */
  const deploymentConfigs = (depth: number, node: ComponentNode) => {
    if (writeConfigs.length < 2) return;
    for (const c of writeConfigs) {
      const o: OrkDeployOverride = c.deployments === null
        ? {
          deployEvent: String(node['deployEvent'] ?? 'ejection'),
          deployAltitude: typeof node['deployAltitude'] === 'number' ? node['deployAltitude'] as number : 200,
          deployDelay: typeof node['deployDelay'] === 'number' ? node['deployDelay'] as number : 0,
        }
        : (node.id ? c.deployments[node.id] ?? {} : {});
      if (Object.keys(o).length === 0) continue;
      emit(depth, `<deploymentconfiguration configid="${c.id}">`);
      if (o.deployEvent !== undefined) emit(depth + 1, `<deployevent>${escapeXml(o.deployEvent)}</deployevent>`);
      if (o.deployAltitude !== undefined) emit(depth + 1, `<deployaltitude>${o.deployAltitude}</deployaltitude>`);
      if (o.deployDelay !== undefined) emit(depth + 1, `<deploydelay>${o.deployDelay}</deploydelay>`);
      emit(depth, '</deploymentconfiguration>');
    }
  };

  /**
   * Separation for a booster stage / parallel stage: desktop's bare defaults
   * followed by one block per configuration. Each configuration writes ITS OWN
   * value — the writer used to repeat the live tree's into every block, so
   * saving while one configuration was open rewrote all the others. A design
   * that says "never separate" on six of its seven configurations came back
   * separating at the motor's ejection charge on all of them.
   */
  const separationBlocks = (depth: number, node: ComponentNode) => {
    const liveEv = typeof node['separationEvent'] === 'string' ? (node['separationEvent'] as string) : 'ejection';
    const liveDelay = typeof node['separationDelay'] === 'number' ? (node['separationDelay'] as number) : 0;
    const liveAlt = typeof node['separationAltitude'] === 'number' ? (node['separationAltitude'] as number) : 200;
    const sep = (d: number, ev: string, delay: number, alt: number) => {
      emit(d, `<separationevent>${escapeXml(ev)}</separationevent>`);
      emit(d, `<separationaltitude>${alt}</separationaltitude>`);
      emit(d, `<separationdelay>${delay}</separationdelay>`);
    };
    sep(depth, liveEv, liveDelay, liveAlt);
    for (const c of writeConfigs) {
      const o = c.separations === null || !node.id ? undefined : c.separations[node.id];
      emit(depth, `<separationconfiguration configid="${c.id}">`);
      sep(depth + 1, o?.separationEvent ?? liveEv, o?.separationDelay ?? liveDelay,
        o?.separationAltitude ?? liveAlt);
      emit(depth, '</separationconfiguration>');
    }
  };

  /**
   * Writes back whatever fillet the file came in with (see readFillet). The old
   * hard-coded 0.0 + Cardboard silently deleted a designer's epoxy fillets from
   * their own .ork on every save; these defaults are the same literals, used
   * only when the design genuinely has no fillet.
   */
  const filletXml = (depth: number, node: ComponentNode) => {
    emit(depth, `<filletradius>${n(node, 'filletRadius', 0)}</filletradius>`);
    const density = typeof node['filletDensity'] === 'number' ? node['filletDensity'] as number : 680;
    const group = typeof node['filletMaterialGroup'] === 'string'
      ? node['filletMaterialGroup'] as string : 'PaperProducts';
    const matName = typeof node['filletMaterialName'] === 'string'
      ? node['filletMaterialName'] as string : 'Cardboard';
    emit(depth, `<filletmaterial type="bulk" density="${density}" group="${escapeXml(group)}">`
      + `${escapeXml(matName)}</filletmaterial>`);
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

  /** The write-configs that hold a motor for this mount, in write order. */
  const mountConfigs = (nodeId: string | undefined) =>
    nodeId ? writeConfigs.filter((c) => c.motors[nodeId]) : [];

  // Configs may all be empty here: a mount with no motor loaded still writes
  // <motormount> so the mount flag survives the round trip (desktop same).
  const motorMountXml = (depth: number, nodeId: string | undefined, overhangM = 0) => {
    const withMotor = mountConfigs(nodeId);
    // Bare ignition defaults: the default-marked config's motor when it has
    // one here (the desktop writes its default config bare), else the first.
    const bare = (withMotor.find((c) => c.id === defaultId) ?? withMotor[0])?.motors[nodeId!];
    const ev = bare?.ignitionEvent ?? 'automatic';
    const evDelay = bare?.ignitionDelay ?? 0;
    emit(depth, '<motormount>');
    emit(depth + 1, `<ignitionevent>${escapeXml(ev)}</ignitionevent>`);
    emit(depth + 1, `<ignitiondelay>${evDelay}</ignitiondelay>`);
    emit(depth + 1, `<overhang>${overhangM}</overhang>`);
    for (const c of withMotor) {
      const m = c.motors[nodeId!]!;
      emit(depth + 1, `<motor configid="${c.id}">`);
      // Desktop element order (RocketComponentSaver): type, manufacturer,
      // digest, designation, diameter, length, delay. Unknown identity is
      // OMITTED, never guessed: the desktop matcher treats a missing field
      // as "match anything", while a wrong <type> or an unregistered
      // manufacturer (the old 'custom' fallback, and our own 'unknown'
      // sentinel) fails every description-tier match and loses the motor.
      if (m.type) emit(depth + 2, `<type>${escapeXml(m.type)}</type>`);
      if (m.manufacturer && m.manufacturer !== 'unknown' && m.manufacturer !== 'custom') {
        emit(depth + 2, `<manufacturer>${escapeXml(m.manufacturer)}</manufacturer>`);
      }
      if (m.digest) emit(depth + 2, `<digest>${escapeXml(m.digest)}</digest>`);
      emit(depth + 2, `<designation>${escapeXml(m.designation)}</designation>`);
      emit(depth + 2, `<diameter>${m.diameter}</diameter>`);
      emit(depth + 2, `<length>${m.length}</length>`);
      // Plugged (no ejection charge) → the desktop's literal "none".
      emit(depth + 2, `<delay>${Number.isFinite(m.delay) ? m.delay : 'none'}</delay>`);
      emit(depth + 1, '</motor>');
    }
    for (const c of withMotor) {
      const m = c.motors[nodeId!]!;
      emit(depth + 1, `<ignitionconfiguration configid="${c.id}">`);
      emit(depth + 2, `<ignitionevent>${escapeXml(m.ignitionEvent ?? 'automatic')}</ignitionevent>`);
      emit(depth + 2, `<ignitiondelay>${m.ignitionDelay ?? 0}</ignitiondelay>`);
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
    // Widened: the editor carries app-level types the engine union does not
    // (see tree/schema.ts EditorComponentType) and they still have to be saved.
    const t = node.type as ComponentType | 'protuberance';
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
        // Write what actually simulated so the desktop reproduces our
        // aerodynamics: an explicit imported/edited 'clipped' wins; otherwise
        // the kernel's default clipped state, which setShapeType() sets to
        // type.isClippable() (true for every shape that reaches this branch).
        // Desktop TransitionSaver only writes <shapeclipped> for CLIPPABLE
        // shapes — a conical transition carries no tag, and emitting one
        // anyway would grow a 'clipped' field on re-import that the golden
        // file never had (breaking bit-stable round trips).
        if (shapeIsClippable(String(node['shape'] ?? 'conical'))) {
          const clippedOut = typeof node['clipped'] === 'boolean'
            ? (node['clipped'] as boolean) : true;
          emit(depth + 1, `<shapeclipped>${clippedOut}</shapeclipped>`);
        }
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
        // Extension tag (desktop warns-and-ignores): sub-minimum flag.
        if (node['caseAirframe'] === true) {
          emit(depth + 1, '<caseairframe>true</caseairframe>');
        }
        // Min-diameter: the body tube itself is the motor mount.
        if (node['motorMount'] === true || mountConfigs(node.id).length > 0) {
          motorMountXml(depth + 1, node.id, n(node, 'motorOverhang', 0));
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
        emit(depth + 1, `<rotation>${(n(node, 'rotation', 0) * 180) / Math.PI}</rotation>`);
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${escapeXml(String(node['crossSection'] ?? 'square'))}</crosssection>`);
        airfoilXml(depth + 1, node);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        finTabsXml(depth + 1, node);
        filletXml(depth + 1, node);
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
        emit(depth + 1, `<rotation>${(n(node, 'rotation', 0) * 180) / Math.PI}</rotation>`);
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${escapeXml(String(node['crossSection'] ?? 'square'))}</crosssection>`);
        airfoilXml(depth + 1, node);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        finTabsXml(depth + 1, node);
        filletXml(depth + 1, node);
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
        emit(depth + 1, `<rotation>${(n(node, 'rotation', 0) * 180) / Math.PI}</rotation>`);
        position(depth + 1, node, 'bottom');
        finishXml(depth + 1, node);
        material(depth + 1, node);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.003)}</thickness>`);
        emit(depth + 1, `<crosssection>${escapeXml(String(node['crossSection'] ?? 'square'))}</crosssection>`);
        airfoilXml(depth + 1, node);
        emit(depth + 1, `<cant>${(n(node, 'cant', 0) * 180) / Math.PI}</cant>`);
        finTabsXml(depth + 1, node);
        filletXml(depth + 1, node);
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
        emit(depth + 1, `<rotation>${(n(node, 'rotation', 0) * 180) / Math.PI}</rotation>`);
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
        if (typeof node['maxMotorLength'] === 'number') {
          // Extension tag (desktop warns-and-ignores): the mount's physical
          // motor-length limit travels with the design.
          emit(depth + 1, `<maxmotorlength>${node['maxMotorLength']}</maxmotorlength>`);
        }
        if (node['motorMount'] === true || mountConfigs(node.id).length > 0) {
          motorMountXml(depth + 1, node.id, n(node, 'motorOverhang', 0));
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
        ringRadii(depth + 1, node, false);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.0005)}</thickness>`);
        close('tubecoupler');
        break;
      }
      case 'centeringring':
      case 'bulkhead': {
        open(t);
        header(depth + 1, node, t === 'bulkhead' ? 'Bulkhead' : 'Centering Ring');
        emit(depth + 1, `<instancecount>${n(node, 'instanceCount', 1)}</instancecount>`);
        emit(depth + 1, `<instanceseparation>${n(node, 'instanceSeparation', 0)}</instanceseparation>`);
        position(depth + 1, node, 'bottom');
        material(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.002)}</length>`);
        emit(depth + 1, '<radialposition>0.0</radialposition>');
        emit(depth + 1, '<radialdirection>0.0</radialdirection>');
        ringRadii(depth + 1, node, t === 'centeringring');
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
        ringRadii(depth + 1, node, false);
        emit(depth + 1, `<thickness>${n(node, 'thickness', 0.001)}</thickness>`);
        close('engineblock');
        break;
      }
      case 'fairing': {
        // Extension element: our own reader round-trips it; the desktop
        // warns-and-skips (same contract as the airfoil-section tags).
        open('fairing');
        header(depth + 1, node, 'Camera shroud');
        position(depth + 1, node, 'middle');
        finishXml(depth + 1, node);
        emit(depth + 1, `<length>${n(node, 'length', 0.08)}</length>`);
        emit(depth + 1, `<width>${n(node, 'width', 0.025)}</width>`);
        emit(depth + 1, `<height>${n(node, 'height', 0.02)}</height>`);
        emit(depth + 1, `<fairingshape>${escapeXml(String(node['fairingShape'] ?? 'halfround'))}</fairingshape>`);
        emit(depth + 1, `<mass>${n(node, 'mass', 0.03)}</mass>`);
        close('fairing');
        break;
      }
      case 'protuberance': {
        // Extension element, same contract as <fairing>: our reader
        // round-trips it, the desktop warns-and-skips. Angles are RADIANS here
        // (SI internally) — degrees exist only at the RASAero boundary.
        open('protuberance');
        header(depth + 1, node, 'Protuberance');
        position(depth + 1, node, 'middle');
        emit(depth + 1, `<dragclass>${escapeXml(String(node['dragClass'] ?? 'streamlinedbase'))}</dragclass>`);
        emit(depth + 1, `<width>${n(node, 'width', 0.02)}</width>`);
        emit(depth + 1, `<height>${n(node, 'height', 0.01)}</height>`);
        emit(depth + 1, `<length>${n(node, 'length', 0.06)}</length>`);
        emit(depth + 1, `<count>${Math.max(1, Math.round(n(node, 'count', 1)))}</count>`);
        emit(depth + 1, `<plateangle>${n(node, 'plateAngle', Math.PI / 4)}</plateangle>`);
        if (typeof node['cdFrontal'] === 'number' && Number.isFinite(node['cdFrontal'])) {
          emit(depth + 1, `<cdfrontal>${node['cdFrontal'] as number}</cdfrontal>`);
        }
        emit(depth + 1, `<mass>${n(node, 'mass', 0)}</mass>`);
        close('protuberance');
        break;
      }
      case 'launchlug': {
        open('launchlug');
        header(depth + 1, node, 'Launch Lug');
        emit(depth + 1, `<instancecount>${n(node, 'instanceCount', 1)}</instancecount>`);
        emit(depth + 1, `<instanceseparation>${n(node, 'instanceSeparation', 0)}</instanceseparation>`);
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
        emit(depth + 1, `<instancecount>${n(node, 'instanceCount', 1)}</instancecount>`);
        emit(depth + 1, `<instanceseparation>${n(node, 'instanceSeparation', 0)}</instanceseparation>`);
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
        deploymentConfigs(depth + 1, node);
        emit(depth + 1, `<diameter>${n(node, 'diameter', 0.3)}</diameter>`);
        if (typeof node['spillHoleDiameter'] === 'number' && (node['spillHoleDiameter'] as number) > 0) {
          // Extension tag (desktop warns-and-ignores, same as airfoilsection).
          emit(depth + 1, `<spillholediameter>${node['spillHoleDiameter']}</spillholediameter>`);
        }
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
        deploymentConfigs(depth + 1, node);
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
        // Legal values = MassComponent.MassComponentType lowercased:
        // masscomponent, altimeter, flightcomputer, deploymentcharge,
        // tracker, payload, recoveryhardware, battery.
        emit(depth + 1, `<masscomponenttype>${escapeXml(String(node['massComponentType'] ?? 'masscomponent'))}</masscomponenttype>`);
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
          separationBlocks(depth + 1, node);
        }
        close(t);
        break;
      }
    }
  };

  emit(0, "<?xml version='1.0' encoding='utf-8'?>");
  emit(0, '<openrocket version="1.10" creator="MMRocket Sim">');
  emit(1, '<rocket>');
  emit(2, `<name>${escapeXml(name)}</name>`);
  emit(2, `<id>${uuid()}</id>`);
  emit(2, '<axialoffset method="absolute">0.0</axialoffset>');
  emit(2, '<position type="absolute">0.0</position>');
  emit(2, '<designtype>original</designtype>');
  // The mass and balance point the builder actually MEASURED. The ballast this
  // produces ("Build allowance") is an ordinary mass component and always
  // saved; these two numbers did not, so re-opening a file left the box blank
  // and the discrepancy it reports — the diagnostic half of the feature —
  // unrecoverable (issues-2026-08-23b #3).
  //
  // Extension elements: our own reader round-trips them, the desktop
  // warns-and-skips, exactly like <fairing> and <nozzleexitdiameter>. Emitted
  // only when set, so a design that never used the box is byte-identical to
  // what this wrote before the feature existed.
  if (typeof measured?.massKg === 'number' && Number.isFinite(measured.massKg)) {
    emit(2, `<measuredmass>${measured.massKg}</measuredmass>`);
  }
  if (typeof measured?.cgM === 'number' && Number.isFinite(measured.cgM)) {
    emit(2, `<measuredcg>${measured.cgM}</measuredcg>`);
  }
  // Stage nodes at the top level export as sibling <stage> blocks (the
  // desktop model); legacy flat trees wrap into one implicit stage.
  const stageNodes = asStageNodes(tree);
  for (const c of writeConfigs) {
    emit(2, `<motorconfiguration configid="${c.id}"${c.id === defaultId ? ' default="true"' : ''}>`);
    if (c.name !== null) emit(3, `<name>${escapeXml(c.name)}</name>`);
    for (let i = 0; i < stageNodes.length; i++) {
      emit(3, `<stage number="${i}" active="true"/>`);
    }
    emit(2, '</motorconfiguration>');
  }
  emit(2, '<referencetype>maximum</referencetype>');
  emit(2, '<subcomponents>');
  for (let i = 0; i < stageNodes.length; i++) {
    const st = stageNodes[i]!;
    emit(3, '<stage>');
    emit(4, `<name>${escapeXml(st.name ?? (i === 0 ? 'Sustainer' : `Booster ${i}`))}</name>`);
    emit(4, `<id>${uuid()}</id>`);
    // The stage's own overrides, in the desktop's element order. Emits nothing
    // when none are set, so a plain design round-trips byte-identically — but
    // without this a whole-stage Cd or weighed mass typed in the app was
    // applied to the simulation and then thrown away on Save.
    overrides(4, st);
    // RASAero power-on base-drag input (metres, no conversion). Non-standard
    // element (OpenRocket desktop ignores it); only emitted when set > 0 so a
    // plain design round-trips exactly. Applies to every stage incl. sustainer.
    if (typeof st['nozzleExitDiameter'] === 'number' && (st['nozzleExitDiameter'] as number) > 0) {
      emit(4, `<nozzleexitdiameter>${st['nozzleExitDiameter']}</nozzleexitdiameter>`);
    }
    if (i > 0) {
      // Separation (lower stages only) — desktop writes the DEFAULT params
      // bare, then a per-config block (AxialStageSaver).
      separationBlocks(4, st);
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
  if (launch) {
    // One <simulation> PER configuration, each in the exact shape of the
    // desktop's OpenRocketSaver.saveSimulation() so 24.12 opens it cleanly.
    // The desktop restores EVERY <simulation> unconditionally
    // (SingleSimulationHandler), and writes one per configuration itself —
    // the old single minted block meant a file saved here with seven
    // configurations came back to the desktop with six sims gone. Its loader
    // tolerates missing elements but WARNS on any simulator/calculator other
    // than RK4Simulator/BarrowmanCalculator and on unknown status values —
    // write the only ones it accepts. We store no per-configuration launch
    // site, so every simulation carries the app's current conditions; with
    // no configs supplied this is the classic single-simulation output.
    //
    // ≤23.09 legacy trio the desktop still writes: turbulence here is the
    // INTENSITY ratio stddev/average (PinkNoiseWindModel maps zero wind to
    // 0 or 1 — mirror it so old desktops recover the same stddev).
    const turb = launch.windAverage !== 0 ? launch.windStdDev / launch.windAverage
      : launch.windStdDev !== 0 ? 1 : 0;
    writeConfigs.forEach((c, i) => {
      emit(2, '<simulation status="notsimulated">');
      // The desktop's sim table shows this name — a renamed configuration
      // reads as itself; unnamed ones get the desktop's own "Simulation N".
      emit(3, `<name>${escapeXml(c.name ?? `Simulation ${i + 1}`)}</name>`);
      emit(3, '<simulator>RK4Simulator</simulator>');
      emit(3, '<calculator>BarrowmanCalculator</calculator>');
      emit(3, '<conditions>');
      emit(4, `<configid>${c.id}</configid>`);
      emit(4, `<launchrodlength>${launch.launchRodLengthM}</launchrodlength>`);
      // Desktop defaults for options we don't model: launch into wind, and
      // rod/wind direction (rod direction is DEGREES on disk, 90 = π/2 rad).
      emit(4, '<launchintowind>true</launchintowind>');
      // Rod angle is DEGREES on disk (the saver multiplies by 180/π).
      emit(4, `<launchrodangle>${launch.launchRodAngleDeg}</launchrodangle>`);
      emit(4, '<launchroddirection>90.0</launchroddirection>');
      emit(4, `<windaverage>${launch.windAverage}</windaverage>`);
      emit(4, `<windturbulence>${turb}</windturbulence>`);
      // Wind direction is RADIANS on disk (unlike the rod elements — the
      // saver writes getDirection() raw); π/2 is the desktop default.
      emit(4, `<winddirection>${Math.PI / 2}</winddirection>`);
      emit(4, '<wind model="average">');
      emit(5, `<speed>${launch.windAverage}</speed>`);
      emit(5, `<direction>${Math.PI / 2}</direction>`);
      emit(5, `<standarddeviation>${launch.windStdDev}</standarddeviation>`);
      emit(4, '</wind>');
      emit(4, '<windmodeltype>Average</windmodeltype>');
      emit(4, `<launchaltitude>${launch.launchAltitudeM}</launchaltitude>`);
      emit(4, `<launchlatitude>${launch.latitudeDeg}</launchlatitude>`);
      // We don't model longitude — the desktop's preference default.
      emit(4, '<launchlongitude>-80.6</launchlongitude>');
      emit(4, '<geodeticmethod>spherical</geodeticmethod>');
      if (launch.temperatureC === null && launch.pressureHPa === null) {
        emit(4, '<atmosphere model="isa"/>');
      } else {
        // KELVIN / PASCAL on disk. The desktop stores both-or-ISA, so a
        // single custom value fills the other with the ISA sea-level standard.
        emit(4, '<atmosphere model="extendedisa">');
        emit(5, `<basetemperature>${(launch.temperatureC ?? 15) + 273.15}</basetemperature>`);
        emit(5, `<basepressure>${(launch.pressureHPa ?? 1013.25) * 100}</basepressure>`);
        emit(4, '</atmosphere>');
      }
      // RK4SimulationStepper recommended defaults (the desktop's own values).
      emit(4, '<timestep>0.05</timestep>');
      emit(4, '<maxtime>1200.0</maxtime>');
      emit(3, '</conditions>');
      emit(2, '</simulation>');
    });
  }
  emit(1, '</simulations>');
  emit(0, '</openrocket>');
  return lines.join('\n') + '\n';
}

// ============================ helpers ============================

/**
 * Mass / CG / Cd overrides and their "applies to all subcomponents" flags.
 *
 * Module-level rather than inline in `base()` because a **stage** carries these
 * too and is built by its own code path — desktop OpenRocket writes
 * {@code <overridemass>} straight under {@code <stage>} for the very common
 * "I weighed the whole rocket" case. Reading them only in `base()` meant a
 * stage-level override was dropped at import: LEM-M2B.ork (beta thread,
 * 2026-08-22) states a weighed 0.6747 kg with subcomponents-override on, and we
 * imported 0.7346 kg — 8.9 % heavy, CG 31 mm aft, for a reason nothing on
 * screen could explain.
 */
function readOverrides(el: Element, node: ComponentNode): void {
  const om = num(el, 'overridemass', NaN);
  if (!Number.isNaN(om)) node['overrideMass'] = om;
  const ocg = num(el, 'overridecg', NaN);
  if (!Number.isNaN(ocg)) node['overrideCGX'] = ocg;
  const ocd = num(el, 'overridecd', NaN);
  if (!Number.isNaN(ocd)) node['overrideCD'] = ocd;
  // "Override for all subcomponents": per-quantity flags (24.x format);
  // legacy files carry a single <overridesubcomponents> covering all.
  const legacyAll = text(el, ':scope > overridesubcomponents') === 'true';
  if (legacyAll || text(el, ':scope > overridesubcomponentsmass') === 'true') {
    node['overrideSubcomponentsMass'] = true;
  }
  if (legacyAll || text(el, ':scope > overridesubcomponentscg') === 'true') {
    node['overrideSubcomponentsCG'] = true;
  }
  if (legacyAll || text(el, ':scope > overridesubcomponentscd') === 'true') {
    node['overrideSubcomponentsCD'] = true;
  }
}

/**
 * A radius that OpenRocket may write as a number OR as the literal `auto`
 * (rings, couplers, bulkheads and engine blocks size themselves off the parent
 * or a sibling mount when automatic). `undefined` means "leave it automatic";
 * a number is the author's explicit dimension.
 *
 * `num()` cannot express this — a bare `auto` parses to NaN and silently
 * becomes the fallback, which is how every explicit ring radius in a .ork was
 * being thrown away on import.
 */
function autoNum(el: Element, tag: string): number | undefined {
  const t = text(el, `:scope > ${tag}`);
  if (!t || t.trim().toLowerCase() === 'auto') return undefined;
  const v = Number(t.split(/\s+/).pop());
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Every element OpenRocket 24.12 can write as an automatic dimension, from
 * `core/.../importt/DocumentConfig.java` (the `"auto"` DoubleSetters) and the
 * matching savers. Two shapes exist, and the difference is the whole bug:
 *
 * | element                                    | saver writes    | this reader |
 * |--------------------------------------------|-----------------|-------------|
 * | `BodyTube:radius`                          | `auto <value>`  | resolved    |
 * | `NoseCone:aftradius` (its BASE radius)     | `auto <value>`  | resolved    |
 * | `Transition:foreradius` / `aftradius`      | `auto <value>`  | resolved    |
 * | `MassObject:packedradius`                  | `auto <value>`  | resolved    |
 * | `TubeFinSet:radius`                        | bare `auto`     | kernel      |
 * | `CenteringRing:inner/outerradius`          | bare `auto`     | kernel      |
 * | `Bulkhead` / `TubeCoupler` / `EngineBlock` `:outerradius` | bare `auto` | kernel |
 * | `RecoveryDevice:cd`                        | bare `auto`     | kernel      |
 *
 * "kernel" means the value is left off the node and `ComponentFactory` turns
 * that into `set…Automatic(true)`, which is correct and stays that way.
 * "resolved" means the factory has no automatic path for it, so a bare `auto`
 * has to be turned into a number HERE or the component silently takes a hard
 * fallback — 12 mm for a body tube, which is the defect this exists to fix.
 *
 * **OpenRocket 15.03 wrote all eight as a BARE `auto`**; 23.09+ append the last
 * resolved value, which the trailing-token parse in `num()` happens to survive.
 * That is why only 15.03-era files were affected, and they are exactly the files
 * a long-standing builder has in their archive.
 */
/** Component tags that sit on the centreline (kernel `SymmetricComponent`). */
const SYMMETRIC_TAGS = new Set(['nosecone', 'bodytube', 'transition']);

/**
 * `SymmetricComponent.DEFAULT_RADIUS` — what the desktop shows for an automatic
 * radius with no neighbour to take one from. NOT the 12 mm this reader falls
 * back to for a missing tag; that fallback is ours and stays where it is.
 */
const DEFAULT_AUTO_RADIUS = 0.025;

/** An automatic radius that could not be resolved from any neighbour. */
const UNRESOLVED = -1;

interface AutoRadii {
  /** `BodyTube.getAutoOuterRadius()`. */
  bodyTube(el: Element): number;
  /** `Transition.getAutoAftRadius()` — and a nose cone's automatic BASE radius. */
  aft(el: Element): number;
  /** `Transition.getAutoForeRadius()`. */
  fore(el: Element): number;
  /** `MassObject.getMaxParentRadius()` — the cavity the mass sits in. */
  packed(el: Element): number;
}

/**
 * Resolves an automatic radius from the neighbouring component the way the
 * desktop does, working on the XML directly (the DOM already has every
 * neighbour; the editor tree does not exist yet at read time).
 *
 * Mirrors `BodyTube.getAutoOuterRadius` / `Transition.getAutoFore|AftRadius`
 * and the `getFront|RearAutoRadius` pair they call: a component asked for the
 * face it presents to its neighbour answers with a stated number, or chains on
 * to ITS neighbour when it is automatic too, or gives up (`UNRESOLVED`).
 *
 * A CHAIN of automatic tubes therefore chains all the way to its anchor —
 * 24.12 does NOT stop at the first automatic neighbour and fall through to
 * DEFAULT_RADIUS. Worth spelling out, because `BodyTube.java:95` reads as
 * though it should: `if (c != null && !c.usesNextCompAutomatic())`. That is a
 * circularity guard, not a "skip automatic neighbours" guard —
 * for a BODY TUBE neighbour, `usesNextCompAutomatic()` is
 * `isOuterRadiusAutomatic() && refComp == getNextSymmetricComponent()`
 * (`BodyTube.java:172-174`), so it fires only when that neighbour already
 * took ITS radius from us. (A transition or nose cone neighbour overrides it
 * as a plain `isAftRadiusAutomatic()` — `Transition.java:281-284` — so there
 * the guard IS a skip; it just changes nothing, because
 * `Transition.getFrontAutoRadius` returns -1 in exactly that case,
 * `Transition.java:263-267`.) The neighbour can only
 * have done that at `BodyTube.java:99-104`, reached only after its own forward
 * walk came back < 0 — so `front()` below returns `UNRESOLVED` for it anyway,
 * and the visited set lands on the same answer without a `refComp` field of
 * our own. The walk that actually chains is `BodyTube.getFrontAutoRadius`
 * (`BodyTube.java:216-227`), which recurses through automatic neighbours with
 * no guard at all until it reaches a stated radius.
 *
 * The desktop's own output settles it. `docs/User files/TRF RASAero Files/
 * 38mm Min.ork`, creator "OpenRocket 23.09", is a nose cone of aftradius
 * 0.02032 followed by THREE chained automatic tubes, and 23.09 saved
 * `<radius>auto 0.02032</radius>` on all three — not `auto 0.025` on the last
 * two. Replaying 24.12's algorithm, refComp field and all, across every .ork
 * in this repo (50 automatic dimensions) agrees with this resolver on all 50
 * and reproduces every value the desktop had stored.
 *
 * Two KINDS of desktop degeneracy are NOT reproduced:
 * `Transition.getRearAutoRadius` on an un-flipped nose cone hands back 0
 * instead of -1 (see `rear` below), and both `Transition.getForeRadius`
 * (`Transition.java:73-92`) and `getAftRadius` (`Transition.java:167-187`)
 * pass a -1 out of their auto-getter through unclamped. Either would put a zero or negative radius on a
 * component. This reader answers `UNRESOLVED` for both, which becomes
 * DEFAULT_AUTO_RADIUS and the "no neighbour" note instead.
 */
function makeAutoRadii(rocketEl: Element): AutoRadii {
  // Centreline chains. The rocket's axial stages share ONE chain — desktop's
  // getPreviousSymmetricComponent walks across stage boundaries — while a
  // parallel stage or pod set gets its own, with the body tube it hangs off
  // standing in for the component ahead of its first child.
  const pos = new Map<Element, { chain: Element[]; i: number; owner: Element | null }>();
  const symChildren = (asm: Element): Element[] => {
    const wrap = asm.querySelector(':scope > subcomponents');
    return wrap ? Array.from(wrap.children).filter((c) => SYMMETRIC_TAGS.has(c.tagName)) : [];
  };
  const register = (chain: Element[], owner: Element | null): void => {
    chain.forEach((el, i) => pos.set(el, { chain, i, owner }));
  };
  register(
    Array.from(rocketEl.querySelectorAll(':scope > subcomponents > stage'))
      .flatMap((s) => symChildren(s)),
    null);
  for (const asm of Array.from(rocketEl.querySelectorAll('parallelstage, podset, boosterset'))) {
    const grandparent = asm.parentElement?.parentElement ?? null;
    register(
      symChildren(asm),
      grandparent && SYMMETRIC_TAGS.has(grandparent.tagName) ? grandparent : null);
  }

  const prevOf = (el: Element): Element | null => {
    const p = pos.get(el);
    if (!p) return null;
    return p.i > 0 ? p.chain[p.i - 1]! : p.owner;
  };
  const nextOf = (el: Element): Element | null => {
    const p = pos.get(el);
    if (!p) return null;
    return p.i + 1 < p.chain.length ? p.chain[p.i + 1]! : null;
  };

  /**
   * The number the AUTHOR stated for a dimension, or null when they left it
   * automatic. `auto 0.0508` counts as stated: the desktop writes the value it
   * had just resolved, so trusting it reproduces the desktop exactly and keeps
   * every 23.09+ file importing bit-identically to before this existed.
   */
  const stated = (el: Element, tag: string): number | null => {
    const t = text(el, `:scope > ${tag}`);
    if (t === null) return null;
    const v = Number(t.trim().split(/\s+/).pop());
    return Number.isFinite(v) ? v : null;
  };

  /** `getFrontAutoRadius()` — the face this component shows to the one BEHIND it. */
  const front = (el: Element, seen: Set<Element>): number => {
    if (seen.has(el)) return UNRESOLVED; // cyclic auto chain — desktop's refComp guard
    seen.add(el);
    if (el.tagName === 'bodytube') {
      const r = stated(el, 'radius');
      if (r !== null) return r;
      const p = prevOf(el);
      return p ? front(p, seen) : UNRESOLVED;
    }
    return stated(el, 'aftradius') ?? UNRESOLVED;
  };

  /** `getRearAutoRadius()` — the face this component shows to the one AHEAD of it. */
  const rear = (el: Element, seen: Set<Element>): number => {
    if (seen.has(el)) return UNRESOLVED;
    seen.add(el);
    if (el.tagName === 'bodytube') {
      const r = stated(el, 'radius');
      if (r !== null) return r;
      const n = nextOf(el);
      return n ? rear(n, seen) : UNRESOLVED;
    }
    // A DELIBERATE DEVIATION from 24.12, not a mirror of it. An un-flipped
    // nose cone's fore radius is 0 and NOT automatic (`NoseCone
    // .resetForeRadius`, NoseCone.java:276-278), so `Transition
    // .getRearAutoRadius` (Transition.java:270-274) hands back that 0 rather
    // than -1 — and 0 is not < 0, so on the desktop a tube placed AHEAD of a
    // nose cone silently ends up with a ZERO radius. We answer UNRESOLVED,
    // which becomes the 25 mm DEFAULT_AUTO_RADIUS plus the "no neighbour"
    // note: a degenerate design the user is told about beats one they are not.
    // (`<isflipped>` is ignored on read and hard-coded `false` on save, so a
    // flipped cone's genuine fore face is a separate gap, not one this walk
    // attempts to close.)
    if (el.tagName === 'nosecone') return UNRESOLVED;
    return stated(el, 'foreradius') ?? UNRESOLVED;
  };

  const bodyTube = (el: Element): number => {
    const p = prevOf(el);
    const ahead = p ? front(p, new Set([el])) : UNRESOLVED;
    if (ahead > 0) return ahead;
    const n = nextOf(el);
    const behind = n ? rear(n, new Set([el])) : UNRESOLVED;
    return behind > 0 ? behind : UNRESOLVED;
  };
  const aft = (el: Element): number => {
    const n = nextOf(el);
    const r = n ? rear(n, new Set([el])) : UNRESOLVED;
    return r > 0 ? r : UNRESOLVED;
  };
  const fore = (el: Element): number => {
    const p = prevOf(el);
    const r = p ? front(p, new Set([el])) : UNRESOLVED;
    return r > 0 ? r : UNRESOLVED;
  };
  const resolved = (v: number | null, fb: () => number): number =>
    v !== null ? v : fb();
  const packed = (el: Element): number => {
    const owner = el.parentElement?.parentElement ?? null;
    if (!owner) return UNRESOLVED;
    const inner = (r: number): number =>
      r > 0 ? Math.max(r - (stated(owner, 'thickness') ?? 0), 0) : UNRESOLVED;
    switch (owner.tagName) {
      case 'nosecone':
        return resolved(stated(owner, 'aftradius'), () => aft(owner));
      case 'transition': {
        const f = resolved(stated(owner, 'foreradius'), () => fore(owner));
        const a = resolved(stated(owner, 'aftradius'), () => aft(owner));
        return Math.max(f, a) > 0 ? Math.max(f, a) : UNRESOLVED;
      }
      case 'bodytube':
        return inner(resolved(stated(owner, 'radius'), () => bodyTube(owner)));
      case 'innertube':
      case 'tubecoupler':
      case 'engineblock':
        return inner(stated(owner, 'outerradius') ?? UNRESOLVED);
      case 'centeringring':
      case 'bulkhead':
        return stated(owner, 'innerradius') ?? UNRESOLVED;
      default:
        return UNRESOLVED;
    }
  };
  return { bodyTube, aft, fore, packed };
}

/**
 * A recovery device's `<cd>`: a number, or the literal `auto` (desktop's
 * `RecoveryDevice.setCDAutomatic`, which the kernel factory honours by leaving
 * the field off). Anything else is dropped — `Number("auto 0.8")` is NaN, and a
 * NaN drag coefficient reaches the descent solver.
 */
function readAutoCd(el: Element, node: ComponentNode): void {
  const t = text(el, ':scope > cd');
  if (t === null || /^auto\b/i.test(t)) return;
  const v = Number(t);
  if (Number.isFinite(v) && v >= 0) node['cd'] = v;
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
/**
 * RASAero feature #4: supersonic airfoil section (our extension tags — the
 * desktop loader warns on unknown elements and continues, so files stay
 * openable there). Absent tags leave the classic cross-section behavior.
 */
/**
 * <instancecount>/<instanceseparation>, PASS-THROUGH only.
 *
 * CenteringRing and Bulkhead are LineInstanceable and LaunchLug/RailButton are
 * Instanceable, so OpenRocket writes these for all four. Neither was read, and
 * export hard-wrote 1 / 0.0 — so a motor mount declared as one CenteringRing
 * with instancecount 3 came back from a save as a single ring, permanently
 * losing two-thirds of that structural mass from the user's own file. The app
 * still simulates and draws ONE; the file keeps all N, and the import note
 * says so rather than letting the difference stay silent.
 */
/**
 * Explicit ring/coupler/bulkhead/engine-block radii. OpenRocket writes these
 * as numbers whenever the author sized the part by hand and `auto` otherwise;
 * we read neither, so every hand-set dimension was replaced by our automatic
 * value. On CT-Concep98-External-Fincan.ork (beta thread) that changed the dry
 * mass and moved the CG, and one centering ring whose file says
 * `<innerradius>auto</innerradius>` next to an explicit outer radius became a
 * solid disk. Saving then wrote `auto` back over the author's numbers.
 */
function readRingRadii(el: Element, node: ComponentNode): void {
  const or = autoNum(el, 'outerradius');
  if (or !== undefined && or > 0) node['outerRadius'] = or;
  const ir = autoNum(el, 'innerradius');
  if (ir !== undefined && ir >= 0) node['innerRadius'] = ir;
}

function readInstances(el: Element, node: ComponentNode): void {
  const count = Math.round(num(el, 'instancecount', 1));
  if (count > 1) node['instanceCount'] = count;
  const sep = num(el, 'instanceseparation', 0);
  if (sep !== 0) node['instanceSeparation'] = sep;
}

function readAirfoil(el: Element, node: ComponentNode): void {
  const section = text(el, ':scope > airfoilsection');
  if (section) node['airfoilSection'] = section;
  const led = num(el, 'airfoillediamond', 0);
  if (led > 0) node['airfoilLeDiamond'] = led;
  const ted = num(el, 'airfoiltediamond', 0);
  if (ted > 0) node['airfoilTeDiamond'] = ted;
  const ler = num(el, 'finleradius', 0);
  if (ler > 0) node['finLeRadius'] = ler;
  readFillet(el, node);
}

/**
 * Fin fillets, PASS-THROUGH only.
 *
 * OpenRocket's FinSetSaver writes <filletradius>/<filletmaterial> for every fin
 * set and counts the fillet volume toward fin mass. This app's kernel bridge
 * does not model fillets yet — but the exporter used to hard-write
 * `<filletradius>0.0</filletradius>` and a Cardboard material, so opening a
 * desktop design with 6 mm epoxy fillets and saving it DELETED them from the
 * user's own file. Preserving the values costs nothing and stops the
 * destruction; the mass still is not counted, which the import note says.
 */
function readFillet(el: Element, node: ComponentNode): void {
  const r = num(el, 'filletradius', 0);
  if (!(r > 0)) return;
  node['filletRadius'] = r;
  const m = el.querySelector(':scope > filletmaterial');
  if (!m) return;
  const d = Number(m.getAttribute('density'));
  if (Number.isFinite(d) && d > 0) node['filletDensity'] = d;
  const group = m.getAttribute('group');
  if (group) node['filletMaterialGroup'] = group;
  const name = (m.textContent ?? '').trim();
  if (name) node['filletMaterialName'] = name;
}

/** Fin-set rotation about the body axis (.ork stores DEGREES; we keep rad). */
function readFinRotation(el: Element, node: ComponentNode): void {
  const deg = num(el, 'rotation', 0);
  if (deg !== 0) node['rotation'] = (deg * Math.PI) / 180;
}

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

/**
 * Recovery-device deployment: the bare tags are the defaults; the chosen
 * config's <deploymentconfiguration> block (same child tag names) overrides
 * them PER FIELD — the desktop handler clones the default and applies only
 * the fields the block carries.
 */
function readDeployment(el: Element, node: ComponentNode, configEl: Element | null = null): void {
  for (const src of configEl ? [el, configEl] : [el]) {
    const event = text(src, ':scope > deployevent');
    if (event) node['deployEvent'] = event;
    if (text(src, ':scope > deployaltitude') !== null) {
      node['deployAltitude'] = num(src, 'deployaltitude', 200);
    }
    if (text(src, ':scope > deploydelay') !== null) {
      node['deployDelay'] = num(src, 'deploydelay', 0);
    }
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
