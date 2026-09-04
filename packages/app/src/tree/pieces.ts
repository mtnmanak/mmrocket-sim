import * as THREE from 'three';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import {
  assemblyBoundingRadius, assemblyChainLength, isAssembly,
  resolveAssemblyRadius, ringInstanceOffsets,
} from './assembly.js';
import { clusterOffsets } from './cluster.js';
import { tubeFinRadius } from './tubefins.js';
import { outerProfile } from './shapeProfile.js';
import { isConformal, shroudEnds } from './shroud.js';
import { shroudGeometry } from './shroudMesh.js';
import { kernelLength } from './kernelLength.js';

/**
 * THE APP'S 3D GEOMETRY, and nothing else.
 *
 * This is `buildPieces` and the helpers it needs: three.js BufferGeometry
 * built from the component tree — lathe profiles for nose cones and
 * transitions (kernel-exact shape math), cylinders for tubes, extruded shapes
 * for fins at their instance angles. No React, no hooks, no renderer.
 *
 * It lives here rather than in `components/Rocket3D.tsx` because FOUR
 * consumers are not the 3D view: File > Save STL, the OBJ exporter, the glTF
 * exporter and the 3D tab. App.tsx deliberately `lazy()`-loads Rocket3D to
 * keep @react-three/fiber (969 KB) and @react-three/drei (2.7 MB) out of the
 * initial bundle — and then the STL path used to `import()` that same module
 * just to reach this function, pulling 3.6 MB of renderer over the network to
 * write a file that never mounts a canvas. Nothing below imports either
 * package, so importing THIS module costs `three` alone.
 */

const nodeColor = (n: ComponentNode, dflt: string): string => typeof n['color'] === 'string' ? (n['color'] as string) : dflt;

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

const numOpt = (n: ComponentNode, key: string): number | undefined =>
  typeof n[key] === 'number' ? (n[key] as number) : undefined;


function axialStart(child: ComponentNode, childLen: number, pStart: number, pLen: number): number {
  const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  switch (pos.method) {
    case 'middle': return pStart + (pLen - childLen) / 2 + pos.offset;
    case 'bottom': return pStart + pLen - childLen + pos.offset;
    case 'absolute': return pos.offset;
    default: return pStart + pos.offset;
  }
}

/**
 * Lathe points for a nose/transition outer profile (kernel-exact shapes from
 * shapeProfile.ts). Lathe geometry revolves around +Y; the radius floor keeps
 * the tip from degenerating.
 */
function lathePoints(
  shape: string, param: number | undefined, length: number,
  foreR: number, aftR: number, clipped?: boolean,
): THREE.Vector2[] {
  // `clipped` = the node's stored flag; absent keeps the kernel default
  // (clipped), so the drawn transition matches the geometry the engine flies.
  return outerProfile(shape, param, length, foreR, aftR, undefined, undefined, clipped)
    .map(([x, r]) => new THREE.Vector2(Math.max(0.0001, r), x));
}

const MAT = {
  nose: '#c9c2b5',
  body: '#e2ded6',
  transition: '#c9c2b5',
  fin: '#a98f6f',
  lug: '#9a978f',
  inner: '#6b6862',
  motor: '#c65420',
};

export interface Piece {
  key: string;
  geometry: THREE.BufferGeometry;
  color: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  /** External shell (nose/tube/transition) — drawn see-through so mounts and
   *  motors read inside (S5, 2026-08-21c). */
  translucent?: boolean;
  /** Inner tubes — glassier still, so the loaded motor INSIDE them shows
   *  (batch 08-21d: an opaque mount hid the motor entirely). */
  innerGlass?: boolean;
}

/** Loaded motor case dimensions (m) keyed by mount node id — the same shape
 *  TreeSchematic takes. */
export type MotorDims = Record<string, { length: number; diameter: number; label?: string }>;

/** Shared with the OBJ exporter — this IS the app's 3D geometry. */
export function buildPieces(tree: RocketTree, motors?: MotorDims): { pieces: Piece[]; totalLen: number; maxR: number } {
  const pieces: Piece[] = [];
  let maxR = 0.005;
  let k = 0;

  // Push a piece. For off-axis assemblies an instance transform `xform` is
  // baked into the geometry (like addFins already does), so the flat Piece[]
  // stays position/rotation-free there and the OBJ exporter needs no changes.
  const place = (
    key: string, geometry: THREE.BufferGeometry, color: string,
    position?: [number, number, number], rotation?: [number, number, number],
    xform?: THREE.Matrix4, translucent?: boolean | 'glass',
  ) => {
    const flags = {
      translucent: translucent === true || undefined,
      innerGlass: translucent === 'glass' || undefined,
    };
    if (!xform) { pieces.push({ key, geometry, color, position, rotation, ...flags }); return; }
    const g = geometry.clone();
    const m = new THREE.Matrix4().copy(xform);
    if (position) m.multiply(new THREE.Matrix4().makeTranslation(position[0], position[1], position[2]));
    if (rotation) m.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])));
    g.applyMatrix4(m);
    pieces.push({ key, geometry: g, color, ...flags });
  };

  const addFins = (child: ComponentNode, pStart: number, pLen: number, pRadius: number, xform?: THREE.Matrix4) => {
    const count = Math.max(1, Math.round(num(child, 'finCount', 3)));
    const ffPoints = child.type === 'freeformfinset'
      ? ((child['points'] as [number, number][] | undefined) ?? [])
      : [];
    // A freeform fin needs THREE points to be a shape. Two lines below guard
    // `ffPoints.length` for the chord and the height, and the profile builder
    // used to drop the guard and index `raw[0]!` — but `??` substitutes its
    // default only for a MISSING key, so an EMPTY array walked straight into
    // that non-null assertion and threw a TypeError. rocksimFile.ts:580 writes
    // exactly that array: a <CustomFinSet> with an empty or absent <PointList>
    // parses to []. The throw happened inside buildPieces, which the design
    // screen has no error boundary around, so opening the 3D tab on such an
    // import blanked the whole app and lost unsaved work — and File > Save STL
    // reaches the same call without ever mounting the 3D view.
    //
    // Skip the set rather than substitute a made-up fin: >= 3 is the same test
    // TreeSchematic.tsx:875, orkFile.ts:533 and FinPointsEditor use, so all
    // four agree that a sub-3-point set draws nothing at all.
    if (child.type === 'freeformfinset' && ffPoints.length < 3) return;
    const root = child.type === 'freeformfinset' && ffPoints.length
      ? Math.max(...ffPoints.map((p) => p[0]))
      : num(child, 'rootChord', 0.05);
    const height = child.type === 'freeformfinset' && ffPoints.length
      ? Math.max(...ffPoints.map((p) => p[1]))
      : num(child, 'height', 0.03);
    const thickness = num(child, 'thickness', 0.003);
    const start = axialStart(child, root, pStart, pLen);
    maxR = Math.max(maxR, pRadius + height);

    const shape = new THREE.Shape();
    if (child.type === 'freeformfinset') {
      // ffPoints, not a re-read with a default: the >= 3 guard at the top of
      // this function is what makes raw[0] safe, and reading the key twice is
      // how the two fell out of step in the first place.
      shape.moveTo(ffPoints[0]![0], ffPoints[0]![1]);
      for (let i = 1; i < ffPoints.length; i++) {
        shape.lineTo(ffPoints[i]![0], ffPoints[i]![1]);
      }
    } else if (child.type === 'ellipticalfinset') {
      // Half-ellipse fin profile.
      shape.moveTo(0, 0);
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        shape.lineTo(root * t, height * Math.sin(Math.PI * t));
      }
      shape.lineTo(root, 0);
    } else {
      const tip = num(child, 'tipChord', 0.03);
      const sweep = num(child, 'sweep', 0.02);
      shape.moveTo(0, 0);
      shape.lineTo(sweep, height);
      shape.lineTo(sweep + tip, height);
      shape.lineTo(root, 0);
    }
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    geo.translate(0, 0, -thickness / 2);

    for (let i = 0; i < count; i++) {
      const angle = num(child, 'rotation', 0) + (2 * Math.PI * i) / count;
      // Fin lies in the XY plane, root on the surface (+Y), then rotate about X.
      const g = geo.clone();
      g.translate(start, pRadius, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationX(angle));
      if (xform) g.applyMatrix4(xform); // off-axis pod instance
      pieces.push({ key: `fin${k++}`, geometry: g, color: nodeColor(child, MAT.fin) });
    }
    geo.dispose();
  };

  const addChildren = (parent: ComponentNode, pStart: number, pLen: number, pRadius: number, xform?: THREE.Matrix4) => {
    for (const child of parent.children ?? []) {
      if (child.type === 'trapezoidfinset' || child.type === 'ellipticalfinset' || child.type === 'freeformfinset') {
        addFins(child, pStart, pLen, pRadius, xform);
      } else if (child.type === 'tubefinset') {
        // Ring of open tubes around the body, each tangent to the surface.
        const count = Math.max(1, Math.round(num(child, 'finCount', 6)));
        const len = num(child, 'length', 0.1);
        const rt = tubeFinRadius(child, pRadius);
        const wall = Math.min(num(child, 'thickness', 0.0005), rt * 0.45);
        const start = axialStart(child, len, pStart, pLen);
        maxR = Math.max(maxR, pRadius + 2 * rt);
        for (let i = 0; i < count; i++) {
          const angle = num(child, 'rotation', 0) + (2 * Math.PI * i) / count;
          // Open tube: an annulus extruded along the body axis.
          const ring = new THREE.Shape();
          ring.absarc(0, 0, rt, 0, 2 * Math.PI, false);
          const bore = new THREE.Path();
          bore.absarc(0, 0, Math.max(rt - wall, rt * 0.55), 0, 2 * Math.PI, true);
          ring.holes.push(bore);
          const geo = new THREE.ExtrudeGeometry(ring, { depth: len, bevelEnabled: false, curveSegments: 24 });
          // Extrude runs along +Z; rotate so the tube runs along +X (body axis),
          // then lift to the surface (+Y) and spin about X for the ring position.
          geo.rotateY(Math.PI / 2);
          geo.translate(start, pRadius + rt, 0);
          geo.applyMatrix4(new THREE.Matrix4().makeRotationX(angle));
          if (xform) geo.applyMatrix4(xform);
          pieces.push({ key: `tubefin${k++}`, geometry: geo, color: nodeColor(child, MAT.fin) });
        }
      } else if (child.type === 'fairing') {
        // External shroud — a real shell now (v0.088), not a box: its two ends
        // are shaped independently and its underside is cut to the tube unless
        // the owner says otherwise. `shroudGeometry` builds it already sitting
        // on the +y surface at the right radius, so unlike the box it needs no
        // radial offset — only the rotation to its mounting angle.
        const len = num(child, 'length', 0.08);
        const wid = num(child, 'width', 0.025);
        const hgt = num(child, 'height', 0.02);
        const start = axialStart(child, len, pStart, pLen);
        maxR = Math.max(maxR, pRadius + hgt);
        const ends = shroudEnds(child);
        const geo = shroudGeometry({
          length: len, width: wid, height: hgt, bodyRadius: pRadius,
          conformal: isConformal(child), fore: ends.fore, aft: ends.aft,
        });
        place(`fairing${k++}`, geo, nodeColor(child, MAT.lug),
          [start, 0, 0], [num(child, 'angleOffset', 0), 0, 0], xform);
      } else if ((child.type as string) === 'protuberance') {
        // Drag bump, drawn as the frontal box it IS aerodynamically — width x
        // height — so what the eye reads is the area feeding the drag. It sits
        // at its own mounting angle, same as every other surface part.
        const len = num(child, 'length', 0.06);
        const wid = num(child, 'width', 0.02);
        const hgt = num(child, 'height', 0.01);
        const start = axialStart(child, len, pStart, pLen);
        maxR = Math.max(maxR, pRadius + hgt);
        const geo = new THREE.BoxGeometry(len, hgt, wid);
        const pa = num(child, 'angleOffset', 0);
        const pd = pRadius + hgt / 2;
        place(`prot${k++}`, geo, nodeColor(child, MAT.lug),
          [start + len / 2, pd * Math.cos(pa), pd * Math.sin(pa)], [pa, 0, 0], xform);
      } else if (child.type === 'launchlug') {
        const len = num(child, 'length', 0.05);
        const r = num(child, 'outerRadius', 0.0022);
        const start = axialStart(child, len, pStart, pLen);
        const geo = new THREE.CylinderGeometry(r, r, len, 16);
        // Euler order XYZ gives Rx*Ry*Rz, so the -pi/2 about Z still lays the
        // cylinder along the body and the X term then swings it round.
        const la = num(child, 'angleOffset', 0);
        const ld = pRadius + r;
        // Line instances (v0.089): copies march aft from the node's position.
        const lugN = Math.max(1, Math.round(num(child, 'instanceCount', 1)));
        const lugSep = num(child, 'instanceSeparation', 0);
        for (let li = 0; li < lugN; li++) {
          place(`lug${k++}`, geo.clone(), nodeColor(child, MAT.lug),
            [start + li * lugSep + len / 2, ld * Math.cos(la), ld * Math.sin(la)], [la, 0, -Math.PI / 2], xform);
        }
        geo.dispose();
      } else if (child.type === 'railbutton') {
        // Rail buttons had NO 3D drawing at all until v0.089 — a part the app
        // simulated and warned about was simply absent from the one view
        // people rotate to inspect the build. A button is a squat cylinder
        // standing off the surface, its axis radial: one per line instance
        // marching aft.
        // THE STANDOFF IS THE BUTTON'S OWN TOTAL HEIGHT (v0.103). It was the
        // literal 9.7 mm until then — the kernel constructor's default — so a
        // 1515 button (14.2 mm) and a micro button (4.05 mm) drew identically,
        // and the aft view drew a third height again. Same key the kernel now
        // flies (RailButtonCalc.java:57-60 makes totalHeight x OD the drag
        // reference area), so the drawing and the number finally agree.
        // THE STATION IS THE BUTTON'S CENTRE, and it is resolved with an axial
        // length of ZERO (v0.105). This view used to resolve it with the outer
        // diameter and then draw the cylinder aft of that point, which put the
        // drawn button OD/2 = 4.85 mm aft of the flown one on a 'top'-anchored
        // button and 4.85 mm forward of it on a 'bottom'-anchored one. The
        // kernel has no third answer to consult: `RocketComponent.java:86`
        // declares `protected double length = 0` and RailButton never assigns
        // it, and `RailButton.getInstanceBoundingBox` extends ±OD/2 ABOUT the
        // station. `kernelLength` is that zero, shared with the side view and
        // the property panel so the three cannot drift again.
        const bd = num(child, 'outerDiameter', 0.0097);
        const bh = num(child, 'totalHeight', 0.0097);
        const station = axialStart(child, kernelLength(child), pStart, pLen);
        const bGeo = new THREE.CylinderGeometry(bd / 2, bd / 2, bh, 16);
        const ba = num(child, 'angleOffset', 0);
        const bdst = pRadius + bh / 2;
        const bN = Math.max(1, Math.round(num(child, 'instanceCount', 1)));
        const bSep = num(child, 'instanceSeparation', 0);
        for (let li = 0; li < bN; li++) {
          // CylinderGeometry's axis is +y; rotating about X by the mount angle
          // swings that radial axis around the body — no -pi/2 here, unlike
          // the lug, whose axis must lie ALONG the body.
          place(`rbtn${k++}`, bGeo.clone(), nodeColor(child, MAT.lug),
            [station + li * bSep, bdst * Math.cos(ba), bdst * Math.sin(ba)], [ba, 0, 0], xform);
        }
        bGeo.dispose();
        maxR = Math.max(maxR, pRadius + bh);
      } else if (child.type === 'innertube') {
        // Motor mount / inner tube, one per cluster position — visible through
        // the translucent shell. A loaded motor seats flush against the
        // mount's aft end (how motors actually load), same as the 2D view.
        const len = num(child, 'length', 0.05);
        const r = num(child, 'outerRadius', 0.0095);
        const start = axialStart(child, len, pStart, pLen);
        // A tube can sit OFF the centreline on its own, independently of any
        // cluster pattern: desktop's "split cluster" makes each motor tube
        // exactly that, one radius and one angle apiece. Both fields are
        // editable here (schema RADIAL_PLACEMENT), read from <radialposition>
        // and written back by orkFile, and scaled by scaleRocket — but until
        // v0.105 only the AFT view drew them (AftView.tsx:215-217), so a split
        // cluster spread out end-on and stacked on the axis in the side and 3D
        // views. Angle 0 is +y, the same convention every radial part uses.
        const rp = num(child, 'radialPosition', 0);
        const rd = num(child, 'radialDirection', 0);
        const ry = rp * Math.cos(rd);
        const rz = rp * Math.sin(rd);
        const motor = child.id ? motors?.[child.id] : undefined;
        for (const off of clusterOffsets(
          child['cluster'] as string | undefined, r,
          num(child, 'clusterScale', 1), num(child, 'clusterRotation', 0),
        )) {
          place(`inner${k++}`, new THREE.CylinderGeometry(r, r, len, 32), nodeColor(child, MAT.inner),
            [start + len / 2, ry + off.y, rz + off.z], [0, 0, -Math.PI / 2], xform, 'glass');
          if (motor) {
            const mR = motor.diameter / 2;
            const mStart = start + len - motor.length + num(child, 'motorOverhang', 0);
            place(`motor${k++}`, new THREE.CylinderGeometry(mR, mR, motor.length, 32), MAT.motor,
              [mStart + motor.length / 2, ry + off.y, rz + off.z], [0, 0, -Math.PI / 2], xform);
          }
        }
      } else if (isAssembly(child.type)) {
        // Off-axis pod / booster: place its whole sub-chain at the instance's
        // radius + angle (the addFins rotate-about-X primitive, lifted from one
        // fin to a mini-rocket). Nested pods compose transforms.
        const podChain = child.children ?? [];
        const podLen = assemblyChainLength(child);
        const podRadius = resolveAssemblyRadius(child, pRadius);
        const podStart = axialStart(child, podLen, pStart, pLen);
        const count = Math.max(1, Math.round(num(child, 'instanceCount', 2)));
        const angleOffset = num(child, 'angleOffset', 0);
        maxR = Math.max(maxR, podRadius + assemblyBoundingRadius(child));
        for (const off of ringInstanceOffsets(count, podRadius, angleOffset)) {
          const m = new THREE.Matrix4().makeRotationX(off.angle)
            .multiply(new THREE.Matrix4().makeTranslation(podStart, podRadius, 0));
          addChain(podChain, xform ? new THREE.Matrix4().copy(xform).multiply(m) : m);
        }
      }
      // Other internal components are not rendered in 3D (invisible in tubes).
    }
  };

  // Builds an axial nose→tail chain in its local frame; `xform` (when present)
  // is baked into every piece to place an off-axis pod instance. Returns the
  // chain's axial length.
  const addChain = (nodes: ComponentNode[], xform?: THREE.Matrix4): number => {
    let x = 0;
    for (const n of nodes) {
      const len = num(n, 'length', 0);
      if (n.type === 'nosecone') {
        const R = num(n, 'aftRadius', 0.012);
        const shapeName = typeof n['shape'] === 'string' ? (n['shape'] as string) : 'ogive';
        const pts = lathePoints(shapeName, numOpt(n, 'shapeParameter'), len, 0, R);
        place(`nose${k++}`, new THREE.LatheGeometry(pts, 48), nodeColor(n, MAT.nose),
          [x, 0, 0], [0, 0, -Math.PI / 2], xform, true);
        maxR = Math.max(maxR, R);
        addChildren(n, x, len, R, xform);
        x += len;
      } else if (n.type === 'bodytube') {
        const R = num(n, 'outerRadius', 0.012);
        place(`body${k++}`, new THREE.CylinderGeometry(R, R, len, 48), nodeColor(n, MAT.body),
          [x + len / 2, 0, 0], [0, 0, -Math.PI / 2], xform, true);
        maxR = Math.max(maxR, R);
        // Min-diameter mount: a motor loaded directly in this body tube.
        const tubeMotor = n.id ? motors?.[n.id] : undefined;
        if (tubeMotor) {
          const mR = tubeMotor.diameter / 2;
          const mStart = x + len - tubeMotor.length + num(n, 'motorOverhang', 0);
          place(`motor${k++}`, new THREE.CylinderGeometry(mR, mR, tubeMotor.length, 32), MAT.motor,
            [mStart + tubeMotor.length / 2, 0, 0], [0, 0, -Math.PI / 2], xform);
        }
        addChildren(n, x, len, R, xform);
        x += len;
      } else if (n.type === 'transition') {
        const rf = num(n, 'foreRadius', 0.012);
        const ra = num(n, 'aftRadius', 0.009);
        const shapeName = typeof n['shape'] === 'string' ? (n['shape'] as string) : 'conical';
        // Same lathe pattern as the nose: profile y runs fore→aft, and after
        // rotation.z = -π/2 the lathe's +Y axis points along +X (aft).
        // node['clipped'] (.ork <shapeclipped>) rides along so an unclipped
        // file draws the way it simulates.
        const pts = lathePoints(shapeName, numOpt(n, 'shapeParameter'), len, rf, ra,
          typeof n['clipped'] === 'boolean' ? (n['clipped'] as boolean) : undefined);
        place(`trans${k++}`, new THREE.LatheGeometry(pts, 48), nodeColor(n, MAT.transition),
          [x, 0, 0], [0, 0, -Math.PI / 2], xform, true);
        maxR = Math.max(maxR, rf, ra);
        addChildren(n, x, len, Math.max(rf, ra), xform);
        x += len;
      }
    }
    return x;
  };

  // Stages flatten into one nose-to-tail chain (sustainer first, boosters after).
  const chain = tree.components.flatMap((n) => (n.type === 'stage' ? n.children ?? [] : [n]));
  const totalLen = addChain(chain);

  return { pieces, totalLen: Math.max(totalLen, 0.05), maxR };
}
