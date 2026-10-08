// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { planImport } from './importApply.js';
import { importOrk } from './orkFile.js';

const design = (version: string | null, extra = '') => `<openrocket${version === null ? '' : ` version="${version}"`} creator="OpenRocket 24.12">
  <rocket><name>Version check</name><subcomponents><stage><name>Sustainer</name><subcomponents>
    <bodytube><name>Body</name><length>0.4</length><radius>0.025</radius><thickness>0.001</thickness></bodytube>
    ${extra}
  </subcomponents></stage></subcomponents></rocket></openrocket>`;

describe('.ork newer-format warning', () => {
  it.each(['1.11', '1.20', '2.0'])(
    'opens format %s and warns about settings being ignored or lost on saving', (version) => {
      const result = importOrk(design(version));
      expect(result.name).toBe('Version check');
      expect(result.tree.components[0]!.children![0]).toMatchObject({ type: 'bodytube', length: 0.4 });
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0]).toContain(version);
      expect(result.notes[0]).toMatch(/newer OpenRocket/);
      expect(result.notes[0]).toMatch(/settings may be ignored/);
      expect(result.notes[0]).toMatch(/lost.*sav/i);
    });

  it.each(['1.3', '1.4', '1.9', '1.10', null, '', 'unknown'])(
    'keeps the existing quiet import for version %j', (version) => {
      const result = importOrk(design(version));
      expect(result.tree.components[0]!.children![0]).toMatchObject({ type: 'bodytube', length: 0.4 });
      expect(result.notes).toEqual([]);
    });

  it('carries the warning and ignored-component note from a zipped file into the import notice', () => {
    const bytes = zipSync({ 'rocket.ork': strToU8(design('1.11', '<futurepart><name>Future</name></futurepart>')) });
    const imported = importOrk(bytes.buffer as ArrayBuffer);
    const plan = planImport(imported, { working: {}, configs: {} }, {
      launch: DEFAULT_CONDITIONS,
      text: { mass: kg => `${kg} kg`, length: m => `${m} m` },
    });
    expect(plan.snapshot.tree.components[0]!.children![0]!.type).toBe('bodytube');
    expect(plan.note.text).toMatch(/Loaded.*Version check/);
    expect(plan.note.text).toMatch(/newer OpenRocket/);
    expect(plan.note.text).toContain('Ignored unsupported components: futurepart.');
  });
});
