// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { makeNode } from '../tree/treeModel.js';
import { exportRkt, importRkt } from './rocksimFile.js';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { exportOrk, importOrk } from './orkFile.js';

const treeFor = (patch: Partial<ComponentNode> = {}): RocketTree => ({ name: 'Fillets', components: [
  { id: 'session-stage', type: 'stage', children: [
    { id: 'session-nose', type: 'nosecone', length: 0.1, aftRadius: 0.02, shape: 'conical' },
    { id: 'session-body', type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [
      { ...makeNode('trapezoidfinset'), id: 'session-fins', name: 'Tail fins', filletRadius: 0.003,
        filletDensity: 1250, filletMaterialName: 'Imported epoxy', ...patch },
    ] },
  ] },
] });
const fin = (tree: RocketTree) => tree.components[0]!.children![1]!.children![0]!;

describe('fillet export loss', () => {
  it.each(['rounded', 'airfoil'] as const)('reports .rkt parameter loss for %s fins even with calculated mass', (crossSection) => {
    const notes: string[] = [];
    const xml = exportRkt({ name: 'Fillets', tree: treeFor({ crossSection }), notes,
      compInfo: { 'session-fins': { mass: 0.025, cgX: 0.02, positionX: 0.35 } } });
    expect(notes.join(' ')).toMatch(/fillet radius and material.*not saved in \.rkt/i);
    expect(notes.join(' ')).toContain('Save a .ork file');
    expect(notes.join(' ')).toContain('recalculated mass and CG may change');
    expect(fin(importRkt(xml).tree)['filletRadius']).toBeUndefined();
    expect(xml).toContain('<CalcMass>25</CalcMass>');
    expect(xml).not.toContain('session-fins');
  });

  it('reports .CDX1 parameter loss while leaving the supplied total launch mass and CG intact', () => {
    const notes: string[] = [];
    const xml = exportCdx1({ name: 'Fillets', tree: treeFor(), notes, launchMassKg: 0.75, launchCgM: 0.2 });
    expect(notes.join(' ')).toMatch(/fillet radius and material.*not saved in \.CDX1/i);
    expect(notes.join(' ')).toContain('Save a .ork file');
    expect(fin(importCdx1(xml).tree)['filletRadius']).toBeUndefined();
    expect(xml).toBe(exportCdx1({ name: 'Fillets', tree: treeFor({ filletRadius: 0 }), launchMassKg: 0.75, launchCgM: 0.2 }));
    expect(xml).not.toContain('session-fins');
    const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.tsx'), 'utf8');
    const save = app.slice(app.indexOf('const onSaveCdx1 ='), app.indexOf('const onSaveCdx1 =') + 2400);
    expect(save).toContain('notes: filletNotes');
    expect(save).toContain('...filletNotes');
  });

  it('warns for a retained material at zero radius, but not a default unfilleted design', () => {
    for (const writer of [exportRkt, exportCdx1]) {
      const retained: string[] = [];
      writer({ name: 'Fillets', tree: treeFor({ filletRadius: 0 }), notes: retained });
      expect(retained.join(' ')).toMatch(/fillet radius and material/i);
      const empty: string[] = [];
      writer({ name: 'Fillets', tree: treeFor({ filletRadius: undefined, filletDensity: undefined, filletMaterialName: undefined }), notes: empty });
      expect(empty.join(' ')).not.toMatch(/fillet/i);
    }
  });

  it('preserves named material while fillets are disabled in .ork', () => {
    const xml = exportOrk({ name: 'Fillets', tree: treeFor({ filletRadius: 0 }) });
    const back = fin(importOrk(xml).tree);
    expect(back['filletRadius'] ?? 0).toBe(0);
    expect(back['filletMaterialName']).toBe('Imported epoxy');
    expect(back['filletDensity']).toBe(1250);
    expect(xml).not.toContain('session-fins');
  });
});
