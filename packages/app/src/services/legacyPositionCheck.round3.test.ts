// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, RocketTree } from '@online-openrocket/engine';
import { addNewComponent } from './addComponent.js';
import { defaultTree, emptyTree, findNode } from '../tree/treeModel.js';
import { absoluteStations } from '../tree/position.js';
import { checkLegacyPositions, historicalStations, legacyPositionCandidates, pendingLegacyPositions, preserveLegacyPositionCheck, recordCurrentPlacement } from './legacyPositionCheck.js';
import { exportOrk, importOrk } from './orkFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { designStateFromSession } from './sessionRestore.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { autosaveToOrk } from './autosaveBackup.js';

function built(type: 'podset' | 'parallelstage', descendant = false, starter = emptyTree()): RocketTree {
  let tree = starter;
  const add = (parent: string, kind: ComponentType) => {
    const result = addNewComponent(tree, parent, kind, null);
    tree = result.tree;
    return result.node.id!;
  };
  const body = add(tree.components[0]!.id!, 'bodytube');
  findNode(tree, body)!['length'] = 1;
  const pod = add(body, type);
  findNode(tree, pod)!.position = { method: 'top', offset: 0.2 };
  const nose = add(pod, 'nosecone');
  findNode(tree, nose)!['length'] = 0.1;
  const tube = add(pod, 'bodytube');
  findNode(tree, tube)!['length'] = 0.2;
  findNode(tree, tube)!.name = 'Stacked tube';
  if (descendant) {
    const mass = add(tube, 'masscomponent');
    findNode(tree, mass)!.name = 'Deliberate relative weight';
    findNode(tree, mass)!.position = { method: 'top', offset: 0.06 };
  }
  return tree;
}
const xmlFor = (tree: RocketTree) => exportOrk({ tree, name: tree.name! });
const warnings = (notes: string[]) => notes.filter(n => n.startsWith('Possible pre-v0.138'));
const unknown = (tree: RocketTree): RocketTree => ({ name: tree.name, components: tree.components });
function autosaveRestore(tree: RocketTree) {
  saveSessionDebounced({ tree, launch: DEFAULT_CONDITIONS });
  flushSession();
  return designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
}
afterEach(() => { flushSession(); localStorage.clear(); vi.restoreAllMocks(); });

describe.each(['podset', 'parallelstage'] as const)('REVIEW-2 %s', type => {
  it.each(['file', 'share', 'autosave', 'unstamped HEAD file'])('correct stacked chain stays quiet through %s', async route => {
    const tree = built(type);
    const tube = [...absoluteStations(tree).values()].find(s => s.node.name === 'Stacked tube')!;
    expect(tube.start).toBeCloseTo(0.3, 12);
    expect(historicalStations(tree).get(tube.node.id!)).toBeCloseTo(0.2, 12);
    const xml = route === 'unstamped HEAD file'
      ? xmlFor(tree).replace(/ mmrsim-placement="[^"]*"/, '') : xmlFor(tree);
    const notes = route === 'autosave' ? autosaveRestore(tree).restoreNotes
      : importOrk(route === 'share' ? await decodeShareFragment(await encodeShareFragment(xml)) : xml).notes;
    expect(warnings(notes)).toEqual([]);
    expect(legacyPositionCandidates(tree)).toEqual([]);
  });

  it.each(['file', 'share', 'autosave', 'recovery'])('new design with relative descendants stays quiet through %s', async route => {
    const tree = built(type, true);
    expect(legacyPositionCandidates(tree).some(p => p.name === 'Deliberate relative weight')).toBe(true);
    const xml = route === 'recovery' ? autosaveToOrk({ tree, launch: DEFAULT_CONDITIONS, savedAt: 1 }) : xmlFor(tree);
    const result = route === 'autosave' ? autosaveRestore(tree)
      : importOrk(route === 'share' ? await decodeShareFragment(await encodeShareFragment(xml)) : xml);
    expect(warnings('restoreNotes' in result ? result.restoreNotes : result.notes)).toEqual([]);
    const reopened = 'state' in result ? result.state.tree : result.tree;
    expect(warnings(autosaveRestore(reopened).restoreNotes)).toEqual([]);
    expect(warnings(importOrk(xmlFor(reopened)).notes)).toEqual([]);
  });

  it('desktop provenance survives autosave, file, share and recovery export', async () => {
    const desktop = xmlFor(unknown(built(type, true))).replace('creator="MMRocket Sim"', 'creator="OpenRocket 24.12"');
    const opened = importOrk(desktop);
    expect(warnings(opened.notes)).toEqual([]);
    const restored = autosaveRestore(opened.tree);
    expect(warnings(restored.restoreNotes)).toEqual([]);
    const xml = xmlFor(restored.state.tree);
    for (const input of [xml, await decodeShareFragment(await encodeShareFragment(xml)), autosaveToOrk(loadSession()!)]) {
      const reopened = importOrk(input);
      expect(warnings(reopened.notes)).toEqual([]);
      expect(warnings(autosaveRestore(reopened.tree).restoreNotes)).toEqual([]);
    }
  });

  it('an unresolved legacy relative descendant survives every resave route and a newer writer stamp', async () => {
    const tree = checkLegacyPositions(unknown(built(type, true)), true, []);
    expect(pendingLegacyPositions(tree).map(p => p.name)).toEqual(['Deliberate relative weight']);
    const restored = autosaveRestore(tree);
    expect(warnings(restored.restoreNotes)).toHaveLength(1);
    const xml = xmlFor(restored.state.tree).replace('creator="MMRocket Sim"', 'creator="MMRocket Sim" mmrsim-version="99.999"');
    expect(xml).not.toContain('mmrsim-placement="current"');
    for (const input of [xml, await decodeShareFragment(await encodeShareFragment(xml)), autosaveToOrk(loadSession()!)]) {
      expect(warnings(importOrk(input).notes)).toHaveLength(1);
    }
  });
});

it('the default starter also retains current provenance after adding a pod descendant', () => {
  expect(warnings(autosaveRestore(built('podset', true, defaultTree())).restoreNotes)).toEqual([]);
});

it('provenance changes XML only for an otherwise eligible design; chain-only exports stay byte-identical', () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  for (const descendant of [false, true]) {
    const tree = built('podset', descendant);
    const xml = xmlFor(tree);
    expect(xml.includes(' mmrsim-placement="current"')).toBe(descendant);
    expect(xml.replace(' mmrsim-placement="current"', '')).toBe(xmlFor(unknown(tree)));
  }
});

it('opening an unstamped chain-only file remains safe when a new descendant is added', () => {
  let tree = importOrk(xmlFor(unknown(built('podset')))).tree;
  const tube = [...absoluteStations(tree).values()].find(s => s.node.name === 'Stacked tube')!.node;
  tree = addNewComponent(tree, tube.id!, 'masscomponent', null).tree;
  expect(warnings(autosaveRestore(tree).restoreNotes)).toEqual([]);
  expect(warnings(importOrk(xmlFor(tree)).notes)).toEqual([]);
});

it('an unresolved check takes precedence even if current provenance is also present', () => {
  const legacy = checkLegacyPositions(unknown(built('podset', true)), true, []);
  const mixed = recordCurrentPlacement(legacy);
  expect(pendingLegacyPositions(mixed)).toHaveLength(1);
  expect(warnings(autosaveRestore(mixed).restoreNotes)).toHaveLength(1);
  expect(xmlFor(mixed)).not.toContain('mmrsim-placement="current"');
  expect(warnings(importOrk(xmlFor(mixed)).notes)).toHaveLength(1);
});

it('Undo carries current provenance as well as pending IDs', () => {
  const live = built('podset', true);
  const undone = preserveLegacyPositionCheck(unknown(live), live);
  expect(warnings(importOrk(xmlFor(undone)).notes)).toEqual([]);
});

it('chain exclusion follows placement, including explicit offsets and non-chain assembly children', () => {
  const tree = unknown(built('podset'));
  const tube = [...absoluteStations(tree).values()].find(s => s.node.name === 'Stacked tube')!.node;
  tube.position = { method: 'absolute', offset: 99 };
  const assembly = [...absoluteStations(tree).values()].find(s => s.node.type === 'podset')!.node;
  assembly.children!.push({ type: 'transition', id: 'transition', length: 0.1, position: { method: 'top', offset: 77 } });
  assembly.children!.push({ type: 'masscomponent', id: 'direct-mass', position: { method: 'top', offset: 88 } });
  expect(legacyPositionCandidates(tree)).toEqual([]);
  // A positioned descendant must not disappear along with its chain parent.
  tube.children = [{ type: 'masscomponent', id: 'weight', position: { method: 'top', offset: 0.06 } }];
  expect(legacyPositionCandidates(tree).map(p => p.id)).toEqual(['weight']);
});
