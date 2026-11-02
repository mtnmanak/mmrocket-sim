// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { gzipSync, zipSync } from 'fflate';
import { parseDesignFile } from './designFile.js';
import { importOrk, exportOrk } from './orkFile.js';
import { importCdx1, exportCdx1 } from './rasaeroFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { highestTier, noteFlags } from './importNotes.js';
import { noteField } from './noteField.js';
import type { Preset } from './presets.js';

const xml = '<openrocket version="1.10"><rocket><name>Test</name><subcomponents><stage><subcomponents><bodytube><length>0.5</length><radius>0.03</radius></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>';
const raw = new TextEncoder().encode(xml);
const zip = (b: Uint8Array) => zipSync({ 'rocket.ork': b });
const buffer = (b: Uint8Array) => b.slice().buffer;

it.each([['zip-in-zip', zip(zip(raw))], ['gzip-in-zip', zip(gzipSync(raw))], ['gzip-in-gzip', gzipSync(gzipSync(raw))]])('refuses nested %s', async (_kind, bytes) => {
  await expect(parseDesignFile(buffer(bytes), 'test.ork', { presets: [] })).rejects.toThrow(/nested archive/i);
});
it.each([zip(raw), gzipSync(raw)])('keeps single-layer .ork imports', async bytes => {
  const r = await parseDesignFile(buffer(bytes), 'test.ork', { presets: [] });
  expect(r.name).toBe('Test');
  expect(r.tree.components[0]!.children![0]!.length).toBeCloseTo(0.5, 10);
});
it('bounds the file-format note filename before quoting it', async () => {
  const name = 'x'.repeat(210) + '\u202e.cdx1';
  const r = await parseDesignFile(buffer(raw), name, { presets: [] });
  const n = r.noteTiers!.find(n => n.kind === 'I22.file-format')!;
  expect(n.text).toContain(`“${noteField(name, 200)}”:`);
  expect(n.text).not.toContain('[U+202E]');
});
it('round trips BodyTube, Transition, BoatTail in station order', () => {
  const r = importCdx1('<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube><Transition><Length>3</Length><RearDiameter>2</RearDiameter></Transition><BoatTail><Length>2</Length><RearDiameter>1</RearDiameter></BoatTail><Booster><Length>10</Length><Diameter>2</Diameter><Location>23</Location></Booster></RocketDesign></RASAeroDocument>');
  const saved = exportCdx1({ name: r.name, tree: r.tree, motors: r.motors });
  expect(saved.indexOf('</Transition>')).toBeLessThan(saved.indexOf('<BoatTail>'));
  const reopened = importCdx1(saved);
  const geometry = (d: typeof r) => JSON.parse(JSON.stringify(d.tree.components, (key, value: unknown) => key === 'id' ? undefined : value));
  expect(geometry(reopened)).toEqual(geometry(r));
});
it('treats pre-rename preset links as app-owned', () => {
  const preset: Preset = { kind: 'Parachute', manufacturer: 'Test', partNo: 'P', description: 'Test chute', cd: 1.5, mass: 0.1 };
  const source = xml.replace('<bodytube>', '<bodytube><subcomponents><parachute><preset manufacturer="Test" partno="P"/></parachute></subcomponents>');
  const read = (creator: string) => importOrk(source.replace('<openrocket ', `<openrocket creator="${creator}" `), { presets: [preset] });
  const old = read('Online OpenRocket');
  const current = read('MMRocket Sim');
  expect(old.notes).toEqual(current.notes);
  const chute = (d: typeof old) => d.tree.components[0]!.children![0]!.children![0]!;
  expect(chute(old).cd).toBe(chute(current).cd);
  expect(chute(old).overrideMass).toBe(chute(current).overrideMass);
});
it('flags the elevated winds-aloft rod save disclosure as Caution', () => {
  const r = importOrk(xml);
  const notes: string[] = [];
  exportOrk({ name: r.name, tree: r.tree, motors: r.motors, notes, launch: { ...DEFAULT_CONDITIONS, launchAltitudeM: 100, launchRodAngleDeg: 5, windLevels: [{ altitude: 0, speed: 3, direction: 0 }] } });
  expect(notes.join(' ')).toContain('wrong height');
  expect(highestTier(noteFlags(notes))).toBe('caution');
});
it('ignores the unreleased ignition child while retaining the attribute', () => {
  const mount = '<motormount><ignitionevent>launch</ignitionevent><mmrignitionconfiguration configid="a"><ignitionevent>never</ignitionevent></mmrignitionconfiguration></motormount>';
  const source = xml.replace('<rocket>', '<rocket><motorconfiguration configid="a" default="true"><name>Test config</name></motorconfiguration>').replace('<bodytube>', `<bodytube>${mount}`).replace('<openrocket ', '<openrocket creator="MMRocket Sim" ');
  const r = importOrk(source);
  expect(r.configs[0]?.ignitions).toBeUndefined();
  const withAttr = importOrk(source.replace('<motormount>', '<motormount mmrignitions="[[&quot;a&quot;,&quot;never&quot;,0]]">'));
  expect(Object.values(withAttr.configs[0]!.ignitions ?? {})).toEqual([{ event: 'never', delay: 0 }]);
});
