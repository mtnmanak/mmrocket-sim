import { useMemo } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { ComponentNode, ComponentPosition, RocketTree, StaticInfo } from '@online-openrocket/engine';

/**
 * 3D rocket view (react-three-fiber). Geometry is generated from the
 * component tree: lathe profiles for nose cones, cylinders for tubes and
 * transitions, extruded shapes for fins placed at their instance angles.
 * Rocket axis = +X (nose tip at x=0, aft increasing), matching the engine.
 */

const nodeColor = (n: ComponentNode, dflt: string): string => typeof n['color'] === 'string' ? (n['color'] as string) : dflt;

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

function axialStart(child: ComponentNode, childLen: number, pStart: number, pLen: number): number {
  const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  switch (pos.method) {
    case 'middle': return pStart + (pLen - childLen) / 2 + pos.offset;
    case 'bottom': return pStart + pLen - childLen + pos.offset;
    case 'absolute': return pos.offset;
    default: return pStart + pos.offset;
  }
}

/** Nose profile radius fraction at t∈[0,1] (tip→base) per shape. */
function noseProfile(shape: string, t: number, R: number, L: number): number {
  switch (shape) {
    case 'conical': return R * t;
    case 'ellipsoid': return R * Math.sqrt(1 - (1 - t) * (1 - t));
    case 'parabolic': return R * (2 * t - t * t);
    case 'power': return R * Math.sqrt(t);
    case 'haack': {
      const theta = Math.acos(1 - 2 * t);
      return (R / Math.sqrt(Math.PI)) * Math.sqrt(theta - Math.sin(2 * theta) / 2);
    }
    case 'ogive':
    default: {
      const x = t * L;
      const rho = (R * R + L * L) / (2 * R);
      return Math.sqrt(Math.max(0, rho * rho - (L - x) * (L - x))) - (rho - R);
    }
  }
}

const MAT = {
  nose: '#c9c2b5',
  body: '#e2ded6',
  transition: '#c9c2b5',
  fin: '#a98f6f',
  lug: '#9a978f',
};

interface Piece {
  key: string;
  geometry: THREE.BufferGeometry;
  color: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
}

function buildPieces(tree: RocketTree): { pieces: Piece[]; totalLen: number; maxR: number } {
  const pieces: Piece[] = [];
  let x = 0;
  let maxR = 0.005;
  let k = 0;

  const addFins = (child: ComponentNode, pStart: number, pLen: number, pRadius: number) => {
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
      const angle = (2 * Math.PI * i) / count;
      // Fin lies in the XY plane, root on the surface (+Y), then rotate about X.
      const g = geo.clone();
      g.translate(start, pRadius, 0);
      const m = new THREE.Matrix4().makeRotationX(angle);
      g.applyMatrix4(m);
      pieces.push({ key: `fin${k++}`, geometry: g, color: nodeColor(child, MAT.fin) });
    }
    geo.dispose();
  };

  const addChildren = (parent: ComponentNode, pStart: number, pLen: number, pRadius: number) => {
    for (const child of parent.children ?? []) {
      if (child.type === 'trapezoidfinset' || child.type === 'ellipticalfinset' || child.type === 'freeformfinset') {
        addFins(child, pStart, pLen, pRadius);
      } else if (child.type === 'launchlug') {
        const len = num(child, 'length', 0.05);
        const r = num(child, 'outerRadius', 0.0022);
        const start = axialStart(child, len, pStart, pLen);
        const geo = new THREE.CylinderGeometry(r, r, len, 16);
        pieces.push({
          key: `lug${k++}`, geometry: geo, color: nodeColor(child, MAT.lug),
          position: [start + len / 2, pRadius + r, 0],
          rotation: [0, 0, -Math.PI / 2],
        });
      }
      // Internal components are not rendered in 3D (invisible inside tubes).
    }
  };

  for (const n of tree.components) {
    const len = num(n, 'length', 0);
    if (n.type === 'nosecone') {
      const R = num(n, 'aftRadius', 0.012);
      const shapeName = typeof n['shape'] === 'string' ? (n['shape'] as string) : 'ogive';
      const pts: THREE.Vector2[] = [];
      const steps = 32;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        pts.push(new THREE.Vector2(Math.max(0.0001, noseProfile(shapeName, t, R, len)), t * len));
      }
      const geo = new THREE.LatheGeometry(pts, 48);
      pieces.push({
        key: `nose${k++}`, geometry: geo, color: nodeColor(n, MAT.nose),
        position: [x, 0, 0],
        rotation: [0, 0, -Math.PI / 2],
      });
      maxR = Math.max(maxR, R);
      addChildren(n, x, len, R);
      x += len;
    } else if (n.type === 'bodytube') {
      const R = num(n, 'outerRadius', 0.012);
      const geo = new THREE.CylinderGeometry(R, R, len, 48);
      pieces.push({
        key: `body${k++}`, geometry: geo, color: nodeColor(n, MAT.body),
        position: [x + len / 2, 0, 0],
        rotation: [0, 0, -Math.PI / 2],
      });
      maxR = Math.max(maxR, R);
      addChildren(n, x, len, R);
      x += len;
    } else if (n.type === 'transition') {
      const rf = num(n, 'foreRadius', 0.012);
      const ra = num(n, 'aftRadius', 0.009);
      // After rotation.z = -π/2 the cylinder's +Y axis points along +X (aft):
      // top radius = aft radius.
      const geo = new THREE.CylinderGeometry(ra, rf, len, 48);
      pieces.push({
        key: `trans${k++}`, geometry: geo, color: nodeColor(n, MAT.transition),
        position: [x + len / 2, 0, 0],
        rotation: [0, 0, -Math.PI / 2],
      });
      maxR = Math.max(maxR, rf, ra);
      addChildren(n, x, len, Math.max(rf, ra));
      x += len;
    }
  }

  return { pieces, totalLen: Math.max(x, 0.05), maxR };
}

export function Rocket3D({ tree, info }: { tree: RocketTree; info: StaticInfo | null }) {
  const { pieces, totalLen, maxR } = useMemo(() => buildPieces(tree), [tree]);
  const center = totalLen / 2;
  const camDist = Math.max(totalLen * 1.1, maxR * 6, 0.25);
  const markerR = Math.max(totalLen * 0.012, maxR * 0.25);

  return (
    <div style={{ height: 300 }}>
      <Canvas camera={{ position: [center + camDist * 0.5, camDist * 0.45, camDist * 0.8], fov: 40 }}>
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
          {info && (
            <>
              <mesh position={[info.cg, 0, 0]}>
                <sphereGeometry args={[markerR, 24, 24]} />
                <meshStandardMaterial color="#0b0b0b" />
              </mesh>
              <mesh position={[info.cp, 0, 0]}>
                <sphereGeometry args={[markerR, 24, 24]} />
                <meshStandardMaterial color="#e34948" />
              </mesh>
            </>
          )}
        </group>
        <OrbitControls target={[center, 0, 0]} enableDamping dampingFactor={0.1} />
      </Canvas>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0', textAlign: 'center' }}>
        drag to rotate · scroll to zoom · <span style={{ color: 'var(--text-primary)' }}>●</span> CG ·{' '}
        <span style={{ color: '#e34948' }}>●</span> CP
      </p>
    </div>
  );
}
