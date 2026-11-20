import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { finOnMount, profileMount } from './finRoot.js';
import { seatedChordPoints, sectionMacPoints } from './finChords.js';
import { finMacFromOutline, finSectionSpec, sectionHalfThickness } from './finSection.js';
import { shapedFin } from './finSurface.js';
import { isWatertight, solidVolume } from './solidMesh.js';

it.each(['rounded', 'airfoil'])('r4 preserves the %s section at a stepped leading edge', crossSection => {
  const points: [number, number][] = [[0, 0], [0, 0.03], [0.05, 0.03], [0.05, 0.05], [0.08, 0.05], [0.1, 0]];
  const node: ComponentNode = { type: 'freeformfinset', points, thickness: 0.004, crossSection };
  const mesh = shapedFin(node, points, [points], 0.004)!.mesh;
  const step = mesh.pos.filter((_, i) => i % 3 === 2 && Math.abs(mesh.pos[i - 2]! - 0.05) < 1e-12 && Math.abs(mesh.pos[i - 1]! - 0.03) < 1e-12);
  expect(step.some(z => Math.abs(z) < 1e-12)).toBe(true);
  expect(step.every(z => Math.abs(z) < 1e-12)).toBe(true);
  // Measured from 83a04223's display mesh for this exact fixture (m³).
  const baseVolume = crossSection === 'rounded' ? 1.3821165708246058e-5 : 9.500921836805389e-6;
  const volume = solidVolume({ positions: Float64Array.from(mesh.pos), triangles: Uint32Array.from(mesh.tri) });
  expect(Math.abs(volume - baseVolume) / baseVolume).toBeLessThan(1e-6);
});

it.each(['rounded', 'airfoil'])('r4 preserves a stepped %s leading edge above a tapered mount', crossSection => {
  const points: [number, number][] = [[0, 0], [0, 0.03], [0.05, 0.03], [0.05, 0.05], [0.08, 0.05], [0.1, 0]];
  const mount = profileMount('conical', undefined, 0.1, 0.03, 0.02);
  const node: ComponentNode = { type: 'freeformfinset', points, thickness: 0.004, crossSection };
  const mesh = shapedFin(node, seatedChordPoints(points, 0, mount), finOnMount(points, 0, mount).lobes, 0.004)!.mesh;
  const step = mesh.pos.filter((_, i) => i % 3 === 2 && Math.abs(mesh.pos[i - 2]! - 0.05) < 1e-12 && Math.abs(mesh.pos[i - 1]! - 0.03) < 1e-12);
  expect(step.length).toBeGreaterThan(0);
  expect(step.every(z => Math.abs(z) < 1e-12)).toBe(true);
});

it('S4b-b1 measures section MAC with the sampled root, independently of exposed chords', () => {
  const points: [number, number][] = [[0, 0], [0, 0.021], [0.1, 0.021], [0.1, 0]];
  const mount = profileMount('ogive', 1, 0.1, 0.01, 0.03);
  const n: ComponentNode = { type: 'freeformfinset', points, crossSection: 'airfoil', airfoilSection: 'hexagonal', thickness: 0.004, airfoilLeDiamond: 0.01 };
  const macPoints = sectionMacPoints(points, 0, mount);
  const mac = finMacFromOutline(macPoints);
  // FinSetCalc's 48 strips over the physics-resolution root: about 59.660 mm.
  expect(mac).toBeCloseTo(0.059660, 6);
  const own = seatedChordPoints(points, 0, mount);
  expect(finMacFromOutline(own)).toBeGreaterThan(mac + 0.01);
  const shaped = shapedFin(n, own, finOnMount(points, 0, mount).lobes, 0.004, undefined, macPoints)!;
  expect(shaped.halfAt(0.005, 0.0205)).toBeCloseTo(sectionHalfThickness(finSectionSpec(n, mac), 0.1, 0.05), 12);
});

it('S4b-2 seats a flush rounded strake without a knife edge or overlapping opposing caps', () => {
  const points: [number, number][] = [[0, 0], [0.05, 0], [0.08, 0.04], [0.1, 0.04], [0.12, 0]];
  const mount = profileMount('conical', undefined, 0.12, 0.027, 0.019);
  const n: ComponentNode = { type: 'freeformfinset', points, thickness: 0.004, crossSection: 'rounded' };
  const loops = finOnMount(points, 0, mount).lobes;
  const shaped = shapedFin(n, seatedChordPoints(points, 0, mount), loops, 0.004)!;
  expect(shaped).not.toBeNull();
  expect.soft(shaped.halfAt(0.025, -0.001)).toBeGreaterThan(0.001);
  const { pos, tri, group } = shaped.mesh;
  const solid = { positions: Float64Array.from(pos), triangles: Uint32Array.from(tri) };
  expect.soft(isWatertight(solid)).toBe(true);
  expect.soft(solidVolume(solid)).toBeGreaterThan(0);
  type V = [number, number];
  const cross = (a: V, b: V, c: V) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const area = (poly: V[]) => Math.abs(poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length]![1] - p[1] * poly[(i + 1) % poly.length]![0], 0)) / 2;
  const caps: { y: number; sign: number; poly: V[] }[] = [];
  for (let t = 0; t < group.length; t++) {
    if (group[t] !== 2) continue;
    const indices = tri.slice(3 * t, 3 * t + 3);
    const poly = indices.map(i => [pos[3 * i]!, pos[3 * i + 2]!] as V);
    const signed = cross(poly[0]!, poly[1]!, poly[2]!);
    if (Math.abs(signed) > 1e-16) caps.push({ y: pos[3 * indices[0]! + 1]!, sign: Math.sign(signed), poly });
  }
  let overlap = 0;
  for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) {
    const a = caps[i]!, b = caps[j]!;
    if (a.sign === b.sign || Math.abs(a.y - b.y) > 1e-10) continue;
    let clipped = a.poly;
    for (let k = 0; k < 3 && clipped.length; k++) {
      const p = b.poly[k]!, q = b.poly[(k + 1) % 3]!;
      const out: V[] = [];
      for (let h = 0; h < clipped.length; h++) {
        const r = clipped[h]!, s = clipped[(h + 1) % clipped.length]!;
        const dr = b.sign * cross(p, q, r), ds = b.sign * cross(p, q, s);
        if (dr >= 0) out.push(r);
        if ((dr >= 0) !== (ds >= 0)) {
          const u = dr / (dr - ds);
          out.push([r[0] + u * (s[0] - r[0]), r[1] + u * (s[1] - r[1])]);
        }
      }
      clipped = out;
    }
    if (clipped.length >= 3) overlap += area(clipped);
  }
  expect(overlap, 'opposing cap overlap (m²)').toBeLessThan(1e-12);
});
