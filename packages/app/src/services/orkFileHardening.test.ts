// @vitest-environment happy-dom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { exportOrk, importOrk, type OrkExportConfig, type OrkExportMotor } from './orkFile.js';
import { MAX_ZIP_MEMBER_BYTES } from './zipMember.js';

/**
 * Hardening tests for the .ork importer/exporter: the untrusted-input paths
 * (zip member selection and its size cap), the file-sourced strings that reach
 * the exporter's XML, and the two round-trip losses beside them. The behaviour
 * tests for ordinary designs live in orkFile.test.ts.
 */

/** A minimal but real .ork document; `body` goes inside the sustainer stage. */
const orkXml = (body: string, extra = ''): string =>
  `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12">
  <rocket>
    <name>Test</name>
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>${body}</subcomponents>
      </stage>
    </subcomponents>
  </rocket>
  ${extra}
</openrocket>`;

const BODY_TUBE = '<bodytube><name>Tube</name><length>0.3</length>'
  + '<radius>0.025</radius><thickness>0.001</thickness></bodytube>';

const buf = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/**
 * Rewrite fields of ONE entry's central-directory record. That record is where
 * fflate reads the compression method and the uncompressed size from
 * (`zh()`: method at +10, uncompressed size at +24, name length at +28, name at
 * +46), so patching it is how a crafted archive is simulated without shipping
 * one: a bomb PROMISES a gigabyte in a few hundred bytes, and `method` 14 is a
 * probe that throws the moment fflate is asked to inflate that entry — which is
 * exactly what must never happen to an entry the importer does not want.
 * (rocksimFileHardening.test.ts carries the same helper for the .rkt path.)
 */
function patchZipEntry(zip: Uint8Array, name: string,
    patch: { method?: number; originalSize?: number }): void {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let b = 0; b + 46 <= zip.length; b++) {
    if (dv.getUint32(b, true) !== 0x02014b50) continue; // central-directory header
    const nameLen = dv.getUint16(b + 28, true);
    const entryName = new TextDecoder().decode(zip.subarray(b + 46, b + 46 + nameLen));
    if (entryName !== name) continue;
    if (patch.method !== undefined) dv.setUint16(b + 10, patch.method, true);
    if (patch.originalSize !== undefined) dv.setUint32(b + 24, patch.originalSize, true);
    return;
  }
  throw new Error(`no central-directory record for ${name}`);
}

function flatten(nodes: ComponentNode[]): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) { out.push(n); walk(n.children ?? []); }
  };
  walk(nodes);
  return out;
}

describe('.ork zip reading is bounded', () => {
  it('opens an ordinary zipped .ork', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(orkXml(BODY_TUBE)) });
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('never inflates an entry it will not read', () => {
    // The decoy is marked compression 14 (LZMA), which fflate refuses to
    // inflate — so the import can only succeed if the decoy is skipped before
    // any inflate. The old `unzipSync(bytes)` inflated EVERY entry to build the
    // map it then searched, which is the decompression-bomb vector: real files
    // carry megabytes of decals beside a 30 KB rocket.ork.
    const zip = zipSync({
      'decals/black_gloss.png': strToU8('x'.repeat(4096)),
      'rocket.ork': strToU8(orkXml(BODY_TUBE)),
    });
    patchZipEntry(zip, 'decals/black_gloss.png', { method: 14 });
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('refuses an entry that declares more than the cap', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(orkXml(BODY_TUBE)) });
    patchZipEntry(zip, 'rocket.ork', { originalSize: MAX_ZIP_MEMBER_BYTES + 1 });
    // Rejected on the DECLARED size, before the allocation fflate would size
    // from that same field — a caught Error the user can read, not an
    // out-of-memory tab that takes their open design with it.
    expect(() => importOrk(buf(zip))).toThrow(/expands to .* MB/);
    expect(() => importOrk(buf(zip))).toThrow(/not a rocket design/);
  });

  it('accepts a member right up to the cap', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(orkXml(BODY_TUBE)) });
    // 15.16 MB is the largest real member measured across this repo's corpus
    // (Wildman Mach 2 this one.ork); the cap has to clear it by a wide margin.
    patchZipEntry(zip, 'rocket.ork', { originalSize: MAX_ZIP_MEMBER_BYTES });
    expect(MAX_ZIP_MEMBER_BYTES).toBeGreaterThan(16 * 1024 * 1024);
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('skips a macOS AppleDouble sidecar that sorts first', () => {
    // `__MACOSX/._rocket.ork` also ends in ".ork", so the old name match
    // preferred the resource fork over the design and reported the user's own
    // file as an XML parse error.
    const zip = zipSync({
      '__MACOSX/._rocket.ork': new Uint8Array([0, 5, 22, 7, 0, 2]),
      'rocket.ork': strToU8(orkXml(BODY_TUBE)),
    });
    expect(importOrk(buf(zip)).name).toBe('Test');
  });

  it('names an empty archive instead of crashing on it', () => {
    expect(() => importOrk(buf(zipSync({})))).toThrow(/Empty \.ork archive/);
  });
});

describe('flight-configuration ids survive the exporter as XML', () => {
  // A configid is file-sourced free text kept verbatim as the stable key.
  // This one is legal in a .ork (`configid="Main &amp; backup"` and friends)
  // and breaks every unescaped interpolation: the bare & is not an entity, and
  // the quote closes the attribute.
  const WEIRD = 'Main & backup "<>';
  const MOTOR: OrkExportMotor = {
    designation: 'H128W', manufacturer: 'AeroTech', diameter: 0.029, length: 0.194, delay: 6,
  };
  const tree = {
    name: 'Cfg',
    components: [
      {
        type: 'stage', id: 'st1', name: 'Sustainer',
        children: [
          { type: 'bodytube', id: 'mount', motorMount: true, length: 0.3, outerRadius: 0.025, thickness: 0.001 },
          { type: 'parachute', id: 'chute', diameter: 0.6, deployEvent: 'apogee' },
        ],
      },
      {
        type: 'stage', id: 'st2', name: 'Booster',
        children: [{ type: 'bodytube', id: 'bt2', length: 0.2, outerRadius: 0.025, thickness: 0.001 }],
      },
    ] as unknown as ComponentNode[],
  };
  const configs: OrkExportConfig[] = [
    { id: WEIRD, name: 'A & B', isDefault: true, motors: { mount: MOTOR }, deployments: {}, separations: {} },
    {
      id: 'plain-2', name: null, isDefault: false, motors: { mount: MOTOR },
      deployments: { chute: { deployEvent: 'altitude', deployAltitude: 300 } },
      separations: { st2: { separationEvent: 'burnout' } },
    },
  ];
  const xml = exportOrk({
    name: 'Cfg', tree, motors: { mount: MOTOR }, configs, activeConfigId: WEIRD,
    launch: DEFAULT_CONDITIONS,
  });

  it('escapes the id at every one of the six emit sites', () => {
    expect(xml).not.toContain(WEIRD);
    // <motorconfiguration>, <deploymentconfiguration>, <separationconfiguration>,
    // <motor>, <ignitionconfiguration> attributes + the <configid> element.
    const escaped = 'Main &amp; backup &quot;&lt;&gt;';
    expect(xml.split(escaped).length - 1).toBe(6);
  });

  it('re-opens the file it just wrote, with the id intact', () => {
    // Declaration stripped exactly as importOrk strips it — this exporter
    // writes OpenRocket's single-quoted `<?xml version='1.0'?>`, which several
    // parsers (happy-dom's included) reject on sight.
    const doc = new DOMParser().parseFromString(xml.replace(/^<\?xml[^?]*\?>/, ''), 'text/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('openrocket > rocket > motorconfiguration')
      ?.getAttribute('configid')).toBe(WEIRD);
    const back = importOrk(xml);
    expect(back.configs.map((c) => c.id)).toEqual([WEIRD, 'plain-2']);
    expect(back.chosenConfigId).toBe(WEIRD);
    expect(back.configs[0]!.name).toBe('A & B');
  });
});

describe("a transition's shoulder caps round-trip", () => {
  const TRANSITION = '<transition><name>Boat tail</name><length>0.05</length>'
    + '<foreradius>0.038</foreradius><aftradius>0.028</aftradius><thickness>0.0012192</thickness>'
    + '<shape>conical</shape>'
    + '<foreshoulderradius>0.027</foreshoulderradius><foreshoulderlength>0.02</foreshoulderlength>'
    + '<foreshouldercapped>false</foreshouldercapped>'
    + '<aftshoulderradius>0.0381</aftshoulderradius><aftshoulderlength>0.025</aftshoulderlength>'
    + '<aftshoulderthickness>0.0012192</aftshoulderthickness>'
    + '<aftshouldercapped>true</aftshouldercapped></transition>';

  it('reads a capped aft shoulder and leaves an uncapped fore one alone', () => {
    const t = flatten(importOrk(orkXml(TRANSITION)).tree.components)
      .find((n) => n.type === 'transition')!;
    expect(t['aftShoulderCapped']).toBe(true);
    expect(t['foreShoulderCapped']).toBeUndefined();
  });

  it('writes the cap the design has, not a hard-coded false', () => {
    // The literal `false` deleted the cap — a disc of 38.1 mm radius and
    // 1.22 mm wall, several grams — from the builder's own file on every save.
    const out = exportOrk({ name: 'T', tree: importOrk(orkXml(TRANSITION)).tree });
    expect(out).toContain('<aftshouldercapped>true</aftshouldercapped>');
    expect(out).toContain('<foreshouldercapped>false</foreshouldercapped>');
    // ...and it still says true after a second trip through both halves.
    const twice = flatten(importOrk(out).tree.components).find((n) => n.type === 'transition')!;
    expect(twice['aftShoulderCapped']).toBe(true);
  });
});

describe('an imported atmosphere is checked before it reaches the engine', () => {
  const withAtmosphere = (inner: string): string => orkXml(BODY_TUBE,
    `<simulations><simulation status="notsimulated"><name>Sim</name>
      <conditions><atmosphere model="extendedisa">${inner}</atmosphere></conditions>
    </simulation></simulations>`);
  const atmosphereNotes = (notes: string[]) =>
    notes.filter((n) => /launch site states/.test(n));

  it('takes a real launch site verbatim', () => {
    const r = importOrk(withAtmosphere(
      '<basetemperature>293.15</basetemperature><basepressure>101325.0</basepressure>'));
    expect(r.launch?.temperatureC).toBeCloseTo(20, 9);
    expect(r.launch?.pressureHPa).toBeCloseTo(1013.25, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(0);
  });

  it('takes the edges of the envelope the panel enforces', () => {
    const r = importOrk(withAtmosphere(
      '<basetemperature>213.15</basetemperature><basepressure>30000</basepressure>'));
    expect(r.launch?.temperatureC).toBeCloseTo(-60, 9);
    expect(r.launch?.pressureHPa).toBeCloseTo(300, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(0);
  });

  it('refuses hPa written into the pascal-valued element, and says so', () => {
    // 1013.25 Pa is 1 % of sea-level density: drag collapses and apogee is
    // overstated several times over.
    const r = importOrk(withAtmosphere(
      '<basetemperature>293.15</basetemperature><basepressure>1013.25</basepressure>'));
    expect(r.launch?.pressureHPa).toBeNull();
    expect(r.launch?.temperatureC).toBeCloseTo(20, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(1);
    expect(atmosphereNotes(r.notes)[0]).toMatch(/1013\.25 Pa/);
    expect(atmosphereNotes(r.notes)[0]).toMatch(/standard atmosphere/);
  });

  it('refuses Celsius written into the kelvin-valued element, and says so', () => {
    // 20 K puts the speed of sound near 90 m/s, so a subsonic flight would be
    // computed on supersonic drag.
    const r = importOrk(withAtmosphere(
      '<basetemperature>20</basetemperature><basepressure>101325.0</basepressure>'));
    expect(r.launch?.temperatureC).toBeNull();
    expect(r.launch?.pressureHPa).toBeCloseTo(1013.25, 9);
    expect(atmosphereNotes(r.notes)).toHaveLength(1);
    expect(atmosphereNotes(r.notes)[0]).toMatch(/20 K/);
  });

  it('still reads the ISA marker as "blank = standard"', () => {
    const r = importOrk(orkXml(BODY_TUBE,
      `<simulations><simulation status="notsimulated"><name>Sim</name>
        <conditions><atmosphere model="isa"/></conditions>
      </simulation></simulations>`));
    expect(r.launch?.temperatureC).toBeNull();
    expect(r.launch?.pressureHPa).toBeNull();
    expect(atmosphereNotes(r.notes)).toHaveLength(0);
  });
});
