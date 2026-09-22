import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { clusterOffsets } from '../tree/cluster.js';
import { tubeFinRadius } from '../tree/tubefins.js';
import { arrowPan, wheelNotches } from '../chartPanZoom.js';
import { isAssembly, resolveAssemblyRadius, ringInstanceOffsets } from '../tree/assembly.js';
import { isConformal } from '../tree/shroud.js';
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

type Shape = (
  | { kind: 'circle'; y: number; z: number; r: number; fill: string; stroke: string; dash?: string; width?: number; title?: string }
  | { kind: 'fin'; y: number; z: number; angle: number; from: number; to: number; thick: number; fill: string; stroke: string; title?: string }
  /**
   * A camera shroud's cross-section (v0.088). Its own kind because a shroud is
   * the one surface part whose SEATING matters: `conformal` decides whether the
   * underside follows the tube's arc or lies flat on the tangent chord.
   *
   * This is the view where that shows. A flat-bottomed 25 mm shroud on a 24 mm
   * body tube stands 5.3 mm clear of the surface at each bottom corner — the
   * gap Eric described on 2026-08-31 — and the side view can never show it,
   * because a cylinder's generatrix is straight.
   */
  | { kind: 'shroud'; y: number; z: number; angle: number; baseR: number; height: number;
      width: number; conformal: boolean; fill: string; stroke: string; title?: string }
) & {
  /** React key, from the part's IDENTITY — see aftLayout's keyFor. */
  key: string;
};

/** Every shape of the cross-section, in its painter's layer, and how far out it reaches (m). */
export interface AftLayout {
  hulls: Shape[];
  inner: Shape[];
  outer: Shape[];
  extent: number;
}

/**
 * The aft view's cross-section: a pure walk of the tree at one roll angle.
 *
 * Pure so the view can memoise it on (tree, roll, motors) — the only inputs it
 * reads. It ran in the render body until audit 2026-09-22, so every pan move
 * and every wheel notch, which change nothing but the view transform, re-walked
 * the whole tree to rebuild identical shapes: jank on pods and clusters.
 */
export function aftLayout(
  tree: RocketTree, roll: number, motors?: Record<string, MotorDims>,
): AftLayout {
  // Painter's layers: hulls (opaque, big→small), then internals, then externals.
  const hulls: Shape[] = [];
  const inner: Shape[] = [];
  const outer: Shape[] = [];
  let extent = 0.02;

  const reach = (y: number, z: number, r: number) => {
    extent = Math.max(extent, Math.hypot(y, z) + r);
  };

  /**
   * A React key from the part's IDENTITY: its id (and which of its shapes
   * this is), numbered by occurrence when one part draws several — a fin set's
   * fins, a cluster's tubes, a pod's parts once per ring instance. The view
   * used one render-time counter shared by all three layers (audit
   * 2026-09-22), so adding one hull re-keyed every internal and external shape
   * after it, and React patched a circle's DOM node into a fin's.
   */
  const seen = new Map<string, number>();
  const keyFor = (n: ComponentNode, part = ''): string => {
    const base = `${n.id ?? n.type}${part}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return k === 0 ? base : `${base}#${k}`;
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
            key: keyFor(child), kind: 'fin', y: cy, z: cz, angle, from: pRadius, to: pRadius + span,
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
            key: keyFor(child), kind: 'circle', y: cy + d * Math.cos(angle), z: cz + d * Math.sin(angle), r: rt,
            fill: 'none', stroke: '#7a786f', title: `${child.name ?? 'Tube fins'} ×${count}`,
          });
        }
        reach(cy, cz, pRadius + 2 * rt);
      } else if (t === 'fairing') {
        // Shroud cross-section, at the angle it is actually mounted. This is
        // the view that answers "will a fin be in shot?", so it is the one
        // that has to place the shroud honestly.
        const wid = num(child, 'width', 0.025);
        const hgt = num(child, 'height', 0.02);
        outer.push({
          key: keyFor(child), kind: 'shroud', y: cy, z: cz, angle: num(child, 'angleOffset', 0) + roll,
          baseR: pRadius, height: hgt, width: wid, conformal: isConformal(child),
          fill: colorOf(child, '#c8c5be'), stroke: '#7a786f',
          title: child.name ?? 'Camera shroud',
        });
        reach(cy, cz, pRadius + hgt);
      } else if ((t as string) === 'protuberance') {
        // A drag bump, end-on: the frontal box it IS aerodynamically, `width`
        // across and `height` off the surface — the same box the 3D view
        // builds (pieces.ts) and the rectangle the rail button below already
        // uses. This view had no branch for it until audit 2026-09-22, so a
        // part the side and 3D views both drew was missing from this one.
        // `count` identical bumps have no positions of their own (the count
        // multiplies the drag, treeModel.protuberanceFrontalArea), so one
        // shape stands for them and the title carries the count, as a lug's
        // stacked line instances do.
        const wid = num(child, 'width', 0.02);
        const hgt = num(child, 'height', 0.01);
        const count = Math.max(1, Math.round(num(child, 'count', 1)));
        outer.push({
          key: keyFor(child), kind: 'shroud', y: cy, z: cz, angle: num(child, 'angleOffset', 0) + roll,
          baseR: pRadius, height: hgt, width: wid, conformal: false,
          fill: colorOf(child, '#c8c5be'), stroke: '#7a786f',
          title: `${child.name ?? 'Protuberance'}${count > 1 ? ` ×${count}` : ''}`,
        });
        reach(cy, cz, pRadius + hgt);
      } else if (t === 'launchlug' || t === 'railbutton') {
        // Angle 0 is the top of the side view, and the aft frame's +y is up,
        // so a lug at 0 draws at 12 o'clock here too — the two views agree.
        const a = num(child, 'angleOffset', 0) + roll;
        // Line instances stack in this end-on projection — one shape, so the
        // title carries the count instead.
        const stackTitle = `${child.name ?? t}${num(child, 'instanceCount', 1) > 1 ? ` ×${Math.round(num(child, 'instanceCount', 1))}` : ''}`;
        if (t === 'railbutton') {
          // END-ON, A BUTTON IS NOT A CIRCLE (v0.103). It is OD wide
          // tangentially and TOTAL HEIGHT tall radially, and those are two
          // different numbers — a 1515 button is 15.75 x 11.42 mm. Drawing a
          // circle of radius OD/2 centred at pRadius + OD/2 made the diameter
          // stand in for the height a third time (Rocket3D used a 9.7 mm
          // literal, TreeSchematic used 2 x radius), so the app showed three
          // different button heights in three views of one rocket. Reusing the
          // non-conformal shroud path is exactly the rectangle wanted: it runs
          // from the tube surface out to baseR + height with straight parallel
          // sides `width` apart. Fallbacks are the kernel constructor's
          // (RailButton.java:58-64), not the old 4 mm one.
          outer.push({
            key: keyFor(child), kind: 'shroud', y: cy, z: cz, angle: a, baseR: pRadius,
            height: num(child, 'totalHeight', 0.0097),
            width: num(child, 'outerDiameter', 0.0097),
            conformal: false,
            fill: colorOf(child, '#c8c5be'), stroke: '#7a786f', title: stackTitle,
          });
          reach(cy, cz, pRadius + num(child, 'totalHeight', 0.0097));
        } else {
          // A lug is a tube lying ON the surface: round end-on, and it stands
          // off by its own diameter.
          const r = num(child, 'outerRadius', 0.002);
          outer.push({
            key: keyFor(child), kind: 'circle',
            y: cy + (pRadius + r) * Math.cos(a), z: cz + (pRadius + r) * Math.sin(a), r,
            fill: colorOf(child, '#c8c5be'), stroke: '#7a786f', title: stackTitle,
          });
          reach(cy, cz, pRadius + 2 * r);
        }
      } else if (t === 'innertube') {
        const r = num(child, 'outerRadius', 0.0095);
        const offs = clusterOffsets(
          child['cluster'] as string | undefined, r,
          num(child, 'clusterScale', 1), num(child, 'clusterRotation', 0) + roll,
        );
        // A tube can also sit OFF the centreline on its own (OpenRocket's
        // radial position/direction). Desktop's "split cluster" makes each
        // motor tube exactly that, so without this a split cluster draws as
        // one stack of tubes on the axis. Angle 0 is +y, like everything else.
        const rp = num(child, 'radialPosition', 0);
        const rd = num(child, 'radialDirection', 0) + roll;
        const oy = rp * Math.cos(rd);
        const oz = rp * Math.sin(rd);
        const motor = child.id ? motors?.[child.id] : undefined;
        for (const off of offs) {
          inner.push({
            key: keyFor(child), kind: 'circle', y: cy + oy + off.y, z: cz + oz + off.z, r,
            fill: 'none', stroke: colorOf(child, '#9a978f'), dash: '3 2',
            title: child.name ?? 'Inner tube',
          });
          if (motor) {
            inner.push({
              key: keyFor(child, ':motor'), kind: 'circle', y: cy + oy + off.y, z: cz + oz + off.z, r: motor.diameter / 2,
              fill: '#8b5a2b', stroke: '#6b4520', title: 'Motor',
            });
          }
          reach(cy + oy + off.y, cz + oz + off.z, r);
        }
        walkChildren(child, r, cy + oy, cz + oz);
      } else if (t === 'tubecoupler' || t === 'centeringring' || t === 'engineblock' || t === 'bulkhead') {
        const r = Math.min(pRadius * 0.98, num(child, 'outerRadius', pRadius * 0.95));
        inner.push({
          key: keyFor(child), kind: 'circle', y: cy, z: cz, r,
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
        key: keyFor(n), kind: 'circle', y: cy, z: cz, r,
        fill: colorOf(n, '#e7e5e0'), stroke: '#7a786f', title: n.name ?? n.type,
      });
      reach(cy, cz, r);
      // Body-tube mounts (minimum/sub-minimum builds) draw their motor too —
      // previously only inner tubes did.
      if (n.type === 'bodytube' && n['motorMount'] === true) {
        const motor = n.id ? motors?.[n.id] : undefined;
        if (motor) {
          inner.push({
            key: keyFor(n, ':motor'), kind: 'circle', y: cy, z: cz, r: motor.diameter / 2,
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

  return { hulls, inner, outer, extent };
}

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
  // The zoom as last committed, so the wheel listener can tell BEFORE it
  // updates whether this notch zooms at all — effect-written, like eRef.
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      // Per NOTCH, not per event — see the same change on the 2D schematic.
      const stepK = (k0: number) => Math.min(12, Math.max(1, k0 * 1.15 ** wheelNotches(e)));
      // Swallow the wheel only when it zooms (audit 2026-09-22): at fit or at
      // 12x the unconditional preventDefault stopped the page scrolling with
      // the pointer over this drawing — the same fix as the 2D schematic's.
      if (stepK(zoomRef.current.k) === zoomRef.current.k) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const Ev = eRef.current;
      const vx = -Ev + ((e.clientX - rect.left) / rect.width) * 2 * Ev;
      const vy = -Ev + ((e.clientY - rect.top) / rect.height) * 2 * Ev;
      setZoom((z) => {
        const k = stepK(z.k);
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
  // Memoised on exactly what the walk reads (audit 2026-09-22): a pan move or a
  // wheel notch changes only `zoom`, and must not re-walk the tree.
  const { hulls, inner, outer, extent } = useMemo(
    () => aftLayout(tree, roll, motors), [tree, roll, motors]);

  const E = extent * 1.12;
  // Written in an EFFECT, not in the render body (2026-09-08 audit). A ref
  // assignment during render is undefined under StrictMode's double-render and
  // under concurrent rendering; the wheel handler reads this, so it has to be
  // current, but "current as of the last committed render" is what it actually
  // needs.
  useEffect(() => { eRef.current = E; }, [E]);
  const scale = 1; // viewBox is in meters — the SVG scales itself.
  const toSvg = (v: number) => v * scale;

  const drawShape = (s: Shape) => {
    if (s.kind === 'circle') {
      return (
        <circle key={s.key} cx={toSvg(s.z)} cy={-toSvg(s.y)} r={toSvg(s.r)}
          fill={s.fill} fillOpacity={s.fill === '#8b5a2b' ? 0.45 : undefined}
          stroke={s.stroke} strokeWidth={E / 220} strokeDasharray={s.dash
            ? s.dash.split(' ').map((d) => (Number(d) * E) / 110).join(' ')
            : undefined}>
          {s.title ? <title>{s.title}</title> : null}
        </circle>
      );
    }
    if (s.kind === 'shroud') {
      // A shroud spans a real ARC of the airframe, not a point on it. Half of
      // that arc is θ = asin(halfWidth / R), clamped — the app's own defaults
      // put halfWidth/R above 1, where an unclamped asin is NaN and the whole
      // element silently disappears (shroud.shroudHalfAngle).
      const outR = s.baseR + s.height;
      const P = (y: number, z: number) => `${toSvg(z)},${-toSvg(y)}`;
      const ca = Math.cos(s.angle);
      const sa = Math.sin(s.angle);
      // radial unit (ca, sa); tangential unit (−sa, ca).
      const pt = (r: number, off: number): [number, number] =>
        [s.y + r * ca - off * sa, s.z + r * sa + off * ca];
      // The same two shapes tree/shroudMesh.ts builds in 3D: STRAIGHT PARALLEL
      // SIDES and a flat top for both — that is what a real shroud is (the
      // owner photographed and measured his Inverted Pursuits housing after
      // the first cut of this drew splayed radial sides that read as a
      // trapezoid; docs/Camera Shrouds/) — differing only in the FLOOR:
      // conformal follows the tube's arc, flat rests on the tangent plane with
      // the crescent gap open at its corners. This is the only view that can
      // show any of that.
      let d: string;
      if (s.conformal) {
        // Side walls stand at lateral ±hw (clamped inside the tube — beyond
        // ±R there is nothing to conform to); the floor is the tube's own arc
        // between the wall feet, which sit at angle ±asin(hw/R) from the mount
        // line. Sweep flag: P() negates y, so screen-clockwise is INCREASING
        // model angle; the floor runs from the +hw foot back to the −hw foot
        // (decreasing angle) = sweep 0. Same derivation as v0.088's arcs,
        // checked numerically then, reused now.
        const hw = Math.min(s.width / 2, s.baseR * 0.98);
        const footY = Math.sqrt(Math.max(0, s.baseR * s.baseR - hw * hw));
        const corners = [pt(outR, -hw), pt(outR, hw), pt(footY, hw)];
        const [fy0, fz0] = pt(footY, -hw);
        d = 'M ' + corners.map(([y, z]) => P(y, z)).join(' L ')
          + ` A ${toSvg(s.baseR)} ${toSvg(s.baseR)} 0 0 0 ${P(fy0, fz0)} Z`;
      } else {
        const hw = Math.min(s.width / 2, s.baseR * 2);
        const corners = [pt(s.baseR, -hw), pt(outR, -hw), pt(outR, hw), pt(s.baseR, hw)];
        d = 'M ' + corners.map(([y, z]) => P(y, z)).join(' L ') + ' Z';
      }
      return (
        <path key={s.key} d={d} fill={s.fill} stroke={s.stroke} strokeWidth={E / 220}>
          {s.title ? <title>{s.title}</title> : null}
        </path>
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
      <polygon key={s.key}
        points={pts.map(([y, z]) => `${toSvg(z!)},${-toSvg(y!)}`).join(' ')}
        fill={s.fill} stroke={s.stroke} strokeWidth={E / 220}>
        {s.title ? <title>{s.title}</title> : null}
      </polygon>
    );
  };

  const toView = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      vx: -E + ((clientX - rect.left) / rect.width) * 2 * E,
      vy: -E + ((clientY - rect.top) / rect.height) * 2 * E,
    };
  };
  /**
   * Arrow keys pan a ZOOMED view a tenth of its width a press (audit
   * 2026-09-22) — the zoom buttons zoom about the axis, so without this a pod
   * or cluster tube off the centre left the view with no keyboard way back.
   * At fit there is nothing to pan (the pointer pan is off there too), and the
   * arrows go on scrolling the page.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const d = arrowPan(e.key);
    if (!d || zoom.k === 1) return;
    e.preventDefault();
    const step = 0.2 * E; // a tenth of the 2E-wide view
    setZoom((z) => ({ ...z, x: z.x + d[0] * step, y: z.y + d[1] * step }));
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
        // role="group", not "img" (2026-09-08 audit, same fix as
        // TreeSchematic.tsx:1499). Every shape below carries a <title> naming
        // the part — "Fins x3", "Motor", "Camera shroud" — and role="img" made
        // the entire subtree presentational, so none of them was exposed. The
        // one label then had to carry the whole view, and it named three
        // pointer gestures that have no keyboard equivalent. The keyboard path
        // is the labelled +/- and fit buttons beside the drawing, and — since
        // audit 2026-09-22, when this label still promised pan buttons that
        // never existed — the arrow keys on the focused drawing.
        role="group"
        tabIndex={0}
        aria-label="Aft end view, looking at the rocket from behind. Zoom with the buttons beside this drawing; once zoomed in, the arrow keys pan it."
        onKeyDown={onKeyDown}
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
          {hulls.map(drawShape)}
          {inner.map(drawShape)}
          {outer.map(drawShape)}
          {/* Center crosshair */}
          <line x1={-E * 0.05} y1={0} x2={E * 0.05} y2={0} stroke="#9a978f" strokeWidth={E / 300} />
          <line x1={0} y1={-E * 0.05} x2={0} y2={E * 0.05} stroke="#9a978f" strokeWidth={E / 300} />
        </g>
      </svg>
      <RollControl roll={roll} onRoll={setRoll} />
      {/* aria-label, not title alone: name-from-content wins over `title`, so
          these three announced as "plus sign button", "minus sign button" and
          "north east and south west arrow button". TreeSchematic's copies of
          the identical pair have carried aria-label since they were written. */}
      <div className="schematic-controls">
        <button title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.5)}>+</button>
        <button title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>−</button>
        <button title="Fit" aria-label="Fit the whole cross-section in view"
          onClick={() => setZoom({ k: 1, x: 0, y: 0 })}>⤢</button>
      </div>
    </div>
  );
}
