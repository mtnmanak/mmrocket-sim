import { expect, it } from 'vitest';
import { OrkRocket, type MotorSpec } from './orkEngine.js';

const motor: MotorSpec = { designation: 'Delay test', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 1], thrusts: [0, 6, 0], masses: [0.02, 0.019, 0.01], cgX: 0.035, ejectionDelay: 0 };
it.each([-2, -Infinity, NaN])('B-S3-1 refuses invalid ejection delay %s at both kernel boundaries', delay => {
  const tree = OrkRocket.buildTree({ components: [{ type: 'bodytube', id: 'mount', length: 0.3, outerRadius: 0.012, motorMount: true }] });
  const legacy = OrkRocket.build({ noseCone: { length: 0.07, aftRadius: 0.012, thickness: 0.002 },
    bodyTube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003 },
    fins: { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
    motorMount: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 } });
  expect(() => tree.setMotorById('mount', { ...motor, ejectionDelay: delay })).toThrow(/Delay test.*ejection delay/);
  expect(() => legacy.setMotor({ ...motor, ejectionDelay: delay })).toThrow(/Delay test.*ejection delay/);
});
it.each([0, 2, Infinity])('accepts a nonnegative delay or plugged Infinity: %s', delay => {
  const tree = OrkRocket.buildTree({ components: [{ type: 'bodytube', id: 'mount', length: 0.3, outerRadius: 0.012, motorMount: true }] });
  expect(() => tree.setMotorById('mount', { ...motor, ejectionDelay: delay })).not.toThrow();
});
