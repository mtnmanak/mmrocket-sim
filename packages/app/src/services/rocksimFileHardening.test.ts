// @vitest-environment happy-dom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { importRkt } from './rocksimFile.js';
import { MAX_ZIP_MEMBER_BYTES } from './zipMember.js';

/**
 * Hardening tests for the .rkt importer: the zipped-archive path (which used to
 * take whatever entry sorted first and crash on an empty archive), and the
 * shock-cord mass a stated `<KnownMass>` used to lose. Ordinary import/export
 * behaviour is covered by rocksimFile.test.ts.
 */

/** A minimal but real RockSim design; `parts` goes inside the sustainer slot. */
const rktXml = (parts: string): string =>
  `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign>
  <Name>Test</Name><StageCount>1</StageCount>
  <Stage3Parts>
    <BodyTube><Name>Tube</Name><OD>66</OD><ID>64</ID><Len>400</Len>
      <AttachedParts>${parts}</AttachedParts>
    </BodyTube>
  </Stage3Parts>
</RocketDesign></DesignInformation></RockSimDocument>`;

const buf = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/**
 * Rewrite fields of ONE entry's central-directory record — method at +10,
 * uncompressed size at +24, name length at +28, name at +46 (zipMember.ts,
 * mirroring fflate `zh()`). See the twin in orkFileHardening.test.ts for why: a
 * bomb PROMISES its size in a few hundred bytes, and compression method 14 is a
 * probe that throws the instant the reader is asked to inflate an entry the
 * importer never wanted.
 */
function patchZipEntry(zip: Uint8Array, name: string,
    patch: { method?: number; originalSize?: number }): void {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let b = 0; b + 46 <= zip.length; b++) {
    if (dv.getUint32(b, true) !== 0x02014b50) continue;
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

const SHOCK_CORD = (extra: string): string =>
  `<MassObject><Name>Shock cord</Name><TypeCode>1</TypeCode><Len>1000</Len>
    <Xb>100</Xb><LocationMode>0</LocationMode>${extra}</MassObject>`;

describe('a zipped .rkt picks the right member, bounded', () => {
  it('opens an ordinary zipped .rkt', () => {
    const zip = zipSync({ 'design.rkt': strToU8(rktXml('')) });
    expect(importRkt(buf(zip)).name).toBe('Test');
  });

  it('skips the macOS AppleDouble sidecar that sorts before the design', () => {
    // `__MACOSX/._design.rkt` first in the central directory is what a .rkt
    // zipped on a Mac looks like; the old first-entry read decoded that
    // resource fork as XML and told the user their good file was corrupt.
    const zip = zipSync({
      '__MACOSX/._design.rkt': new Uint8Array([0, 5, 22, 7, 0, 2, 255]),
      'design.rkt': strToU8(rktXml('')),
    });
    expect(importRkt(buf(zip)).name).toBe('Test');
  });

  it('never inflates an entry it will not read', () => {
    const zip = zipSync({
      'notes.bin': strToU8('x'.repeat(4096)),
      'design.rkt': strToU8(rktXml('')),
    });
    patchZipEntry(zip, 'notes.bin', { method: 14 });
    expect(importRkt(buf(zip)).name).toBe('Test');
  });

  it('refuses an entry that declares more than the cap', () => {
    const zip = zipSync({ 'design.rkt': strToU8(rktXml('')) });
    patchZipEntry(zip, 'design.rkt', { originalSize: MAX_ZIP_MEMBER_BYTES + 1 });
    expect(() => importRkt(buf(zip))).toThrow(/expands to .* MB/);
  });

  it('names an empty archive instead of crashing on undefined', () => {
    // `Object.values(unzipSync(bytes))[0]!` handed `undefined` to strFromU8 and
    // surfaced as "Cannot read properties of undefined".
    expect(() => importRkt(buf(zipSync({})))).toThrow(/Empty \.rkt archive/);
  });
});

describe("a shock cord's weighed mass is not thrown away", () => {
  it('keeps a stated KnownMass when the cord has no line density', () => {
    // DensityType 0 with Density 0: readRecoveryMaterial returns with no line
    // density at all, so deleting the override left the cord flying at the
    // kernel's default — the builder's 25 g gone with nothing in its place.
    const cord = flatten(importRkt(rktXml(SHOCK_CORD(
      '<UseKnownCG>1</UseKnownCG><KnownMass>25</KnownMass><DensityType>0</DensityType>'
      + '<Density>0</Density>'))).tree.components)
      .find((n) => n.type === 'shockcord')!;
    expect(cord['overrideMass']).toBeCloseTo(0.025, 12);
    expect(cord['lineDensity']).toBeUndefined();
    // The CG pin still goes (the kernel's packed length puts it at most
    // 12.5 mm off, and that call is deliberately unchanged).
    expect(cord['overrideCGX']).toBeUndefined();
  });

  it('keeps it beside a real line density too', () => {
    const cord = flatten(importRkt(rktXml(SHOCK_CORD(
      '<UseKnownCG>1</UseKnownCG><KnownMass>25</KnownMass><DensityType>2</DensityType>'
      + '<Density>0.005</Density>'))).tree.components)
      .find((n) => n.type === 'shockcord')!;
    expect(cord['overrideMass']).toBeCloseTo(0.025, 12);
    expect(cord['lineDensity']).toBeCloseTo(0.005, 12);
  });

  it('leaves a cord that states no mass alone', () => {
    const cord = flatten(importRkt(rktXml(SHOCK_CORD(
      '<UseKnownCG>0</UseKnownCG><KnownMass>0</KnownMass><DensityType>2</DensityType>'
      + '<Density>0.0018</Density>'))).tree.components)
      .find((n) => n.type === 'shockcord')!;
    expect(cord['overrideMass']).toBeUndefined();
    expect(cord['lineDensity']).toBeCloseTo(0.0018, 12);
  });

  it('names a cord kept against the file’s own CG flag', () => {
    // UseKnownMass 1 / UseKnownCG 0: the mass is applied (the 2026-08-23a
    // independent-flags ruling) and the note has to say so — the unconditional
    // keptWithoutCGFlag.delete() used to silence it while also dropping the mass.
    const r = importRkt(rktXml(SHOCK_CORD(
      '<UseKnownMass>1</UseKnownMass><UseKnownCG>0</UseKnownCG><KnownMass>25</KnownMass>'
      + '<DensityType>0</DensityType><Density>0</Density>')));
    const cord = flatten(r.tree.components).find((n) => n.type === 'shockcord')!;
    expect(cord['overrideMass']).toBeCloseTo(0.025, 12);
    expect(r.notes.some((n) => /known CG/.test(n))).toBe(true);
  });

  it('still folds a mass object’s KnownMass into its real mass', () => {
    // The non-cord branch is unchanged: KnownMass becomes `mass`, so the
    // duplicate override must still go or the mass counts twice.
    const mc = flatten(importRkt(rktXml(
      '<MassObject><Name>Altimeter</Name><TypeCode>0</TypeCode><Len>20</Len><Xb>50</Xb>'
      + '<LocationMode>0</LocationMode><UseKnownCG>1</UseKnownCG><KnownMass>30</KnownMass>'
      + '</MassObject>')).tree.components).find((n) => n.type === 'masscomponent')!;
    expect(mc['mass']).toBeCloseTo(0.03, 12);
    expect(mc['overrideMass']).toBeUndefined();
    expect(mc['overrideCGX']).toBe(0);
  });
});

describe('a CDATA section whose text holds "<![CDATA[" (audit 2026-09-22)', () => {
  it('is one section, closed by the first "]]>" after its own opener — as XML reads it', () => {
    // Legal XML: only "]]>" ends a section, so an opener inside one is text.
    // The split-on-opener pre-pass read that inner opener as a SECOND section,
    // left the real one unterminated, and the parser refused a valid file.
    const r = importRkt(rktXml(
      '<MassObject><Name><![CDATA[Bay <![CDATA[ & more]]></Name><TypeCode>0</TypeCode>'
      + '<Len>20</Len><Xb>50</Xb><LocationMode>0</LocationMode><KnownMass>30</KnownMass>'
      + '</MassObject>'));
    const mc = flatten(r.tree.components).find((n) => n.type === 'masscomponent')!;
    expect(mc.name).toBe('Bay <![CDATA[ & more');
  });

  it('leaves text after an unterminated opener alone, as the regex it replaced did', () => {
    // The opener with no "]]>" after it is not a section; nothing after it is
    // either. A well-formed section BEFORE it is still inlined.
    const r = importRkt(rktXml(
      '<MassObject><Name><![CDATA[A & B]]></Name><TypeCode>0</TypeCode><Len>20</Len>'
      + '<Xb>50</Xb><LocationMode>0</LocationMode><KnownMass>30</KnownMass></MassObject>'));
    expect(flatten(r.tree.components).find((n) => n.type === 'masscomponent')!.name).toBe('A & B');
    expect(() => importRkt(rktXml('<Comments><![CDATA[ never closed</Comments>'))).toThrow(/RockSim/);
  });
});

describe('an unreadable .rkt number is named, not silently defaulted (audit 2026-09-22)', () => {
  it('records the tag and its raw text once, and says the default stood in', () => {
    // `<OD>2,5</OD>` is not a number; the reader's fallback (a 24 mm tube) is a
    // real-looking size, so without a note every downstream figure is quietly wrong.
    const r = importRkt(rktXml(
      '<BodyTube><Name>Mount</Name><OD>2,5</OD><ID>23</ID><Len>70</Len></BodyTube>'
      + '<BodyTube><Name>Mount 2</Name><OD>2,5</OD><ID>23</ID><Len>70</Len></BodyTube>'));
    const note = r.notes.find((n) => /Could not read/.test(n));
    expect(note).toBeDefined();
    expect(note).toMatch(/<OD> “2,5”/);
    // One entry per tag, not per part.
    expect(note!.match(/<OD>/g)).toHaveLength(1);
    expect(note).toMatch(/^Could not read 1 number /);
  });

  it('stays silent for an ABSENT field and for ordinary numbers', () => {
    const r = importRkt(rktXml('<BodyTube><Name>Mount</Name><Len>70</Len></BodyTube>'));
    expect(r.notes.some((n) => /Could not read/.test(n))).toBe(false);
  });

  it('covers the engine-set and deployment readers too', () => {
    const xml = rktXml('<BodyTube><Name>Mount</Name><OD>24</OD><ID>23</ID><Len>70</Len>'
      + '<IsMotorMount>1</IsMotorMount><SerialNo>9</SerialNo></BodyTube>'
      + '<Parachute><Name>Main</Name><Dia>600</Dia><SerialNo>11</SerialNo></Parachute>')
      .replace('</RocketDesign>', '<SimulationEventList><SimulationEvent><PartSerialNo>11</PartSerialNo>'
        + '<Type>5</Type><DeployAltitude>1,5</DeployAltitude></SimulationEvent></SimulationEventList>'
        + '<SimulationResultsList><SimulationResults><Stage3Engines>'
        + '<EngineSet><EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg>'
        + '<EjectionDelay>five</EjectionDelay><MountSerialNo>9</MountSerialNo></EngineSet>'
        + '</Stage3Engines></SimulationResults></SimulationResultsList></RocketDesign>');
    const note = importRkt(xml).notes.find((n) => /Could not read/.test(n));
    expect(note).toMatch(/<EjectionDelay> “five”/);
    // The deployment reader's own field — an altitude main left on apogee.
    expect(note).toMatch(/<DeployAltitude> “1,5”/);
  });
});

describe('a refused .rkt fin outline is replaced by one the user can see (audit 2026-09-22)', () => {
  const crossing = rktXml('<CustomFinSet><Name>Fins</Name><FinCount>3</FinCount><Thickness>3</Thickness>'
    + '<Xb>0</Xb><LocationMode>2</LocationMode><PointList>60,0|0,30|60,30|0,0|</PointList></CustomFinSet>');
  const finIn = (r: ReturnType<typeof importRkt>) =>
    flatten(r.tree.components).find((n) => n.type === 'freeformfinset')!;

  it('carries the outline the simulator flies, and the note says so', () => {
    const r = importRkt(crossing);
    // Left with no points, the kernel flew FreeformFinSet's own 50 mm default
    // while the side view, the fin editor and every export drew nothing.
    expect(finIn(r)['points']).toEqual([[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]]);
    expect(r.notes.some((n) => /outline was not used — .*keeps a default outline/.test(n))).toBe(true);
  });

  it('flies exactly what the empty set flew — the kernel default, made visible', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const tree = importRkt(crossing).tree;
    const withDefault = OrkRocket.buildTree(engineTree(tree)).staticInfo();
    const fin = finIn({ tree } as ReturnType<typeof importRkt>);
    delete fin['points'];
    const empty = OrkRocket.buildTree(engineTree(tree)).staticInfo();
    expect(withDefault.mass).toBe(empty.mass);
    expect(withDefault.cp).toBe(empty.cp);
    expect(withDefault.cg).toBe(empty.cg);
  }, 60000);
});
