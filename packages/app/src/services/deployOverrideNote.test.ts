// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { deployOverrideNote, describeDeployment, sameDeployment, type DeploySetting } from './deployOverrideNote.js';
import { exportOrk, importOrk } from './orkFile.js';

/**
 * A recovery device whose flight configuration overrides its own deployment
 * (2026-10-10, @atestani's LEM-1-2026 re-saved by Eric in desktop OR 24.12):
 * the component setting says 300 ft, the configuration says ejection charge.
 * Desktop OR's dialog shows the first and flies the second; so does the app,
 * and now it says so.
 */
const ALT_300: DeploySetting = { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 };
const EJECTION: DeploySetting = { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 };

/** The LEM-1-2026_2 shape: two chutes, own setting 300 ft, default configuration overrides to ejection. */
function lem(configName = '', extraConfig = '', secondChute = true): string {
  const chute = (name: string) => `
            <parachute><name>${name}</name><diameter>0.9144</diameter><cd>auto</cd>
              <deployevent>altitude</deployevent><deployaltitude>91.44</deployaltitude><deploydelay>0.0</deploydelay>
              <deploymentconfiguration configid="cfg-a">
                <deployevent>ejection</deployevent><deployaltitude>200.0</deployaltitude><deploydelay>0.0</deploydelay>
              </deploymentconfiguration>
            </parachute>`;
  return `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
    <name>LEM</name>
    ${extraConfig}
    <motorconfiguration configid="cfg-a" default="true">${configName ? `<name>${configName}</name>` : ''}
      <stage number="0" active="true"/></motorconfiguration>
    <subcomponents><stage><name>Sustainer</name><subcomponents>
      <nosecone><name>N</name><length>0.1</length><thickness>0.002</thickness>
        <shape>ogive</shape><aftradius>0.044</aftradius></nosecone>
      <bodytube><name>B</name><length>0.4</length><thickness>0.006</thickness><radius>0.044</radius>
        <subcomponents>${chute('Parachute')}${secondChute ? chute('Parachute') : ''}</subcomponents>
      </bodytube>
    </subcomponents></stage></subcomponents></rocket></openrocket>`;
}

const overrideNotes = (notes: readonly string[]) => notes.filter((n) => n.startsWith('Recovery: '));

describe('sameDeployment', () => {
  it('ignores the altitude unless the event is altitude, and compares the delay', () => {
    expect(sameDeployment(EJECTION, { ...EJECTION, deployAltitude: 91.44 })).toBe(true);
    expect(sameDeployment(ALT_300, { ...ALT_300, deployAltitude: 100 })).toBe(false);
    expect(sameDeployment(EJECTION, { ...EJECTION, deployDelay: 1 })).toBe(false);
    expect(sameDeployment(EJECTION, ALT_300)).toBe(false);
  });
});

describe('describeDeployment', () => {
  it('uses the Deploy at labels, with metres and feet for an altitude and a delay when set', () => {
    expect(describeDeployment(EJECTION)).toBe('Motor ejection charge');
    expect(describeDeployment(ALT_300)).toBe('Altitude (descending), 91.4 m (300 ft)');
    expect(describeDeployment({ deployEvent: 'apogee', deployAltitude: 0, deployDelay: 1.5 })).toBe('Apogee + 1.5 s');
  });
});

describe('deployOverrideNote', () => {
  it('says nothing when nothing is overridden', () => {
    expect(deployOverrideNote([], null)).toBeNull();
  });

  it('counts identical devices once and names where the override lives in desktop OR', () => {
    const o = { name: 'Parachute', kind: 'parachute', own: ALT_300, flown: EJECTION };
    const note = deployOverrideNote([o, o], null)!;
    expect(note).toContain('Parachute (×2) opens at Motor ejection charge, not at its own setting (Altitude (descending), 91.4 m (300 ft))');
    expect(note).toContain('Recovery: The flight configuration this file opens with overrides');
    expect(note).toContain('its parachute dialog shows only the component\'s own setting');
    expect(note).toContain('Motors & Configuration tab, under Recovery');
    expect(note).toContain('Reset deployment');
  });
});

describe('importOrk — a configuration that overrides a recovery device', () => {
  it('flies the override (unchanged) and now says so, once, for both chutes', () => {
    const r = importOrk(lem());
    const chutes = r.tree.components[0]!.children![1]!.children!;
    expect(chutes.map((c) => c['deployEvent'])).toEqual(['ejection', 'ejection']);
    const notes = overrideNotes(r.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Parachute (×2) opens at Motor ejection charge');
    expect(notes[0]).toContain('91.4 m (300 ft)');
  });

  it('names the configuration when the file names it', () => {
    expect(overrideNotes(importOrk(lem('JLCR flight')).notes)[0]).toContain('Recovery: Flight configuration “JLCR flight” overrides');
  });

  it('is silent when the override repeats the component setting (every file the app saves)', () => {
    const same = lem().replace(/<deployevent>ejection<\/deployevent>/g, '<deployevent>altitude</deployevent>')
      .replace(/<deployaltitude>200.0<\/deployaltitude>/g, '<deployaltitude>91.44</deployaltitude>');
    expect(overrideNotes(importOrk(same).notes)).toEqual([]);
  });

  it('is silent when only a configuration the file does NOT open with overrides', () => {
    const other = lem('', '', false).replace('configid="cfg-a">\n', 'configid="cfg-z">\n')
      .replace('<deploymentconfiguration configid="cfg-a">', '<deploymentconfiguration configid="cfg-z">');
    const withZ = other.replace('<name>LEM</name>',
      '<name>LEM</name><motorconfiguration configid="cfg-z"><stage number="0" active="true"/></motorconfiguration>');
    const r = importOrk(withZ);
    expect(r.tree.components[0]!.children![1]!.children![0]!['deployEvent']).toBe('altitude');
    expect(overrideNotes(r.notes)).toEqual([]);
  });

  it('opens the app\'s own save of that file without the note, flying the same deployment', () => {
    const first = importOrk(lem());
    const saved = exportOrk({ name: first.name, tree: first.tree, motors: first.motors, configs: first.configs, activeConfigId: first.chosenConfigId });
    const again = importOrk(saved);
    expect(again.tree.components[0]!.children![1]!.children!.map((c) => c['deployEvent'])).toEqual(['ejection', 'ejection']);
    expect(overrideNotes(again.notes)).toEqual([]);
  });
});
