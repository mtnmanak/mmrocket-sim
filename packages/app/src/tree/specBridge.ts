import type { ComponentNode, RocketSpec, RocketTree } from '@online-openrocket/engine';
import { freshId } from './treeModel.js';

/**
 * Bridges between the MVP fixed-shape RocketSpec (still used by .ork I/O
 * until P2.5) and the Phase 2 component tree.
 */

export function specToTree(name: string, spec: RocketSpec): RocketTree {
  const children: ComponentNode[] = [
    {
      type: 'trapezoidfinset', id: freshId(), name: 'Fins',
      finCount: spec.fins.count, rootChord: spec.fins.rootChord, tipChord: spec.fins.tipChord,
      sweep: spec.fins.sweep, height: spec.fins.height, thickness: spec.fins.thickness,
      density: spec.fins.materialDensity,
      position: { method: 'bottom', offset: 0 },
    },
    {
      type: 'innertube', id: freshId(), name: 'Motor mount',
      length: spec.motorMount.length, outerRadius: spec.motorMount.outerRadius,
      thickness: spec.motorMount.thickness, motorMount: true,
      position: { method: 'bottom', offset: 0 },
    },
  ];
  if (spec.parachute) {
    children.push({
      type: 'parachute', id: freshId(), name: 'Parachute',
      diameter: spec.parachute.diameter, cd: spec.parachute.dragCoefficient,
      position: { method: 'top', offset: 0.02 },
    });
  }
  return {
    name,
    components: [
      {
        type: 'nosecone', id: freshId(), name: 'Nose cone',
        length: spec.noseCone.length, aftRadius: spec.noseCone.aftRadius,
        thickness: spec.noseCone.thickness, shape: spec.noseCone.shape ?? 'ogive',
        density: spec.noseCone.materialDensity,
      },
      {
        type: 'bodytube', id: freshId(), name: 'Body tube',
        length: spec.bodyTube.length, outerRadius: spec.bodyTube.outerRadius,
        thickness: spec.bodyTube.thickness, density: spec.bodyTube.materialDensity,
        children,
      },
    ],
  };
}

const num = (n: ComponentNode | undefined, key: string, fb: number): number =>
  n && typeof n[key] === 'number' ? (n[key] as number) : fb;

/** Best-effort projection of a tree onto the fixed MVP spec (for .ork export until P2.5). */
export function treeToSpec(tree: RocketTree): RocketSpec {
  const all: ComponentNode[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) {
      all.push(n);
      walk(n.children ?? []);
    }
  };
  walk(tree.components);

  const nose = all.find((n) => n.type === 'nosecone');
  const body = all.find((n) => n.type === 'bodytube');
  const fins = all.find((n) => n.type === 'trapezoidfinset');
  const mount = all.find((n) => n.type === 'innertube' && n['motorMount'] === true)
    ?? all.find((n) => n.type === 'innertube');
  const chute = all.find((n) => n.type === 'parachute');

  return {
    noseCone: {
      length: num(nose, 'length', 0.07),
      aftRadius: num(nose, 'aftRadius', 0.012),
      thickness: num(nose, 'thickness', 0.002),
      shape: (nose?.['shape'] as RocketSpec['noseCone']['shape']) ?? 'ogive',
      materialDensity: nose && typeof nose['density'] === 'number' ? (nose['density'] as number) : undefined,
    },
    bodyTube: {
      length: num(body, 'length', 0.3),
      outerRadius: num(body, 'outerRadius', 0.012),
      thickness: num(body, 'thickness', 0.0003),
      materialDensity: body && typeof body['density'] === 'number' ? (body['density'] as number) : undefined,
    },
    fins: {
      count: num(fins, 'finCount', 3),
      rootChord: num(fins, 'rootChord', 0.05),
      tipChord: num(fins, 'tipChord', 0.03),
      sweep: num(fins, 'sweep', 0.02),
      height: num(fins, 'height', 0.03),
      thickness: num(fins, 'thickness', 0.003),
    },
    motorMount: {
      length: num(mount, 'length', 0.07),
      outerRadius: num(mount, 'outerRadius', 0.0095),
      thickness: num(mount, 'thickness', 0.0005),
    },
    parachute: chute
      ? {
          diameter: num(chute, 'diameter', 0.3),
          dragCoefficient: typeof chute['cd'] === 'number' ? (chute['cd'] as number) : undefined,
        }
      : undefined,
  };
}
