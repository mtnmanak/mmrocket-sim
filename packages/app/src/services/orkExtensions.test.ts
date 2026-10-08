// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt } from './rocksimFile.js';
import { exportCdx1 } from './rasaeroFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { parseXml, currentXmlParser, browserXmlParser } from './xmlParse.js';
import { planImport, resolveImportMotors } from './importApply.js';
import { designStateFromSession } from './sessionRestore.js';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { preservedSimulationExtensions } from './orkExtensions.js';
import { autosaveToOrk } from './autosaveBackup.js';

// Hand-written XML, deliberately unlike a serializer's output (CRLF, entities,
// single quotes, CDATA, comments, and a > inside an attribute).
const script = `<extension extensionid='info.openrocket.core.simulation.extension.impl.ScriptingExtension' note="a > b">\r\n`
  + `  <entry type="string" key="language">JavaScript</entry>\r\n`
  + `  <!-- keep &amp; this comment -->\r\n`
  + `  <entry key='script' type='string'>globalThis.__extensionExecuted();\r\n`
  + `var text = "&lt;extension extensionid='fake'/&gt;&lt;/simulation&gt;";</entry>\r\n`
  + `  <entry key="enabled" type="boolean">true</entry>\r\n</extension>`;
const air = `<extension extensionid="net.sf.openrocket.simulation.extension.example.AirStart">`
  + `<entry key="launchAltitude" type="double">100.00</entry>`
  + `<entry key="launchVelocity" type="double">5&#48;</entry></extension>`;
const sim = (id: string, extensions: string, name = id) => `<simulation status="notsimulated"><name>${name}</name>`
  + `<conditions><configid>${id}</configid></conditions>${extensions}</simulation>`;
const fixture = (sims = sim('B', air) + sim('A', script), configs = true) =>
  `<openrocket version="1.10"><rocket><name>Extensions</name>${configs
    ? '<motorconfiguration configid="A" default="true"><name>A</name></motorconfiguration>'
      + '<motorconfiguration configid="B"><name>B</name></motorconfiguration>' : ''}`
  + `<subcomponents><stage><name>Main</name><subcomponents><bodytube><length>0.3</length>`
  + `<radius>0.02</radius><thickness>0.001</thickness></bodytube></subcomponents></stage></subcomponents>`
  + `</rocket><simulations>${sims}</simulations></openrocket>`;
const save = (opened: ReturnType<typeof importOrk>, notes: string[] = []) => exportOrk({
  ...opened, launch: DEFAULT_CONDITIONS, configs: opened.configs, activeConfigId: opened.chosenConfigId, notes,
});
const simulations = (xml: string) => Array.from(parseXml(xml.replace(/^<\?xml[^?]*\?>/, ''), 'bad export')
  .querySelectorAll('simulations > simulation'));

afterEach(() => vi.unstubAllGlobals());

describe('opaque desktop simulation extensions', () => {
  // happy-dom 20 rejects all CDATA; the JS project tests the valid XML that
  // native browser DOMParser accepts. Do not weaken the production parser.
  it.skipIf(currentXmlParser() === browserXmlParser)('preserves CDATA containing fake closing tags', () => {
    const cdata = `<extension extensionid="custom.Cdata"><entry><![CDATA[</extension></simulation><extension/>]]></entry></extension>`;
    expect(save(importOrk(fixture(sim('A', '<?keep <extension/> ?>' + cdata))))).toContain(cdata);
  });
  it('round-trips each raw block in its own simulation, after conditions and before flightdata', () => {
    const opened = importOrk(fixture());
    const output = exportOrk({ ...opened, launch: DEFAULT_CONDITIONS,
      flightData: { A: { maxAltitude: 12 } }, activeConfigId: 'A' });
    expect(output).toContain(script);
    expect(output).toContain(air);
    const sims = simulations(output);
    expect(sims.find(s => s.querySelector('conditions > configid')?.textContent === 'A')?.querySelector('extension')?.getAttribute('extensionid'))
      .toContain('ScriptingExtension');
    expect(sims.find(s => s.querySelector('conditions > configid')?.textContent === 'B')?.querySelector('extension')?.getAttribute('extensionid'))
      .toContain('AirStart');
    expect(output.indexOf(script)).toBeGreaterThan(output.lastIndexOf('</conditions>', output.indexOf(script)));
    expect(output.indexOf(script)).toBeLessThan(output.indexOf('<flightdata'));
    // Results flown without extensions cannot be advertised as current on desktop.
    expect(sims[0]?.getAttribute('status')).toBe('outdated');
    expect(save(importOrk(output))).toContain(script);
    for (const node of opened.tree.components) expect(output).not.toContain(`id="${node.id}"`);
  });

  it('states counts, kinds, the execution limit and the enabled-script consequence', async () => {
    const opened = importOrk(fixture());
    const note = opened.notes.join('\n');
    expect(note).toContain('This file contains 2 simulation extensions');
    expect(note).toContain('JavaScript script');
    expect(note).toContain('Air-start');
    expect(note).toContain('the app keeps them when you save as .ork but does not run them; flights here run without them.');
    expect(note).toMatch(/enabled.*desktop OpenRocket would run.*trusted.*app.*numbers may differ/i);
    const plan = planImport(opened, await resolveImportMotors(opened), {
      launch: DEFAULT_CONDITIONS, text: { mass: kg => `${kg} kg`, length: m => `${m} m` },
    });
    expect(plan.note.severity).toBe('warn');
    const restored = designStateFromSession(JSON.parse(JSON.stringify({ ...plan.snapshot,
      launch: DEFAULT_CONDITIONS, savedAt: 1, emptyConfigVersion: 1 })), { legacyMaxMotorLengthM: null });
    expect(restored.state.savedConfigs.every(c => Object.keys(c.motors).length === 0)).toBe(true);
    expect(exportOrk({ name: opened.name, tree: restored.state.tree,
      configs: restored.state.savedConfigs.map(c => ({ ...c, motors: {} })),
      launch: DEFAULT_CONDITIONS })).toContain(script);
    expect(autosaveToOrk({ ...restored.state, savedAt: 1 })).toContain(script);
    expect(preservedSimulationExtensions(restored.state.tree).map(g => g.configId)).toEqual(['B', 'A']);
  });

  it('does not merge extensions from separate simulations sharing a configuration', () => {
    const output = save(importOrk(fixture(sim('A', script, 'Script run') + sim('A', air, 'Air run'))));
    const sims = simulations(output).filter(s => s.querySelector('conditions > configid')?.textContent === 'A');
    expect(sims).toHaveLength(2);
    expect(sims.map(s => s.querySelectorAll('extension').length)).toEqual([1, 1]);
    expect(sims.map(s => s.querySelector('name')?.textContent)).toEqual(['Script run', 'Air run']);
  });

  it('reports dropped extensions when their configuration is deleted, without moving them to the remaining one', () => {
    const opened = importOrk(fixture());
    opened.configs = opened.configs.filter(c => c.id !== 'A');
    const notes: string[] = [];
    const output = save(opened, notes);
    expect(output).not.toContain(script);
    expect(output).toContain(air);
    expect(notes.join(' ')).toMatch(/1 simulation extension.*not saved.*simulation.*no longer/i);
  });

  it('states an unmappable simulation loss, including saves without launch conditions', () => {
    const opened = importOrk(fixture(sim('missing', script)));
    const notes: string[] = [];
    expect(save(opened, notes)).not.toContain(script);
    expect(notes.join(' ')).toMatch(/1 simulation extension.*not saved/i);
    const noLaunch: string[] = [];
    exportOrk({ ...importOrk(fixture()), launch: undefined, notes: noLaunch });
    expect(noLaunch.join(' ')).toMatch(/2 simulation extensions.*not saved/i);
  });

  it('keeps a dry unnamed configuration with extensions, and maps the no-config fallback', () => {
    const dry = fixture(sim('A', script)).replace('<name>A</name></motorconfiguration>', '</motorconfiguration>')
      .replace('<motorconfiguration configid="B"><name>B</name></motorconfiguration>', '');
    expect(importOrk(dry).configs).toHaveLength(1);
    expect(save(importOrk(dry))).toContain(script);
    const untagged = dry.replace('<configid>A</configid>', '');
    expect(importOrk(untagged).configs).toHaveLength(1);
    expect(save(importOrk(untagged))).toContain(script);
    expect(save(importOrk(fixture(sim('', script), false)))).toContain(script);
    const noConfigs = save(importOrk(fixture(sim('', script) + sim('', air), false)));
    expect(noConfigs).toContain(script);
    expect(noConfigs).toContain(air);
  });

  it('refuses aggregate extension XML beyond 1 MiB, counting UTF-8 bytes across simulations', () => {
    const block = `<extension extensionid="unknown"><entry>${'é'.repeat(270000)}</entry></extension>`;
    expect(() => importOrk(fixture(sim('A', block) + sim('B', block))))
      .toThrow(/simulation extension.*1,048,576.*bytes/i);
    expect(save(importOrk(fixture(sim('A', block))))).toContain(block);
  });

  it('keeps unknown ids and Java code, ignores lookalikes in comments, and never executes scripts', () => {
    const executed = vi.fn();
    vi.stubGlobal('__extensionExecuted', executed);
    const java = '<extension extensionid="info.openrocket.core.simulation.extension.impl.JavaCode"/>';
    const unknown = '<extension extensionid="custom.Unknown"><entry type="string">&lt;script&gt;</entry></extension>';
    const opened = importOrk(fixture(sim('A', script + java + unknown + '<!-- <extension/> -->')));
    const output = save(opened);
    expect(opened.notes.join(' ')).toContain('3 simulation extensions');
    expect(opened.notes.join(' ')).toContain('Java code');
    expect(opened.notes.join(' ')).toContain('custom.Unknown');
    for (const block of [script, java, unknown]) expect(output).toContain(block);
    expect(executed).not.toHaveBeenCalled();
  });

  it.each(['zip', 'gzip'] as const)('preserves raw extension bytes from a %s .ork', format => {
    const bytes = format === 'zip' ? zipSync({ 'rocket.ork': strToU8(fixture()) }) : gzipSync(strToU8(fixture()));
    const xml = save(importOrk(bytes.buffer as ArrayBuffer));
    expect(xml).toContain(script);
    expect(xml).toContain(air);
  });

  it('does not call a disabled script enabled, and retains its language and flag', () => {
    const disabled = script.replace('>true</entry>', '>false</entry>').replace('>JavaScript<', '>Groovy<');
    const opened = importOrk(fixture(sim('A', disabled)));
    expect(opened.notes.join(' ')).toContain('Groovy script');
    expect(opened.notes.join(' ')).not.toContain('desktop OpenRocket would run');
    expect(save(opened)).toContain(disabled);
  });

  it('preserves extensions under an unknown wrapper', () => {
    const opened = importOrk(fixture(sim('A', '<wrapper>' + air + '</wrapper>')));
    expect(save(opened)).toContain(air);
    expect(opened.notes.join(' ')).toContain('1 simulation extension (Air-start)');
  });

  it('refuses corrupt or oversized raw XML restored from a session before emitting it', () => {
    for (const raw of ['<rocket/>', '<extension/></simulation><simulation><extension/>', '<extension><broken></extension>',
      `<extension>${'x'.repeat(1024 * 1024)}</extension>`]) {
      const opened = importOrk(fixture());
      const stored = preservedSimulationExtensions(opened.tree);
      stored[0]!.xml[0] = raw;
      expect(() => save(opened)).toThrow(/simulation extension.*(invalid|bytes)/i);
    }
  });

  it.each([['.rkt', exportRkt], ['.CDX1', exportCdx1]] as const)('reports %s extension loss', (format, writer) => {
    const opened = importOrk(fixture());
    const notes: string[] = [];
    expect(writer({ name: opened.name, tree: opened.tree, notes })).not.toContain('<extension');
    expect(notes.join(' ')).toContain(`Simulation extensions are not carried in ${format}`);
  });
});
