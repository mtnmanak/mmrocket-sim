import { expect, it } from 'vitest';
import { OrkRocket, type MotorSpec } from './orkEngine.js';

const motor: MotorSpec = { designation: 'CG', diameter: 0.018, length: 0.1, cgX: 0.05,
  times: [0, 1, 2], thrusts: [0, 20, 0], masses: [0.02, 0.015, 0.01], ejectionDelay: 5 };
it.each([-1, 5, NaN, Infinity])('names an invalid motor CG before the bridge: %s', cgX => {
  const rocket = OrkRocket.buildTree({ components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'mount', motorMount: true }] }] });
  expect(() => rocket.setMotorById('mount', { ...motor, cgX })).toThrow(/Motor CG:.*CG/);
});
it('names a zero-thrust motor before the bridge', () => {
  const rocket = OrkRocket.buildTree({ components: [{ type: 'stage', children: [{ type: 'bodytube', id: 'mount', motorMount: true }] }] });
  expect(() => rocket.setMotorById('mount', { ...motor, thrusts: [0, 0, 0] })).toThrow(/Motor CG:.*positive thrust/);
});
