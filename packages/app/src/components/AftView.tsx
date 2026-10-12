import { useEffect, useMemo, useRef, useState } from 'react';
import type { RocketTree } from '@online-openrocket/engine';
import { arrowPan, releasedDuring, startsGesture, wheelNotches } from '../chartPanZoom.js';
import { shroudHalfWidth } from '../tree/shroud.js';
import { aftLayout, type MotorDims, type Shape } from '../tree/aftLayout.js';
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

/** Square viewBox with the SVG default xMidYMid meet letterboxing. */
function clientToView(svg: SVGSVGElement, clientX: number, clientY: number, extent: number) {
  const rect = svg.getBoundingClientRect();
  const scale = 2 * extent / Math.min(rect.width, rect.height);
  return {
    vx: (clientX - rect.left - rect.width / 2) * scale,
    vy: (clientY - rect.top - rect.height / 2) * scale,
  };
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
  /** The pan in progress, and the pointer that owns it (see endPan). */
  const pan = useRef<{ px: number; py: number; x: number; y: number; pointerId: number } | null>(null);
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
      const { vx, vy } = clientToView(svg, e.clientX, e.clientY, eRef.current);
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
      // A shroud spans a real ARC of the airframe, not a point on it, and the
      // app's own defaults make it wider than its tube: its half-width is
      // clamped (shroud.shroudHalfWidth, the one the 3D mesh uses) or the
      // conformal floor's √(R²−hw²) is NaN and the whole element silently
      // disappears.
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
        const hw = shroudHalfWidth(s.baseR, s.width, true);
        const footY = Math.sqrt(Math.max(0, s.baseR * s.baseR - hw * hw));
        const corners = [pt(outR, -hw), pt(outR, hw), pt(footY, hw)];
        const [fy0, fz0] = pt(footY, -hw);
        d = 'M ' + corners.map(([y, z]) => P(y, z)).join(' L ')
          + ` A ${toSvg(s.baseR)} ${toSvg(s.baseR)} 0 0 0 ${P(fy0, fz0)} Z`;
      } else {
        const hw = shroudHalfWidth(s.baseR, s.width, false);
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
    return clientToView(svgRef.current!, clientX, clientY, E);
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
  /**
   * Ends the pan its OWN pointer started — a second finger lifting, leaving or
   * being cancelled must not end the first finger's (TreeSchematic's endDrag).
   * The capture is taken once, on press, and never moved, so a lost capture is
   * a real end of the gesture here, not the side view's hand-off.
   */
  const endPan = (e: React.PointerEvent) => {
    if (pan.current?.pointerId === e.pointerId) pan.current = null;
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
        // TreeSchematic's interactive <svg> `role`). Every shape below carries a <title> naming
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
        // THE SIDE VIEW'S GESTURE RULES (seam review of audit 2026-09-22):
        // only a primary press of the primary pointer pans, only that pointer
        // drives it, and a move with the button up is a release this view
        // never saw. The audit gave TreeSchematic all three and left this pan
        // following a right-press (glued to a bare mouse once macOS's context
        // menu ate the release) and a second finger.
        onPointerDown={(e) => {
          if (zoom.k === 1 || !startsGesture(e)) return;
          const { vx, vy } = toView(e.clientX, e.clientY);
          pan.current = { px: vx, py: vy, x: zoom.x, y: zoom.y, pointerId: e.pointerId };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          // Capture the pan state NOW: setZoom's updater runs after this
          // handler returns, and a pointer-up in between nulls pan.current —
          // reading it inside the updater crashed the app (live report,
          // "Cannot read properties of null (reading 'x')").
          const p = pan.current;
          if (!p || !svgRef.current || e.pointerId !== p.pointerId) return;
          if (releasedDuring(e)) { pan.current = null; return; }
          const { vx, vy } = toView(e.clientX, e.clientY);
          setZoom((z) => ({ ...z, x: p.x + (vx - p.px), y: p.y + (vy - p.py) }));
        }}
        onPointerUp={endPan}
        onPointerLeave={endPan}
        onPointerCancel={endPan}
        onLostPointerCapture={endPan}>
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
