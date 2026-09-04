import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { RocketTree, StaticInfo } from '@online-openrocket/engine';
import { buildPieces, type MotorDims, type Piece } from '../tree/pieces.js';
import {
  downloadBlob, IMAGE_FORMAT_EXT, snapshotWithHeader,
  type ExportData, type ImageFormat,
} from '../services/schematicExport.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import {
  formatStability, hasAerodynamicForce, shownCp, shownStability, stabilityState,
  type StabilityState, type StabilityUnit,
} from '../services/simReport.js';
import { stabilityReadout } from './stabilityWording.js';
import { ImageExportMenu, type ImageExportOptions } from './ImageExportMenu.js';

/**
 * 3D rocket view (react-three-fiber). Geometry is generated from the
 * component tree: lathe profiles for nose cones and transitions (kernel-exact
 * shape math), cylinders for tubes, extruded shapes for fins placed at their
 * instance angles. The external shell is slightly translucent so motor mounts
 * and loaded motors read inside (S5), and a floating CG/CP callout hangs
 * beside the hull (2026-08-21c).
 * Rocket axis = +X (nose tip at x=0, aft increasing), matching the engine.
 *
 * THE GEOMETRY ITSELF LIVES IN `tree/pieces.ts`, not here. It is shared with
 * File > Save STL and the OBJ/glTF exporters, none of which mount a canvas —
 * leaving it in this module made those three paths download @react-three/fiber
 * and @react-three/drei (3.6 MB) to write a file. The re-exports below keep
 * the old import path working while callers move.
 */

/** One size rule for the on-axis marker spheres AND the callout gadget. */
const markerRadius = (totalLen: number, maxR: number): number =>
  Math.max(totalLen * 0.015, maxR * 0.35);

// DARK-theme status hexes on purpose: the 3D background is the dusk gradient
// in both themes, so the dark-theme inks are the legible set here.
const MARGIN_COLOR: Record<StabilityState, string> = {
  ok: '#4dbd4d', over: '#e0a53d', under: '#f0716f',
};

export interface CalloutGadget {
  /** Radial (z) offset of the gadget column, clear of the hull. */
  off: number;
  /** Gadget sphere radius — smaller than the on-axis markers. */
  r: number;
  cg: { pos: [number, number, number]; text: string; color: string };
  cp: { pos: [number, number, number]; text: string; color: string };
  /** Margin readout between the spheres; null when stability is unknown. */
  margin: { pos: [number, number, number]; text: string; color: string } | null;
}

/**
 * Floating CG/CP callout beside the rocket (the owner, 2026-08-21c: "RocketForge
 * also uses callouts in 3D and it looks slick"): the two spheres sit at the
 * TRUE axial stations, offset radially clear of the hull, with the static
 * margin between them. Pure so the numbers are provable — the R3F canvas
 * cannot mount in tests.
 */
/**
 * Which of the 3D view's two marker systems to draw. Pure and exported
 * because the R3F canvas cannot be mounted in this test environment (see the
 * note at the top of this file) — the decision is testable, the scene is not.
 *
 * Absent means BOTH: a stored preferences blob written before this existed
 * must keep the view it has always had.
 */
export function markerVisibility(pref: string | undefined): { axis: boolean; callout: boolean } {
  switch (pref) {
    case 'off': return { axis: false, callout: false };
    case 'axis': return { axis: true, callout: false };
    case 'callout': return { axis: false, callout: true };
    default: return { axis: true, callout: true };
  }
}

export function calloutGadget(
  info: StaticInfo | null,
  maxR: number,
  totalLen: number,
  stabilityUnit: StabilityUnit = 'cal',
): CalloutGadget | null {
  if (!info || !Number.isFinite(info.cg) || !Number.isFinite(info.cp)) return null;
  const markerR = markerRadius(totalLen, maxR);
  const off = maxR + markerR * 2.2;
  // No aerodynamic normal force -> no meaningful CP to mark. See
  // hasAerodynamicForce; the kernel reports cp 0 there, which would draw the
  // marker on the nose tip as though that were a measurement.
  const state = hasAerodynamicForce(info) ? stabilityState(shownStability(info)) : null;
  return {
    off,
    r: markerR * 0.55,
    cg: { pos: [info.cg, 0, off], text: 'CG', color: '#e9edf1' },
    cp: { pos: [shownCp(info), 0, off], text: 'CP', color: '#e34948' },
    // Glyph and word, not colour alone — the same string the 2D schematic
    // builds (TreeSchematic's marginText). `formatStability` returns a bare
    // number ("1.85 cal", or a percentage), so before v0.105 the whole
    // under/over/ok verdict rode on MARGIN_COLOR and vanished for a
    // colour-blind reader. See components/stabilityWording.ts.
    margin: state === null ? null : {
      pos: [(info.cg + shownCp(info)) / 2, 0, off],
      text: stabilityReadout(state, formatStability(info, stabilityUnit)),
      color: MARGIN_COLOR[state],
    },
  };
}

/**
 * World-space bounds of the rendered rocket, straight off the Piece list.
 * `Box3.setFromObject(scene)` would also work, but the pieces ARE what the
 * scene is built from, so this needs no world matrices to be up to date, is
 * deterministic outside a mounted canvas (hence testable), and leaves out the
 * CG/CP marker spheres — annotations, not rocket. Pieces carrying a bake-in
 * transform already have it applied to their geometry; the rest get their
 * position/rotation applied here as T·R, exactly as <mesh> composes it. A
 * rotated piece contributes the AABB of its rotated box: conservative, so the
 * framing can only ever be roomy, never clipped.
 */
export function piecesBounds(pieces: Piece[]): THREE.Box3 {
  const box = new THREE.Box3();
  const one = new THREE.Box3();
  for (const p of pieces) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
    if (!p.geometry.boundingBox) continue;
    one.copy(p.geometry.boundingBox);
    if (p.position || p.rotation) {
      const r = p.rotation ?? [0, 0, 0];
      const t = p.position ?? [0, 0, 0];
      one.applyMatrix4(new THREE.Matrix4()
        .makeRotationFromEuler(new THREE.Euler(r[0], r[1], r[2]))
        .setPosition(t[0], t[1], t[2]));
    }
    box.union(one);
  }
  return box;
}

/**
 * Is `box` safe to aim a camera at? `!box.isEmpty()` is NOT enough on its own.
 * `Box3.isEmpty()` is `max.x < min.x || max.y < min.y || max.z < min.z`, and
 * every comparison involving NaN is false — so a box poisoned by a NaN
 * dimension cheerfully reports itself NON-empty and walks straight into the
 * fit. One NaN field on one component is all it takes (a nosecone `length` of
 * NaN reaches the lathe profile, the geometry's bounding box, then this union),
 * and the payoff is a NaN camera position, a NaN centre, and a blank export
 * with nothing logged. Demand six finite components; the caller then falls back
 * to the live camera, which is precisely the un-fitted export the user got
 * before auto-fit existed.
 */
export function isFittableBox(box: THREE.Box3): boolean {
  return !box.isEmpty() && [
    box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z,
  ].every((v) => Number.isFinite(v));
}

/** Breathing room around the fitted subject — 6 % keeps the nose tip and the
 *  fin tips off the border without visibly wasting frame. */
export const FIT_MARGIN = 1.06;
/** Fallback distance for a degenerate (empty/zero-size) box: any finite,
 *  non-zero number will do — the point is that no NaN/Infinity reaches the
 *  camera, which would blank the export. */
const MIN_FIT_DIST = 1e-3;

/**
 * Reframe a camera so `box` fills the frame, KEEPING the caller's viewing
 * direction — only distance and target move, so a user who rotated to a
 * three-quarter view gets that same view, filled.
 *
 * Extracted as a pure function because the R3F canvas cannot be mounted
 * headlessly here (this @react-three/fiber v8 build does not expose
 * canvas.__r3f, and monkeypatching rAF breaks its mounting), so this is where
 * the export framing is actually proven.
 *
 * @param direction where the camera LOOKS (camera → subject), i.e. exactly
 *                  what `camera.getWorldDirection()` returns.
 * @param aspect    the EXPORT aspect (width/height), not the on-screen one.
 */
export function fitCameraToBox(
  box: THREE.Box3,
  direction: THREE.Vector3,
  fovDeg: number,
  aspect: number,
  margin: number = FIT_MARGIN,
  up: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
): { position: THREE.Vector3; target: THREE.Vector3 } {
  const target = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);

  // Camera-space basis. `back` runs subject → camera, so the returned position
  // is target + back·dist and the view direction survives bit-exactly.
  const back = new THREE.Vector3().copy(direction).negate();
  if (!Number.isFinite(back.lengthSq()) || back.lengthSq() === 0) back.set(0, 0, 1);
  back.normalize();
  const upv = new THREE.Vector3().copy(up);
  if (!Number.isFinite(upv.lengthSq()) || upv.lengthSq() === 0) upv.set(0, 1, 0);
  // Dead overhead (view parallel to `up`): the cross degenerates, and whatever
  // basis we invent here is a GUESS about roll around the view axis. It has to
  // be the same guess three makes, because exportCamera feeds this position to
  // `cam.lookAt(target)` and Matrix4.lookAt does NOT substitute an axis — it
  // nudges its own z (our `back`) by 1e-4 and re-crosses. Substituting (1,0,0)
  // gave a basis rotated 90° from the camera that actually renders, so a
  // straight-down view measured the rocket's LENGTH as frame height and its
  // diameter as frame width — exactly backwards, and the fit was sized to the
  // wrong pair. Mirror three's nudge instead (`=== 0` is three's own test, so
  // the two agree on WHEN to nudge as well as HOW), then derive `right` the
  // normal way. Nudging `back` — not `right` — is what makes this airtight:
  // the returned position lies along the NUDGED axis, so lookAt sees a
  // non-degenerate case, skips its own nudge, and rebuilds this very basis.
  const right = new THREE.Vector3().crossVectors(upv, back);
  if (right.lengthSq() === 0) {
    if (Math.abs(upv.z) === 1) back.x += 1e-4; else back.z += 1e-4;
    back.normalize();
    right.crossVectors(upv, back);
  }
  right.normalize();
  const trueUp = new THREE.Vector3().crossVectors(back, right).normalize();

  // Support function of an AABB along an axis: the box's half-extent as seen
  // along that axis, whatever the viewing angle.
  const extent = (a: THREE.Vector3) =>
    Math.abs(half.x * a.x) + Math.abs(half.y * a.y) + Math.abs(half.z * a.z);

  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
  const m = Number.isFinite(margin) && margin > 0 ? margin : 1;
  // Fit CORNER BY CORNER, not extent-plus-extent. A corner sitting at
  // camera-space (u, v, w) — w measured along `back`, i.e. TOWARDS the lens —
  // is in frame when m·|u| <= tan·aspect·(d − w) and m·|v| <= tan·(d − w),
  // so that one corner demands
  //     d >= max( m·|u|/(tan·aspect), m·|v|/tan ) + w
  // and the fit is the max of that over all eight. The horizontal half-angle
  // is the vertical one WIDENED by the aspect ratio, hence the /aspect on the
  // width term: a rocket is long and thin, so it is nearly always width that
  // wins, and using the height term alone is what chops the nose and the fins
  // off a 16:9 export.
  //
  // The previous form — max(widthTerm, heightTerm) + halfD — summed two maxima
  // that are reached at DIFFERENT corners: the widest corner is rarely the
  // nearest one, so it charged the full depth to a corner that does not have
  // it. On a stubby subject the slack swamps the fit: a 0.37 m rocket of
  // maxR 0.05 on a 16:9 panel came out framed SMALLER than with no fit at all
  // (0.83 of frame vs 0.91), and the fit is ON by default, so that was a
  // straight downgrade for every short design. The per-corner max is the exact
  // bound — every corner satisfied, at least one tight against the edge.
  const rel = new THREE.Vector3();
  let raw = 0;
  for (let i = 0; i < 8; i++) {
    // Corners as centre ± half, not box.min/max: an EMPTY Box3 carries
    // ±Infinity extremes but reports a (0,0,0) size, so going through `half`
    // keeps this loop finite and lets the degenerate guard below do its job.
    rel.set(i & 1 ? half.x : -half.x, i & 2 ? half.y : -half.y, i & 4 ? half.z : -half.z);
    const u = rel.dot(right), v = rel.dot(trueUp), w = rel.dot(back);
    raw = Math.max(raw, Math.max(
      (m * Math.abs(u)) / (tanHalfFov * aspect),
      (m * Math.abs(v)) / tanHalfFov,
    ) + w);
  }
  const dist = Number.isFinite(raw) && raw > 0 ? raw : Math.max(extent(back), MIN_FIT_DIST);

  return { position: new THREE.Vector3().copy(target).addScaledVector(back, dist), target };
}

/**
 * A throwaway camera that frames `box` the way `src` is currently looking.
 * Kept out of the snapshot handler so the whole export view — framing AND
 * clipping planes — is provable without a mounted canvas.
 */
export function exportCamera(
  box: THREE.Box3, src: THREE.PerspectiveCamera, aspect: number,
): THREE.PerspectiveCamera {
  const { position, target } = fitCameraToBox(
    box, src.getWorldDirection(new THREE.Vector3()), src.fov, aspect, FIT_MARGIN, src.up);
  const cam = new THREE.PerspectiveCamera(src.fov, aspect);
  cam.up.copy(src.up);
  cam.position.copy(position);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  // Near/far must bracket the subject at its NEW distance: fitting a small
  // rocket pulls the camera well inside the live camera's 0.1 m default near
  // plane, which would export an empty frame. Camera space looks down -Z, so
  // the box's z range there is exactly the depth span to cover.
  const view = box.clone().applyMatrix4(cam.matrixWorldInverse);
  cam.near = Math.max(1e-4, -view.max.z * 0.9);
  cam.far = Math.max(cam.near * 16, -view.min.z * 1.1);
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * Canvas-texture for a billboard label. Drawn at 3× the nominal glyph size so
 * it stays devicePixel-sharp when zoomed; the thin dark outline keeps the ink
 * legible over the light band of the dusk background.
 */
function labelTexture(text: string, color: string): { texture: THREE.CanvasTexture; aspect: number } {
  const px = 96;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `700 ${px}px system-ui, 'Segoe UI', sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + px * 0.3);
  const h = Math.ceil(px * 1.25);
  canvas.width = w;
  canvas.height = h; // resizing resets the 2D context state — restyle below
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * 0.14;
  ctx.strokeStyle = 'rgba(10, 15, 22, 0.9)';
  ctx.strokeText(text, px * 0.15, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, px * 0.15, h / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: w / h };
}

/**
 * Billboard text beside a gadget sphere. The sprite `center` shifts it in
 * SCREEN space by `gap` (world units), so every label hangs the same distance
 * from its anchor at any camera angle — a world-space offset would swing
 * around with the orbit. `place` splits the three labels vertically: CG and
 * CP sit almost on one line, so hanging all three to the right piles them up
 * exactly when the margin is small — the case that matters most.
 */
function CalloutLabel({ text, color, position, height, gap, place = 'right' }: {
  text: string; color: string; position: [number, number, number];
  height: number; gap: number; place?: 'right' | 'above' | 'below';
}) {
  const { texture, aspect } = useMemo(() => labelTexture(text, color), [text, color]);
  // The JSX-declared material is R3F-disposed on unmount; its map is ours.
  useEffect(() => () => texture.dispose(), [texture]);
  const center = useMemo(
    () => place === 'above' ? new THREE.Vector2(0.5, -(gap / height))
      : place === 'below' ? new THREE.Vector2(0.5, 1 + gap / height)
      : new THREE.Vector2(-(gap / (height * aspect)), 0.5),
    [place, gap, height, aspect]);
  return (
    <sprite position={position} scale={[height * aspect, height, 1]}
      center={center} renderOrder={13}>
      <spriteMaterial map={texture} depthTest={false} transparent />
    </sprite>
  );
}

export function Rocket3D({ tree, info, motors, exportData }: {
  tree: RocketTree;
  info: StaticInfo | null;
  /** Loaded motor cases keyed by mount node id — rendered seated at the
   *  mount's aft end, showing through the translucent shell (S5). */
  motors?: MotorDims;
  /** When set, a 📷 PNG snapshot button appears (issue 2026-08-11a). */
  exportData?: Omit<ExportData, 'spanM'>;
}) {
  const { prefs, setPrefs } = usePrefs();
  const markers = markerVisibility(prefs.markers3d);
  const { pieces, totalLen, maxR } = useMemo(() => buildPieces(tree, motors), [tree, motors]);
  const r3f = useRef<{ gl: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera } | null>(null);

  // Hi-res snapshot (issue 2026-08-11b): re-render the SAME scene/camera at
  // the export width (updateStyle=false keeps the on-screen CSS size), grab
  // the buffer, then restore — preserveDrawingBuffer makes the read reliable.
  const snapshot = async (format: ImageFormat, widthPx: number, opts?: ImageExportOptions) => {
    const st = r3f.current;
    if (!st || !exportData) return;
    const el = st.gl.domElement;
    const cssW = el.clientWidth || el.width || 1;
    const cssH = el.clientHeight || el.height || 1;
    const pr = st.gl.getPixelRatio();
    const outH = Math.max(1, Math.round(widthPx * (cssH / cssW)));

    // Auto-fit (the owner, 12 Aug 2026). His real 8K export has the rocket filling
    // roughly a fifth of the frame, so four fifths of those pixels are
    // background. Trimming to content AFTER the render cannot fix that — it
    // throws pixels away, so an "8K" export of a small on-screen rocket yields
    // far fewer than 8K pixels OF ROCKET. Moving the camera in BEFORE the
    // hi-res render lands the full requested resolution on the subject; trim
    // is the weaker half of the same idea.
    //
    // The fit renders through a THROWAWAY camera instead of moving the live
    // one and restoring it. OrbitControls owns the on-screen camera and
    // re-derives its state from it every frame, and the hi-res encode below
    // takes long enough (seconds, at 8K) for plenty of frames to land — a
    // mutate/restore pair would flash a jumped view at the user and risks
    // leaving the controls desynced if the capture throws. A throwaway cannot
    // desync: there is nothing to put back. Building it fresh rather than
    // cloning also guarantees a clean projection (no inherited zoom or view
    // offset). spanM stays 2*maxR: framing moves the camera, never the rocket.
    const src = st.camera as THREE.PerspectiveCamera;
    const box = opts?.fit && src.isPerspectiveCamera ? piecesBounds(pieces) : null;
    const cam: THREE.Camera = box && isFittableBox(box)
      ? exportCamera(box, src, widthPx / outH)
      : st.camera;

    try {
      st.gl.setPixelRatio(1);
      st.gl.setSize(widthPx, outH, false);
      st.gl.render(st.scene, cam);
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
  const markerR = markerRadius(totalLen, maxR);
  const gadget = markers.callout ? calloutGadget(info, maxR, totalLen, prefs.stabilityUnit) : null;

  // View presets + recovery (batch 08-21d): a pan or deep zoom could lose the
  // rocket with no way back — these jump the camera to known-good stations.
  // OrbitControls re-derives its state from the camera, so setting position +
  // target + update() is the whole move.
  const controls = useRef<import('three-stdlib').OrbitControls | null>(null);
  const jumpTo = (pos: [number, number, number]) => {
    const st = r3f.current;
    const c = controls.current;
    if (!st || !c) return;
    st.camera.position.set(pos[0], pos[1], pos[2]);
    c.target.set(center, 0, 0);
    c.update();
  };

  return (
    <div className="rocket3d-wrap" style={{ position: 'relative' }}>
      {/* One control row, top-RIGHT (v0.076): at top-left the floating stats
          chip's default position buried Reset/Side/Aft/◉ — most users never
          learned they existed (owner report, issues-2026-08-26d). Top-right
          held only the Image menu, which now closes the row. */}
      <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 2, display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button className="file-btn" title="Reset the camera to the standard three-quarter view"
          onClick={() => jumpTo([center + camDist * 0.5, camDist * 0.45, camDist * 0.8])}>⟲ Reset</button>
        <button className="file-btn" title="Straight-on side profile"
          onClick={() => jumpTo([center, 0, camDist * 1.05])}>Side</button>
        <button className="file-btn" title="From behind — clusters and fin count as they really sit"
          onClick={() => jumpTo([totalLen + camDist * 0.9, 0, 0])}>Aft</button>
        {/* A tester asked for the CG/CP markers to be optional — the shell is
            what he wanted to look at. This is a plain on/off; Preferences has
            the four-way (spheres and callout are independent). */}
        <button className="file-btn" aria-pressed={markers.axis || markers.callout}
          title="Show or hide the CG / CP markers and the floating callout. Preferences → Display can keep one and drop the other."
          onClick={() => setPrefs({
            ...prefs,
            markers3d: (markers.axis || markers.callout) ? 'off' : 'both',
          })}>
          {(markers.axis || markers.callout) ? '◉ CG/CP' : '○ CG/CP'}
        </button>
        {exportData && (
          <ImageExportMenu label="📷 Image" fitOption
            title="Snapshot the current 3D view with design data — rotate to the angle you want, then pick PNG or JPG and a width (re-rendered at that resolution)"
            onPick={snapshot} />
        )}
      </div>
      <Canvas camera={{ position: [center + camDist * 0.5, camDist * 0.45, camDist * 0.8], fov: 40 }}
        // Snapshot export reads the drawing buffer after the frame — without
        // this flag WebGL may have discarded it and toDataURL returns black.
        gl={{ preserveDrawingBuffer: true }}
        onCreated={(state) => { r3f.current = { gl: state.gl, scene: state.scene, camera: state.camera }; }}>
        {/* Soft studio setup (S5): warm-neutral key, cool fill, low rim —
            subtle and blueprint-serious, no shadows or environment maps. */}
        <ambientLight intensity={0.55} />
        <directionalLight position={[1.5, 2.5, 2]} intensity={0.95} color="#fff7ee" />
        <directionalLight position={[-2, 0.5, -1]} intensity={0.45} color="#e8eef8" />
        <directionalLight position={[-0.5, -1.5, -2.5]} intensity={0.35} />
        <group>
          {pieces.map((p) => (
            <mesh key={p.key} geometry={p.geometry}
              position={p.position ?? [0, 0, 0]}
              rotation={p.rotation ?? [0, 0, 0]}
              renderOrder={p.translucent ? 2 : p.innerGlass ? 1 : 0}>
              {/* See-through layering (batch 08-21d — 0.88 with depth writes
                  on looked opaque in practice): opaque pieces (motor, fins)
                  first, then glassy inner tubes, then the shell — depth writes
                  off for both see-through tiers so each layer shows through
                  the ones over it; DoubleSide draws far walls for depth. */}
              <meshStandardMaterial color={p.color} roughness={0.6} metalness={0.05}
                transparent={!!p.translucent || !!p.innerGlass}
                opacity={p.translucent ? 0.55 : p.innerGlass ? 0.5 : 1}
                depthWrite={!p.translucent && !p.innerGlass}
                side={p.translucent || p.innerGlass ? THREE.DoubleSide : THREE.FrontSide} />
            </mesh>
          ))}
          {/* CG/CP sit on the rocket axis — inside the shell — so they must
              render ON TOP (depthTest off, high renderOrder) to be visible,
              exactly like the 2D markers. `transparent` puts them in the
              transparent queue AFTER the see-through shell, or the shell
              would wash over them. */}
          {/* 0.45× the shared size rule (batch 08-21d): full-size axis balls
              overwhelmed small rockets; the gadget keeps the size rule. */}
          {markers.axis && info && Number.isFinite(info.cg) && (
            <mesh position={[info.cg, 0, 0]} renderOrder={10}>
              <sphereGeometry args={[markerR * 0.45, 24, 24]} />
              <meshStandardMaterial color="#e9edf1" emissive="#8891a0" depthTest={false} transparent />
            </mesh>
          )}
          {markers.axis && info && Number.isFinite(info.cp) && (
            <mesh position={[shownCp(info), 0, 0]} renderOrder={11}>
              <sphereGeometry args={[markerR * 0.45, 24, 24]} />
              <meshStandardMaterial color="#e34948" emissive="#5a1010" depthTest={false} transparent />
            </mesh>
          )}
          {/* Floating CG/CP callout beside the hull (2026-08-21c). Same
              always-on-top treatment as the axis markers; no pointer handlers,
              so it never swallows OrbitControls' events. */}
          {gadget && (
            <group>
              {Math.abs(gadget.cg.pos[0] - gadget.cp.pos[0]) > 1e-9 && (
                <mesh position={[(gadget.cg.pos[0] + gadget.cp.pos[0]) / 2, 0, gadget.off]}
                  rotation={[0, 0, -Math.PI / 2]} renderOrder={11}>
                  <cylinderGeometry args={[gadget.r * 0.12, gadget.r * 0.12,
                    Math.abs(gadget.cg.pos[0] - gadget.cp.pos[0]), 8]} />
                  <meshBasicMaterial color="#8891a0" depthTest={false} transparent />
                </mesh>
              )}
              <mesh position={gadget.cg.pos} renderOrder={12}>
                <sphereGeometry args={[gadget.r, 24, 24]} />
                <meshStandardMaterial color="#e9edf1" emissive="#8891a0" depthTest={false} transparent />
              </mesh>
              <mesh position={gadget.cp.pos} renderOrder={12}>
                <sphereGeometry args={[gadget.r, 24, 24]} />
                <meshStandardMaterial color="#e34948" emissive="#5a1010" depthTest={false} transparent />
              </mesh>
              <CalloutLabel text={gadget.cg.text} color={gadget.cg.color} place="above"
                position={gadget.cg.pos} height={markerR * 1.2} gap={gadget.r * 1.5} />
              <CalloutLabel text={gadget.cp.text} color={gadget.cp.color} place="below"
                position={gadget.cp.pos} height={markerR * 1.2} gap={gadget.r * 1.5} />
              {gadget.margin && (
                <CalloutLabel text={gadget.margin.text} color={gadget.margin.color} place="right"
                  position={gadget.margin.pos} height={markerR * 1.1} gap={markerR * 1.1} />
              )}
            </group>
          )}
        </group>
        {/* Distance limits (batch 08-21d): an unbounded zoom could bury the
            camera inside the hull or fling it to where the rocket is a pixel;
            the view buttons above are the recovery path either way. */}
        <OrbitControls ref={controls} target={[center, 0, 0]} enableDamping dampingFactor={0.1}
          minDistance={camDist * 0.12} maxDistance={camDist * 5} />
      </Canvas>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0', textAlign: 'center' }}>
        drag to rotate · scroll to zoom
        {/* The legend goes with the markers — a key for dots nobody is drawing
            is worse than no key. */}
        {markers.axis && (
          <> · <span style={{ color: '#aab2bd' }}>●</span> CG ·{' '}
            <span style={{ color: '#e34948' }}>●</span> CP</>
        )}
      </p>
    </div>
  );
}
