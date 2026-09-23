// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { engineTree, normalizeTree } from '../tree/treeModel.js';

/**
 * The three importers and the share link apply the limits table at the file
 * boundary, and SAY so in the import banner (audit 2026-09-22, "counts read
 * with no ceiling", "degenerate values fail the whole build" and "unknown enum
 * strings"). Every file below was measured at a7756c5 doing the damage its
 * test names; each now imports inside the limits with one note per repair.
 */

const flatten = (ns: readonly ComponentNode[]): ComponentNode[] =>
  ns.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const ofType = (tree: RocketTree, type: string): ComponentNode =>
  flatten(tree.components).find((n) => n.type === type)!;

/** Build the way App.tsx's buildResult does; the kernel's message, or null. */
function build(tree: RocketTree): string | null {
  try {
    resetEngine();
    OrkRocket.buildTree(engineTree(normalizeTree(tree))).staticInfo();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ---------------------------------------------------------------- .rkt

const rkt = (parts: string): string =>
  `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign>
  <Name>Test</Name><StageCount>1</StageCount>
  <Stage3Parts>
    <NoseCone><Name>Nose</Name><Len>150</Len><BaseDia>66</BaseDia><ShapeCode>1</ShapeCode></NoseCone>
    <BodyTube><Name>Tube</Name><OD>66</OD><ID>64</ID><Len>400</Len>
      <AttachedParts>${parts}</AttachedParts>
    </BodyTube>
  </Stage3Parts>
</RocketDesign></DesignInformation></RockSimDocument>`;

const FINSET = (extra: string) => `<FinSet><Name>Fins</Name><ShapeCode>0</ShapeCode>
  <RootChord>80</RootChord><TipChord>40</TipChord><SweepDistance>30</SweepDistance>
  <Thickness>3</Thickness>${extra}</FinSet>`;

describe('.rkt — counts', () => {
  it('a FinCount of 70,000 imports as the kernel\'s 8, with a note', () => {
    // At a7756c5 this reached the side view raw, whose Math.min(...ys) spread
    // threw RangeError and replaced the whole app with "Something went wrong".
    const r = importRkt(rkt(FINSET('<FinCount>70000</FinCount><SemiSpan>50</SemiSpan>')));
    expect(ofType(r.tree, 'trapezoidfinset')['finCount']).toBe(8);
    expect(r.notes.filter((n) => /fin count/.test(n))).toEqual([
      '“Fins”: fin count 70000 is over the limit of 8 (the most fins a set can have in OpenRocket,'
        + ' and so the most the simulation flies) — set to 8.',
    ]);
  });

  it('a TubeCount of 100,000 imports as 8', () => {
    const r = importRkt(rkt('<TubeFinSet><Name>Tubes</Name><TubeCount>100000</TubeCount><Len>80</Len>'
      + '<OD>20</OD><ID>19</ID></TubeFinSet>'));
    expect(ofType(r.tree, 'tubefinset')['finCount']).toBe(8);
    expect(r.notes.some((n) => n.startsWith('“Tubes”: fin count 100000 is over the limit of 8'))).toBe(true);
  });

  it('a ShroudLineCount of 1,000,000 no longer weighs 540 kg', () => {
    const r = importRkt(rkt('<Parachute><Name>Chute</Name><Dia>600</Dia>'
      + '<ShroudLineCount>1000000</ShroudLineCount><ShroudLineLen>300</ShroudLineLen></Parachute>'));
    const chute = ofType(r.tree, 'parachute');
    expect(chute['lineCount']).toBe(64);
    expect(r.notes).toContain(
      '“Chute”: line count 1000000 is over the limit of 64 (more than any real parachute) — set to 64.');
    // The kernel's own mass for the imported canopy: 540.02 kg with the file's
    // count (measured at a7756c5), 0.0535 kg with 64 lines.
    resetEngine();
    const t = engineTree(normalizeTree(r.tree));
    const rocket = OrkRocket.buildTree(t);
    rocket.staticInfo();
    expect(rocket.componentInfo(ofType(t, 'parachute').id!).mass).toBeLessThan(0.1);
  });
});

describe('.rkt — degenerate dimensions', () => {
  it('a negative SemiSpan imports as zero, says so, and the design builds', () => {
    const r = importRkt(rkt(FINSET('<FinCount>4</FinCount><SemiSpan>-50</SemiSpan>')));
    expect(ofType(r.tree, 'trapezoidfinset')['height']).toBe(0);
    expect(r.notes).toContain('“Fins”: height -50 mm cannot be negative — set to 0 mm.');
    expect(build(r.tree)).toBeNull();
  });

  it('a negative tube-fin Len imports as the 0.1 mm minimum, and the design builds', () => {
    const r = importRkt(rkt('<TubeFinSet><Name>Tubes</Name><TubeCount>6</TubeCount><Len>-80</Len>'
      + '<OD>20</OD><ID>19</ID></TubeFinSet>'));
    expect(ofType(r.tree, 'tubefinset')['length']).toBe(0.0001);
    expect(r.notes).toContain('“Tubes”: length -80 mm is below the minimum of 0.1 mm — set to 0.1 mm.');
    expect(build(r.tree)).toBeNull();
  });
});

// ---------------------------------------------------------------- .CDX1

const cdx1 = (fin: string): string =>
  `<?xml version="1.0"?><RASAeroDocument><FileVersion>2</FileVersion><RocketDesign>
    <NoseCone><PartType>NoseCone</PartType><Length>4.5</Length><Diameter>1.64</Diameter></NoseCone>
    <BodyTube><PartType>BodyTube</PartType><Length>18.25</Length><Diameter>1.64</Diameter>
      <Fin>${fin}</Fin></BodyTube>
  </RocketDesign></RASAeroDocument>`;

describe('.CDX1 — fin count and span', () => {
  it('a fin Count of 50 imports as 8 (the reader had a floor and no ceiling)', () => {
    const r = importCdx1(cdx1('<Count>50</Count><Chord>3</Chord><Span>2</Span><TipChord>1.5</TipChord>'
      + '<SweepDistance>1</SweepDistance><Location>3</Location><Thickness>0.1</Thickness>'));
    expect(ofType(r.tree, 'trapezoidfinset')['finCount']).toBe(8);
    expect(r.notes.some((n) => /^“Fins”: fin count 50 is over the limit of 8/.test(n))).toBe(true);
  });

  it('a negative Span imports as zero, and the design builds', () => {
    const r = importCdx1(cdx1('<Count>4</Count><Chord>3</Chord><Span>-2</Span><TipChord>1.5</TipChord>'
      + '<SweepDistance>1</SweepDistance><Location>3</Location><Thickness>0.1</Thickness>'));
    expect(ofType(r.tree, 'trapezoidfinset')['height']).toBe(0);
    // -2 in: RASAero's inches, so the millimetres carry the conversion's tail.
    expect(r.notes).toContain('“Fins”: height -50.8001 mm cannot be negative — set to 0 mm.');
    expect(build(r.tree)).toBeNull();
  });
});

// ---------------------------------------------------------------- .ork

/** A .ork with one nose and one body tube; `kids` go inside the tube. */
const ork = (kids: string, opts: { rocketExtra?: string; stages?: string } = {}): string =>
  `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="1.10" creator="OpenRocket 24.12">
  <rocket>
    <name>Test</name>
    ${opts.rocketExtra ?? ''}
    <subcomponents>
      <stage>
        <name>Sustainer</name>
        <subcomponents>
          <nosecone><name>Nose</name><length>0.15</length><shape>ogive</shape><aftradius>0.025</aftradius><thickness>0.002</thickness></nosecone>
          <bodytube><name>Tube</name><length>0.4</length><radius>0.025</radius><thickness>0.001</thickness>
            <subcomponents>${kids}</subcomponents>
          </bodytube>
        </subcomponents>
      </stage>
      ${opts.stages ?? ''}
    </subcomponents>
  </rocket>
</openrocket>`;

const LUG = (count: string) => `<launchlug><name>Lug</name><length>0.05</length><radius>0.0022</radius>
  <thickness>0.0003</thickness><instancecount>${count}</instancecount><instanceseparation>0.001</instanceseparation></launchlug>`;
const ORK_FINS = (extra: string) => `<trapezoidfinset><name>Fins</name><fincount>4</fincount>
  <rootchord>0.08</rootchord><tipchord>0.04</tipchord><sweeplength>0.03</sweeplength>
  <thickness>0.003</thickness>${extra}</trapezoidfinset>`;

describe('.ork — counts and dimensions', () => {
  it('a lug instancecount of 20,000 imports as the bridge\'s 64 (it drew 2.0 M vertices)', () => {
    const r = importOrk(ork(LUG('20000')));
    expect(ofType(r.tree, 'launchlug')['instanceCount']).toBe(64);
    expect(r.notes).toContain(
      '“Lug”: number of instances 20000 is over the limit of 64 (the most the simulation places in a line) — set to 64.');
  });

  it('a negative fin height imports as zero, and the design builds', () => {
    const raw = ork(ORK_FINS('<height>-0.03</height>'));
    const r = importOrk(raw);
    expect(ofType(r.tree, 'trapezoidfinset')['height']).toBe(0);
    expect(r.notes).toContain('“Fins”: height -30 mm cannot be negative — set to 0 mm.');
    expect(build(r.tree)).toBeNull();
  });

  it('a clean file gets no repair notes', () => {
    const r = importOrk(ork(ORK_FINS('<height>0.03</height>') + LUG('2')));
    expect(r.notes.filter((n) => /limit|minimum|negative|not one the simulation knows/.test(n))).toEqual([]);
  });
});

describe('.ork — enum strings', () => {
  it('drops an unknown airfoil section with a note, and respells a known one silently', () => {
    const r = importOrk(ork(ORK_FINS('<height>0.03</height><airfoilsection>wedgie</airfoilsection>')
      + ORK_FINS('<height>0.03</height><airfoilsection>HEX_BLUNT_BASE</airfoilsection>').replace('>Fins<', '>Aft fins<')));
    const [a, b] = flatten(r.tree.components).filter((n) => n.type === 'trapezoidfinset');
    expect(a).not.toHaveProperty('airfoilSection');
    expect(b!['airfoilSection']).toBe('hexbluntbase');
    expect(r.notes.filter((n) => /airfoil/.test(n))).toEqual([
      '“Fins”: supersonic airfoil section “wedgie” is not one the simulation knows — it now uses the classic cross-section drag.',
    ]);
    expect(build(r.tree)).toBeNull();
  });

  const BOOSTER = (sep: string) => `<stage><name>Booster</name>${sep}<subcomponents>
    <bodytube><name>Booster tube</name><length>0.3</length><radius>0.025</radius><thickness>0.001</thickness></bodytube>
  </subcomponents></stage>`;
  const CONFIGS = `<motorconfiguration configid="a" default="true"><name>A</name></motorconfiguration>
    <motorconfiguration configid="b"><name>B</name></motorconfiguration>`;

  it('an unknown separation in a configuration NOT opened is repaired too, not left to fail the day it is picked', () => {
    // At a7756c5 configuration B carried "sometime" verbatim; applying it put
    // the string on the stage and OrkEngine.separationEventOf threw, failing
    // the whole build.
    const r = importOrk(ork('', {
      rocketExtra: CONFIGS,
      stages: BOOSTER(`<separationconfiguration configid="a"><separationevent>burnout</separationevent></separationconfiguration>
        <separationconfiguration configid="b"><separationevent>sometime</separationevent></separationconfiguration>`),
    }));
    expect(r.chosenConfigId).toBe('a');
    const boosterId = r.tree.components[1]!.id!;
    const b = r.configs!.find((c) => c.id === 'b')!;
    expect(b.separations[boosterId]!.separationEvent).toBe('ejection');
    expect(r.notes).toContain('“Booster”: separation event “sometime”, in a flight configuration other than'
      + ' the one opened, is not one the simulation knows — that configuration now uses this stage’s ejection'
      + ' charge, desktop OpenRocket’s default.');
  });

  it('an unknown separation in the OPENED configuration is dropped from the stage, one note', () => {
    const r = importOrk(ork('', {
      rocketExtra: CONFIGS,
      stages: BOOSTER('<separationevent>sometime</separationevent>'),
    }));
    expect(r.tree.components[1]).not.toHaveProperty('separationEvent');
    // Both configurations inherit the bare tag — still ONE note, the tree pass's.
    expect(r.notes.filter((n) => /sometime/.test(n))).toEqual([
      '“Booster”: separation event “sometime” is not one the simulation knows — it now uses this stage’s'
        + ' ejection charge, desktop OpenRocket’s default.',
    ]);
    for (const c of r.configs!) expect(c.separations[r.tree.components[1]!.id!]!.separationEvent).toBe('ejection');
    expect(build(r.tree)).toBeNull();
  });

  const MOUNT = (ignition: string) => `<innertube><name>Mount</name><length>0.07</length>
    <outerradius>0.0095</outerradius><thickness>0.0005</thickness>
    <motormount><ignitionevent>${ignition}</ignitionevent><ignitiondelay>0</ignitiondelay>
      <motor><type>single</type><manufacturer>Estes</manufacturer><designation>C6</designation>
        <diameter>0.018</diameter><length>0.07</length><delay>5</delay></motor>
    </motormount></innertube>`;

  it('an unknown ignition event falls back to automatic with a note (the kernel threw on it)', () => {
    const r = importOrk(ork(MOUNT('whenever')));
    expect(r.motor!.ignitionEvent).toBeUndefined();
    expect(r.notes).toContain('“Mount”: motor ignition event “whenever” is not one the simulation knows'
      + ' — it now uses automatic ignition, desktop OpenRocket’s default.');
  });

  it('an ignition event in another spelling is read in the kernel\'s', () => {
    const r = importOrk(ork(MOUNT('EJECTION_CHARGE')));
    expect(r.motor!.ignitionEvent).toBe('ejectioncharge');
    expect(r.notes.some((n) => /ignition/.test(n))).toBe(false);
  });

  it('a deploy event is left as the file wrote it — desktop\'s lowerstageseparation included — and saved back', () => {
    // Not an enum the pass repairs: the bridge never throws on a deploy event
    // (ComponentFactory.deployEventOf flies what it does not name as the
    // ejection charge), and desktop 24.12 has one the app's menu lacks —
    // LOWER_STAGE_SEPARATION, saved as "lowerstageseparation". A first cut of
    // this pass checked deploy events against the app's five, deleted that one
    // with a note, and the .ork export then wrote "ejection" in its place.
    const r = importOrk(ork('<parachute><name>Chute</name><diameter>0.3</diameter>'
      + '<deployevent>lowerstageseparation</deployevent></parachute>'));
    expect(ofType(r.tree, 'parachute')['deployEvent']).toBe('lowerstageseparation');
    expect(r.notes.some((n) => /deploy/.test(n))).toBe(false);
    const tree = normalizeTree(r.tree);
    expect(ofType(tree, 'parachute')['deployEvent']).toBe('lowerstageseparation');
    expect(exportOrk({ name: r.name, tree })).toContain('<deployevent>lowerstageseparation</deployevent>');
    expect(build(r.tree)).toBeNull();
  });
});

// ---------------------------------------------------------------- share link

describe('a share link is a .ork, and gets the same repairs', () => {
  it('a link carrying a fin count of 1e8 opens as 8 fins with a note', async () => {
    // A 519-character link did this at a7756c5 and was applied with no prompt
    // on a first visit (App.tsx's share-link loader calls importOrk).
    const frag = await encodeShareFragment(ork(ORK_FINS('<height>0.03</height>').replace('<fincount>4</fincount>', '<fincount>100000000</fincount>')));
    const r = importOrk(await decodeShareFragment(frag));
    expect(ofType(r.tree, 'trapezoidfinset')['finCount']).toBe(8);
    expect(r.notes.some((n) => /^“Fins”: fin count 100000000 is over the limit of 8/.test(n))).toBe(true);
  });
});
