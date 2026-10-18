// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { importRkt, MAX_RKT_SIMULATION_RECORDS } from './rocksimFile.js';
import * as nodeNumbers from '../tree/nodeNum.js';
import { currentXmlParser, setXmlParser } from './xmlParse.js';

// Count the real node reads, including each grouping/de-collision comparison,
// rather than timing the machine (audit 2026-10-11, S1b-3).
describe('RockSim refuses large designs before quadratic passes', () => {
  it.each(['BodyTube', 'FinSet'])('bounds reads for 2,001 distinct %s children', tag => {
    const children = Array.from({ length: 2001 }, (_, i) => `<${tag}><Xb>${i * 100}</Xb>
      <OD>20</OD><ID>18</ID><Len>50</Len><RootChord>50</RootChord><TipChord>20</TipChord>
      <SemiSpan>20</SemiSpan><FinCount>3</FinCount><ShapeCode>0</ShapeCode></${tag}>`).join('');
    const xml = `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount>
      <Stage3Parts><BodyTube><OD>60</OD><ID>58</ID><Len>400</Len><AttachedParts>${children}
      </AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
    const original = nodeNumbers.num;
    let reads = 0;
    const spy = vi.spyOn(nodeNumbers, 'num').mockImplementation((...args) => {
      reads++;
      return original(...args);
    });
    try {
      expect(() => importRkt(xml)).toThrow(/2,003 parts, past the 2,000/);
      // Conversion can read dimensions, but millions of pairwise comparisons cannot pass.
      expect(reads).toBeLessThan(20 * 2001);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('S1b-g2 bounds raw RockSim simulation work before folding', () => {
  const engine = `<EngineSet><EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg><MountSerialNo>7</MountSerialNo>
    <EngineCount>1</EngineCount><IgnitionDelay>0</IgnitionDelay><EjectionDelay>5</EjectionDelay></EngineSet>`;
  const sim = (sets = engine) => `<SimulationResults><Mass0>200</Mass0><TimeToBurnout>2</TimeToBurnout>
    <Stage3Engines>${sets}</Stage3Engines></SimulationResults>`;
  const file = (records: string, extra = '') => `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation>
    <RocketDesign><StageCount>1</StageCount><UseKnownMass>1</UseKnownMass><Stage3Mass>100</Stage3Mass>
      <Stage3Parts><BodyTube><OD>20</OD><ID>18</ID><Len>300</Len><IsMotorMount>1</IsMotorMount>
        <SerialNo>7</SerialNo></BodyTube></Stage3Parts>${extra}<SimulationResultsList>${records}</SimulationResultsList>
    </RocketDesign></DesignInformation></RockSimDocument>`;

  it('refuses more than 4096 raw simulations, even with no engines to retain', () => {
    expect(MAX_RKT_SIMULATION_RECORDS).toBe(4096);
    expect(() => importRkt(file('<SimulationResults/>'.repeat(4096)))).not.toThrow();
    expect(() => importRkt(file('<SimulationResults/>'.repeat(4097))))
      .toThrow('This file contains 4,097 simulations, past the 4,096 the app will open. Remove simulations in RockSim and save it again. Desktop OR has no such limit.');
  }, 30_000);

  it('refuses more than 4096 total engine sets, including loose and empty sets', () => {
    expect(() => importRkt(file(sim('<EngineSet/>'.repeat(4096))))).not.toThrow();
    expect(() => importRkt(file(sim('<EngineSet/>'.repeat(2049)), '<EngineSet/>'.repeat(2048))))
      .toThrow("This file's simulations list 4,097 motor loadouts, past the 4,096 the app will open. Remove simulations in RockSim and save it again. Desktop OR has no such limit.");
  }, 30_000);

  it.each(['SimulationResults', 'EngineSet'])('refuses nested %s before per-record subtree reads', tag => {
    const parser = currentXmlParser();
    let queries = 0;
    let records = 0;
    setXmlParser(xml => {
      const doc = parser(xml);
      for (const record of doc.querySelectorAll('SimulationResults, EngineSet')) {
        records++;
        const query = record.querySelector.bind(record);
        const queryAll = record.querySelectorAll.bind(record);
        vi.spyOn(record, 'querySelector').mockImplementation(selector => {
          queries++;
          return query(selector);
        });
        vi.spyOn(record, 'querySelectorAll').mockImplementation(selector => {
          queries++;
          return queryAll(selector);
        });
      }
      return doc;
    });
    try {
      // Wrappers ensure the check detects ancestors, not just direct parents.
      // All records fit below both raw caps; the innermost padding is shared.
      const nested = `<${tag}><Wrapper>`.repeat(24) + '<Pad/>'.repeat(200)
        + `</Wrapper></${tag}>`.repeat(24);
      const xml = file(tag === 'EngineSet' ? sim(nested) : nested);
      const population = tag === 'EngineSet' ? 'motor loadouts' : 'simulations';
      expect(() => importRkt(xml)).toThrow(`This RockSim file contains nested ${population}, which the app cannot open. Open it in RockSim and save it again.`);
      expect(records).toBe(tag === 'EngineSet' ? 25 : 24);
      expect(queries).toBe(0);
    } finally {
      setXmlParser(parser);
      vi.restoreAllMocks();
    }
  });

  it.each([true, false])('keeps document and design probes constant with shared fields present=%s', present => {
    const parser = currentXmlParser();
    const measure = (count: number) => {
      const probes = { document: 0, root: 0, design: 0 };
      setXmlParser(xml => {
        const doc = parser(xml);
        const design = doc.querySelector('RockSimDocument > DesignInformation > RocketDesign')!;
        for (const [target, key] of [[doc, 'document'], [doc.documentElement, 'root'], [design, 'design']] as const) {
          const query = target.querySelector.bind(target);
          vi.spyOn(target, 'querySelector').mockImplementation(selector => {
            probes[key]++;
            return query(selector);
          });
        }
        return doc;
      });
      let xml = file(sim().repeat(count), '<Pad/>'.repeat(1500));
      if (!present) xml = xml.replace('<FileVersion>4</FileVersion>', '').replace('<StageCount>1</StageCount>', '');
      const result = importRkt(xml);
      expect(result.configs).toHaveLength(1);
      return probes;
    };
    try {
      expect(measure(300)).toEqual(measure(1));
    } finally {
      setXmlParser(parser);
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('uses only the resolved design for stage and dry-mass evidence', () => {
    const decoy = '<RocketDesign><StageCount>2</StageCount><UseKnownMass>0</UseKnownMass><Stage3Mass>999</Stage3Mass></RocketDesign>';
    const result = importRkt(file(sim()).replace('<DesignInformation>', `${decoy}<DesignInformation>`));
    expect(Object.values(result.motors)[0]).toMatchObject({ rktBurnTimeS: 2,
      matchContext: { physical: { loadedMassG: 200, dryMassG: 100, motorMassG: 100, burnTimeS: 2 } } });
  });

  it.each([true, false])('memoises a padded serial target with ID present=%s across 300 simulations', present => {
    const parser = currentXmlParser();
    const measure = (count: number) => {
      let queries = 0;
      let scans = 0;
      setXmlParser(xml => {
        const doc = parser(xml);
        const mount = doc.querySelector('Junk')!;
        const query = mount.querySelector.bind(mount);
        vi.spyOn(mount, 'querySelector').mockImplementation(selector => {
          queries++;
          return query(selector);
        });
        const children = mount.children;
        Object.defineProperty(mount, 'children', { configurable: true, get: () => { scans++; return children; } });
        return doc;
      });
      const junk = `<Junk><SerialNo>9</SerialNo>${'<Pad/>'.repeat(1500)}${present ? '<ID>18</ID>' : ''}<IsMotorMount>1</IsMotorMount></Junk>`;
      const result = importRkt(file(sim(engine.replace('<MountSerialNo>7', '<MountSerialNo>9')).repeat(count), junk));
      expect(result.configs).toHaveLength(1);
      expect(Object.values(result.motors)[0]!.matchContext?.mountBoreMm).toBeUndefined();
      return { queries, scans };
    };
    try {
      expect(measure(300)).toEqual({ queries: 0, scans: 1 });
      expect(measure(1)).toEqual({ queries: 0, scans: 1 });
    } finally {
      setXmlParser(parser);
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('counts motor-bearing sets per stage once before checking stale serials', () => {
    const parser = currentXmlParser();
    let stageReads = 0;
    const count = 40;
    setXmlParser(xml => {
      const doc = parser(xml);
      const stage = doc.querySelector('Stage3Engines')!;
      const tagName = stage.tagName;
      Object.defineProperty(stage, 'tagName', { configurable: true, get: () => { stageReads++; return tagName; } });
      return doc;
    });
    try {
      const mounts = Array.from({ length: count }, (_, i) => `<BodyTube><OD>20</OD><ID>18</ID><Len>100</Len>
        <Xb>${i * 10}</Xb><IsMotorMount>1</IsMotorMount><SerialNo>${i + 10}</SerialNo></BodyTube>`).join('');
      const xml = file(sim(engine.replace('<MountSerialNo>7', '<MountSerialNo>9999').repeat(count)))
        .replace(/<Stage3Parts>.*?<\/Stage3Parts>/s, `<Stage3Parts>${mounts}</Stage3Parts>`);
      const result = importRkt(xml);
      expect(Object.keys(result.motors)).toHaveLength(count);
      expect(stageReads).toBeLessThan(20 * count);
    } finally {
      setXmlParser(parser);
    }
  });

  it('indexes the design once and counts each simulation once for 300 identical simulations', () => {
    const parser = currentXmlParser();
    let designWalks = 0;
    let simulationWalks = 0;
    setXmlParser(xml => {
      const doc = parser(xml);
      const design = doc.querySelector('RocketDesign')!;
      const query = design.querySelectorAll.bind(design);
      vi.spyOn(design, 'querySelectorAll').mockImplementation(selector => {
        if (selector === 'SerialNo') designWalks++;
        return query(selector);
      });
      for (const simulation of doc.querySelectorAll('SimulationResults')) {
        const query = simulation.querySelectorAll.bind(simulation);
        vi.spyOn(simulation, 'querySelectorAll').mockImplementation(selector => {
          if (selector === 'EngineSet') simulationWalks++;
          return query(selector);
        });
      }
      return doc;
    });
    try {
      const result = importRkt(file(sim().repeat(300), '<SerialNo>junk</SerialNo>'.repeat(1500)));
      expect(result.configs).toHaveLength(1);
      expect(Object.values(result.motors)[0]).toMatchObject({ rktBurnTimeS: 2,
        matchContext: { mountBoreMm: 18, physical: { loadedMassG: 200, dryMassG: 100, burnTimeS: 2 } } });
      expect(designWalks).toBe(1);
      expect(simulationWalks).toBe(300);
    } finally {
      setXmlParser(parser);
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('does not infer motor dimensions or dry-mass evidence from a duplicated serial', () => {
    const result = importRkt(file(sim(), '<SerialNo>7</SerialNo>'));
    expect(Object.values(result.motors)[0]!.matchContext).toEqual({ source: 'rocksim' });
  });
});
