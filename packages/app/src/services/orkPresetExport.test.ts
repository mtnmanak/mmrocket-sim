// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { ORK_PRESET_IMPORT_STATE } from './orkPresetState.js';
import { designStateFromSession } from './sessionRestore.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const linked = (type: ComponentNode['type'], patch: Partial<ComponentNode> = {}): ComponentNode => ({
  type, orkPresetManufacturer: 'Maker', orkPresetPartNo: 'Part', orkPresetDigest: 'desktop-digest', ...patch,
});
const digest = (node: ComponentNode) => exportOrk({ name: 'Linked',
  tree: { components: [{ type: 'stage', children: [node] }] },
}).match(/<preset[^>]* digest="([^"]*)"/)?.[1];

describe('desktop preset export', () => {
  const open = (type: 'parachute' | 'railbutton', fields: string) => {
    const r = importOrk(`<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Linked</name>
      <subcomponents><stage><subcomponents><${type}>
      <preset type="${type === 'parachute' ? 'PARACHUTE' : 'RAIL_BUTTON'}" manufacturer="Maker" partno="Part" digest="desktop-digest"/>
      ${fields}</${type}></subcomponents></stage></subcomponents></rocket></openrocket>`);
    return r.tree.components[0]!.children![0]!;
  };
  it.each(['parachute', 'railbutton'] as const)('drops %s digest only for cleared file-carried values', type => {
    const cdKey = type === 'parachute' ? 'cd' : 'overrideCD';
    const original = open(type, '<cd>1.5</cd><overridecd>0.7</overridecd><overridemass>0.02</overridemass>');
    expect(original[ORK_PRESET_IMPORT_STATE]).toEqual({ [cdKey]: true, overrideMass: true });
    for (const key of [cdKey, 'overrideMass']) {
      for (const value of [undefined, NaN, Infinity]) {
        expect(digest({ ...original, [key]: value })).toBe('');
      }
    }
    expect(digest({ ...original, [cdKey]: 0, overrideMass: 0 })).toBe('desktop-digest');
  });

  it.each(['parachute', 'railbutton'] as const)('keeps untouched automatic %s and legacy links', type => {
    const original = open(type, '<cd>auto</cd>');
    const cdKey = type === 'parachute' ? 'cd' : 'overrideCD';
    expect(original[ORK_PRESET_IMPORT_STATE]).toEqual({ [cdKey]: false, overrideMass: false });
    expect(digest(original)).toBe('desktop-digest');
    expect(digest(linked(type))).toBe('desktop-digest');
    // A value added here and then cleared was absent in the imported file.
    expect(digest({ ...original, [cdKey]: undefined })).toBe('desktop-digest');
  });

  it('keeps the import record through session serialization and validates restored records', () => {
    const node = open('parachute', '<cd>1.5</cd>');
    const restore = (part: ComponentNode) => {
      const session = JSON.parse(JSON.stringify({ tree: { components: [{ type: 'stage', children: [part] }] },
        launch: DEFAULT_CONDITIONS, savedAt: 1 }));
      return designStateFromSession(session, { legacyMaxMotorLengthM: null }).state.tree.components[0]!.children![0]!;
    };
    const restored = restore(node);
    expect(restored[ORK_PRESET_IMPORT_STATE]).toEqual({ cd: true, overrideMass: false });
    expect(digest({ ...restored, cd: undefined })).toBe('');
    for (const bad of [true, [], { cd: 'true', overrideMass: false }, { cd: true },
      { cd: true, overrideMass: false, extra: true }]) {
      const repaired = restore({ ...node, cd: undefined, [ORK_PRESET_IMPORT_STATE]: bad });
      expect(repaired[ORK_PRESET_IMPORT_STATE]).toBeUndefined();
      expect(digest(repaired)).toBe('desktop-digest');
    }
  });

  it.each(['bodytube', 'innertube', 'tubefinset', 'nosecone', 'transition', 'tubecoupler',
    'bulkhead', 'centeringring', 'engineblock', 'launchlug', 'streamer'] as const)(
    'keeps %s links whose preset fields are explicitly written or recomputed', type => {
      expect(digest(linked(type))).toBe('desktop-digest');
    });
});
