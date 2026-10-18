import { expect, it } from 'vitest';
import * as tubeHoles from './tubeHoles.js';
import type { ComponentNode } from '@online-openrocket/engine';

it('S5-1 exposes the operative defaults and marking helper without an unused type alias', () => {
  expect('TUBE_HOLE_TYPE' in tubeHoles).toBe(false);
  expect(tubeHoles.tubeHoleMarks({ type: 'tubehole' } as unknown as ComponentNode)).toHaveLength(1);
});
