// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { importOrk } from '../services/orkFile.js';
import { estimateMotorRoom } from './motorRoom.js';
import { absoluteStations } from './position.js';
import { findNode } from './treeModel.js';

/**
 * Motor room on real tester designs whose boat tail or base cone the mount tube passes through (audit E7, S4a-g1).
 * The files are local-only (docs/ is not in the repository), so these run where the corpus exists and skip
 * elsewhere; the synthetic boat-tail cases in motorRoom.test.ts cover the same rule everywhere.
 * CT's mount extends 50.8 mm past its host tube: the open flare it passes through is not a wall.
 */
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/User files');
const mountIn = (nodes: ComponentNode[]): string | undefined => {
  for (const n of nodes) {
    if (n['motorMount'] === true && typeof n.id === 'string') return n.id;
    const inner = mountIn((n.children ?? []) as ComponentNode[]);
    if (inner) return inner;
  }
  return undefined;
};

for (const { file, expected } of [
  { file: 'Buckeye Files/pringles 2 - baseconehack.ork', expected: 0.26035 },
  { file: 'CT-Concep98-External-Fincan.ork', expected: 1.222045 },
]) {
  it.skipIf(!existsSync(join(CORPUS, file)))(`estimates motor room for the tester file ${file}`, () => {
    const bytes = readFileSync(join(CORPUS, file));
    const tree = importOrk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).tree;
    const mountId = mountIn(tree.components)!;
    const mount = findNode(tree, mountId)!;
    const room = estimateMotorRoom(tree, mountId);
    if (file === 'CT-Concep98-External-Fincan.ork') {
      const stations = absoluteStations(tree), span = stations.get(mountId)!;
      const host = stations.get(span.parent!.id!)!;
      expect(span.start).toBeCloseTo(1.655445, 9);
      expect(span.end).toBeCloseTo(2.569845, 9);
      expect(host.end).toBeCloseTo(2.519045, 9);
      expect(room!.lengthM).toBeGreaterThan(mount['length'] as number);
    }
    expect(room?.lengthM).toBeCloseTo(expected, 9);
  });
}
