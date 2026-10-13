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
import { browserXmlParser, currentXmlParser, setXmlParser } from './xmlParse.js';

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

describe('foreign-format pre-count (board Tier 2 part-cap early refusal)', () => {
  it.each([['.rkt', importRkt, rktOf], ['.CDX1', importCdx1, cdxOf]] as const)(
    '%s refuses provably retained 2,001 parts before the XML parser', (_format, read, input) => {
      const parser = currentXmlParser();
      let parsed = false;
      setXmlParser(xml => { parsed = true; return parser(xml); });
      try {
        expect(refusal(() => read(input(2001))).message).toBe(SENTENCE('2,001'));
        expect(parsed).toBe(false);
      } finally { setXmlParser(parser); }
    }, 30_000);

  it('RockSim does not count unsupported, incompatible, inactive-stage or fin-attached parts', () => {
    const ignored = '<Unknown><MassObject/></Unknown>'.repeat(2001);
    const fins = '<FinSet><Name>Wing</Name><AttachedParts>' + '<ExternalPod/>'.repeat(2001) + '</AttachedParts></FinSet>';
    const xml = rktOf(2).replace('<AttachedParts>', `<AttachedParts>${ignored}${fins}<Transition/>`)
      .replace('</Stage3Parts>', '</Stage3Parts><Stage2Parts>' + '<BodyTube/>'.repeat(2001) + '</Stage2Parts>');
    expect(countParts(importRkt(xml).tree.components)).toBe(3);
  }, 30_000);

  it('RockSim does not count fins on inner tubes or attachments of leaf handlers', () => {
    const xml = rktOf(2).replace('<AttachedParts>', '<IsInsideTube>1</IsInsideTube><AttachedParts>'
      + '<FinSet/>'.repeat(2001) + '<Ring><AttachedParts>' + '<MassObject/>'.repeat(2001) + '</AttachedParts></Ring>');
    expect(countParts(importRkt(xml).tree.components)).toBe(3);
  }, 30_000);

  it('RockSim counts only the first AttachedParts wrapper and clamps stage count as the importer does', () => {
    const xml = rktOf(2).replace('<StageCount>1', '<StageCount>1.5')
      .replace('</AttachedParts>', '</AttachedParts><AttachedParts>' + '<MassObject/>'.repeat(2001) + '</AttachedParts>');
    expect(countParts(importRkt(xml).tree.components)).toBe(2);
  }, 30_000);

  it.each(['rkt', 'CDX1'] as const)('%s uncertain retention falls back and still enforces the late cap', format => {
    const xml = format === 'rkt' ? rktOf(2000).replace('<AttachedParts>', '<AttachedParts><SubAssembly><AttachedParts>'
      + '<MassObject/><MassObject/></AttachedParts></SubAssembly>')
      : cdxOf(2000).replace('</RASAeroDocument>', '<Recovery><Event1>true</Event1><EventType1>Apogee</EventType1>'
        + '<Event2>true</Event2><EventType2>Apogee</EventType2></Recovery></RASAeroDocument>');
    const parser = currentXmlParser();
    let parsed = false;
    setXmlParser(input => { parsed = true; return parser(input); });
    try {
      expect(refusal(() => (format === 'rkt' ? importRkt : importCdx1)(xml)).message).toBe(SENTENCE('2,002'));
      expect(parsed).toBe(true);
    } finally { setXmlParser(parser); }
  }, 30_000);

  it('RASAero conditional lugs and protuberances retain the exact late refusal', () => {
    const xml = cdxOf(2000).replace('</BodyTube>', '<LaunchLugDiameter>0.2</LaunchLugDiameter>'
      + '<LaunchLugLength>1</LaunchLugLength><Protuberance><StreamlinedNoBaseDrag>0.1</StreamlinedNoBaseDrag>'
      + '</Protuberance></BodyTube>');
    expect(refusal(() => importCdx1(xml)).message).toBe(SENTENCE('2,002'));
  }, 30_000);

  it('unclosed XML with enough apparent parts keeps the parse refusal', () => {
    expect(() => importRkt(rktOf(2001).replace('</RockSimDocument>', ''))).toThrow('XML parse error');
    expect(() => importCdx1(cdxOf(2001).replace('</RASAeroDocument>', ''))).toThrow('XML parse error');
  });

  it('RASAero counts only the first direct Fin and ignores unsupported subtrees and text', () => {
    const xml = cdxOf(2).replace('</BodyTube>', '<Fin/>'.repeat(2001) + '</BodyTube>')
      .replace('</RocketDesign>', '<Unknown><BodyTube/></Unknown>'.repeat(2001) + '</RocketDesign>');
    expect(countParts(importCdx1(xml).tree.components)).toBe(3);
  }, 30_000);

  it('fake tags in comments, CDATA and quoted attributes never create a new refusal', () => {
    const fake = '<BodyTube/>'.repeat(2001);
    const xml = cdxOf(2).replace('<RASAeroDocument>', `<RASAeroDocument note='${fake}'>`)
      .replace('<RocketDesign>', `<RocketDesign><!--${fake}--><Comments><![CDATA[${fake}]]></Comments>`);
    // A literal '<' in an attribute is malformed: use XML's escaped spelling.
    const escaped = xml.replace(`note='${fake}'`, `note='${fake.replaceAll('<', '&lt;')}'`);
    if (currentXmlParser() === browserXmlParser) {
      // happy-dom rejects valid CDATA; preserve that existing refusal, never a part-limit refusal.
      expect(() => importCdx1(escaped)).toThrow('XML parse error');
    } else expect(countParts(importCdx1(escaped).tree.components)).toBe(2);
  }, 30_000);

  it.skipIf(!process.env.B10_IMPORT_BENCH)('times the 8,000-fin crafted workload', () => {
    const workloads = [
      ['rkt', importRkt, rktOf(2).replace('<AttachedParts>', '<AttachedParts>' + '<FinSet/>'.repeat(8000))],
      ['CDX1', importCdx1, cdxOf(8001).replaceAll('</BodyTube>', '<Fin/></BodyTube>')],
    ] as const;
    for (const [format, read, xml] of workloads) {
      const times = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        expect(refusal(() => read(xml)).name).toBe(TOO_MANY_PARTS_ERROR_NAME);
        times.push(performance.now() - start);
      }
      console.log(`${format}: ${xml.length} chars, milliseconds ${times.map(t => t.toFixed(3)).join(', ')}`);
    }
  }, 120_000);
});

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
