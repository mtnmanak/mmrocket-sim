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

describe('.ork import — permissive handling of real desktop designs', () => {
  const DESKTOP_STYLE = `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12">
  <rocket>
    <name>Minimum Diameter</name>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>
          <nosecone>
            <name>Nose</name><length>0.1</length><thickness>0.001</thickness>
            <shape>haack</shape><aftradius>0.0125</aftradius>
          </nosecone>
          <bodytube>
            <name>Body</name><length>0.45</length><thickness>0.0005</thickness><radius>0.0125</radius>
            <subcomponents>
              <ellipticalfinset>
                <name>Fins</name><fincount>4</fincount><rootchord>0.06</rootchord><height>0.04</height>
              </ellipticalfinset>
              <launchlug><name>Lug</name><length>0.03</length></launchlug>
              <streamer><name>Streamer</name><striplength>0.5</striplength></streamer>
            </subcomponents>
            <motormount>
              <ignitionevent>automatic</ignitionevent>
              <motor configid="abc"><type>single</type><manufacturer>Estes</manufacturer>
                <designation>D12</designation><diameter>0.024</diameter><length>0.07</length><delay>5.0</delay></motor>
            </motormount>
          </bodytube>
        </subcomponents>
      </stage>
    </subcomponents>
  </rocket>
</openrocket>`;

  it('imports body-tube motor mounts, defaults unsupported fins, reports everything', () => {
    const result = importOrk(DESKTOP_STYLE);

    expect(result.name).toBe('Minimum Diameter');
    // Body tube became the mount host.
    expect(result.spec.motorMount.outerRadius).toBeCloseTo(0.0125, 12);
    expect(result.spec.motorMount.length).toBeCloseTo(0.45, 12);
    // Motor reference still extracted.
    expect(result.motor?.designation).toBe('D12');
    expect(result.motor?.diameter).toBeCloseTo(0.024, 12);
    // Elliptical fins -> defaults with a note; streamer/lug reported.
    expect(result.notes.join(' ')).toMatch(/elliptical/i);
    expect(result.notes.join(' ')).toMatch(/Motor mounts directly/i);
    expect(result.notes.join(' ')).toMatch(/parachute/i);
    expect(result.ignored).toContain('launchlug');
    expect(result.ignored).toContain('streamer');
  });

  it('accepts bare XML delivered as an ArrayBuffer (browser file input path)', () => {
    const bytes = new TextEncoder().encode(DESKTOP_STYLE);
    const buf = bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
    const result = importOrk(buf);
    expect(result.name).toBe('Minimum Diameter');
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
