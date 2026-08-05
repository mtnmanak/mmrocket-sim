import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { clusterOffsets } from '../tree/cluster.js';
import { tubeFinRadius } from '../tree/tubefins.js';
import { isAssembly, resolveAssemblyRadius, ringInstanceOffsets } from '../tree/assembly.js';

/**
 * Aft end view — the rocket seen from behind (down the +X axis). This is the
 * only place cluster layouts, pod rings and fin counts are visible as they
 * really are: the side views project everything onto one plane. Pure display,
 * no interaction (edit cluster layout/rotation/spacing in the motor dialog and
 * watch this update).
 *
 * Convention: +y right, +z up — matching the kernel's cross-section frame
 * (cluster offsets and pod ring offsets are already {y,z} in that frame).
 */

interface MotorDims { length: number; diameter: number }

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

const colorOf = (n: ComponentNode, dflt: string): string =>
  typeof n['color'] === 'string' ? (n['color'] as string) : dflt;

type Shape =
  | { kind: 'circle'; y: number; z: number; r: number; fill: string; stroke: string; dash?: string; width?: number; title?: string }
  | { kind: 'fin'; y: number; z: number; angle: number; from: number; to: number; thick: number; fill: string; stroke: string; title?: string };

export function AftView({ tree, motors }: {
  tree: RocketTree;
  /** Loaded motor dimensions per mount node id (real case sizes). */
  motors?: Record<string, MotorDims>;
}) {
  // Painter's layers: hulls (opaque, big→small), then internals, then externals.
  const hulls: Shape[] = [];
  const inner: Shape[] = [];
  const outer: Shape[] = [];
  let extent = 0.02;

  const reach = (y: number, z: number, r: number) => {
    extent = Math.max(extent, Math.hypot(y, z) + r);
  };

  const finSpan = (n: ComponentNode): number => {
    if (n.type === 'freeformfinset') {
      const pts = n['points'];
      if (Array.isArray(pts) && pts.length > 0) {
        return Math.max(0, ...pts.map((p) => (Array.isArray(p) ? Number(p[1]) || 0 : 0)));
      }
    }
    return num(n, 'height', 0.03);
  };

  const walkChildren = (parent: ComponentNode, pRadius: number, cy: number, cz: number) => {
    for (const child of parent.children ?? []) {
      const t = child.type;
      if (isAssembly(t)) {
        const podRadius = resolveAssemblyRadius(child, pRadius);
        const count = Math.max(1, Math.round(num(child, 'instanceCount', 2)));
        for (const off of ringInstanceOffsets(count, podRadius, num(child, 'angleOffset', 0))) {
          walkChain(child.children ?? [], cy + off.y, cz + off.z);
        }
      } else if (t === 'trapezoidfinset' || t === 'ellipticalfinset' || t === 'freeformfinset') {
        const count = Math.max(1, Math.round(num(child, 'finCount', 3)));
        const span = finSpan(child);
        const thick = num(child, 'thickness', 0.003);
        for (let i = 0; i < count; i++) {
          // First fin straight up, like the desktop's rear view.
          const angle = Math.PI / 2 + (2 * Math.PI * i) / count;
          outer.push({
            kind: 'fin', y: cy, z: cz, angle, from: pRadius, to: pRadius + span,
            thick, fill: colorOf(child, '#b9b7b0'), stroke: '#7a786f',
            title: `${child.name ?? 'Fins'} ×${count}`,
          });
        }
        reach(cy, cz, pRadius + span);
      } else if (t === 'tubefinset') {
        const count = Math.max(1, Math.round(num(child, 'finCount', 6)));
        const rt = tubeFinRadius(child, pRadius);
        for (let i = 0; i < count; i++) {
          const angle = Math.PI / 2 + (2 * Math.PI * i) / count;
          const d = pRadius + rt;
          outer.push({
            kind: 'circle', y: cy + d * Math.cos(angle), z: cz + d * Math.sin(angle), r: rt,
            fill: 'none', stroke: '#7a786f', title: `${child.name ?? 'Tube fins'} ×${count}`,
          });
        }
        reach(cy, cz, pRadius + 2 * rt);
      } else if (t === 'launchlug' || t === 'railbutton') {
        const r = t === 'railbutton' ? num(child, 'outerDiameter', 0.004) / 2 : num(child, 'outerRadius', 0.002);
        // Radial direction isn't modeled — shown at the right side.
        outer.push({
          kind: 'circle', y: cy + pRadius + r, z: cz, r,
          fill: colorOf(child, '#c8c5be'), stroke: '#7a786f', title: child.name ?? t,
        });
        reach(cy, cz, pRadius + 2 * r);
      } else if (t === 'innertube') {
        const r = num(child, 'outerRadius', 0.0095);
        const offs = clusterOffsets(
          child['cluster'] as string | undefined, r,
          num(child, 'clusterScale', 1), num(child, 'clusterRotation', 0),
        );
        const motor = child.id ? motors?.[child.id] : undefined;
        for (const off of offs) {
          inner.push({
            kind: 'circle', y: cy + off.y, z: cz + off.z, r,
            fill: 'none', stroke: colorOf(child, '#9a978f'), dash: '3 2',
            title: child.name ?? 'Inner tube',
          });
          if (motor) {
            inner.push({
              kind: 'circle', y: cy + off.y, z: cz + off.z, r: motor.diameter / 2,
              fill: '#8b5a2b', stroke: '#6b4520', title: 'Motor',
            });
          }
          reach(cy + off.y, cz + off.z, r);
        }
        walkChildren(child, r, cy, cz);
      } else if (t === 'tubecoupler' || t === 'centeringring' || t === 'engineblock' || t === 'bulkhead') {
        const r = Math.min(pRadius * 0.98, num(child, 'outerRadius', pRadius * 0.95));
        inner.push({
          kind: 'circle', y: cy, z: cz, r,
          fill: 'none', stroke: colorOf(child, '#9a978f'), dash: '2 3',
          title: child.name ?? t,
        });
      }
      // parachute/streamer/shockcord/mass: no meaningful cross-section here.
    }
  };

  const walkChain = (nodes: ComponentNode[], cy: number, cz: number) => {
    for (const n of nodes) {
      if (n.type === 'stage') {
        walkChain(n.children ?? [], cy, cz);
        continue;
      }
      const r = Math.max(num(n, 'outerRadius', 0), num(n, 'aftRadius', 0), num(n, 'foreRadius', 0));
      if (r <= 0) continue;
      hulls.push({
        kind: 'circle', y: cy, z: cz, r,
        fill: colorOf(n, '#e7e5e0'), stroke: '#7a786f', title: n.name ?? n.type,
      });
      reach(cy, cz, r);
      walkChildren(n, r, cy, cz);
    }
  };

  walkChain(tree.components, 0, 0);

  // Big circles first so nested ones stay visible.
  hulls.sort((a, b) => (b.kind === 'circle' ? b.r : 0) - (a.kind === 'circle' ? a.r : 0));

  const E = extent * 1.12;
  const scale = 1; // viewBox is in meters — the SVG scales itself.
  const toSvg = (v: number) => v * scale;

  const drawShape = (s: Shape, i: number) => {
    if (s.kind === 'circle') {
      return (
        <circle key={i} cx={toSvg(s.y)} cy={-toSvg(s.z)} r={toSvg(s.r)}
          fill={s.fill} fillOpacity={s.fill === '#8b5a2b' ? 0.45 : undefined}
          stroke={s.stroke} strokeWidth={E / 220} strokeDasharray={s.dash
            ? s.dash.split(' ').map((d) => (Number(d) * E) / 110).join(' ')
            : undefined}>
          {s.title ? <title>{s.title}</title> : null}
        </circle>
      );
    }
    // Fin: a radial rectangle from `from` to `to` at `angle`, `thick` wide.
    const cos = Math.cos(s.angle);
    const sin = Math.sin(s.angle);
    const ny = -sin; // unit normal in the cross-section plane
    const nz = cos;
    const h = s.thick / 2;
    const pts = [
      [s.y + s.from * cos + ny * h, s.z + s.from * sin + nz * h],
      [s.y + s.to * cos + ny * h, s.z + s.to * sin + nz * h],
      [s.y + s.to * cos - ny * h, s.z + s.to * sin - nz * h],
      [s.y + s.from * cos - ny * h, s.z + s.from * sin - nz * h],
    ];
    return (
      <polygon key={i}
        points={pts.map(([y, z]) => `${toSvg(y!)},${-toSvg(z!)}`).join(' ')}
        fill={s.fill} stroke={s.stroke} strokeWidth={E / 220}>
        {s.title ? <title>{s.title}</title> : null}
      </polygon>
    );
  };

  let i = 0;
  return (
    <svg viewBox={`${-E} ${-E} ${2 * E} ${2 * E}`}
      style={{ width: '100%', height: 'auto', maxHeight: 360, display: 'block' }}
      role="img" aria-label="Aft end view — looking at the rocket from behind">
      {hulls.map((s) => drawShape(s, i++))}
      {inner.map((s) => drawShape(s, i++))}
      {outer.map((s) => drawShape(s, i++))}
      {/* Center crosshair */}
      <line x1={-E * 0.05} y1={0} x2={E * 0.05} y2={0} stroke="#9a978f" strokeWidth={E / 300} />
      <line x1={0} y1={-E * 0.05} x2={0} y2={E * 0.05} stroke="#9a978f" strokeWidth={E / 300} />
    </svg>
  );
}
