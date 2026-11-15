import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';

export function balanceMotor(peak = 100, burn = 2): MountMotor {
  return { label: 'Balance motor', meta: { label: 'Balance motor' }, ignition: { event: 'automatic', delay: 0 },
    spec: { designation: 'Balance motor', diameter: 0.029, length: 0.1, cgX: 0.05, ejectionDelay: 5,
      times: [0, 0.1, burn - 0.1, burn], thrusts: [0, peak, peak, 0], masses: [0.2, 0.19, 0.11, 0.1] } };
}

export function balanceTree(count = 4): RocketTree {
  return { name: 'Balance test', components: [{ type: 'stage', id: 'stage', name: 'Stage', children: [
    { type: 'bodytube', id: 'body', length: 1, outerRadius: 0.15, thickness: 0.002,
      children: Array.from({ length: count }, (_, i): ComponentNode => ({
        type: 'innertube', id: `m${i}`, name: `Mount ${i + 1}`, motorMount: true,
        length: 0.2, outerRadius: 0.02, radialPosition: 0.06, radialDirection: 2 * Math.PI * i / count,
      })),
    },
  ] }] };
}
