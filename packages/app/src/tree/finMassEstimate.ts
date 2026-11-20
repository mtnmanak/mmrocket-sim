import type { ComponentNode } from '@online-openrocket/engine';
import { finCountOf } from './counts.js';
import { KERNEL_DEFAULT_MATERIALS, kernelNum } from './kernelDefaults.js';
import { numOpt } from './nodeNum.js';
import { signedArea } from './polygon.js';
import { finPlanformPoints } from './solidMesh.js';
import { finOnMount, type MountSurface } from './finRoot.js';

/** Outline-only airfoil mass in kg; tabs and fillets are deliberately omitted. */
export function airfoilFinMassEstimate(node: ComponentNode, mount?: MountSurface, front = 0): number | undefined {
  const points = finPlanformPoints(node);
  if (!points) return undefined;
  const lobes = node.type === 'freeformfinset' && mount ? finOnMount(points, front, mount, 100).lobes : [points];
  const area = lobes.reduce((sum, lobe) => sum + Math.abs(signedArea(lobe)), 0);
  const thickness = kernelNum(node, 'thickness');
  const density = numOpt(node, 'density');
  const bulkDensity = density !== undefined && density > 0 ? density : KERNEL_DEFAULT_MATERIALS.bulk.density;
  // FinSet.CrossSection.AIRFOIL's volume factor, independent of the drawing law.
  const mass = finCountOf(node) * area * thickness * bulkDensity * 0.85;
  return Number.isFinite(area) && area > 0 && Number.isFinite(thickness) && thickness > 0
    && Number.isFinite(mass) && mass > 0 ? mass : undefined;
}
