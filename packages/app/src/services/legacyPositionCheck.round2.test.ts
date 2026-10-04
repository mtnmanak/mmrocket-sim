// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { checkLegacyPositions, dismissLegacyPositions } from './legacyPositionCheck.js';
import { designNotices, type NoticeDismissers, type NoticeInput } from './notices.js';
import { designStateFromSession } from './sessionRestore.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { flushSession } from './session.js';

function fixture(shifted = false): RocketTree {
  return { name: 'Review fixture', components: [{ type: 'stage', id: 's', children: [
    { type: 'bodytube', id: 'body', length: 1, children: [
      { type: 'podset', id: 'pod', name: 'Pod', position: { method: 'top', offset: 0 }, children: [
        ...(shifted ? [{ type: 'nosecone', id: 'pn', length: 0.1 } as ComponentNode] : []),
        { type: 'bodytube', id: 'pt', name: 'Pod tube', length: 0.2, children: [
          { type: 'masscomponent', id: 'mass', name: 'Weight', length: 0.02,
            position: { method: 'top', offset: 0.3 } },
        ] },
      ] },
    ] },
  ] }] } as RocketTree;
}
const xmlFor = (tree: RocketTree) => exportOrk({ tree, name: tree.name! });
const notesFor = (notes: string[]) => notes.filter(n => n.startsWith('Possible pre-v0.138'));
afterEach(() => { flushSession(); localStorage.clear(); });

it('REVIEW-1: correct unstamped post-fix file and share with identical stations are quiet', async () => {
  const xml = xmlFor(fixture()).replace(/ mmrsim-version="[^"]*"/, '');
  for (const input of [xml, await decodeShareFragment(await encodeShareFragment(xml))]) {
    expect(notesFor(importOrk(input).notes)).toEqual([]);
  }
});
it('REVIEW-2: a chain-only single-tube pod cannot be flagged', () => {
  const tree = fixture();
  tree.components[0]!.children![0]!.children![0]!.children![0]!.children = [];
  const notes: string[] = [];
  expect(checkLegacyPositions(tree, true, notes)).toBe(tree);
  expect(notes).toEqual([]);
});
it('REVIEW-3: a newer writer cannot hide the old station difference', () => {
  for (const appVersion of ['0.138', '0.158', '0.159']) {
    const result = designStateFromSession({ tree: fixture(true), appVersion, savedAt: 1,
      launch: DEFAULT_CONDITIONS }, { legacyMaxMotorLengthM: null });
    expect(notesFor(result.restoreNotes)).toHaveLength(1);
    const xml = xmlFor(fixture(true)).replace('creator="MMRocket Sim"', `creator="MMRocket Sim" mmrsim-version="${appVersion}"`);
    expect(notesFor(importOrk(xml).notes)).toHaveLength(1);
  }
});
it('REVIEW-4: deleting candidates prevents a replacement safe pod inheriting the note', () => {
  const flagged = checkLegacyPositions(fixture(true), true, []);
  const empty = { ...flagged, components: fixture().components };
  const notes: string[] = [];
  checkLegacyPositions(empty, true, notes);
  expect(notes).toEqual([]);
});
it('REVIEW-5: unaffected export retains its exact original root bytes', () => {
  expect(xmlFor(fixture()).split('\n')[1]).toBe('<openrocket version="1.10" creator="MMRocket Sim">');
});
it('REVIEW-6: the note names parts, controls and a comparison reference without claiming damage', () => {
  const notes: string[] = [];
  checkLegacyPositions(fixture(true), true, notes);
  expect(notes[0]).toContain('Weight');
  expect(notes[0]).toContain('an app version before v0.138 placed parts inside a pod or strap-on differently');
  expect(notes[0]).toContain('Position (in parent) / Relative to / Offset');
  expect(notes[0]).toContain('design you intended');
  expect(notes[0]).toContain('file you started from, if you still have it');
  expect(notes[0]).not.toContain('Pod tube'); // Stacked parts are not candidates.
  expect(notes[0]).toContain('may');
});

it('shows one live notice, survives save messages, and dismisses only this design', () => {
  const tree = checkLegacyPositions(fixture(true), true, []);
  const loadNotes: string[] = [];
  checkLegacyPositions(tree, true, loadNotes);
  const input: NoticeInput = { tree, assigned: [], error: null, buildFailed: false, motorFailures: [],
    restoredByOlderBuild: false, timeStepMigrated: false, timeStepMigratedFrom: null, padMassNote: null,
    fileNote: { severity: 'info', text: `Loaded design.\n${loadNotes[0]}` }, runsCapped: { evicted: 0, unsaved: 0 },
    lengthText: String };
  const noop = () => {};
  const dismiss: NoticeDismissers = { simError: noop, staleSession: noop, timeStep: noop,
    padMassNote: noop, fileNote: noop, runsCapped: noop,
    legacyPositions: () => { input.tree = dismissLegacyPositions(input.tree); } };
  let notices = designNotices(input, dismiss);
  expect(notices.filter(n => n.text.includes('Possible pre-v0.138'))).toHaveLength(1);
  expect(notices.find(n => n.id === 'file-note')!.text).toBe('Loaded design.');
  input.fileNote = { severity: 'info', text: 'Saved design.' };
  notices = designNotices(input, dismiss);
  expect(notices.find(n => n.id === 'legacy-positions')!.severity).toBe('warn');
  notices.find(n => n.id === 'legacy-positions')!.onDismiss!();
  expect(designNotices(input, dismiss).map(n => n.id)).toEqual(['file-note']);
  input.tree = tree;
  input.tree.components = fixture().components;
  expect(designNotices(input, dismiss).map(n => n.id)).toEqual(['file-note']);
});

it('unaffected XML matches measured pre-change HEAD bytes with deterministic UUIDs', () => {
  const stub = vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  try {
    for (const pod of [false, true]) {
      const tree: RocketTree = { name: 'Byte fixture', components: [{ type: 'stage', id: 's', children: [
        { type: 'bodytube', id: 'body', length: 1, children: pod ? [
          { type: 'podset', id: 'pod', position: { method: 'top', offset: 0 }, children: [
            { type: 'bodytube', id: 'pt', length: 0.2 },
          ] },
        ] : [] },
      ] }] };
      const input = { tree, name: tree.name! };
      // Measured from the HEAD exporter before this task; full XML compared
      // byte-for-byte against that exporter before recording these digests.
      const xml = exportOrk(input);
      expect(Buffer.byteLength(xml)).toBe(pod ? 2150 : 1150);
      expect(createHash('sha256').update(xml).digest('hex')).toBe(pod
        ? 'c537c045f06e98616afc6880037415ec6a88bd6e9070a1149c38920ce121fb17'
        : '12cfb8863571f4e7e94ea2bf64830bcf5c0318771f669d638499c91ff048207c');
    }
  } finally { stub.mockRestore(); }
});
