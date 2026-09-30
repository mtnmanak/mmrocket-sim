import { afterAll, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt, importRkt } from './rocksimFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { FIELDS, applyFieldLimit, blankValue, fieldLimit } from '../tree/schema.js';
import { sanitizeTree } from '../tree/sanitize.js';
import { scaleRocket } from '../tree/scaleRocket.js';

// Keep Node's native compression streams/Blob for the real share-link codec.
const window = new Window();
vi.stubGlobal('DOMParser', window.DOMParser);
afterAll(() => { vi.unstubAllGlobals(); window.close(); });

const transition: ComponentNode = {
  type: 'transition', id: 'tr', name: 'Reducer', length: 0.08,
  foreRadius: 0.025, aftRadius: 0.015, thickness: 0.001, shape: 'conical',
  foreShoulderRadius: 0.024, foreShoulderLength: 0.02, foreShoulderThickness: 0.0015,
  aftShoulderRadius: 0.0145, aftShoulderLength: 0.03, aftShoulderThickness: 0.002,
  foreShoulderCapped: true, aftShoulderCapped: true,
};
const treeOf = (node: ComponentNode): RocketTree => ({
  name: 'K15', components: [{ type: 'stage', id: 'stage', children: [node] }],
});
const part = (tree: RocketTree) => tree.components[0]!.children![0]!;

describe('K15 transition shoulder thickness', () => {
  it.each(['fore', 'aft'])('%s field uses the nose thickness units, limits and zero default', (side) => {
    const key = `${side}ShoulderThickness`;
    const fields = FIELDS.transition;
    const f = fields.find((field) => field.key === key)!;
    const nose = FIELDS.nosecone.find((field) => field.key === 'shoulderThickness')!;
    expect(f).toEqual({ ...nose, key, label: `${side === 'fore' ? 'Fore' : 'Aft'} shoulder thickness` });
    expect(fields[fields.indexOf(f) - 1]!.key).toBe(`${side}ShoulderLength`);
    expect(blankValue('transition', key)).toBe(0);
    expect(fieldLimit('transition', key)).toEqual(fieldLimit('nosecone', 'shoulderThickness'));
    expect(applyFieldLimit(fieldLimit('transition', key)!, -0.001)).toBe(0);
  });

  it('sanitizes both walls with named repair notes and preserves omitted keys', () => {
    const notes: string[] = [];
    const fixed = part(sanitizeTree(treeOf({ ...transition,
      foreShoulderThickness: -0.001, aftShoulderThickness: -0.002,
    }), notes));
    expect(fixed['foreShoulderThickness']).toBe(0);
    expect(fixed['aftShoulderThickness']).toBe(0);
    expect(notes.join(' ')).toContain('fore shoulder thickness');
    expect(notes.join(' ')).toContain('aft shoulder thickness');
    const omitted = part(sanitizeTree(treeOf({ type: 'transition' })));
    expect(omitted).not.toHaveProperty('foreShoulderThickness');
    expect(omitted).not.toHaveProperty('aftShoulderThickness');
  });

  it.each([false, true])('preserves independent walls and caps through .ork (share link: %s)', async (share) => {
    const xml = exportOrk({ name: 'K15', tree: treeOf(transition) });
    const payload = share ? await decodeShareFragment(await encodeShareFragment(xml)) : xml;
    const got = part(importOrk(payload).tree);
    for (const side of ['fore', 'aft']) {
      for (const field of ['Radius', 'Length', 'Thickness', 'Capped']) {
        const key = `${side}Shoulder${field}`;
        expect(got[key]).toBe(transition[key]);
      }
    }
  });

  it('scales each wall with its shoulder and leaves cap flags and input unchanged', () => {
    const tree = treeOf(transition);
    const got = part(scaleRocket(tree, 2).tree);
    for (const side of ['fore', 'aft']) {
      for (const field of ['Radius', 'Length', 'Thickness']) {
        const key = `${side}Shoulder${field}`;
        expect(got[key]).toBe((transition[key] as number) * 2);
      }
      expect(got[`${side}ShoulderCapped`]).toBe(true);
    }
    expect(part(tree)['aftShoulderThickness']).toBe(0.002);
  });

  it.each([false, true])('imports .rkt shoulder walls using desktop rules (filled: %s)', (filled) => {
    const xml = `<RockSimDocument><DesignInformation><RocketDesign><Name>K15</Name>
      <StageCount>1</StageCount><Stage3Parts><Transition><Name>Reducer</Name>
      <Len>80</Len><FrontDia>50</FrontDia><RearDia>30</RearDia><WallThickness>2</WallThickness>
      <ConstructionType>${filled ? 0 : 1}</ConstructionType>
      <FrontShoulderLen>20</FrontShoulderLen><FrontShoulderDia>48</FrontShoulderDia>
      <RearShoulderLen>30</RearShoulderLen><RearShoulderDia>29</RearShoulderDia>
      </Transition></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
    const got = part(importRkt(xml).tree);
    expect(got['foreShoulderThickness']).toBe(filled ? 0.024 : 0.002);
    expect(got['aftShoulderThickness']).toBe(filled ? 0.0145 : 0.002);
  });

  it.each([false, true])('exports .rkt shoulder geometry and its representable thickness (filled: %s)', (filled) => {
    const node = { ...transition, filled, foreShoulderCapped: false, aftShoulderCapped: false,
      foreShoulderThickness: filled ? 0.024 : 0.001,
      aftShoulderThickness: filled ? 0.0145 : 0.001 };
    const notes: string[] = [];
    const xml = exportRkt({ name: 'K15', tree: treeOf(node), notes });
    expect(notes).toEqual([]);
    const got = part(importRkt(xml).tree);
    for (const side of ['fore', 'aft']) {
      for (const field of ['Radius', 'Length', 'Thickness']) {
        const key = `${side}Shoulder${field}`;
        expect(got[key]).toBe(node[key as keyof typeof node]);
      }
    }
  });

  it.each(['fore', 'aft'])('reports .rkt loss of independent %s wall or cap', (side) => {
    const base = { ...transition, foreShoulderThickness: 0.001, aftShoulderThickness: 0.001,
      foreShoulderCapped: false, aftShoulderCapped: false };
    for (const extra of [{ [`${side}ShoulderThickness`]: 0.002 }, { [`${side}ShoulderCapped`]: true }]) {
      const notes: string[] = [];
      exportRkt({ name: 'K15', tree: treeOf({ ...base, ...extra }), notes });
      expect(notes.join(' ')).toContain('cannot keep their end caps');
      expect(notes.join(' ')).toContain('Use .ork');
    }
  });

  it('does not report .rkt shoulder loss when neither shoulder has length', () => {
    const notes: string[] = [];
    exportRkt({ name: 'K15', tree: treeOf({ ...transition, foreShoulderLength: 0, aftShoulderLength: 0 }), notes });
    expect(notes).toEqual([]);
  });
});
