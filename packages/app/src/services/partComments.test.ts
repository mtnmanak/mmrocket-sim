// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine, type RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { physicsKeyOf } from './designDerivation.js';
import { designFingerprint } from './dirtyState.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { checkFormatLoss } from './formatLoss.js';
import { normalizeTree, defaultTree, duplicateNode, engineTree, findNode, motorMounts, updateNode } from '../tree/treeModel.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { simulateDesign } from './simulateDesign.js';
import { comparable } from './simulate.testSupport.js';

const comment = '  As built: café <&> "钛"\nReplace after 3 flights.  ';
const tree: RocketTree = { name: 'Comments', components: [{ type: 'stage', id: 's', name: 'Stage', comment,
  children: [{ type: 'bodytube', id: 'tube', name: 'Tube', length: 0.3, outerRadius: 0.02,
    thickness: 0.001, comment, children: [{ type: 'freeformfinset', id: 'fin', name: 'Fins',
      crossSection: 'rounded', points: [[0, 0], [0.04, 0.05], [0.08, 0.05], [0.1, 0]], comment: '\n' }] }] }] };
const snapshot = (t = tree) => ({ tree: t, mountMotors: {}, launch: DEFAULT_CONDITIONS,
  savedConfigs: [], activeConfigId: null, measured: { massKg: null, cgM: null } });

describe('C-B8 part comments', () => {
  it('round-trips desktop comment elements on stages and nested parts, including whitespace and XML', async () => {
    const xml = exportOrk({ name: tree.name!, tree });
    expect(xml).toContain('<comment>');
    expect(xml).toContain('&lt;&amp;&gt;');
    const opened = importOrk(new TextEncoder().encode(xml).buffer);
    expect(opened.tree.components[0]!['comment']).toBe(comment);
    expect(opened.tree.components[0]!.children![0]!['comment']).toBe(comment);
    expect(opened.tree.components[0]!.children![0]!.children![0]!['comment']).toBe('\n');
    const empty = updateNode(tree, 'tube', { comment: undefined });
    const again = importOrk(new TextEncoder().encode(exportOrk({ name: 'Comments', tree: empty })).buffer);
    expect(again.tree.components[0]!.children![0]!['comment']).toBeUndefined();
  });

  it('comments mark work unsaved but do not change the physics key at any depth', () => {
    const changed = updateNode(tree, 'fin', { comment: 'Different note' });
    expect(designFingerprint(snapshot(changed))).not.toBe(designFingerprint(snapshot()));
    expect(physicsKeyOf(changed.components)).toBe(physicsKeyOf(tree.components));
    const noComments = updateNode(updateNode(updateNode(tree, 's', { comment: undefined }), 'tube',
      { comment: undefined }), 'fin', { comment: undefined });
    expect(physicsKeyOf(noComments.components)).toBe(physicsKeyOf(tree.components));
  });

  it('share links carry part comments', async () => {
    const xml = exportOrk({ name: tree.name!, tree });
    const opened = importOrk(await decodeShareFragment(await encodeShareFragment(xml)));
    expect(opened.tree.components[0]!['comment']).toBe(comment);
    expect(opened.tree.components[0]!.children![0]!['comment']).toBe(comment);
  });

  it('the real kernel gives the same static figures with rounded freeform-fin comments or without them', () => {
    const without = updateNode(updateNode(updateNode(tree, 's', { comment: undefined }), 'tube',
      { comment: undefined }), 'fin', { comment: undefined });
    resetEngine();
    const before = OrkRocket.buildTree(engineTree(without)).staticInfo();
    const after = OrkRocket.buildTree(engineTree(tree)).staticInfo();
    // Differential comparison in one runtime, not hard-coded kernel floats.
    expect(after).toEqual(before);
  });

  it.each(['rounded', 'airfoil'])('comments preserve the real C6 flight report with %s freeform fins', async crossSection => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
    try {
      let airframe = defaultTree();
      const body = airframe.components[0]!.children!.find(n => n.type === 'bodytube')!;
      const fin = body.children!.find(n => n.type === 'trapezoidfinset')!;
      airframe = updateNode(airframe, fin.id!, { type: 'freeformfinset', crossSection,
        points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]] });
      const annotated = updateNode(updateNode(airframe, fin.id!, { comment }), airframe.components[0]!.id!, { comment });
      const motor = (await loadCatalogueMotor('Estes', 'C6', 5))!;
      const motors = { [motorMounts(airframe)[0]!.id!]: motor };
      const before = await simulateDesign({ ...snapshot(airframe), mountMotors: motors, unmatchedRefs: {} });
      const after = await simulateDesign({ ...snapshot(annotated), mountMotors: motors, unmatchedRefs: {} });
      // Same-runtime differential; only wall-clock/identity fields are removed.
      expect(comparable(after.run)).toEqual(comparable(before.run));
    } finally { vi.unstubAllGlobals(); }
  }, 30_000);

  it('normalization and deep duplication keep text while invalid restored values are removed', () => {
    const normalized = normalizeTree(JSON.parse(JSON.stringify(tree)) as RocketTree);
    const copy = duplicateNode(normalized, 'tube');
    expect(copy).not.toBeNull();
    expect(copy!.tree.components[0]!.children![1]!['comment']).toBe(comment);
    expect(copy!.tree.components[0]!.children![1]!.children![0]!['comment']).toBe('\n');
    const invalid = normalizeTree(updateNode(tree, 'tube', { comment: { malicious: true } }));
    expect(findNode(invalid, 'tube')!['comment']).toBeUndefined();
  });

  it.each(['rkt', 'cdx1'] as const)('%s reports part comments in the existing lossy-save report', format => {
    const report = checkFormatLoss(format, { ...snapshot(), configs: [], motors: {}, flightData: {} });
    expect(report.losses.join('\n')).toContain('Part comments');
    expect(report.losses.join('\n')).toContain('Stage');
    expect(report.losses.join('\n')).toContain('Tube');
    const bare: RocketTree = { components: [{ type: 'stage', children: [] }] };
    expect(checkFormatLoss(format, { ...snapshot(bare), configs: [], motors: {}, flightData: {} }).losses.join('\n'))
      .not.toContain('Part comments');
  });
});
