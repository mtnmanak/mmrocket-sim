// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { importOrk } from '../services/orkFile.js';
import { estimateMotorRoom } from './motorRoom.js';

/**
 * Motor room on real tester designs whose boat tail or base cone the mount tube passes through (audit E7, S4a-g1).
 * The files are local-only (docs/ is not in the repository), so these run where the corpus exists and skip
 * elsewhere; the synthetic flush boat-tail cases in motorRoom.test.ts cover the same rule everywhere. The expected
 * values are main's estimates, which the enclosing-shell change must keep.
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
  { file: 'CT-Concep98-External-Fincan.ork', expected: 0.4191 },
]) {
  it.skipIf(!existsSync(join(CORPUS, file)))(`keeps main's motor room for the tester file ${file}`, () => {
    const bytes = readFileSync(join(CORPUS, file));
    const tree = importOrk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).tree;
    expect(estimateMotorRoom(tree, mountIn(tree.components)!)?.lengthM).toBeCloseTo(expected, 9);
  });
}
