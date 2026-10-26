// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { importOrk } from '../services/orkFile.js';
import { componentDxf } from '../services/dxfExport.js';
import { paperTemplateGeometry } from '../services/paperTemplates.js';
import { solidContextFor } from './solidContext.js';
import { componentLoop, componentSolid } from './solidMesh.js';

const NINJA = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/User files/TRF RASAero Files/ninja_4in_54mm-MMT.ork');
it.skipIf(!existsSync(NINJA))('exports the real ninja aft ring around centred mount and retainer tubes', async () => {
  const tree = importOrk(new Uint8Array(readFileSync(NINJA)).buffer).tree;
  const flatten = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
  const ring = flatten(tree.components).find(n => n.type === 'centeringring'
    && (n['position'] as { offset?: number } | undefined)?.offset === -0.01)!;
  expect(ring).toBeDefined();
  expect(Number(ring['outerRadius']) * 2).toBeCloseTo(0.0989838, 9);
  expect(Number(ring['innerRadius']) * 2).toBeCloseTo(0.0574802, 9);
  const ctx = solidContextFor(tree, ring);
  expect(componentLoop(ring, ctx)).not.toBeNull();
  expect(await componentSolid(ring, ctx)).not.toBeNull();
  expect(componentDxf(ring, ctx, 'Ninja')).not.toBeNull();
  expect(paperTemplateGeometry(ring, ctx).circles).toEqual([ring['outerRadius'], ring['innerRadius']]);
});
