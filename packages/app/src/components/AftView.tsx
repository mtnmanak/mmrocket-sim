import { useEffect, useRef, useState } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { clusterOffsets } from '../tree/cluster.js';
import { tubeFinRadius } from '../tree/tubefins.js';
import { isAssembly, resolveAssemblyRadius, ringInstanceOffsets } from '../tree/assembly.js';
import { RollControl } from './RollControl.js';

/**
 * Aft end view — the rocket seen from behind (down the +X axis). This is the
 * only place cluster layouts, pod rings and fin counts are visible as they
 * really are: the side views project everything onto one plane. Edit cluster
 * layout/rotation/spacing in the motor dialog and watch this update; the roll
 * slider spins the whole cross-section.
 *
 * Convention: **+y UP, +z right** — the desktop's back view
 * (`FinSetShapes.makePolygonBack` plots `(a.z, a.y)`, and the figure mirrors
 * y upwards; 24.12). Angle 0 is +y for EVERYTHING, exactly as the kernel
 * places it: `FinSet.getInstanceOffsets` starts a fin at `Coordinate(0,
 * bodyRadius, 0)` and `RingInstanceable` starts a pod at `(r·cosθ, r·sinθ)`.
 *
 * Until v0.078 this frame was transposed (+y right, +z up) with a
 * compensating +π/2 on fin sets only, so fins came out straight up — correct
 * — while pods, clusters and the 3D view's fins disagreed with them by 90°.
 * A roll slider makes that disagreement visible on the first drag, so the
 * frame moved to the kernel's rather than the fins' fudge moving to the pods.
 */

interface MotorDims { length: number; diameter: number }

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

const colorOf = (n: ComponentNode, dflt: string): string =>
  typeof n['color'] === 'string' ? (n['color'] as string) : dflt;

type Shape =
  | { kind: 'circle'; y: number; z: number; r: number; fill: string; stroke: string; dash?: string; width?: number; title?: string }
  | { kind: 'fin'; y: number; z: number; angle: number; from: number; to: number; thick: number; fill: string; stroke: string; title?: string };

export function AftView({ tree, motors, roll: rollProp, onRoll }: {
  tree: RocketTree;
  /** Loaded motor dimensions per mount node id (real case sizes). */
  motors?: Record<string, MotorDims>;
  /**
   * Roll about the long axis (rad). Controlled-or-not, the same way
   * TreeSchematic takes it, so App can share ONE angle between the two views.
   */
  roll?: number;
  onRoll?: (rad: number) => void;
}) {
  const [rollLocal, setRollLocal] = useState(0);
  const roll = rollProp ?? rollLocal;
  const setRoll = onRoll ?? setRollLocal;
  // Zoom/pan in viewBox (meter) coordinates — same pattern as TreeSchematic
  // (issue 2026-08-05b #13: "the user needs to be able to zoom the aft view").
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const eRef = useRef(0.02);
  const pan = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const Ev = eRef.current;
      const vx = -Ev + ((e.clientX - rect.left) / rect.width) * 2 * Ev;
      const vy = -Ev + ((e.clientY - rect.top) / rect.height) * 2 * Ev;
      setZoom((z) => {
        const k = Math.min(12, Math.max(1, z.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (k === z.k) return z;
        const mx = (vx - z.x) / z.k;
        const my = (vy - z.y) / z.k;
        return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: vx - mx * k, y: vy - my * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);
  const zoomBy = (f: number) => setZoom((z) => {
    // About the viewBox origin — the rocket axis is always at (0,0) here.
    const k = Math.min(12, Math.max(1, z.k * f));
    return k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: z.x * (k / z.k), y: z.y * (k / z.k) };
  });
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
        for (const off of ringInstanceOffsets(count, podRadius, num(child, 'angleOffset', 0) + roll)) {
          walkChain(child.children ?? [], cy + off.y, cz + off.z);
        }
      } else if (t === 'trapezoidfinset' || t === 'ellipticalfinset' || t === 'freeformfinset') {
        const count = Math.max(1, Math.round(num(child, 'finCount', 3)));
        const span = finSpan(child);
        const thick = num(child, 'thickness', 0.003);
        for (let i = 0; i < count; i++) {
          // Angle 0 is +y — the kernel's own placement — and +y draws UP, so
          // an unrotated first fin still points straight up.
          const angle = num(child, 'rotation', 0) + roll + (2 * Math.PI * i) / count;
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
          const angle = num(child, 'rotation', 0) + roll + (2 * Math.PI * i) / count;
          const d = pRadius + rt;
          outer.push({
            kind: 'circle', y: cy + d * Math.cos(angle), z: cz + d * Math.sin(angle), r: rt,
            fill: 'none', stroke: '#7a786f', title: `${child.name ?? 'Tube fins'} ×${count}`,
          });
        }
        reach(cy, cz, pRadius + 2 * rt);
      } else if (t === 'fairing') {
        // Shroud cross-section at the top (radial angle not modeled).
        const wid = num(child, 'width', 0.025);
        const hgt = num(child, 'height', 0.02);
        outer.push({
          kind: 'fin', y: cy, z: cz, angle: 0, from: pRadius, to: pRadius + hgt,
          thick: wid, fill: colorOf(child, '#c8c5be'), stroke: '#7a786f',
          title: child.name ?? 'Camera shroud',
        });
        reach(cy, cz, pRadius + hgt);
      } else if (t === 'launchlug' || t === 'railbutton') {
        const r = t === 'railbutton' ? num(child, 'outerDiameter', 0.004) / 2 : num(child, 'outerRadius', 0.002);
        // Radial direction isn't modeled — shown at the right side, which is
        // +z in this frame. It does not roll, because there is no angle to roll.
        outer.push({
          kind: 'circle', y: cy, z: cz + pRadius + r, r,
          fill: colorOf(child, '#c8c5be'), stroke: '#7a786f', title: child.name ?? t,
        });
        reach(cy, cz, pRadius + 2 * r);
      } else if (t === 'innertube') {
        const r = num(child, 'outerRadius', 0.0095);
        const offs = clusterOffsets(
          child['cluster'] as string | undefined, r,
          num(child, 'clusterScale', 1), num(child, 'clusterRotation', 0) + roll,
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
      // Body-tube mounts (minimum/sub-minimum builds) draw their motor too —
      // previously only inner tubes did.
      if (n.type === 'bodytube' && n['motorMount'] === true) {
        const motor = n.id ? motors?.[n.id] : undefined;
        if (motor) {
          inner.push({
            kind: 'circle', y: cy, z: cz, r: motor.diameter / 2,
            fill: '#8b5a2b', stroke: '#6b4520', title: 'Motor',
          });
        }
      }
      walkChildren(n, r, cy, cz);
    }
  };

  walkChain(tree.components, 0, 0);

  // Big circles first so nested ones stay visible.
  hulls.sort((a, b) => (b.kind === 'circle' ? b.r : 0) - (a.kind === 'circle' ? a.r : 0));

  const E = extent * 1.12;
  eRef.current = E;
  const scale = 1; // viewBox is in meters — the SVG scales itself.
  const toSvg = (v: number) => v * scale;

  const drawShape = (s: Shape, i: number) => {
    if (s.kind === 'circle') {
      return (
        <circle key={i} cx={toSvg(s.z)} cy={-toSvg(s.y)} r={toSvg(s.r)}
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
        points={pts.map(([y, z]) => `${toSvg(z!)},${-toSvg(y!)}`).join(' ')}
        fill={s.fill} stroke={s.stroke} strokeWidth={E / 220}>
        {s.title ? <title>{s.title}</title> : null}
      </polygon>
    );
  };

  let i = 0;
  const toView = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      vx: -E + ((clientX - rect.left) / rect.width) * 2 * E,
      vy: -E + ((clientY - rect.top) / rect.height) * 2 * E,
    };
  };
  return (
    <div style={{ position: 'relative' }}>
      {/* className marks this svg as METER-scaled: its viewBox spans ~0.4
          units, so any CSS stroke-width in "px" is really meters and floods
          the drawing — the Daylight black-box bug (owner report 2026-08-29).
          styles.css scopes its stroke-width bump to :not(.aft-svg). */}
      <svg ref={svgRef} className="aft-svg" viewBox={`${-E} ${-E} ${2 * E} ${2 * E}`}
        style={{ width: '100%', height: 'auto', maxHeight: 360, display: 'block',
          touchAction: 'none', cursor: zoom.k > 1 ? 'grab' : undefined }}
        role="img" aria-label="Aft end view — looking at the rocket from behind; wheel to zoom, drag to pan, roll with the slider"
        onPointerDown={(e) => {
          if (zoom.k === 1) return;
          const { vx, vy } = toView(e.clientX, e.clientY);
          pan.current = { px: vx, py: vy, x: zoom.x, y: zoom.y };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          // Capture the pan state NOW: setZoom's updater runs after this
          // handler returns, and a pointer-up in between nulls pan.current —
          // reading it inside the updater crashed the app (live report,
          // "Cannot read properties of null (reading 'x')").
          const p = pan.current;
          if (!p || !svgRef.current) return;
          const { vx, vy } = toView(e.clientX, e.clientY);
          setZoom((z) => ({ ...z, x: p.x + (vx - p.px), y: p.y + (vy - p.py) }));
        }}
        onPointerUp={() => { pan.current = null; }}
        onPointerLeave={() => { pan.current = null; }}>
        <g transform={`translate(${zoom.x} ${zoom.y}) scale(${zoom.k})`}>
          {hulls.map((s) => drawShape(s, i++))}
          {inner.map((s) => drawShape(s, i++))}
          {outer.map((s) => drawShape(s, i++))}
          {/* Center crosshair */}
          <line x1={-E * 0.05} y1={0} x2={E * 0.05} y2={0} stroke="#9a978f" strokeWidth={E / 300} />
          <line x1={0} y1={-E * 0.05} x2={0} y2={E * 0.05} stroke="#9a978f" strokeWidth={E / 300} />
        </g>
      </svg>
      <RollControl roll={roll} onRoll={setRoll} />
      <div className="schematic-controls">
        <button title="Zoom in" onClick={() => zoomBy(1.5)}>+</button>
        <button title="Zoom out" onClick={() => zoomBy(1 / 1.5)}>−</button>
        <button title="Fit" onClick={() => setZoom({ k: 1, x: 0, y: 0 })}>⤢</button>
      </div>
    </div>
  );
}
