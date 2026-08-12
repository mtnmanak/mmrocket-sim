import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { ComponentNode, ComponentPosition, RocketTree, StaticInfo } from '@online-openrocket/engine';
import {
  assemblyBoundingRadius, assemblyChainLength, isAssembly,
  resolveAssemblyRadius, ringInstanceOffsets,
} from '../tree/assembly.js';
import { tubeFinRadius } from '../tree/tubefins.js';
import { outerProfile } from '../tree/shapeProfile.js';
import {
  downloadBlob, IMAGE_FORMAT_EXT, snapshotWithHeader,
  type ExportData, type ImageFormat,
} from '../services/schematicExport.js';
import { ImageExportMenu } from './ImageExportMenu.js';

/**
 * 3D rocket view (react-three-fiber). Geometry is generated from the
 * component tree: lathe profiles for nose cones and transitions (kernel-exact
 * shape math), cylinders for tubes, extruded shapes for fins placed at their
 * instance angles.
 * Rocket axis = +X (nose tip at x=0, aft increasing), matching the engine.
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
  foreR: number, aftR: number,
): THREE.Vector2[] {
  return outerProfile(shape, param, length, foreR, aftR)
    .map(([x, r]) => new THREE.Vector2(Math.max(0.0001, r), x));
}

const MAT = {
  nose: '#c9c2b5',
  body: '#e2ded6',
  transition: '#c9c2b5',
  fin: '#a98f6f',
  lug: '#9a978f',
};

export interface Piece {
  key: string;
  geometry: THREE.BufferGeometry;
  color: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
}

/** Shared with the OBJ exporter — this IS the app's 3D geometry. */
export function buildPieces(tree: RocketTree): { pieces: Piece[]; totalLen: number; maxR: number } {
  const pieces: Piece[] = [];
  let maxR = 0.005;
  let k = 0;

  // Push a piece. For off-axis assemblies an instance transform `xform` is
  // baked into the geometry (like addFins already does), so the flat Piece[]
  // stays position/rotation-free there and the OBJ exporter needs no changes.
  const place = (
    key: string, geometry: THREE.BufferGeometry, color: string,
    position?: [number, number, number], rotation?: [number, number, number],
    xform?: THREE.Matrix4,
  ) => {
    if (!xform) { pieces.push({ key, geometry, color, position, rotation }); return; }
    const g = geometry.clone();
    const m = new THREE.Matrix4().copy(xform);
    if (position) m.multiply(new THREE.Matrix4().makeTranslation(position[0], position[1], position[2]));
    if (rotation) m.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])));
    g.applyMatrix4(m);
    pieces.push({ key, geometry: g, color });
  };

  const addFins = (child: ComponentNode, pStart: number, pLen: number, pRadius: number, xform?: THREE.Matrix4) => {
    const count = Math.max(1, Math.round(num(child, 'finCount', 3)));
    const ffPoints = child.type === 'freeformfinset'
      ? ((child['points'] as [number, number][] | undefined) ?? [])
      : [];
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
      const raw = (child['points'] as [number, number][] | undefined) ?? [[0, 0], [0.02, 0.03], [0.05, 0]];
      shape.moveTo(raw[0]![0], raw[0]![1]);
      for (let i = 1; i < raw.length; i++) {
        shape.lineTo(raw[i]![0], raw[i]![1]);
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
        // External shroud on the +Y surface (radial angle not modeled).
        const len = num(child, 'length', 0.08);
        const wid = num(child, 'width', 0.025);
        const hgt = num(child, 'height', 0.02);
        const start = axialStart(child, len, pStart, pLen);
        maxR = Math.max(maxR, pRadius + hgt);
        const geo = new THREE.BoxGeometry(len, hgt, wid);
        place(`fairing${k++}`, geo, nodeColor(child, MAT.lug),
          [start + len / 2, pRadius + hgt / 2, 0], [0, 0, 0], xform);
      } else if (child.type === 'launchlug') {
        const len = num(child, 'length', 0.05);
        const r = num(child, 'outerRadius', 0.0022);
        const start = axialStart(child, len, pStart, pLen);
        const geo = new THREE.CylinderGeometry(r, r, len, 16);
        place(`lug${k++}`, geo, nodeColor(child, MAT.lug),
          [start + len / 2, pRadius + r, 0], [0, 0, -Math.PI / 2], xform);
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
          [x, 0, 0], [0, 0, -Math.PI / 2], xform);
        maxR = Math.max(maxR, R);
        addChildren(n, x, len, R, xform);
        x += len;
      } else if (n.type === 'bodytube') {
        const R = num(n, 'outerRadius', 0.012);
        place(`body${k++}`, new THREE.CylinderGeometry(R, R, len, 48), nodeColor(n, MAT.body),
          [x + len / 2, 0, 0], [0, 0, -Math.PI / 2], xform);
        maxR = Math.max(maxR, R);
        addChildren(n, x, len, R, xform);
        x += len;
      } else if (n.type === 'transition') {
        const rf = num(n, 'foreRadius', 0.012);
        const ra = num(n, 'aftRadius', 0.009);
        const shapeName = typeof n['shape'] === 'string' ? (n['shape'] as string) : 'conical';
        // Same lathe pattern as the nose: profile y runs fore→aft, and after
        // rotation.z = -π/2 the lathe's +Y axis points along +X (aft).
        const pts = lathePoints(shapeName, numOpt(n, 'shapeParameter'), len, rf, ra);
        place(`trans${k++}`, new THREE.LatheGeometry(pts, 48), nodeColor(n, MAT.transition),
          [x, 0, 0], [0, 0, -Math.PI / 2], xform);
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

export function Rocket3D({ tree, info, exportData }: {
  tree: RocketTree;
  info: StaticInfo | null;
  /** When set, a 📷 PNG snapshot button appears (issue 2026-08-11a). */
  exportData?: Omit<ExportData, 'spanM'>;
}) {
  const { pieces, totalLen, maxR } = useMemo(() => buildPieces(tree), [tree]);
  const r3f = useRef<{ gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera } | null>(null);

  // Hi-res snapshot (issue 2026-08-11b): re-render the SAME scene/camera at
  // the export width (updateStyle=false keeps the on-screen CSS size), grab
  // the buffer, then restore — preserveDrawingBuffer makes the read reliable.
  const snapshot = async (format: ImageFormat, widthPx: number) => {
    const st = r3f.current;
    if (!st || !exportData) return;
    const el = st.gl.domElement;
    const cssW = el.clientWidth || el.width || 1;
    const cssH = el.clientHeight || el.height || 1;
    const pr = st.gl.getPixelRatio();
    try {
      st.gl.setPixelRatio(1);
      st.gl.setSize(widthPx, Math.max(1, Math.round(widthPx * (cssH / cssW))), false);
      st.gl.render(st.scene, st.camera);
      const blob = await snapshotWithHeader(el, { ...exportData, spanM: 2 * maxR }, format);
      downloadBlob(blob, `${exportData.name.replace(/[^\w-]+/g, '_')}-3d.${IMAGE_FORMAT_EXT[format]}`);
    } finally {
      st.gl.setPixelRatio(pr);
      st.gl.setSize(cssW, cssH, false);
      st.gl.render(st.scene, st.camera);
    }
  };
  // Mesh keys are stable across rebuilds, so R3F never unmounts/auto-disposes
  // the swapped-out geometries — release them ourselves or every edit leaks
  // a full set of GPU buffers.
  useEffect(() => () => {
    for (const p of pieces) p.geometry.dispose();
  }, [pieces]);
  const center = totalLen / 2;
  const camDist = Math.max(totalLen * 1.1, maxR * 6, 0.25);
  const markerR = Math.max(totalLen * 0.015, maxR * 0.35);

  return (
    <div className="rocket3d-wrap" style={{ position: 'relative' }}>
      {exportData && (
        <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 2 }}>
          <ImageExportMenu label="📷 Image"
            title="Snapshot the current 3D view with design data — rotate/zoom first, then pick PNG or JPG and a width (re-rendered at that resolution)"
            onPick={snapshot} />
        </div>
      )}
      <Canvas camera={{ position: [center + camDist * 0.5, camDist * 0.45, camDist * 0.8], fov: 40 }}
        // Snapshot export reads the drawing buffer after the frame — without
        // this flag WebGL may have discarded it and toDataURL returns black.
        gl={{ preserveDrawingBuffer: true }}
        onCreated={(state) => { r3f.current = { gl: state.gl, scene: state.scene, camera: state.camera }; }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[1, 2, 2]} intensity={1.1} />
        <directionalLight position={[-1, -0.5, -1]} intensity={0.3} />
        <group>
          {pieces.map((p) => (
            <mesh key={p.key} geometry={p.geometry}
              position={p.position ?? [0, 0, 0]}
              rotation={p.rotation ?? [0, 0, 0]}>
              <meshStandardMaterial color={p.color} roughness={0.6} metalness={0.05} />
            </mesh>
          ))}
          {/* CG/CP sit on the rocket axis — inside the shell — so they must
              render ON TOP (depthTest off, high renderOrder) to be visible,
              exactly like the 2D markers. Otherwise the opaque body hides them. */}
          {info && Number.isFinite(info.cg) && (
            <mesh position={[info.cg, 0, 0]} renderOrder={10}>
              <sphereGeometry args={[markerR, 24, 24]} />
              <meshStandardMaterial color="#e9edf1" emissive="#8891a0" depthTest={false} />
            </mesh>
          )}
          {info && Number.isFinite(info.cp) && (
            <mesh position={[info.cp, 0, 0]} renderOrder={11}>
              <sphereGeometry args={[markerR, 24, 24]} />
              <meshStandardMaterial color="#e34948" emissive="#5a1010" depthTest={false} />
            </mesh>
          )}
        </group>
        <OrbitControls target={[center, 0, 0]} enableDamping dampingFactor={0.1} />
      </Canvas>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0', textAlign: 'center' }}>
        drag to rotate · scroll to zoom · <span style={{ color: '#aab2bd' }}>●</span> CG ·{' '}
        <span style={{ color: '#e34948' }}>●</span> CP
      </p>
    </div>
  );
}
