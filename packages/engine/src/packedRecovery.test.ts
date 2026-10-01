import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode } from './orkEngine.js';

// KB1: requires rebuilding the Java bridge into vendor/orkengine.mjs.
// Intentionally active: the stale kernel must fail, never silently skip this gate.
//
// A recovery device is a kernel MassObject: a cylinder of its PACKED length and
// radius, its CG at half the packed length behind its front
// (MassObject.getComponentCG). Desktop's .ork loader sets both
// (DocumentConfig "MassObject:packedlength" -> setLength, ":packedradius" ->
// setRadius); the bridge set neither, so every parachute, streamer and shock
// cord flew MassObject's constructor default, 25 mm x 12.5 mm, whatever the
// design said - a 254 mm packed main put its CG 114.5 mm from where it is.
const build = (device: Record<string, unknown>) => OrkRocket.buildTree({
  name: 'KB1',
  components: [
    { type: 'nosecone', id: 'nose', length: 0.15, aftRadius: 0.025, thickness: 0.002 },
    {
      type: 'bodytube', id: 'body', length: 0.6, outerRadius: 0.025, thickness: 0.001,
      children: [{ id: 'dev', position: { method: 'top', offset: 0.05 }, ...device } as ComponentNode],
    },
  ],
});

const DEVICES: Record<string, unknown>[] = [
  { type: 'parachute', diameter: 0.6 },
  { type: 'streamer', stripLength: 0.8, stripWidth: 0.06 },
  { type: 'shockcord', cordLength: 1.5 },
];

describe('KB1 a recovery device flies its packed size', () => {
  for (const device of DEVICES) {
    it(`${device['type']}: packedLength is its length, and its CG sits at half of it`, () => {
      const info = build({ ...device, packedLength: 0.254, packedRadius: 0.02 }).componentInfo('dev');
      expect(info.length).toBeCloseTo(0.254, 9);
      expect(info.cgX).toBeCloseTo(0.127, 9);
    });

    it(`${device['type']}: no keys keep MassObject's own 25 mm x 12.5 mm`, () => {
      const info = build(device).componentInfo('dev');
      expect(info.length).toBeCloseTo(0.025, 9);
      expect(info.cgX).toBeCloseTo(0.0125, 9);
    });

    it(`${device['type']}: the packed size moves the mass, never changes it`, () => {
      const bare = build(device);
      const packed = build({ ...device, packedLength: 0.254, packedRadius: 0.02 });
      const m = bare.componentInfo('dev').mass;
      expect(m).toBeGreaterThan(0);
      expect(packed.componentInfo('dev').mass).toBeCloseTo(m, 12);
      // The whole rocket's dry CG moves by the device's mass times the shift of
      // its own CG (0.127 - 0.0125 m), over the rocket's dry mass.
      const before = bare.staticInfo();
      const after = packed.staticInfo();
      const expected = (m * (0.127 - 0.0125)) / before.massEmpty;
      expect(after.cgEmpty - before.cgEmpty).toBeGreaterThan(0);
      expect(Math.abs((after.cgEmpty - before.cgEmpty) - expected) / expected).toBeLessThan(1e-6);
    });
  }

  it('a bottom-anchored chute keeps its aft end on the tube end, so its front moves forward', () => {
    const bottom = (extra: Record<string, unknown>) => OrkRocket.buildTree({
      name: 'KB1b',
      components: [{
        type: 'bodytube', id: 'body', length: 0.6, outerRadius: 0.025, thickness: 0.001,
        children: [{ type: 'parachute', id: 'dev', diameter: 0.6, position: { method: 'bottom', offset: 0 }, ...extra }],
      }],
    }).componentInfo('dev');
    expect(bottom({}).positionX).toBeCloseTo(0.6 - 0.025, 9);
    expect(bottom({ packedLength: 0.254 }).positionX).toBeCloseTo(0.6 - 0.254, 9);
  });

  it('packedRadius sets the cylinder the roll inertia is taken over', () => {
    // MassObject.getRotationalUnitInertia = r^2 / 2, about the rocket axis.
    const chute = { type: 'parachute', diameter: 0.6 };
    const thin = build({ ...chute, packedRadius: 0.005 });
    const fat = build({ ...chute, packedRadius: 0.02 });
    const m = thin.componentInfo('dev').mass;
    const dIxx = fat.staticInfo().rotationalInertiaEmpty - thin.staticInfo().rotationalInertiaEmpty;
    const expected = (m * (0.02 ** 2 - 0.005 ** 2)) / 2;
    expect(Math.abs(dIxx - expected) / expected).toBeLessThan(1e-6);
  });
});
