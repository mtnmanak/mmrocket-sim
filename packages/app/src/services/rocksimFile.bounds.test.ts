// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { exportRkt, importRkt, MAX_RKT_SIMULATION_RECORDS } from './rocksimFile.js';
import { exportOrk, importOrk } from './orkFile.js';
import type { ComponentNode } from '@online-openrocket/engine';
import { indexRocksimMotors, MAX_RKT_SERIAL_CHARACTERS, MAX_RKT_SERIAL_LENGTH, MAX_RKT_SERIAL_RECORDS } from './rocksimMotorEvidence.js';
import { noteFlags } from './importNotes.js';
import { parseXml } from './xmlParse.js';
import * as nodeNumbers from '../tree/nodeNum.js';
import { currentXmlParser, setXmlParser } from './xmlParse.js';
import * as sanitize from '../tree/sanitize.js';

// Inject only the budget. The refusal retains sanitize.ts's real count,
// message and Error name; conversion and reconstruction stay real.
function withPartBudget(limit: number, run: () => void): void {
  const limits: { readonly MAX_DESIGN_PARTS: number } = sanitize;
  const budget = vi.spyOn(limits, 'MAX_DESIGN_PARTS', 'get').mockReturnValue(limit);
  const refusal = vi.spyOn(sanitize, 'refuseTooManyParts').mockImplementation(nodes => {
    const parts = sanitize.countParts(nodes);
    if (parts <= limit) return;
    const error = new Error(`This design has ${parts.toLocaleString('en-US')} parts, past the `
      + `${limit.toLocaleString('en-US')} the app will open. Desktop OR has no such limit.`);
    error.name = sanitize.TOO_MANY_PARTS_ERROR_NAME;
    throw error;
  });
  try { run(); } finally { refusal.mockRestore(); budget.mockRestore(); }
}

it('E3 disables serial evidence for nested and oversized fields', () => {
  const doc = parseXml(`<RockSimDocument><Design><BodyTube><SerialNo>7</SerialNo></BodyTube>
    <Future><SerialNo>bad<SerialNo>nested</SerialNo></SerialNo></Future>
    <BodyTube><SerialNo>${'x'.repeat(257)}</SerialNo></BodyTube></Design></RockSimDocument>`, 'bad');
  const notes: string[] = [];
  const index = indexRocksimMotors(doc, doc.querySelector('Design')!, new Map(), notes);
  expect(index.mountsBySerial.size).toBe(0);
  expect(noteFlags(notes)).toEqual([expect.objectContaining({ tier: 'caution', text: expect.stringMatching(/motor.*checks/i) })]);
});

it('E3 never reads descendant text from a nested serial field', () => {
  const doc = parseXml('<Design><BodyTube><SerialNo>outer<SerialNo>inner</SerialNo></SerialNo></BodyTube></Design>', 'bad');
  const serial = doc.querySelector('SerialNo')!;
  Object.defineProperty(serial, 'textContent', { get: () => { throw new Error('descendant read'); } });
  const notes: string[] = [];
  expect(indexRocksimMotors(doc, doc.documentElement, new Map(), notes).mountsBySerial.size).toBe(0);
  expect(noteFlags(notes)[0]?.tier).toBe('caution');
});

it('E3 drops all serial evidence when a nested field could conceal a duplicate', () => {
  const doc = parseXml('<Design><BodyTube><SerialNo>7</SerialNo></BodyTube>'
    + '<Future><SerialNo>7<SerialNo/></SerialNo></Future></Design>', 'bad');
  const notes: string[] = [];
  expect(indexRocksimMotors(doc, doc.documentElement, new Map(), notes).mountsBySerial.has('7')).toBe(false);
  expect(noteFlags(notes)[0]?.tier).toBe('caution');
});

it.each(['records', 'characters'] as const)('E3 permits the serial %s budget and drops the entire index above it', budget => {
  const length = budget === 'characters' ? MAX_RKT_SERIAL_LENGTH : 1;
  const count = budget === 'characters' ? MAX_RKT_SERIAL_CHARACTERS / length : MAX_RKT_SERIAL_RECORDS;
  const field = `<BodyTube><SerialNo>${'x'.repeat(length)}</SerialNo></BodyTube>`;
  for (const extra of [0, 1]) {
    const doc = parseXml(`<Design>${field.repeat(count + extra)}</Design>`, 'bad');
    const notes: string[] = [];
    const result = indexRocksimMotors(doc, doc.documentElement, new Map(), notes);
    expect(result.mountsBySerial.size).toBe(extra ? 0 : 1);
    expect(noteFlags(notes).length).toBe(extra);
  }
});

it('E3 warns in both export passes when expanded RockSim parts cannot reopen', () => {
  const mass = Array.from({ length: 62 }, (_, i) => ({ type: 'masscomponent', id: `m${i}`, mass: 0.001 } as ComponentNode));
  const tree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1, outerRadius: 0.05,
    children: [{ type: 'podset', instanceCount: 32, radiusOffset: 0.1, children: [
      { type: 'bodytube', length: 0.5, outerRadius: 0.02, children: mass },
    ] }],
  }] } as ComponentNode] };
  for (const dryRun of [true, false]) {
    const notes: string[] = [];
    exportRkt({ name: 'Expanded', tree, notes, dryRun });
    expect(notes).toContainEqual(expect.stringMatching(/2,050.*parts.*cannot reopen.*\.ork/i));
  }
});

it.each([true, false])('E3 warns that neither format reopens a 2,001-part design with dryRun=%s', dryRun => {
  const tree = { components: [{ type: 'stage', children: [
    { type: 'bodytube', length: 1, outerRadius: 0.05,
      children: Array.from({ length: 1999 }, () => ({ type: 'masscomponent', mass: 0.001 })) },
  ] } as ComponentNode] };
  expect(sanitize.countParts(tree.components)).toBe(2001);
  const notes: string[] = [];
  const xml = exportRkt({ name: 'Over opening limit', tree, notes, dryRun });
  if (!dryRun) {
    // 2,000 emitted parts plus the stage: no pod, cluster or extension expansion.
    expect(xml.match(/<SerialNo>/g)).toHaveLength(2000);
    expect(() => importRkt(xml)).toThrow(/2,001 parts, past the 2,000/);
    expect(() => importOrk(exportOrk({ name: 'Over opening limit', tree }))).toThrow(/more than 2,000 parts/);
  }
  expect(notes).toContainEqual(expect.stringMatching(
    /design has 2,001 parts.*2,000.*neither \.rkt nor \.ork.*reopen.*remove parts/i,
  ));
  expect(notes.join('\n')).not.toMatch(/expands to|Save as \.ork to keep a file the app can reopen/i);
}, 60_000);

it.each([[1, true], [1, false], [32, true], [32, false]] as const)(
  'E3 counts folded base extensions in %s copies with dryRun=%s', (copies, dryRun) => {
    withPartBudget(copies === 1 ? 20 : 66, () => {
      const cone = { type: 'nosecone', id: 'cone', length: 0.1, aftRadius: 0.02, thickness: 0.001,
        children: [] } as ComponentNode;
      const extension = { type: 'bodytube', id: 'ext', length: 0.05, outerRadius: 0.02,
        thickness: 0.001, rktBaseExtension: true } as ComponentNode;
      const tree = { components: [{ type: 'stage', children: [
        ...(copies === 1 ? [cone, extension] : []),
        { type: 'bodytube', length: 1, outerRadius: 0.05, children: [
          { type: 'podset', instanceCount: copies === 1 ? 2 : copies, radiusOffset: 0.1,
            children: copies === 1
              ? [{ type: 'bodytube', length: 0.5, outerRadius: 0.02 }]
              : [cone, extension] },
          ...(copies === 1 ? Array.from({ length: 13 }, () => ({ type: 'masscomponent', mass: 0.001 })) : []),
        ] },
      ] } as ComponentNode] };
      const count = copies === 1 ? '21' : '98';
      const notes: string[] = [];
      const xml = exportRkt({ name: 'Folded extension', tree, notes, dryRun });
      if (!dryRun) {
        const doc = parseXml(xml, 'bad');
        expect(doc.querySelectorAll('SerialNo')).toHaveLength(copies === 1 ? 19 : 65);
        expect([...doc.querySelectorAll('BaseExtensionLen')].filter(el => Number(el.textContent) > 0)).toHaveLength(copies);
        expect(() => importRkt(xml)).toThrow(new RegExp(`${count} parts`));
      }
      expect(notes).toContainEqual(expect.stringMatching(new RegExp(`${count}.*parts.*cannot reopen.*\\.ork`, 'i')));
    });
  });

it.each([[6, 0.05], [7, 1e-6], [7, 0]])(
  'E3 allows reopenable folded extensions with %s masses and length %s m', (masses, length) => {
    withPartBudget(10, () => {
      const tree = { components: [{ type: 'stage', children: [
        { type: 'nosecone', id: 'cone', length: 0.1, aftRadius: 0.02, thickness: 0.001 },
        { type: 'bodytube', length, outerRadius: 0.02, thickness: 0.001, rktBaseExtension: true },
        { type: 'bodytube', length: 0.5, outerRadius: 0.02,
          children: Array.from({ length: masses }, () => ({ type: 'masscomponent', mass: 0.001 })) },
      ] } as ComponentNode] };
      for (const dryRun of [true, false]) {
        const notes: string[] = [];
        const xml = exportRkt({ name: 'At limit', tree, notes, dryRun });
        expect(notes.join('\n')).not.toMatch(/cannot reopen/);
        if (!dryRun) expect(sanitize.countParts(importRkt(xml).tree.components)).toBe(10);
      }
    });
  });

// Keep the reviewer's exact 2,000-part initial count here. The smaller-budget
// cases above cover the same extension boundaries cheaply. This round trip
// takes several seconds under load; its timeout follows the ORK heavy tests.
it.each([true, false])('E3 allows the exact cluster and extension counterexample to reopen with dryRun=%s', dryRun => {
  const tree = { components: [{ type: 'stage', children: [
    { type: 'nosecone', id: 'cone', length: 0.1, aftRadius: 0.02, thickness: 0.001 },
    { type: 'bodytube', length: 0.05, outerRadius: 0.02, thickness: 0.001, rktBaseExtension: true },
    { type: 'bodytube', length: 0.5, outerRadius: 0.02, children: [
      ...Array.from({ length: 1994 }, () => ({ type: 'masscomponent', mass: 0.001 })),
      { type: 'innertube', length: 0.2, outerRadius: 0.005, thickness: 0.001, cluster: '3-ring' },
    ] },
  ] } as ComponentNode] };
  const notes: string[] = [];
  const xml = exportRkt({ name: 'Cluster and extension', tree, notes, dryRun });
  if (!dryRun) {
    expect(xml.match(/<SerialNo>/g)).toHaveLength(1999);
    const reopened = importRkt(xml);
    expect(sanitize.countParts(reopened.tree.components)).toBe(1999);
    expect(reopened.notes.join('\n')).toMatch(/one 3-ring cluster/);
  }
  expect(notes.join('\n')).not.toMatch(/cannot reopen/);
}, 60_000);

it.each([true, false])('E3 keeps the initial and unmerged cluster limits with dryRun=%s', dryRun => {
  withPartBudget(10, () => {
    for (const kind of ['initial', 'unmerged', 'separate'] as const) {
      const tube = { type: 'innertube', length: 0.2, outerRadius: 0.005, thickness: 0.001 };
      const tree = { components: [{ type: 'stage', children: [
        { type: 'nosecone', id: 'cone', length: 0.1, aftRadius: 0.02, thickness: 0.001 },
        { type: 'bodytube', length: 0.05, outerRadius: 0.02, thickness: 0.001, rktBaseExtension: true },
        { type: 'bodytube', length: 0.5, outerRadius: 0.02, children: [
          ...Array.from({ length: kind === 'unmerged' ? 2 : 5 }, () => ({ type: 'masscomponent', mass: 0.001 })),
          ...(kind === 'separate' ? [
            { ...tube, radialPosition: 0.005, radialDirection: 0 },
            { ...tube, radialPosition: 0.005, radialDirection: Math.PI },
          ] : [{ ...tube, cluster: '3-ring' }]),
          ...(kind === 'unmerged' ? [{ ...tube }, { ...tube }] : []),
        ] },
      ] } as ComponentNode] };
      const notes: string[] = [];
      const xml = exportRkt({ name: kind, tree, notes, dryRun });
      if (kind === 'separate') {
        expect(notes.join('\n')).not.toMatch(/cannot reopen/);
        if (!dryRun) expect(sanitize.countParts(importRkt(xml).tree.components)).toBe(10);
      } else {
        expect(notes.join('\n')).toMatch(/11 parts.*cannot reopen/);
        if (!dryRun) expect(() => importRkt(xml)).toThrow(/11 parts, past the 10/);
      }
    }
  });
});

it.each([true, false])('E3 reports the reader count after cluster merging and extension refusal with dryRun=%s', dryRun => {
  withPartBudget(11, () => {
    const tree = { components: [{ type: 'stage', children: [
      { type: 'bodytube', length: 0.5, outerRadius: 0.03, children: [
        { type: 'innertube', length: 0.2, outerRadius: 0.005, thickness: 0.001, cluster: '3-ring' },
        { type: 'podset', instanceCount: 3, radiusOffset: 0.1, children: [
          { type: 'nosecone', id: 'pod-cone', length: 0.1, aftRadius: 0.02, thickness: 0.001 },
          { type: 'bodytube', id: 'pod-extension', length: 0.05, outerRadius: 0.02, thickness: 0.001, rktBaseExtension: true },
        ] },
      ] },
    ] } as ComponentNode] };
    const notes: string[] = [];
    const xml = exportRkt({ name: 'Cluster merge then extensions', tree, notes, dryRun });
    if (!dryRun) {
      expect(xml.match(/<SerialNo>/g)).toHaveLength(10);
      expect(() => importRkt(xml)).toThrow(/12 parts, past the 11/);
    }
    expect(notes.join('\n')).toMatch(/12 parts.*cannot reopen/);
    expect(notes.join('\n')).not.toMatch(/14 parts/);
  });
});

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
        const mount = doc.querySelector('Ring')!;
        const query = mount.querySelector.bind(mount);
        vi.spyOn(mount, 'querySelector').mockImplementation(selector => {
          queries++;
          return query(selector);
        });
        const children = mount.children;
        Object.defineProperty(mount, 'children', { configurable: true, get: () => { scans++; return children; } });
        return doc;
      });
      const ring = `<Ring><SerialNo>9</SerialNo>${'<Pad/>'.repeat(1500)}${present ? '<ID>18</ID>' : ''}<IsMotorMount>1</IsMotorMount></Ring>`;
      const result = importRkt(file(sim(engine.replace('<MountSerialNo>7', '<MountSerialNo>9')).repeat(count), ring));
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
