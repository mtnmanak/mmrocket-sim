// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ComponentNode, RocketTree, StaticInfo } from '@online-openrocket/engine';
import {
  buildPieces, calloutGadget, exportCamera, fitCameraToBox, FIT_MARGIN, isFittableBox,
  piecesBounds,
} from './Rocket3D.js';

const centerY = (geo: THREE.BufferGeometry): number => {
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  return c.y;
};

const base = (extra: ComponentNode[] = []): RocketTree => ({
  name: 't',
  components: [{
    type: 'stage', id: 's', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.024, shape: 'ogive' } as ComponentNode,
      {
        type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024,
        children: extra,
      } as ComponentNode,
    ],
  } as ComponentNode],
});

// issue 2026-08-11a: shapes drew as fixed ogive/cone regardless of selection.
describe('buildPieces — nose/transition shapes drive the geometry', () => {
  const verts = (tree: RocketTree, keyPrefix: string): Float32Array => {
    const { pieces } = buildPieces(tree);
    const p = pieces.find((pc) => pc.key.startsWith(keyPrefix))!;
    return p.geometry.getAttribute('position').array as Float32Array;
  };
  const maxDiff = (a: Float32Array, b: Float32Array): number => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!));
    return d;
  };
  const noseTree = (shape: string, param?: number): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage', id: 's',
      children: [
        { type: 'nosecone', id: 'n', length: 0.07, aftRadius: 0.024, shape,
          ...(param !== undefined ? { shapeParameter: param } : {}) } as ComponentNode,
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });
  const transTree = (shape: string): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage', id: 's',
      children: [
        { type: 'bodytube', id: 'b1', length: 0.2, outerRadius: 0.012 } as ComponentNode,
        { type: 'transition', id: 'tr', length: 0.05, foreRadius: 0.012, aftRadius: 0.024, shape } as ComponentNode,
        { type: 'bodytube', id: 'b2', length: 0.2, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });

  it('nose cone: conical differs from ogive', () => {
    expect(maxDiff(verts(noseTree('ogive'), 'nose'), verts(noseTree('conical'), 'nose')))
      .toBeGreaterThan(0.001);
  });

  it('nose cone: shapeParameter changes a power-series profile', () => {
    expect(maxDiff(verts(noseTree('power', 0.25), 'nose'), verts(noseTree('power', 0.75), 'nose')))
      .toBeGreaterThan(0.001);
  });

  it('transition: ogive differs from conical (was always a straight cone)', () => {
    expect(maxDiff(verts(transTree('conical'), 'trans'), verts(transTree('ogive'), 'trans')))
      .toBeGreaterThan(0.0005);
  });

  it('transition lathe spans its fore/aft radii and axial slot', () => {
    const { pieces } = buildPieces(transTree('ogive'));
    const tr = pieces.find((p) => p.key.startsWith('trans'))!;
    tr.geometry.computeBoundingBox();
    const bb = tr.geometry.boundingBox!;
    // Lathe local frame before rotation: axis +Y (0..len), radius in XZ.
    expect(bb.min.y).toBeCloseTo(0, 6);
    expect(bb.max.y).toBeCloseTo(0.05, 6);
    expect(bb.max.x).toBeCloseTo(0.024, 3);
    expect(tr.position![0]).toBeCloseTo(0.2, 9); // fore end at the joint
  });
});

/**
 * Export auto-fit (12 Aug 2026). The R3F canvas cannot be mounted headlessly
 * in this repo, so the framing maths is proven here against numbers derived by
 * hand. fov 40° → tan(20°) = 0.36397023426620234, cot(20°) = 2.747477419454622.
 */
describe('fitCameraToBox — export framing', () => {
  const FOV = 40, TAN20 = Math.tan((40 * Math.PI) / 360);
  const boxOf = (hx: number, hy: number, hz: number, c: [number, number, number] = [0, 0, 0]) =>
    new THREE.Box3(
      new THREE.Vector3(c[0] - hx, c[1] - hy, c[2] - hz),
      new THREE.Vector3(c[0] + hx, c[1] + hy, c[2] + hz),
    );
  const VIEW_Z = new THREE.Vector3(0, 0, -1); // camera on +Z looking at the origin
  const dist = (f: { position: THREE.Vector3; target: THREE.Vector3 }) => f.position.distanceTo(f.target);
  // How much of the frame the box actually occupies, through a REAL camera:
  // the largest |NDC| any of the eight corners reaches. 1 = touching the edge,
  // 0.5 = filling half the frame. This is the only honest way to compare a
  // fitted camera against an unfitted one — distance alone says nothing.
  const ndcFill = (box: THREE.Box3, cam: THREE.PerspectiveCamera) => {
    let mx = 0, my = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).project(cam);
      mx = Math.max(mx, Math.abs(p.x));
      my = Math.max(my, Math.abs(p.y));
    }
    return { mx, my, max: Math.max(mx, my) };
  };

  it('frames a long thin box on its WIDTH at 16:9, not its height', () => {
    // halfW 5, halfH 0.5, halfD 0.5. Width term: 5 / (tan20 · 16/9) = 7.7272803;
    // height term would be only 0.5 / tan20 = 1.3737387. Camera sits at the
    // larger of the two, plus halfD so the near face is the one that fits.
    const f = fitCameraToBox(boxOf(5, 0.5, 0.5), VIEW_Z, FOV, 16 / 9, 1);
    expect(dist(f)).toBeCloseTo(8.2272802, 5);
    expect(dist(f)).not.toBeCloseTo(1.3737387 + 0.5, 2); // the height-limited answer
    expect(f.position.x).toBe(0);
    expect(f.position.y).toBe(0);
    expect(f.position.z).toBeCloseTo(8.2272802, 5);
  });

  it('frames a tall narrow box on its HEIGHT at the same aspect', () => {
    // halfH 5 → 5 · cot20 = 13.7373871, well past the 0.7727280 width term.
    const f = fitCameraToBox(boxOf(0.5, 5, 0.5), VIEW_Z, FOV, 16 / 9, 1);
    expect(dist(f)).toBeCloseTo(14.2373871, 5);
    expect(dist(f)).not.toBeCloseTo(0.7727280 + 0.5, 2);
  });

  it('a wider export aspect pulls the camera IN, a narrower one pushes it OUT', () => {
    const at = (aspect: number) => dist(fitCameraToBox(boxOf(5, 0.5, 0.5), VIEW_Z, FOV, aspect, 1));
    expect(at(4 / 3)).toBeCloseTo(10.8030403, 5);  // 5 · 3/(4·tan20) + 0.5
    expect(at(16 / 9)).toBeCloseTo(8.2272802, 5);
    expect(at(21 / 9)).toBeCloseTo(6.3874516, 5);  // 5 · 9/(21·tan20) + 0.5
    expect(at(21 / 9)).toBeLessThan(at(16 / 9));
    expect(at(4 / 3)).toBeGreaterThan(at(16 / 9));
  });

  it('preserves the viewing direction exactly and targets the box centre', () => {
    const dir = new THREE.Vector3(1, -2, 3).normalize();
    const f = fitCameraToBox(boxOf(1, 0.2, 0.2, [0.5, 0, 0]), dir, FOV, 16 / 9);
    const back = new THREE.Vector3().subVectors(f.target, f.position).normalize();
    expect(back.x).toBeCloseTo(dir.x, 12);
    expect(back.y).toBeCloseTo(dir.y, 12);
    expect(back.z).toBeCloseTo(dir.z, 12);
    expect(f.target.x).toBeCloseTo(0.5, 12);
    expect(f.target.y).toBeCloseTo(0, 12);
    expect(f.target.z).toBeCloseTo(0, 12);
    // A non-unit direction must frame identically to its normalised twin.
    const scaled = fitCameraToBox(boxOf(1, 0.2, 0.2, [0.5, 0, 0]), dir.clone().multiplyScalar(37), FOV, 16 / 9);
    expect(scaled.position.distanceTo(f.position)).toBeCloseTo(0, 12);
  });

  it('leaves no corner outside the frame — including from a three-quarter view', () => {
    // The regression that matters: project all eight corners through a real
    // camera built from the fit and check the NDC box. margin 1 makes the
    // width-limited corners land exactly on the frame edge.
    const box = boxOf(0.6, 0.05, 0.05, [0.6, 0, 0]);
    const aspect = 16 / 9;
    for (const dir of [VIEW_Z, new THREE.Vector3(-0.6, -0.45, -0.8).normalize()]) {
      const f = fitCameraToBox(box, dir, FOV, aspect, 1);
      const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.001, 100);
      cam.position.copy(f.position);
      cam.lookAt(f.target);
      cam.updateMatrixWorld();
      let maxX = 0, maxY = 0;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Vector3(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        ).project(cam);
        maxX = Math.max(maxX, Math.abs(p.x));
        maxY = Math.max(maxY, Math.abs(p.y));
      }
      expect(maxX).toBeLessThanOrEqual(1 + 1e-9);
      expect(maxY).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Head-on, the long axis touches the left/right edges exactly.
    const head = fitCameraToBox(box, VIEW_Z, FOV, aspect, 1);
    const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.001, 100);
    cam.position.copy(head.position);
    cam.lookAt(head.target);
    cam.updateMatrixWorld();
    expect(new THREE.Vector3(box.max.x, 0, box.max.z).project(cam).x).toBeCloseTo(1, 9);
  });

  it('applies the margin as pure padding: 1.06 leaves the subject at 1/1.06 of the frame', () => {
    const box = boxOf(0.6, 0.05, 0.05, [0.6, 0, 0]);
    const f = fitCameraToBox(box, VIEW_Z, FOV, 16 / 9, FIT_MARGIN);
    const cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.001, 100);
    cam.position.copy(f.position);
    cam.lookAt(f.target);
    cam.updateMatrixWorld();
    expect(new THREE.Vector3(box.max.x, 0, box.max.z).project(cam).x).toBeCloseTo(1 / FIT_MARGIN, 9);
    // 0.6/(tan20·16/9)·1.06 + 0.05
    expect(dist(f)).toBeCloseTo(0.6 * 1.06 / (TAN20 * 16 / 9) + 0.05, 12);
  });

  it('frames a STUBBY rocket larger than doing nothing at all', () => {
    // The regression that would have shipped. 0.37 m long, maxR 0.05, 16:9
    // export, live camera exactly where <Canvas> places it. The old
    // max(widthTerm, heightTerm) + halfD form charged the full depth extent to
    // the widest corner — but the widest corner is not the nearest one — and
    // pushed the camera out to 0.456 m when the live camera already sat at
    // 0.425 m. Net effect of switching the DEFAULT-ON fit on: the rocket got
    // smaller (0.83 of frame vs 0.91). The per-corner bound sits at 0.413 m.
    const len = 0.37, maxR = 0.05, aspect = 16 / 9;
    const box = new THREE.Box3(
      new THREE.Vector3(0, -maxR, -maxR), new THREE.Vector3(len, maxR, maxR));
    const live = new THREE.PerspectiveCamera(FOV, aspect, 0.1, 1000);
    const d = Math.max(len * 1.1, maxR * 6, 0.25); // Rocket3D's own camDist
    live.position.set(len / 2 + d * 0.5, d * 0.45, d * 0.8);
    live.lookAt(len / 2, 0, 0);
    live.updateMatrixWorld();

    const fitted = exportCamera(box, live, aspect);
    const c = box.getCenter(new THREE.Vector3());
    expect(fitted.position.distanceTo(c)).toBeLessThan(live.position.distanceTo(c));
    expect(ndcFill(box, fitted).max).toBeGreaterThan(ndcFill(box, live).max);
    // ...and it is TIGHT, not merely better: the limiting corner lands exactly
    // on the margin, which is what "fit" is supposed to mean.
    expect(ndcFill(box, fitted).max).toBeCloseTo(1 / FIT_MARGIN, 6);
  });

  it('measures a dead-overhead view in the SAME basis three.lookAt builds', () => {
    // Looking straight down `up`, up × back is zero and the roll about the view
    // axis is a free choice — but fitCameraToBox only chooses the MEASURING
    // basis, while cam.lookAt() chooses the rendering one. Substituting an axis
    // put those 90° apart, so a 1 m rocket had its LENGTH measured as frame
    // height and its 4 cm diameter as frame width, filling ~55 % of the frame.
    // Mirroring three's nudge, the length lands across the WIDE screen axis.
    const box = boxOf(0.5, 0.02, 0.02, [0.5, 0, 0]);
    const aspect = 16 / 9;
    const f = fitCameraToBox(box, new THREE.Vector3(0, -1, 0), FOV, aspect, 1);
    const cam = new THREE.PerspectiveCamera(FOV, aspect, 0.001, 100);
    cam.position.copy(f.position);
    cam.lookAt(f.target);
    cam.updateMatrixWorld();
    const fill = ndcFill(box, cam);
    expect(fill.mx).toBeCloseTo(1, 9); // the 1 m length fills the width
    expect(fill.my).toBeLessThan(0.2); // the 4 cm diameter barely uses the height
    expect(f.position.y).toBeGreaterThan(0); // camera overhead, still looking down
  });

  it('never returns NaN or Infinity for a degenerate box or camera', () => {
    const finite = (f: { position: THREE.Vector3; target: THREE.Vector3 }) =>
      [...f.position.toArray(), ...f.target.toArray()].every(Number.isFinite);
    const point = new THREE.Box3(new THREE.Vector3(1, 2, 3), new THREE.Vector3(1, 2, 3));
    const flat = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
    expect(finite(fitCameraToBox(point, VIEW_Z, FOV, 16 / 9))).toBe(true);
    expect(dist(fitCameraToBox(point, VIEW_Z, FOV, 16 / 9))).toBeGreaterThan(0);
    expect(finite(fitCameraToBox(new THREE.Box3().makeEmpty(), VIEW_Z, FOV, 16 / 9))).toBe(true);
    expect(finite(fitCameraToBox(flat, VIEW_Z, FOV, 16 / 9))).toBe(true);
    // Hostile camera parameters: zero fov, zero/NaN aspect, zero direction,
    // up parallel to the view (dead overhead), zero margin.
    expect(finite(fitCameraToBox(boxOf(1, 1, 1), VIEW_Z, 0, 16 / 9))).toBe(true);
    expect(finite(fitCameraToBox(boxOf(1, 1, 1), VIEW_Z, FOV, 0))).toBe(true);
    expect(finite(fitCameraToBox(boxOf(1, 1, 1), VIEW_Z, FOV, NaN))).toBe(true);
    expect(finite(fitCameraToBox(boxOf(1, 1, 1), new THREE.Vector3(0, 0, 0), FOV, 16 / 9))).toBe(true);
    expect(finite(fitCameraToBox(boxOf(1, 1, 1), new THREE.Vector3(0, -1, 0), FOV, 16 / 9))).toBe(true);
    expect(finite(fitCameraToBox(boxOf(1, 1, 1), VIEW_Z, FOV, 16 / 9, 0))).toBe(true);
  });
});

describe('exportCamera — the camera the snapshot actually renders through', () => {
  // The live camera as the Canvas sets it up: fov 40, looking at the rocket
  // from a three-quarter angle, near 0.1 (R3F's default).
  const liveCam = (len: number) => {
    const c = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 1000);
    const d = Math.max(len * 1.1, 0.25);
    c.position.set(len / 2 + d * 0.5, d * 0.45, d * 0.8);
    c.lookAt(len / 2, 0, 0);
    c.updateMatrixWorld();
    return c;
  };
  const rocketBox = (len: number, r: number) =>
    new THREE.Box3(new THREE.Vector3(0, -r, -r), new THREE.Vector3(len, r, r));
  const cornersInside = (box: THREE.Box3, cam: THREE.PerspectiveCamera) => {
    const f = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z);
      if (!f.containsPoint(p)) return false;
    }
    return true;
  };

  it('keeps a 5 cm rocket in frame — the fit distance falls inside the live near plane', () => {
    const box = rocketBox(0.05, 0.006);
    const src = liveCam(0.05);
    const cam = exportCamera(box, src, 7680 / 4320);
    // The fit pulls in to ~4 cm, well inside the live camera's 0.1 m near
    // plane: without the recomputed planes this export would have been blank.
    expect(cam.position.distanceTo(new THREE.Vector3(0.025, 0, 0))).toBeLessThan(0.1);
    expect(cam.near).toBeLessThan(0.1);
    expect(cam.near).toBeGreaterThan(0);
    expect(cam.far).toBeGreaterThan(cam.near);
    expect(cornersInside(box, cam)).toBe(true);
  });

  it('keeps a 4 m rocket in frame and preserves the live viewing angle', () => {
    const box = rocketBox(4, 0.08);
    const src = liveCam(4);
    const cam = exportCamera(box, src, 7680 / 4320);
    expect(cornersInside(box, cam)).toBe(true);
    const before = src.getWorldDirection(new THREE.Vector3());
    const after = cam.getWorldDirection(new THREE.Vector3());
    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
    expect(after.z).toBeCloseTo(before.z, 12);
    // ...and the live camera is untouched: the export uses a throwaway.
    expect(src.position.toArray()).toEqual(liveCam(4).position.toArray());
    expect(src.near).toBe(0.1);
    expect(src.aspect).toBe(4 / 3);
  });

  it('fills the export aspect, not the on-screen one', () => {
    // Same rocket, same live camera, two export shapes: the 21:9 frame must
    // sit closer than the 4:3 one or the extra width is wasted.
    const box = rocketBox(1.2, 0.03);
    const src = liveCam(1.2);
    const wide = exportCamera(box, src, 21 / 9);
    const square = exportCamera(box, src, 4 / 3);
    const c = box.getCenter(new THREE.Vector3());
    expect(wide.aspect).toBeCloseTo(21 / 9, 12);
    expect(wide.position.distanceTo(c)).toBeLessThan(square.position.distanceTo(c));
    expect(cornersInside(box, wide)).toBe(true);
    expect(cornersInside(box, square)).toBe(true);
  });
});

describe('piecesBounds — what the export frames', () => {
  it('spans the whole rocket in world space, fins and all', () => {
    const withFins = base([{
      type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.04, tipChord: 0.02,
      sweep: 0.02, height: 0.03, position: { method: 'bottom', offset: 0 },
    } as ComponentNode]);
    const { pieces, totalLen, maxR } = buildPieces(withFins);
    const box = piecesBounds(pieces);
    // Nose tip at x=0, aft end at nose 0.07 + tube 0.3.
    expect(box.min.x).toBeCloseTo(0, 6);
    expect(box.max.x).toBeCloseTo(totalLen, 6);
    // Radially: body 0.024 + fin height 0.03 = maxR, on the +Y fin at angle 0.
    expect(box.max.y).toBeCloseTo(maxR, 4);
    expect(box.min.y).toBeGreaterThanOrEqual(-maxR - 1e-9);
    expect(box.isEmpty()).toBe(false);
  });

  it('grows to cover an off-axis booster', () => {
    const withBooster = base([{
      type: 'parallelstage', id: 'ps', instanceCount: 2, radiusOffset: 0,
      radiusMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 },
      children: [{ type: 'bodytube', id: 'bb', length: 0.2, outerRadius: 0.012 } as ComponentNode],
    } as ComponentNode]);
    const core = piecesBounds(buildPieces(base()).pieces);
    const box = piecesBounds(buildPieces(withBooster).pieces);
    // Booster centres sit at ±0.036, so the box reaches 0.036 + 0.012.
    expect(box.max.y).toBeCloseTo(0.048, 4);
    expect(box.min.y).toBeCloseTo(-0.048, 4);
    expect(box.max.y).toBeGreaterThan(core.max.y);
  });

  it('is empty for an empty rocket (the caller must not fit to it)', () => {
    expect(piecesBounds([]).isEmpty()).toBe(true);
  });
});

describe('isFittableBox — the NaN box Box3.isEmpty() waves straight through', () => {
  // One NaN field on one component is enough: it survives the shape profile,
  // the lathe vertices, the geometry bounding box and the union.
  const nanNose = (): RocketTree => ({
    name: 't',
    components: [{
      type: 'stage', id: 's',
      children: [
        { type: 'nosecone', id: 'n', length: NaN, aftRadius: 0.024, shape: 'ogive' } as ComponentNode,
        { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.024 } as ComponentNode,
      ],
    } as ComponentNode],
  });

  // three's computeBoundingBox() console.errors on NaN AND dumps the entire
  // geometry object with it — ~60 lines of noise per call, in the one suite
  // where producing that NaN is the whole point. Silenced here only.
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('catches a NaN box that reports itself NON-empty', () => {
    const box = piecesBounds(buildPieces(nanNose()).pieces);
    expect(Number.isNaN(box.min.x)).toBe(true);
    // The trap the old `!box.isEmpty()` guard fell into: isEmpty() is
    // `max.x < min.x || ...`, and every comparison against NaN is false, so a
    // thoroughly poisoned box swears it is a perfectly good one.
    expect(box.isEmpty()).toBe(false);
    expect(isFittableBox(box)).toBe(false);
  });

  it('is guarding against a real NaN camera, not a hypothetical one', () => {
    const box = piecesBounds(buildPieces(nanNose()).pieces);
    const f = fitCameraToBox(box, new THREE.Vector3(0, 0, -1), 40, 16 / 9);
    // Fit it anyway and the export renders through a camera at nowhere, with
    // nothing logged — a blank PNG is the only symptom the user ever sees.
    expect([...f.position.toArray(), ...f.target.toArray()].some((v) => Number.isNaN(v))).toBe(true);
  });

  it('passes a healthy rocket, rejects empty and infinite ones', () => {
    expect(isFittableBox(piecesBounds(buildPieces(base()).pieces))).toBe(true);
    expect(isFittableBox(piecesBounds([]))).toBe(false);
    expect(isFittableBox(new THREE.Box3().makeEmpty())).toBe(false);
    // Infinity is just as fatal to the camera as NaN, and — on the max side —
    // just as invisible to isEmpty().
    expect(isFittableBox(new THREE.Box3(
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(Infinity, 1, 1)))).toBe(false);
  });
});

describe('buildPieces — off-axis pods (Phase 2)', () => {
  it('renders the core rocket unchanged when there are no pods', () => {
    const { pieces } = buildPieces(base());
    // nose + body, both on the centerline.
    expect(pieces.length).toBe(2);
    expect(pieces.every((p) => p.position && p.position[1] === 0)).toBe(true);
  });

  it('adds one off-axis chain per booster instance, ringed around the body', () => {
    const withBooster = base([{
      type: 'parallelstage', id: 'ps', instanceCount: 2, radiusOffset: 0,
      radiusMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 },
      children: [{ type: 'bodytube', id: 'bb', length: 0.2, outerRadius: 0.012 } as ComponentNode],
    } as ComponentNode]);
    const { pieces, maxR } = buildPieces(withBooster);

    // 2 core (nose+body) + 2 booster bodies (one per instance).
    expect(pieces.length).toBe(4);
    // Booster pieces are baked (no position field — geometry is in world space).
    const boosters = pieces.filter((p) => !p.position);
    expect(boosters.length).toBe(2);

    // RELATIVE radius: offset(0) + parentR(0.024) + podBoundingR(0.012) = 0.036.
    // The two instances (angle 0 and π) sit at +0.036 and -0.036 on the Y axis.
    const ys = boosters.map((p) => centerY(p.geometry)).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-0.036, 4);
    expect(ys[1]).toBeCloseTo(0.036, 4);
    // Camera framing radius grows to include the off-axis booster.
    expect(maxR).toBeGreaterThanOrEqual(0.036);
  });

  it('draws fins on a booster (recurses the pod chain)', () => {
    const withFinnedBooster = base([{
      type: 'parallelstage', id: 'ps', instanceCount: 1, radiusOffset: 0.01,
      radiusMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 },
      children: [{
        type: 'bodytube', id: 'bb', length: 0.2, outerRadius: 0.012,
        children: [{
          type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.04, tipChord: 0.02,
          sweep: 0.02, height: 0.03, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode]);
    const { pieces } = buildPieces(withFinnedBooster);
    // nose + body + 1 booster body + 3 booster fins.
    expect(pieces.filter((p) => p.key.startsWith('fin')).length).toBe(3);
  });
});

/**
 * Floating CG/CP callout beside the hull (2026-08-21c, after RocketForge).
 * The R3F canvas cannot mount here, so the gadget's numbers — the only part
 * with any logic — are pinned through the pure helper.
 */
describe('calloutGadget — the offset CG/CP gadget', () => {
  const MAX_R = 0.024, LEN = 0.37;
  // markerR = max(0.37·0.015, 0.024·0.35) = 0.0084 — the marker-sphere rule.
  const MARKER_R = 0.0084;
  const infoOf = (over: Partial<StaticInfo> = {}): StaticInfo => ({
    length: LEN, mass: 0.12, massEmpty: 0.1, cgEmpty: 0.21, cg: 0.2, cp: 0.28,
    cna: 10, stabilityCalibers: 1.67, refDiameter: 0.048, warnings: 0, warningTexts: [],
    ...over,
  });

  it('floats the spheres at the TRUE axial stations, clear of the hull', () => {
    const g = calloutGadget(infoOf(), MAX_R, LEN)!;
    expect(g.off).toBeCloseTo(MAX_R + MARKER_R * 2.2, 12);
    expect(g.r).toBeCloseTo(MARKER_R * 0.55, 12);
    expect(g.cg.pos).toEqual([0.2, 0, g.off]);
    expect(g.cp.pos).toEqual([0.28, 0, g.off]);
    // Margin readout sits midway between the spheres, on the same column.
    expect(g.margin!.pos[0]).toBeCloseTo(0.24, 12);
    expect(g.margin!.pos[2]).toBeCloseTo(g.off, 12);
  });

  it('labels CG in neutral ink and CP in the CP red', () => {
    const g = calloutGadget(infoOf(), MAX_R, LEN)!;
    expect(g.cg).toMatchObject({ text: 'CG', color: '#e9edf1' });
    expect(g.cp).toMatchObject({ text: 'CP', color: '#e34948' });
  });

  it('formats the margin and colors it by stability state (dark-theme hexes)', () => {
    const at = (cal: number) => calloutGadget(infoOf({ stabilityCalibers: cal }), MAX_R, LEN)!.margin!;
    expect(at(1.67)).toMatchObject({ text: '1.67 cal', color: '#4dbd4d' });  // ok
    expect(at(0.42)).toMatchObject({ text: '0.42 cal', color: '#f0716f' });  // under: the dangerous case
    expect(at(3.5)).toMatchObject({ text: '3.50 cal', color: '#e0a53d' });   // over: weathercocking caution
  });

  it('skips the margin when stability is unknown, the whole gadget without CG+CP', () => {
    expect(calloutGadget(infoOf({ stabilityCalibers: NaN }), MAX_R, LEN)!.margin).toBeNull();
    expect(calloutGadget(null, MAX_R, LEN)).toBeNull();
    expect(calloutGadget(infoOf({ cg: NaN }), MAX_R, LEN)).toBeNull();
    expect(calloutGadget(infoOf({ cp: Infinity }), MAX_R, LEN)).toBeNull();
  });
});

/**
 * S5 materials pass (2026-08-21c): inner tubes render as pieces, a loaded
 * motor case seats at its mount's aft end, and the external shell is flagged
 * translucent so both show through.
 */
describe('buildPieces — inner tubes and loaded motors (S5)', () => {
  // Inner tube seated at the bottom of the 0.3 m body tube that starts at the
  // nose joint (0.07): start = 0.07 + 0.3 − 0.07 = 0.3, centre 0.335.
  const mountTree = (extra: Partial<ComponentNode> = {}): RocketTree => base([{
    type: 'innertube', id: 'mt', length: 0.07, outerRadius: 0.012,
    position: { method: 'bottom', offset: 0 },
    ...extra,
  } as ComponentNode]);

  it('renders a motor mount tube inside the body', () => {
    const { pieces } = buildPieces(mountTree());
    const inner = pieces.filter((p) => p.key.startsWith('inner'));
    expect(inner.length).toBe(1);
    expect(inner[0]!.position![0]).toBeCloseTo(0.335, 9);
    expect(inner[0]!.position![1]).toBe(0);
    inner[0]!.geometry.computeBoundingBox();
    const bb = inner[0]!.geometry.boundingBox!;
    // Cylinder local frame before rotation: axis +Y, radius in XZ.
    expect(bb.max.x).toBeCloseTo(0.012, 6);
    expect(bb.max.y).toBeCloseTo(0.035, 6);
  });

  it("seats a loaded motor flush at the mount's aft end, launch orange", () => {
    const { pieces } = buildPieces(mountTree(), { mt: { length: 0.055, diameter: 0.018 } });
    const motor = pieces.filter((p) => p.key.startsWith('motor'));
    expect(motor.length).toBe(1);
    // Mount aft end at 0.37: motor spans 0.315..0.37, centre 0.3425.
    expect(motor[0]!.position![0]).toBeCloseTo(0.3425, 9);
    expect(motor[0]!.color).toBe('#c65420');
    // No motors prop, or a motor on some other mount: no case drawn.
    expect(buildPieces(mountTree()).pieces.some((p) => p.key.startsWith('motor'))).toBe(false);
    expect(buildPieces(mountTree(), { other: { length: 0.055, diameter: 0.018 } })
      .pieces.some((p) => p.key.startsWith('motor'))).toBe(false);
  });

  it('draws one tube and one motor per cluster position', () => {
    const { pieces } = buildPieces(mountTree({ cluster: 'double' } as Partial<ComponentNode>),
      { mt: { length: 0.055, diameter: 0.018 } });
    const inner = pieces.filter((p) => p.key.startsWith('inner'));
    const motor = pieces.filter((p) => p.key.startsWith('motor'));
    expect(inner.length).toBe(2);
    expect(motor.length).toBe(2);
    // 'double' at separation 2·0.012: tube centres at y = ±0.012.
    const ys = inner.map((p) => p.position![1]).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-0.012, 9);
    expect(ys[1]).toBeCloseTo(0.012, 9);
  });

  it('min-diameter: a motor keyed to a body tube seats at the tube aft end', () => {
    const { pieces } = buildPieces(base(), { b: { length: 0.07, diameter: 0.024 } });
    const motor = pieces.filter((p) => p.key.startsWith('motor'));
    expect(motor.length).toBe(1);
    // Tube spans 0.07..0.37: motor spans 0.3..0.37, centre 0.335.
    expect(motor[0]!.position![0]).toBeCloseTo(0.335, 9);
  });

  it('flags the external shell translucent, internals and fins opaque', () => {
    const withFins = base([
      { type: 'innertube', id: 'mt', length: 0.07, outerRadius: 0.012,
        position: { method: 'bottom', offset: 0 } } as ComponentNode,
      { type: 'trapezoidfinset', id: 'f', finCount: 3, rootChord: 0.04, tipChord: 0.02,
        sweep: 0.02, height: 0.03, position: { method: 'bottom', offset: 0 } } as ComponentNode,
    ]);
    const { pieces } = buildPieces(withFins, { mt: { length: 0.055, diameter: 0.018 } });
    const byPrefix = (pre: string) => pieces.filter((p) => p.key.startsWith(pre));
    expect(byPrefix('nose').every((p) => p.translucent === true)).toBe(true);
    expect(byPrefix('body').every((p) => p.translucent === true)).toBe(true);
    expect(byPrefix('inner').every((p) => !p.translucent)).toBe(true);
    expect(byPrefix('motor').every((p) => !p.translucent)).toBe(true);
    expect(byPrefix('fin').every((p) => !p.translucent)).toBe(true);
  });
});
