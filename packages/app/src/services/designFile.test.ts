// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyDesignNameFallback, designFileOpenFailure, designFileTooLarge, designFormatOf, GENERIC_ROCKET_NAMES,
  MAX_DESIGN_FILE_BYTES, openDesignFile, parseDesignFile,
} from './designFile.js';
import type { ImportedDesign } from './importApply.js';
import { gzipSync, zipSync } from 'fflate';

/**
 * THE FILE DOOR (2026-10-01): the size refusal, the format dispatch, the name
 * fallback and the open-failure sentence App's Open… used inline, moved here
 * so the headless open (simulateFile.ts) refuses, parses, names and words
 * exactly what the app does. Their sentences moved verbatim.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe('designFileTooLarge', () => {
  it('refuses one byte over 64 MiB with App’s sentence, and lets 64 MiB itself through', () => {
    expect(MAX_DESIGN_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(designFileTooLarge(MAX_DESIGN_FILE_BYTES + 1, 'huge.ork'))
      .toBe('huge.ork is 64 MB — that is not a rocket design. Nothing was opened.');
    expect(designFileTooLarge(MAX_DESIGN_FILE_BYTES, 'big.ork')).toBeNull();
    expect(designFileTooLarge(0, 'empty.ork')).toBeNull();
  });
});

describe('designFormatOf', () => {
  it('reads the extension, any case, and takes anything else for a .ork', () => {
    expect(designFormatOf('a.rkt')).toBe('rkt');
    expect(designFormatOf('a.RKT')).toBe('rkt');
    expect(designFormatOf('a.CDX1')).toBe('cdx1');
    expect(designFormatOf('a.cdx1')).toBe('cdx1');
    expect(designFormatOf('a.ork')).toBe('ork');
    expect(designFormatOf('a.zip')).toBe('ork');
    expect(designFormatOf('rkt.ork')).toBe('ork');
  });
});

describe('applyDesignNameFallback', () => {
  const named = (name: string | undefined): ImportedDesign =>
    ({ name: name ?? '', tree: { name, components: [] }, motors: {}, notes: [] }) as unknown as ImportedDesign;

  it('names a generic or unnamed design after its file: extension off, underscores to spaces', () => {
    for (const generic of ['Rocket', 'new rocket', ' Imported RASAero rocket ', 'IMPORTED ROCKSIM ROCKET', 'My Rocket']) {
      const d = named(generic);
      applyDesignNameFallback(d, 'Big_Bertha_v2.CDX1');
      expect(d.tree.name, generic).toBe('Big Bertha v2');
      expect(d.name).toBe('Big Bertha v2');
    }
    const blank = named(undefined);
    applyDesignNameFallback(blank, 'x.rkt');
    expect(blank.tree.name).toBe('x');
    expect(GENERIC_ROCKET_NAMES.has('imported rasaero rocket')).toBe(true);
  });

  it('keeps a real name, and a file name that is all extension changes nothing', () => {
    const d = named('Wildman');
    applyDesignNameFallback(d, 'other.ork');
    expect(d.tree.name).toBe('Wildman');
    const e = named('Rocket');
    applyDesignNameFallback(e, '.ork');
    expect(e.tree.name).toBe('Rocket');
  });
});

describe('designFileOpenFailure', () => {
  it('names the format the user picked, and the importer’s own words', () => {
    expect(designFileOpenFailure('a.rkt', new Error('This is an older BINARY RockSim file')))
      .toBe('Could not open that .rkt file: This is an older BINARY RockSim file');
    expect(designFileOpenFailure('a.cdx1', new Error('x'))).toBe('Could not open that .CDX1 file: x');
    expect(designFileOpenFailure('a.ORK', 'plain')).toBe('Could not open that .ork file: plain');
    expect(designFileOpenFailure('a.txt', new Error('y'))).toBe('Could not open that file: y');
  });
});

describe('parseDesignFile and openDesignFile', () => {
  it('passes the selected aero model to the RASAero import note', async () => {
    const xml = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>'
      + '<ModifiedBarrowman>False</ModifiedBarrowman></RocketDesign></RASAeroDocument>';
    const data = new TextEncoder().encode(xml).buffer;
    const imported = await openDesignFile(data, 'test.CDX1', { presets: [], aeroChoice: 'hybrid' });
    expect(imported.notes.filter((n) => n.includes('Modified Barrowman'))).toHaveLength(1);
    expect(imported.notes.join(' ')).toContain('model was Hybrid (experimental)');
    expect((await openDesignFile(data, 'test.CDX1', { presets: [], aeroChoice: 'eb' })).notes.join(' '))
      .not.toContain('Modified Barrowman');
  });
  it('dispatch by format: a RASAero file through the .CDX1 reader, named only by openDesignFile', async () => {
    // A RASAero file with no <Comments> has no name of its own.
    const parsed = await parseDesignFile(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', { presets: [] });
    expect(parsed.tree.name).toBe('Imported RASAero rocket');
    expect(parsed.sourceFormat).toBe('cdx1');
    const opened = await openDesignFile(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', { presets: [] });
    expect(opened.tree.name).toBe('My Test Rocket');
    expect(opened.name).toBe('My Test Rocket');
  });

  it('a .ork through the .ork reader, a .rkt through the RockSim reader', async () => {
    expect((await parseDesignFile(fixture('reference.ork'), 'unusual.backup', { presets: [] })).sourceFormat).toBe('ork');
    expect((await parseDesignFile(fixture('rocksimTestRocket1.rkt'), 'test.RKT', { presets: [] })).sourceFormat).toBe('rkt');
    expect((await parseDesignFile(fixture('reference.ork'), 'reference.ork', { presets: [] })).tree.components.length)
      .toBeGreaterThan(0);
    expect((await parseDesignFile(fixture('rocksimTestRocket1.rkt'), 'rocksimTestRocket1.rkt', { presets: [] })).tree.name)
      .toBe('FooBar Test');
    // The wrong reader for the bytes refuses them: the dispatch is by name.
    await expect(parseDesignFile(fixture('reference.ork'), 'reference.rkt', { presets: [] })).rejects.toThrow();
  });
});

/**
 * GZIP (board, 2026-10-11). Desktop's GeneralRocketLoader sniffs the gzip
 * magic (1f 8b) before it looks at the format, so it opens a gzip-compressed
 * .rkt or .CDX1 as it opens a gzip .ork. The app inflated only a .ork, and
 * handed the other two compressed bytes to the XML parser: "XML parse error".
 */
describe('a gzip-compressed .rkt or .CDX1 opens as desktop opens it', () => {
  const gz = (b: ArrayBuffer): ArrayBuffer => {
    const out = gzipSync(new Uint8Array(b));
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  };
  /** An import with every minted id blanked, so two reads of one design compare equal. */
  const withoutIds = (r: ImportedDesign): unknown => JSON.parse(JSON.stringify(
    { name: r.name, tree: r.tree, motors: Object.values(r.motors), notes: r.notes },
    (k, v: unknown) => (k === 'ignitionDefaults' ? Object.values(v as object) : k === 'id' || k === 'mountId' || k.endsWith('Id') ? '' : v)));

  it.each([
    ['rocksimTestRocket1.rkt', 'rkt'], ['FinsOnTransitions.rkt', 'rkt'],
    ['Complex.Two-Stage.CDX1', 'cdx1'], ['Three-stage rocket.CDX1', 'cdx1'],
  ] as const)('%s reads the same compressed as plain', async (name, format) => {
    const plain = await parseDesignFile(fixture(name), name, { presets: [] });
    const compressed = await parseDesignFile(gz(fixture(name)), name, { presets: [] });
    expect(compressed.sourceFormat).toBe(format);
    expect(compressed.tree.components.length).toBeGreaterThan(0);
    expect(withoutIds(compressed)).toEqual(withoutIds(plain));
  });

  it.each(['rocksimTestRocket1.rkt', 'Complex.Two-Stage.CDX1'])(
    'a damaged %s is refused as damaged, not as XML, and says so through the open failure', async (name) => {
      const bytes = new Uint8Array(gz(fixture(name)));
      const cut = bytes.slice(0, bytes.length - 20).buffer;
      const kind = name.endsWith('.rkt') ? '.rkt' : '.CDX1';
      let err: unknown;
      try { await parseDesignFile(cut, name, { presets: [] }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.startsWith(`Not a readable compressed ${kind} file — it is damaged`)).toBe(true);
      expect(designFileOpenFailure(name, err).startsWith(`Could not open that ${kind} file: Not a readable compressed`)).toBe(true);
    });

  it('a file that is only the two magic bytes is refused as damaged, not a crash', async () => {
    const magic = new Uint8Array([0x1f, 0x8b]).buffer;
    await expect(parseDesignFile(magic, 'x.rkt', { presets: [] })).rejects.toThrow(/compressed \.rkt file — it is damaged/);
    await expect(parseDesignFile(magic, 'x.CDX1', { presets: [] })).rejects.toThrow(/compressed \.CDX1 file — it is damaged/);
  });
});

/**
 * ZIP (board Tier 2, 2026-10-11, the residue of the gzip fix above). Desktop's
 * GeneralRocketLoader.loadStep1 opens a zip too: it reads the archive's FIRST
 * entry when that entry's name ends in .ork, .rkt or .CDX1. The .rkt reader
 * already took its member from a zip (zipMember.ts unzipMember); the .CDX1
 * reader handed the zip's bytes to the XML parser.
 */
describe('a zipped .CDX1 opens as desktop opens it', () => {
  const zipped = (entries: Record<string, Uint8Array>): ArrayBuffer => {
    const out = zipSync(entries);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  };
  const withoutIds = (r: ImportedDesign): unknown => JSON.parse(JSON.stringify(
    { name: r.name, tree: r.tree, motors: Object.values(r.motors), notes: r.notes },
    (k, v: unknown) => (k === 'ignitionDefaults' ? Object.values(v as object) : k === 'id' || k === 'mountId' || k.endsWith('Id') ? '' : v)));

  it.each(['Complex.Two-Stage.CDX1', 'Three-stage rocket.CDX1'])('%s reads the same zipped as plain', async (name) => {
    const plain = await parseDesignFile(fixture(name), name, { presets: [] });
    const fromZip = await parseDesignFile(zipped({ [name]: new Uint8Array(fixture(name)) }), name, { presets: [] });
    expect(fromZip.sourceFormat).toBe('cdx1');
    expect(fromZip.tree.components.length).toBeGreaterThan(0);
    expect(withoutIds(fromZip)).toEqual(withoutIds(plain));
  });

  it('takes the .CDX1 member, not a macOS sidecar that sorts ahead of it', async () => {
    const name = 'Complex.Two-Stage.CDX1';
    const data = zipped({
      [`__MACOSX/._${name}`]: new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]),
      'readme.txt': new TextEncoder().encode('not a design'),
      [`designs/${name.toLowerCase()}`]: new Uint8Array(fixture(name)),
    });
    expect(withoutIds(await parseDesignFile(data, name, { presets: [] })))
      .toEqual(withoutIds(await parseDesignFile(fixture(name), name, { presets: [] })));
  });

  it('an empty archive is refused by name, not as XML', async () => {
    await expect(parseDesignFile(zipped({}), 'x.CDX1', { presets: [] })).rejects.toThrow(/Empty \.CDX1 archive/);
  });
});
