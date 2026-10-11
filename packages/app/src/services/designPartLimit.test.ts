// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { designFileOpenFailure, openDesignFile } from './designFile.js';
import { exportOrk, importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { decodeShareFragment, encodeShareFragment, shareLinkOpenFailure } from './shareLink.js';
import type { SessionState } from './session.js';
import { designStateFromSession } from './sessionRestore.js';
import { simulateFile } from './simulateFile.js';
import { SimulateDesignError } from './simulateDesign.js';
import { countParts, MAX_DESIGN_PARTS, TOO_MANY_PARTS_ERROR_NAME } from '../tree/sanitize.js';
import { makeNode } from '../tree/treeModel.js';

/**
 * THE PART LIMIT (board Tier 0 row 84, ruled by Eric 2026-10-11, option c):
 * a design read from outside the app is refused above 2,000 parts, on every
 * route — Open… for .ork, .rkt and .CDX1, a share link, the crash file
 * reopened through Open…, a headless simulateFile — before any motor is
 * matched or the kernel builds anything. 2,000 opens; 2,001 does not.
 */

let stageId = 0;
const makeStage = (name: string) => ({ type: 'stage', id: `stage-${++stageId}`, name, children: [] }) as ComponentNode;

const SENTENCE = (n: string) => `This design has ${n} parts, past the 2,000 the app will open. Desktop OR has no such limit.`;

/** A design of exactly `parts` nodes: one stage, one body tube, and mass components inside it. */
function treeOf(parts: number): RocketTree {
  const body = { ...makeNode('bodytube'),
    children: Array.from({ length: parts - 2 }, () => makeNode('masscomponent')) } as ComponentNode;
  return { name: 'Many', components: [{ ...makeStage('Sustainer'), children: [body] } as ComponentNode] };
}
const orkOf = (parts: number) => exportOrk({ name: 'Many', tree: treeOf(parts) });

/** A .rkt of one stage holding one body tube and `parts - 2` mass objects (the stage counts as a part). */
const rktOf = (parts: number) => `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign>
  <Name>Many</Name><StageCount>1</StageCount><Stage3Parts>
    <BodyTube><Name>Tube</Name><OD>66</OD><ID>64</ID><Len>400</Len><AttachedParts>
      ${'<MassObject><Name>M</Name><KnownMass>10</KnownMass><Len>10</Len><Xb>5</Xb></MassObject>'.repeat(parts - 2)}
    </AttachedParts></BodyTube>
  </Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;

/** A .CDX1 of one stage and `parts - 1` body tubes, one after another. */
const cdxOf = (parts: number) => `<RASAeroDocument><RocketDesign>
  ${'<BodyTube><PartType>BodyTube</PartType><Length>2</Length><Diameter>3</Diameter></BodyTube>'.repeat(parts - 1)}
  </RocketDesign></RASAeroDocument>`;

const refusal = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error('not refused');
};

describe('the part limit at open (board row 84)', () => {
  it('counts every node: stages, boosters, pods and parts at any depth', () => {
    expect(MAX_DESIGN_PARTS).toBe(2000);
    expect(countParts(treeOf(7).components)).toBe(7);
    const pod = { ...makeNode('podset'), children: [{ ...makeNode('bodytube'), children: [makeNode('trapezoidfinset')] }] };
    const nested = [{ ...makeStage('Sustainer'), children: [makeNode('nosecone'),
      { ...makeNode('bodytube'), children: [pod, makeNode('innertube')] }] }, makeStage('Booster')] as ComponentNode[];
    expect(countParts(nested)).toBe(8);
  });

  it('.ork: 2,000 parts open, 2,001 are refused with one plain sentence', () => {
    expect(countParts(importOrk(orkOf(2000)).tree.components)).toBe(2000);
    const e = refusal(() => importOrk(orkOf(2001)));
    expect(e.name).toBe(TOO_MANY_PARTS_ERROR_NAME);
    expect(e.message).toBe(SENTENCE('2,001'));
  }, 30_000);

  it('.rkt: 2,000 parts open, 2,001 are refused', () => {
    expect(countParts(importRkt(rktOf(2000)).tree.components)).toBe(2000);
    expect(refusal(() => importRkt(rktOf(2001))).message).toBe(SENTENCE('2,001'));
  }, 30_000);

  it('.CDX1: 2,000 parts open, 2,001 are refused', () => {
    expect(countParts(importCdx1(cdxOf(2000)).tree.components)).toBe(2000);
    expect(refusal(() => importCdx1(cdxOf(2001))).message).toBe(SENTENCE('2,001'));
  }, 30_000);

  it('Open… (and the crash file reopened through it) words the refusal for the format picked', async () => {
    const bytes = new TextEncoder().encode(orkOf(2001)).buffer as ArrayBuffer;
    const e = await openDesignFile(bytes, 'Many.ork', { presets: [] }).then(() => null, (x: unknown) => x);
    expect(designFileOpenFailure('Many.ork', e)).toBe(`Could not open that .ork file: ${SENTENCE('2,001')}`);
    const rkt = new TextEncoder().encode(rktOf(2001)).buffer as ArrayBuffer;
    const r = await openDesignFile(rkt, 'Many.rkt', { presets: [] }).then(() => null, (x: unknown) => x);
    expect(designFileOpenFailure('Many.rkt', r)).toBe(`Could not open that .rkt file: ${SENTENCE('2,001')}`);
  }, 30_000);

  it('a share link says so instead of calling the link damaged', async () => {
    const fragment = await encodeShareFragment(orkOf(2001));
    const xml = await decodeShareFragment(fragment);
    expect(shareLinkOpenFailure(refusal(() => importOrk(xml))))
      .toBe(`Couldn't open the design in this link: ${SENTENCE('2,001')}`);
  }, 30_000);

  it('simulateFile refuses before any motor is matched or anything is built', async () => {
    const match = vi.fn();
    const err = await simulateFile(new TextEncoder().encode(orkOf(2001)), 'Many.ork', { presets: [], match })
      .then(() => null, (x: unknown) => x);
    expect(err).toBeInstanceOf(SimulateDesignError);
    expect((err as SimulateDesignError).kind).toBe('parse');
    expect((err as SimulateDesignError).message).toBe(`Could not open that .ork file: ${SENTENCE('2,001')}`);
    expect(match).not.toHaveBeenCalled();
  }, 30_000);

  it('does not cap the autosave: a reload restores a design built past the limit in the app', () => {
    // Editing is not capped, so the autosave is the user's own work; the limit
    // guards a file from outside (see MAX_DESIGN_PARTS).
    const restored = designStateFromSession({ tree: treeOf(2001) } as SessionState, { legacyMaxMotorLengthM: null });
    expect(countParts(restored.state.tree.components)).toBe(2001);
  }, 30_000);
});
