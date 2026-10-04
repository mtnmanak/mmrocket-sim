// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { absoluteStations, resolveAbsolutePositions, startFromPosition } from '../tree/position.js';
import { findNode, normalizeTree } from '../tree/treeModel.js';
import { num } from '../tree/nodeNum.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { exportOrk, importOrk } from './orkFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { designStateFromSession } from './sessionRestore.js';
import { autosaveToOrk } from './autosaveBackup.js';
import { APP_VERSION } from '../version.js';
import { decodeXml } from './xmlUtil.js';
import { gunzipCapped, unzipMember } from './zipMember.js';
import { parseXml } from './xmlParse.js';
import { checkLegacyPositions, dismissLegacyPositions, historicalStations, legacyPositionCandidates, pendingLegacyPositions } from './legacyPositionCheck.js';

/** Frozen algorithms from d9185db^: position.ts:38-55,112-161 and
 * assembly.ts:assemblyChainLength. Keep the faulty walk independent of today's
 * placement rule, so the stored fixture is produced by the actual old rule. */
function oldWalk(tree: RocketTree): RocketTree {
  const chainTypes = new Set(['nosecone', 'bodytube', 'transition']);
  const length = (n: ComponentNode): number => {
    if (n.type === 'freeformfinset') {
      const pts = (n['points'] as [number, number][] | undefined) ?? [];
      return pts.length ? pts[pts.length - 1]![0] : 0.05;
    }
    if (n.type === 'trapezoidfinset' || n.type === 'ellipticalfinset') return num(n, 'rootChord', 0.05);
    if (n.type === 'railbutton') return 0;
    if (n.type === 'podset' || n.type === 'parallelstage') {
      return (n.children ?? []).filter(c => chainTypes.has(c.type)).reduce((s, c) => s + num(c, 'length', 0), 0);
    }
    return num(n, 'length', num(n, 'packedLength', 0.025));
  };
  let changed = false;
  const fixChildren = (parent: ComponentNode, pStart: number, pLen: number): ComponentNode => {
    if (!parent.children?.length) return parent;
    const children = parent.children.map(child => {
      let next = child;
      const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      if (pos.method === 'absolute') {
        changed = true;
        next = { ...child, position: { method: 'top', offset: pos.offset - pStart } } as ComponentNode;
      }
      const cLen = length(next);
      const nextPos = (next.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
      const start = pStart + startFromPosition(nextPos, cLen, pLen);
      return fixChildren(next, start, cLen);
    });
    return { ...parent, children } as ComponentNode;
  };
  let x = 0;
  const components = tree.components.map(stage => {
    const kids = stage.type === 'stage' ? stage.children ?? [] : [stage];
    const fixedKids = kids.map(n => {
      // eslint-disable-next-line no-restricted-syntax -- Frozen pre-v0.138 algorithm: this test must reproduce its original default handling.
      const len = chainTypes.has(n.type) ? (typeof n['length'] === 'number' ? n['length'] as number : 0) : 0;
      const fixed = fixChildren(n, x, len);
      x += len;
      return fixed;
    });
    return stage.type === 'stage' ? { ...stage, children: fixedKids } as ComponentNode : fixedKids[0]!;
  });
  return changed ? { ...tree, components } : tree;
}

function original(type: 'podset' | 'parallelstage' = 'podset'): RocketTree {
  return { name: 'Old walk fixture', components: [{ type: 'stage', id: 's', children: [
    { type: 'nosecone', id: 'nose', length: 0.15, aftRadius: 0.027 },
    { type: 'bodytube', id: 'body', length: 1.2, outerRadius: 0.027, children: [
      { type, id: 'pod', name: 'Side assembly', instanceCount: 2, separationEvent: 'never',
        position: { method: 'bottom', offset: 0.1 }, children: [
          { type: 'nosecone', id: 'pn', length: 0.08, aftRadius: 0.012 },
          { type: 'bodytube', id: 'pt1', length: 0.2, outerRadius: 0.012 },
          { type: 'bodytube', id: 'pt2', length: 0.25, outerRadius: 0.012, children: [
            { type: 'freeformfinset', id: 'fin', name: 'Airfoil fin', finCount: 3, crossSection: 'airfoil',
              thickness: 0.002, points: [[0, 0], [0.02, 0.03], [0.07, 0.03], [0.06, 0]],
              position: { method: 'absolute', offset: 1.35 } },
            { type: 'masscomponent', id: 'mass', name: 'Weight', mass: 0.03, length: 0.02,
              position: { method: 'absolute', offset: 1.3 } },
          ] },
        ] },
    ] },
  ] }] } as RocketTree;
}

const saveXml = (tree: RocketTree) => exportOrk({ tree, name: tree.name! });
const oldXml = (tree: RocketTree) => saveXml(tree).replace(/ mmrsim-version="[^"]*"/, '');
const notesFor = (notes: string[]) => notes.filter(n => n.startsWith('Possible pre-v0.138'));
const session = (tree: RocketTree, appVersion: string | undefined) => ({
  tree, appVersion, savedAt: 1, launch: DEFAULT_CONDITIONS,
});
const restore = (tree: RocketTree, version?: string) => {
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify(session(tree, version)));
  return designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
};
afterEach(() => { flushSession(); localStorage.clear(); });

describe('pre-v0.138 station comparison', () => {
  it.each(['podset', 'parallelstage'] as const)('reproduces the historical rewrite and flags the differing stations on every route (%s)', async type => {
    const source = original(type);
    findNode(source, 'fin')!['crossSection'] = type === 'parallelstage' ? 'rounded' : 'airfoil';
    const stored = oldWalk(source);
    expect(findNode(stored, 'fin')!.position!.offset).toBeCloseTo(0.43, 12);
    expect(absoluteStations(stored).get('fin')!.start).toBeCloseTo(1.63, 12);
    expect(historicalStations(stored).get('fin')).toBeCloseTo(1.35, 12);
    expect(absoluteStations(resolveAbsolutePositions(source)).get('fin')!.start).toBeCloseTo(1.35, 12);
    expect(JSON.stringify(oldWalk(stored))).toBe(JSON.stringify(stored));
    const before = JSON.stringify(stored.components);
    expect(legacyPositionCandidates(stored).map(p => p.id)).toEqual(['fin', 'mass']);
    const restored = restore(stored, '0.137');
    expect(notesFor(restored.restoreNotes)).toHaveLength(1);
    expect(notesFor(restored.restoreNotes)[0]).toContain('2 parts');
    expect(JSON.stringify(restored.state.tree.components)).toBe(before);
    const xml = oldXml(stored);
    for (const input of [xml, await decodeShareFragment(await encodeShareFragment(xml)), autosaveToOrk(session(stored, '0.159'))]) {
      const opened = importOrk(input);
      expect(notesFor(opened.notes)).toHaveLength(1);
      const fin = [...absoluteStations(normalizeTree(opened.tree)).values()].find(s => s.node.name === 'Airfoil fin')!;
      expect(fin.start).toBeCloseTo(1.63, 12);
      expect(fin.node['crossSection']).toBe(type === 'parallelstage' ? 'rounded' : 'airfoil');
      expect(pendingLegacyPositions(opened.tree)).toHaveLength(2);
    }
    expect(JSON.stringify(stored.components)).toBe(before);
  });

  it.each([undefined, '', 'garbage', '0.137', '0.138', '0.158', '0.159', '1.0.0'])('checks sessions independently of writer version (%s)', version => {
    expect(notesFor(restore(oldWalk(original()), version).restoreNotes)).toHaveLength(1);
  });

  it('recognizes both historical app names, but never desktop or unknown creators even with obsolete markers', () => {
    for (const creator of ['MMRocket Sim', 'Online OpenRocket', 'OpenRocket 24.12', 'Other app', '']) {
      const xml = oldXml(oldWalk(original())).replace('creator="MMRocket Sim"',
        `creator="${creator}" mmrsim-version="0.137" mmrsim-position-check="pending"`);
      expect(notesFor(importOrk(xml).notes).length).toBe(['MMRocket Sim', 'Online OpenRocket'].includes(creator) ? 1 : 0);
    }
    const marked = checkLegacyPositions(oldWalk(original()), true, []);
    const excluded: string[] = [];
    expect(checkLegacyPositions(marked, false, excluded)).toBe(marked);
    expect(excluded).toEqual([]);
  });

  it('keeps no-assembly and equal-station trees byte-identical', () => {
    const tree = original();
    findNode(tree, 'body')!.children = [];
    const before = JSON.stringify(tree);
    expect(checkLegacyPositions(tree, true, [])).toBe(tree);
    expect(JSON.stringify(restore(tree, '0.137').state.tree)).toBe(before);
    expect(notesFor(importOrk(saveXml(tree)).notes)).toEqual([]);
  });

  it('ignores differences at or below one nanometre, but includes larger ones', () => {
    for (const [length, count] of [[0, 0], [0.5e-9, 0], [1e-9, 0], [2e-9, 1]]) {
      const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'body', length: 1, children: [
          { type: 'podset', id: 'pod', position: { method: 'top', offset: 0 }, children: [
            { type: 'nosecone', id: 'pn', length }, { type: 'bodytube', id: 'pt', length: 0.2, children: [
              { type: 'masscomponent', id: 'mass', position: { method: 'top', offset: 0 } },
            ] },
          ] },
        ] },
      ] }] };
      expect(legacyPositionCandidates(tree)).toHaveLength(count!);
    }
  });

  it('preserves literal absolute stations and excludes differing parts outside assemblies', () => {
    const tree = original();
    expect(legacyPositionCandidates(tree).map(p => p.id)).not.toContain('fin');
    expect(historicalStations(tree).get('fin')).toBeCloseTo(1.35, 12);
    expect(pendingLegacyPositions(restore(tree, '0.159').state.tree).map(p => p.id)).not.toContain('fin');
    findNode(tree, 'body')!.children!.push({ type: 'centeringring', id: 'core-ring', length: 0.01 });
    expect(historicalStations(tree).get('core-ring')).not.toBe(absoluteStations(tree).get('core-ring')!.start);
    expect(legacyPositionCandidates(tree).map(p => p.id)).not.toContain('core-ring');
  });

  it('preserves dismissal in autosave, rechecks a reopened file/share, and does not change export bytes', async () => {
    const marked = restore(oldWalk(original()), '0.137').state.tree;
    const dismissed = dismissLegacyPositions(marked);
    saveSessionDebounced({ tree: dismissed, launch: DEFAULT_CONDITIONS });
    flushSession();
    expect(loadSession()!.appVersion).toBe(APP_VERSION);
    expect(notesFor(designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null }).restoreNotes)).toEqual([]);
    expect(pendingLegacyPositions(dismissed)).toEqual([]);
    const xml = saveXml(dismissed);
    expect(xml).not.toContain('mmrsim-version');
    expect(xml).not.toContain('mmrsim-position-check');
    for (const input of [xml, await decodeShareFragment(await encodeShareFragment(xml))]) {
      expect(notesFor(importOrk(input).notes)).toHaveLength(1);
    }
  });

  it('clears deleted or corrected candidates, never attaching pending checks to new IDs', () => {
    const marked = checkLegacyPositions(oldWalk(original()), true, []);
    const changed = structuredClone(marked);
    // Explicit historical offsets equal the current chain stations. Existing
    // descendant offsets then give identical stations under both rules too.
    findNode(changed, 'pt1')!.position = { method: 'top', offset: 0.08 };
    findNode(changed, 'pt2')!.position = { method: 'top', offset: 0.28 };
    expect(pendingLegacyPositions(changed)).toEqual([]);
    const cleared = checkLegacyPositions(changed, true, []);
    expect(pendingLegacyPositions(cleared)).toEqual([]);
    expect(cleared).toHaveProperty('legacyPositionCheck.pending', []);
    const deleted = structuredClone(marked);
    findNode(deleted, 'body')!.children = [];
    expect(checkLegacyPositions(deleted, true, [])).toHaveProperty('legacyPositionCheck.pending', []);
    // Replace the entire pod with a fresh, even mismatching, assembly. It
    // cannot inherit the previous parts' pending checks.
    const replacement = structuredClone(findNode(oldWalk(original()), 'pod')!);
    const freshIds = (node: ComponentNode) => { node.id += '-new'; node.children?.forEach(freshIds); };
    freshIds(replacement);
    const replaced = { ...marked, components: structuredClone(marked.components) };
    findNode(replaced, 'body')!.children = [replacement];
    expect(legacyPositionCandidates(replaced)).toHaveLength(2);
    expect(pendingLegacyPositions(replaced)).toEqual([]);
    expect(notesFor(restore(replaced, '0.159').restoreNotes)).toEqual([]);
  });

  it('replaces obsolete boolean markers, safely reads malformed metadata and folds names to one line', () => {
    const tree = oldWalk(original());
    Object.assign(tree, { legacyPositionCheck: true });
    findNode(tree, 'pod')!.name = 'Side\nassembly';
    Object.assign(findNode(tree, 'fin')!, { name: 42 });
    const notes: string[] = [];
    const checked = checkLegacyPositions(tree, true, notes);
    expect(pendingLegacyPositions(checked)).toHaveLength(2);
    expect(notes[0]).toContain('freeformfinset');
    expect(notes[0]).toContain('Side assembly');
    expect(notes[0]).not.toMatch(/[\r\n]/);
    Object.assign(tree, { legacyPositionCheck: { pending: [42] } });
    expect(pendingLegacyPositions(checkLegacyPositions(tree, true, []))).toHaveLength(2);
    findNode(tree, 'body')!.children = [];
    Object.assign(tree, { legacyPositionCheck: true });
    expect(pendingLegacyPositions(checkLegacyPositions(tree, true, []))).toEqual([]);
  });
});

// Read-only, opt-in acceptance inventory of the tester's actual bytes.
it.runIf(!!process.env['T360_USER_FILES'])('opens every tester .ork and reports FILES, PARTS and candidate stations in metres', () => {
  const root = process.env['T360_USER_FILES']!;
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.ork$/i.test(entry.name) ? [join(dir, entry.name)] : []);
  const rows = files(root).map(file => {
    const bytes = readFileSync(file);
    const opened = importOrk(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const xmlBytes = bytes[0] === 0x50 && bytes[1] === 0x4b ? unzipMember(bytes, '.ork', '.ork')
      : bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipCapped(bytes, '.ork') : bytes;
    const xml = decodeXml(xmlBytes).xml.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/, '');
    const creator = parseXml(xml, 'Acceptance XML').documentElement.getAttribute('creator');
    const before = JSON.stringify(opened.tree.components);
    checkLegacyPositions(opened.tree, true, []);
    expect(JSON.stringify(opened.tree.components)).toBe(before);
    const flagged = notesFor(opened.notes).length > 0;
    expect(flagged, file).toBe(false);
    const candidates = legacyPositionCandidates(opened.tree);
    const restored = restore(opened.tree, '0.159');
    const restoredParts = pendingLegacyPositions(restored.state.tree);
    expect(restoredParts, file).toEqual([]);
    expect(notesFor(restored.restoreNotes), file).toEqual([]);
    // Also probe a session with no recorded lineage at all, as in REVIEW-2.
    const unknownRestore = restore({ name: opened.tree.name, components: opened.tree.components }, '0.159');
    expect(pendingLegacyPositions(unknownRestore.state.tree), file).toEqual([]);
    return { file: file.slice(root.length + 1), creator, parts: absoluteStations(opened.tree).size,
      flaggedParts: flagged ? candidates.length : 0, flagged, candidates: flagged ? candidates : [],
      restoreFlaggedParts: restoredParts.length, repairedParts: 0 };
  });
  expect(rows.length).toBeGreaterThan(0);
  console.log('T360_ROUND3_ACCEPTANCE', JSON.stringify({ files: rows.length,
    parts: rows.reduce((sum, row) => sum + row.parts, 0), flaggedFiles: rows.filter(row => row.flagged).length,
    flaggedParts: rows.reduce((sum, row) => sum + row.flaggedParts, 0),
    restoreFlaggedFiles: rows.filter(row => row.restoreFlaggedParts > 0).length,
    restoreFlaggedParts: rows.reduce((sum, row) => sum + row.restoreFlaggedParts, 0),
    repairedFiles: 0, repairedParts: 0, rows }));
});
