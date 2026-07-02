// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Golden .ork produced by the REAL OpenRocket 24.12 GeneralRocketSaver. */
function goldenOrk(): ArrayBuffer {
  const buf = readFileSync(join(here, '__fixtures__', 'reference.ork'));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('.ork import', () => {
  it('imports the desktop-generated golden file (zipped)', () => {
    const result = importOrk(goldenOrk());

    expect(result.name).toBe('Reference Rocket');
    expect(result.spec.noseCone.length).toBeCloseTo(0.07, 12);
    expect(result.spec.noseCone.aftRadius).toBeCloseTo(0.012, 12);
    expect(result.spec.noseCone.shape).toBe('ogive');
    expect(result.spec.bodyTube.length).toBeCloseTo(0.3, 12);
    expect(result.spec.bodyTube.materialDensity).toBeCloseTo(950, 9);
    expect(result.spec.fins.count).toBe(3);
    expect(result.spec.fins.rootChord).toBeCloseTo(0.05, 12);
    expect(result.spec.fins.sweep).toBeCloseTo(0.02, 12);
    expect(result.spec.motorMount.outerRadius).toBeCloseTo(0.0095, 12);
    expect(result.spec.parachute?.diameter).toBeCloseTo(0.3, 12);
    expect(result.spec.parachute?.dragCoefficient).toBeUndefined(); // "auto"
    expect(result.motor?.designation).toBe('C6');
    expect(result.motor?.delay).toBe(5);
    expect(result.ignored).toEqual([]);
  });
});

describe('.ork round trip', () => {
  it('export -> import preserves the design', () => {
    const original = importOrk(goldenOrk());
    const xml = exportOrk({
      name: original.name,
      spec: original.spec,
      motor: original.motor,
    });
    const roundTripped = importOrk(xml);

    expect(roundTripped.name).toBe(original.name);
    expect(roundTripped.spec).toEqual(original.spec);
    expect(roundTripped.motor?.designation).toBe('C6');
    expect(roundTripped.motor?.delay).toBe(5);
  });
});
