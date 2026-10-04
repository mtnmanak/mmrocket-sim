// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyDesignNameFallback, designFileOpenFailure, designFileTooLarge, designFormatOf, GENERIC_ROCKET_NAMES,
  MAX_DESIGN_FILE_BYTES, openDesignFile, parseDesignFile,
} from './designFile.js';
import type { ImportedDesign } from './importApply.js';

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
  it('passes the selected aero model to the RASAero import note', () => {
    const xml = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>'
      + '<ModifiedBarrowman>False</ModifiedBarrowman></RocketDesign></RASAeroDocument>';
    const data = new TextEncoder().encode(xml).buffer;
    const imported = openDesignFile(data, 'test.CDX1', { presets: [], aeroChoice: 'hybrid' });
    expect(imported.notes.filter((n) => n.includes('Modified Barrowman'))).toHaveLength(1);
    expect(imported.notes.join(' ')).toContain('model was Hybrid (experimental)');
    expect(openDesignFile(data, 'test.CDX1', { presets: [], aeroChoice: 'eb' }).notes.join(' '))
      .not.toContain('Modified Barrowman');
  });
  it('dispatch by format: a RASAero file through the .CDX1 reader, named only by openDesignFile', () => {
    // A RASAero file with no <Comments> has no name of its own.
    const parsed = parseDesignFile(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', { presets: [] });
    expect(parsed.tree.name).toBe('Imported RASAero rocket');
    const opened = openDesignFile(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', { presets: [] });
    expect(opened.tree.name).toBe('My Test Rocket');
    expect(opened.name).toBe('My Test Rocket');
  });

  it('a .ork through the .ork reader, a .rkt through the RockSim reader', () => {
    expect(parseDesignFile(fixture('reference.ork'), 'reference.ork', { presets: [] }).tree.components.length)
      .toBeGreaterThan(0);
    expect(parseDesignFile(fixture('rocksimTestRocket1.rkt'), 'rocksimTestRocket1.rkt', { presets: [] }).tree.name)
      .toBe('FooBar Test');
    // The wrong reader for the bytes refuses them: the dispatch is by name.
    expect(() => parseDesignFile(fixture('reference.ork'), 'reference.rkt', { presets: [] })).toThrow();
  });
});
