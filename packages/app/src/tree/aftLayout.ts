import { overrideFor } from '../services/flightState.js';
import { resolveTransitionRadii } from './transitionRadii.js';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { lookupTable } from '../services/xmlUtil.js';
import { clusterOffsets } from './cluster.js';
import { tubeFinRadius } from './tubefins.js';
import { assemblyInstanceCount, finCountOf, lineInstanceCount } from './counts.js';
import { isAssembly, resolveAssemblyRadius, ringInstanceOffsets } from './assembly.js';
import { isConformal, shroudHalfWidth } from './shroud.js';
import { finOnMount, flatMount, type MountSurface } from './finRoot.js';
import { kernelNum } from './kernelDefaults.js';
import { axialLength, axialStart } from './position.js';
import { drawnRadius, profileMountOf } from './schematicLayout.js';
import { noseEnds } from './tailCone.js';
import { num } from './nodeNum.js';
import { hiddenPartIds } from './partVisibility.js';

/** A loaded motor seen from aft: the Launch colour, as the side view's case
 *  and the 3D motor (AftView draws it see-through, keyed on this value). */
export const AFT_MOTOR_FILL = 'var(--launch)';


// Keep the pure layout walk separate from interaction/rendering (audit 2026-10-11, S3b-4).
export interface MotorDims { length: number; diameter: number }

const colorOf = (n: ComponentNode, dflt: string): string =>
  typeof n['color'] === 'string' ? (n['color'] as string) : dflt;

export type Shape = (
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
  tree: RocketTree, roll: number, motors?: Record<string, MotorDims>, hiddenIds?: ReadonlySet<string>,
): AftLayout {
  if (motors) motors = lookupTable(motors);
  const hidden = hiddenPartIds(tree, hiddenIds);
  tree = resolveTransitionRadii(tree);
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

  /**
   * A fin set's bar end-on, radially [from, to], or null for a freeform set
   * too broken to draw. A fin roots on its mount AT ITS LEADING EDGE
   * (FinSet.getFinFront), as the 3D and side views root it (tree/finRoot.ts),
   * and its bar runs from that radius plus the planform's lowest point — on a
   * boat tail, the aft root corner — to its tip, as desktop's back view runs it
   * (FinSetShapes.uncantedShapesBack). Every fin was rooted at its parent's
   * LARGEST radius, so on a 54 -> 38 mm boat tail one 40 mm tall drew its tip
   * at 67 mm where it flies at 65 (audit 2026-09-30, on review).
   */
  const finBar = (n: ComponentNode, pStart: number, pLen: number, mount: MountSurface): [number, number] | null => {
    const xFront = axialStart(n, axialLength(n), pStart, pLen) - pStart;
    if (n.type === 'freeformfinset') {
      // Rows validated as the 3D pieces validate them, and fewer than three
      // draws nothing, as in every other view: an empty outline was a 30 mm bar.
      const raw = n['points'];
      if (!Array.isArray(raw) || raw.length < 3 || !raw.every((r) => Array.isArray(r) && r.length >= 2
        && Number.isFinite(r[0]) && Number.isFinite(r[1]))) return null;
      const { r0, outline } = finOnMount(raw as [number, number][], xFront, mount);
      const ys = outline.map(([, y]) => y);
      return [r0 + Math.min(...ys), r0 + Math.max(...ys)];
    }
    const r0 = mount.radiusAt(xFront);
    return [r0, r0 + kernelNum(n, 'height')];
  };

  // `mount` is the parent's outer surface, which a fin's root sits on; every
  // other child is placed by the one radius `pRadius`. `pStart` and `pLen`
  // place the children along the parent, as the 3D and side views place them.
  const walkChildren = (
    parent: ComponentNode, pRadius: number, cy: number, cz: number, pStart: number, pLen: number,
    mount: MountSurface = flatMount(pRadius, pLen), frameRoll = roll,
  ) => {
    for (const child of parent.children ?? []) {
      if (child.id && hidden.has(child.id)) continue;
      const t = child.type;
      if (isAssembly(t)) {
        const podRadius = resolveAssemblyRadius(child, pRadius);
        const count = assemblyInstanceCount(child);
        const podStart = axialStart(child, axialLength(child), pStart, pLen);
        for (const off of ringInstanceOffsets(count, podRadius, num(child, 'angleOffset', 0) + frameRoll)) {
          walkChain(child.children ?? [], cy + off.y, cz + off.z, podStart, off.angle);
        }
      } else if (t === 'trapezoidfinset' || t === 'ellipticalfinset' || t === 'freeformfinset') {
        const bar = finBar(child, pStart, pLen, mount);
        if (!bar) continue;
        const [from, to] = bar;
        const count = finCountOf(child);
        const thick = num(child, 'thickness', 0.003);
        for (let i = 0; i < count; i++) {
          // Angle 0 is +y — the kernel's own placement — and +y draws UP, so
          // an unrotated first fin still points straight up.
          const angle = num(child, 'rotation', 0) + frameRoll + (2 * Math.PI * i) / count;
          outer.push({
            key: keyFor(child), kind: 'fin', y: cy, z: cz, angle, from, to,
            thick, fill: colorOf(child, '#b9b7b0'), stroke: '#7a786f',
            title: `${child.name ?? 'Fins'} ×${count}`,
          });
        }
        reach(cy, cz, to);
      } else if (t === 'tubefinset') {
        const count = finCountOf(child);
        const rt = tubeFinRadius(child, pRadius);
        if (!(rt > 0)) continue;
        for (let i = 0; i < count; i++) {
          const angle = num(child, 'rotation', 0) + frameRoll + (2 * Math.PI * i) / count;
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
          key: keyFor(child), kind: 'shroud', y: cy, z: cz, angle: num(child, 'angleOffset', 0) + frameRoll,
          baseR: pRadius, height: hgt, width: wid, conformal: isConformal(child),
          fill: colorOf(child, '#c8c5be'), stroke: '#7a786f',
          title: child.name ?? 'Camera shroud',
        });
        reach(cy, cz, Math.hypot(pRadius + hgt, shroudHalfWidth(pRadius, wid, isConformal(child))));
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
          key: keyFor(child), kind: 'shroud', y: cy, z: cz, angle: num(child, 'angleOffset', 0) + frameRoll,
          baseR: pRadius, height: hgt, width: wid, conformal: false,
          fill: colorOf(child, '#c8c5be'), stroke: '#7a786f',
          title: `${child.name ?? 'Protuberance'}${count > 1 ? ` ×${count}` : ''}`,
        });
        reach(cy, cz, Math.hypot(pRadius + hgt, shroudHalfWidth(pRadius, wid, false)));
      } else if (t === 'launchlug' || t === 'railbutton') {
        // Angle 0 is the top of the side view, and the aft frame's +y is up,
        // so a lug at 0 draws at 12 o'clock here too — the two views agree.
        const a = num(child, 'angleOffset', 0) + frameRoll;
        // Line instances stack in this end-on projection — one shape, so the
        // title carries the count instead.
        const stackTitle = `${child.name ?? t}${lineInstanceCount(child) > 1 ? ` ×${lineInstanceCount(child)}` : ''}`;
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
          reach(cy, cz, Math.hypot(pRadius + num(child, 'totalHeight', 0.0097),
            shroudHalfWidth(pRadius, num(child, 'outerDiameter', 0.0097), false)));
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
        // The roll goes in as the VIEW's turn, not added to the rotation:
        // the kernel turns a pattern by MINUS its rotation (cluster.ts), so
        // `rotation + frameRoll` would spin the tubes against the rest of the view.
        const offs = clusterOffsets(
          child['cluster'] as string | undefined, r,
          num(child, 'clusterScale', 1), num(child, 'clusterRotation', 0),
          { radialDirection: num(child, 'radialDirection', 0), viewRoll: frameRoll },
        );
        // A tube can also sit OFF the centreline on its own (OpenRocket's
        // radial position/direction). Desktop's "split cluster" makes each
        // motor tube exactly that, so without this a split cluster draws as
        // one stack of tubes on the axis. Angle 0 is +y, like everything else.
        const rp = num(child, 'radialPosition', 0);
        const rd = num(child, 'radialDirection', 0) + frameRoll;
        const oy = rp * Math.cos(rd);
        const oz = rp * Math.sin(rd);
        const motor = child.id ? overrideFor(motors, child.id) : undefined;
        for (const off of offs) {
          inner.push({
            key: keyFor(child), kind: 'circle', y: cy + oy + off.y, z: cz + oz + off.z, r,
            fill: 'none', stroke: colorOf(child, '#9a978f'), dash: '3 2',
            title: child.name ?? 'Inner tube',
          });
          if (motor) {
            inner.push({
              key: keyFor(child, ':motor'), kind: 'circle', y: cy + oy + off.y, z: cz + oz + off.z, r: motor.diameter / 2,
              fill: AFT_MOTOR_FILL, stroke: 'var(--launch-active)', title: 'Motor',
            });
          }
          reach(cy + oy + off.y, cz + oz + off.z, r);
          // Children inherit every cluster instance (audit 2026-10-11, S3b-1).
          const len = axialLength(child);
          walkChildren(child, r, cy + oy + off.y, cz + oz + off.z, axialStart(child, len, pStart, pLen), len, undefined, frameRoll);
        }
      } else if (t === 'tubecoupler' || t === 'centeringring' || t === 'engineblock' || t === 'bulkhead') {
        const len = axialLength(child), start = axialStart(child, len, pStart, pLen);
        const surface = mount ?? flatMount(pRadius, pLen);
        const r = t === 'tubecoupler' ? num(child, 'outerRadius', parent['filled'] === true ? 0 : Math.max(0,
          Math.min(surface.radiusAt(start - pStart), surface.radiusAt(start - pStart + len)) - kernelNum(parent, 'thickness')))
          : Math.min(pRadius * 0.98, num(child, 'outerRadius', pRadius * 0.95));
        inner.push({
          key: keyFor(child), kind: 'circle', y: cy, z: cz, r,
          fill: 'none', stroke: colorOf(child, '#9a978f'), dash: '2 3',
          title: child.name ?? t,
        });
        if (t === 'tubecoupler') {
          walkChildren(child, r, cy, cz, start, len, undefined, frameRoll);
        }
      }
      // parachute/streamer/shockcord/mass: no meaningful cross-section here.
    }
  };

  /**
   * A chain member's hull radius and the surface its fins root on: the radius
   * and profile the side view draws it with (schematicLayout's drawnRadius and
   * profileMountOf), so a fin roots on one body in all three views. A tube or
   * nose with no radius is the 12 mm it flies; read as 0, neither it nor
   * anything on it was drawn.
   */
  const chainSurface = (n: ComponentNode, len: number): { r: number; mount: MountSurface } => {
    if (n.type === 'nosecone') {
      const r = drawnRadius(n);
      const { fore, aft } = noseEnds(n, r); // a tail cone's base is forward
      return { r, mount: profileMountOf(n, len, fore, aft) };
    }
    if (n.type === 'transition') {
      return { r: drawnRadius(n), mount: profileMountOf(n, len, num(n, 'foreRadius', 0.012), num(n, 'aftRadius', 0.009)) };
    }
    const r = n.type === 'bodytube' ? drawnRadius(n)
      : Math.max(num(n, 'outerRadius', 0), num(n, 'aftRadius', 0), num(n, 'foreRadius', 0));
    return { r, mount: flatMount(r, len) };
  };

  /** Walks a nose-to-tail chain from station `x0` (m); returns where it ends. */
  const walkChain = (nodes: ComponentNode[], cy: number, cz: number, x0 = 0, frameRoll = roll): number => {
    let x = x0;
    for (const n of nodes) {
      if (n.type === 'stage') {
        x = walkChain(n.children ?? [], cy, cz, x, frameRoll);
        continue;
      }
      const len = axialLength(n);
      if (n.id && hidden.has(n.id)) { x += len; continue; }
      const { r, mount } = chainSurface(n, len);
      if (r > 0) {
        hulls.push({
          key: keyFor(n), kind: 'circle', y: cy, z: cz, r,
          fill: colorOf(n, '#e7e5e0'), stroke: '#7a786f', title: n.name ?? n.type,
        });
        reach(cy, cz, r);
        // Body-tube mounts (minimum/sub-minimum builds) draw their motor too —
        // previously only inner tubes did.
        if (n.type === 'bodytube' && n['motorMount'] === true) {
          const motor = n.id ? overrideFor(motors, n.id) : undefined;
          if (motor) {
            inner.push({
              key: keyFor(n, ':motor'), kind: 'circle', y: cy, z: cz, r: motor.diameter / 2,
              fill: AFT_MOTOR_FILL, stroke: 'var(--launch-active)', title: 'Motor',
            });
          }
        }
        walkChildren(n, r, cy, cz, x, len, mount, frameRoll);
      }
      x += len;
    }
    return x;
  };

  walkChain(tree.components, 0, 0);

  // Big circles first so nested ones stay visible.
  hulls.sort((a, b) => (b.kind === 'circle' ? b.r : 0) - (a.kind === 'circle' ? a.r : 0));

  return { hulls, inner, outer, extent };
}

