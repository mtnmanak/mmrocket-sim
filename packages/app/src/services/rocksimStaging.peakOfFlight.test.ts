// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, FlightResult } from '@online-openrocket/engine';
import { MOTOR_DB } from './motorDb.js';
import { bundleHasCurve, bundledOnlyFetchSpec, delayOptions } from './thrustcurve.js';
import { matchImportedMotor } from './motorMatch.js';
import { exportRkt, importRkt } from './rocksimFile.js';
import { planImport, resolveImportMotors } from './importApply.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { simulateFile, simulateImported } from './simulateFile.js';
import { rocksimCorpusPath } from './rocksimCorpusPath.testSupport.mjs';
import { inlineXmlCdata } from './xmlUtil.js';
import { parseXml } from './xmlParse.js';
import type { OrkExportMotor } from './orkFile.js';
import { idFree } from './simulate.testSupport.js';

// Choose a currently shipped, flyable 29 mm motor; no upstream identity or date is pinned.
const motor = await (async () => {
  for (const m of MOTOR_DB) {
    const delays = delayOptions(m).filter(Number.isFinite);
    if (m.diameter >= 28 && m.diameter <= 30 && m.avgThrustN >= 50 && m.avgThrustN <= 100
      && m.totImpulseNs >= 70 && m.totImpulseNs <= 140 && delays.length && Math.max(...delays) <= 7
      && await bundleHasCurve(m.motorId)) return m;
  }
  throw new Error('No suitable shipped 29 mm motor for the staging regression');
})();

function engine(serial: number, delay: string, ignition = 0): string {
  return `<EngineSet><EngineCode>${motor.designation}</EngineCode><EngineMfg>${motor.manufacturerAbbrev}</EngineMfg>
    <MountSerialNo>${serial}</MountSerialNo><EjectionDelay>${delay}</EjectionDelay><IgnitionDelay>${ignition}</IgnitionDelay></EngineSet>`;
}

function body(serial: number, nose = false, extra = ''): string {
  return `${nose ? '<NoseCone><Len>140</Len><BaseDia>40</BaseDia><WallThickness>1</WallThickness><ShapeCode>0</ShapeCode></NoseCone>' : ''}
    <BodyTube><Name>Mount ${serial}</Name><SerialNo>${serial}</SerialNo><OD>40</OD><ID>38</ID><Len>300</Len><IsMotorMount>1</IsMotorMount>
    <KnownMass>200</KnownMass><KnownCG>50</KnownCG><UseKnownCG>1</UseKnownCG>
    <AttachedParts><FinSet><FinCount>3</FinCount><RootChord>120</RootChord><TipChord>50</TipChord><SemiSpan>60</SemiSpan><Thickness>2</Thickness><Xb>180</Xb></FinSet>${extra}</AttachedParts></BodyTube>`;
}

function staged(delay: string, ignition = 1.1, second?: string): string {
  return `<RockSimDocument><DesignInformation><RocketDesign><Name>652 timer</Name><StageCount>2</StageCount>
    <Stage3Parts>${body(3, true)}</Stage3Parts><Stage2Parts>${body(2)}${second === undefined ? '' : body(4)}</Stage2Parts><Stage1Parts/>
    <SimulationResultsList><SimulationResults><Stage3Engines>${engine(3, '3', ignition)}</Stage3Engines>
    <Stage2Engines>${engine(2, delay)}${second === undefined ? '' : engine(4, second)}</Stage2Engines></SimulationResults></SimulationResultsList>
    </RocketDesign></DesignInformation></RockSimDocument>`;
}

const fly = (xml: string) => simulateFile(new TextEncoder().encode(xml), 'timer.rkt', { presets: [] });
const time = (result: FlightResult, type: string, id?: string): number => {
  const event = result.events.find(e => e.type === type && (id === undefined || e.motorMountId === id));
  expect(event, `${type} on ${id ?? 'rocket'}`).toBeDefined();
  return event!.time;
};

const exportTree = { components: [
  { type: 'stage', children: [{ type: 'bodytube', id: 'upper', name: 'Upper mount', length: 0.3, outerRadius: 0.02, thickness: 0.001, motorMount: true }] },
  { type: 'stage', children: [{ type: 'bodytube', id: 'lower', name: 'Lower mount', length: 0.3, outerRadius: 0.02, thickness: 0.001, motorMount: true }] },
] as ComponentNode[] };
const exportMotor: OrkExportMotor = { designation: motor.designation, manufacturer: motor.manufacturerAbbrev,
  diameter: motor.diameter / 1000, length: motor.length / 1000, delay: 3 };
// Select by the mount's serial, so a lower-stage zero cannot satisfy an upper timer assertion.
function upperSet(xml: string) {
  const doc = parseXml(xml, 'export timer');
  const mount = [...doc.querySelectorAll('BodyTube')].find(el => el.querySelector(':scope > Name')?.textContent === 'Upper mount')!;
  const serial = mount.querySelector(':scope > SerialNo')!.textContent;
  return [...doc.querySelectorAll('EngineSet')].find(el => el.querySelector(':scope > MountSerialNo')?.textContent === serial)!;
}

describe('Peak of Flight RockSim separation timers (121)', () => {
  it('652: separates at booster burnout + 1 and lights the upper motor at + 2.1', async () => {
    const out = await fly(staged('1'));
    const refs = Object.entries(out.state.mountMotors);
    const upper = refs.find(([, m]) => (m.ignition.event === 'burnout' || m.ignition.event === 'ejectioncharge'))!;
    const booster = refs.find(r => r !== upper)!;
    const burnout = time(out.result, 'BURNOUT', booster[0]);
    expect(time(out.result, 'IGNITION', upper[0]) - burnout).toBeCloseTo(2.1, 6);
    expect(time(out.result, 'STAGE_SEPARATION') - burnout).toBeCloseTo(1, 6);
  }, 60_000);

  it('keeps a zero-delay booster equivalent to the historical burnout mapping', async () => {
    const xml = staged('0');
    const out = await fly(xml);
    const imported = importRkt(xml);
    // Independently reconstruct the pre-patch mapping from XML's stated timer.
    const doc = parseXml(xml, 'historical timers');
    const stated = Number(doc.querySelector('Stage3Engines > EngineSet > IgnitionDelay')!.textContent);
    for (const cfg of imported.configs!) for (const [id, ref] of Object.entries(cfg.motors)) {
      if (ref.ignitionEvent !== 'ejectioncharge') continue;
      ref.ignitionEvent = 'burnout';
      ref.ignitionDelay = stated;
      (cfg.ignitions ??= {})[id] = { event: 'burnout', delay: stated };
    }
    const old = await simulateImported(imported, { presets: [] });
    const oldReport = idFree(old.run);
    // Only this explicitly changed trigger's recorded metadata differs when
    // the lower charge is zero. Preserve and compare every other report field.
    const translated = oldReport.flightOverrides?.filter(o => o.family === 'ignition' && o.flies.event === 'burnout' && o.flies.delay === stated);
    expect(translated).toHaveLength(1);
    const expectedOverrides = oldReport.flightOverrides?.map(o => o.family === 'ignition' && o.flies.event === 'burnout' && o.flies.delay === stated
      ? { ...o, flies: { ...o.flies, event: 'ejectioncharge' } } : o);
    expect(idFree(out.run)).toEqual({ ...oldReport, flightOverrides: expectedOverrides });
    expect(out.result.series).toEqual(old.result.series);
    const withoutIds = (result: FlightResult) => result.events.map(({ sourceId: _source, motorMountId: _mount, ...event }) => event);
    expect(withoutIds(out.result)).toEqual(withoutIds(old.result));
    for (const flight of [out, old]) {
      const upper = Object.entries(flight.state.mountMotors).find(([, m]) => (m.ignition.event === 'burnout' || m.ignition.event === 'ejectioncharge'))!;
      const lower = Object.keys(flight.state.mountMotors).find(id => id !== upper[0])!;
      const burnout = time(flight.result, 'BURNOUT', lower);
      expect(time(flight.result, 'STAGE_SEPARATION') - burnout).toBeCloseTo(0, 6);
      expect(time(flight.result, 'IGNITION', upper[0]) - burnout).toBeCloseTo(stated, 6);
    }
  }, 60_000);

  it('discloses plugged and mixed-delay boosters with caution flags', () => {
    for (const [delay, second, code, text] of [['-2', undefined, 'I11.staging-plugged', 'RockSim would not stage'],
      ['1', '2', 'I11.staging-delays', 'different delays (1 s, 2 s)']] as const) {
      const result = importRkt(staged(delay, 1.1, second));
      expect(result.noteTiers).toContainEqual(expect.objectContaining({ kind: code, tier: 'caution', text: expect.stringContaining(text) }));
      expect(Object.values(result.motors).find(r => (r.ignitionEvent === 'burnout' || r.ignitionEvent === 'ejectioncharge'))?.ignitionDelay).toBe(1.1);
    }
  });

  it('sums decimal timers in microseconds and resolves every-delay before folding it', () => {
    const upper = (delay: string, ig: number) => Object.values(importRkt(staged(delay, ig)).motors)
      .find(r => (r.ignitionEvent === 'burnout' || r.ignitionEvent === 'ejectioncharge'))!;
    expect(upper('0.1', 0.2).ignitionDelay).toBe(0.2);
    expect(upper('-1', 1.1).ignitionDelay).toBe(1.1);
  });

  it('inverts burnout timers, keeps charge timers, and discloses an ignition before separation', () => {
    const tree = exportTree;
    const base: OrkExportMotor = { designation: motor.designation, manufacturer: motor.manufacturerAbbrev, diameter: motor.diameter / 1000, length: motor.length / 1000, delay: 1 };
    for (const [event, delay, written] of [['burnout', 2.1, 1.1], ['ejectioncharge', 1.1, 1.1], ['burnout', 0.5, 0]] as const) {
      const notes: string[] = [];
      const xml = exportRkt({ name: 'timer', tree, motors: { lower: base, upper: { ...base, ignitionEvent: event, ignitionDelay: delay } }, notes });
      expect(Number(upperSet(xml).querySelector('IgnitionDelay')!.textContent)).toBe(written);
      if (delay < 1) {
        expect(notes).toContainEqual(expect.stringContaining('before that stage separates in RockSim (1 s'));
        expect(Object.values(importRkt(xml).motors).find(r => (r.ignitionEvent === 'burnout' || r.ignitionEvent === 'ejectioncharge'))?.ignitionDelay).toBe(0);
      }
      else {
        expect(notes).toEqual([]);
        expect(Object.values(importRkt(xml).motors).find(r => (r.ignitionEvent === 'burnout' || r.ignitionEvent === 'ejectioncharge'))?.ignitionDelay).toBe(written);
      }
    }
  });

  it.each([false, true])('round-trips the delay actually written below, resolved Auto=%s', autoDelay => {
    const xml = exportRkt({ name: 'timer', tree: exportTree, motors: {
      lower: { ...exportMotor, ...(autoDelay ? { autoDelay: true as const } : {}) }, upper: { ...exportMotor, ignitionEvent: 'burnout', ignitionDelay: 4.1 },
    } });
    expect(Number(upperSet(xml).querySelector('IgnitionDelay')!.textContent)).toBe(1.1);
    expect(Object.values(importRkt(xml).motors).find(r => (r.ignitionEvent === 'burnout' || r.ignitionEvent === 'ejectioncharge'))?.ignitionDelay).toBe(1.1);
  });

  it('does not subtract a delay exported as the unresolved every-delay sentinel', () => {
    const notes: string[] = [];
    const xml = exportRkt({ name: 'timer', tree: exportTree, motors: {
      lower: { ...exportMotor, autoDelay: true, rktEveryDelay: true },
      upper: { ...exportMotor, ignitionEvent: 'burnout', ignitionDelay: 4.1 },
    }, notes });
    expect(xml).toContain('<EjectionDelay>-1</EjectionDelay>');
    expect(Number(upperSet(xml).querySelector('IgnitionDelay')!.textContent)).toBe(4.1);
    expect(notes).toContainEqual(expect.stringContaining('whose ejection delay is unresolved'));
    expect(notes).toContainEqual(expect.stringContaining('RockSim counts from that stage\'s separation'));
  });

  it('folds stated timers before resolving every-delay with transferred 24 mm evidence', async () => {
    const catalogue = [
      { ...motor, motorId: 'r2-wide', designation: 'J360-wide', commonName: 'J360SK', diameter: 29, delays: '4,8' },
      { ...motor, motorId: 'r2-narrow', designation: 'J360-narrow', commonName: 'J360SK', diameter: 24, delays: '2,5' },
    ];
    const xml = staged('-1').replaceAll('<ID>38</ID>', '<ID>24</ID>')
      .replaceAll(`<EngineCode>${motor.designation}</EngineCode>`, '<EngineCode>J360SK</EngineCode>');
    const sim = xml.match(/<SimulationResults>[\s\S]*?<\/SimulationResults>/)![0];
    const stale = sim.replace('<MountSerialNo>2</MountSerialNo>', '<MountSerialNo>999</MountSerialNo>');
    const imported = importRkt(xml.replace(sim, stale + sim), { catalogue });
    expect(imported.configs).toHaveLength(1);
    const refs = Object.values(imported.configs![0]!.motors);
    const lower = refs.find(r => r.ignitionEvent !== 'ejectioncharge')!;
    expect(lower.matchContext?.mountBoreMm).toBe(24);
    expect(lower.delay).toBe(Math.max(...delayOptions(catalogue[1]!).filter(Number.isFinite)));
    expect(refs.find(r => (r.ignitionEvent === 'burnout' || r.ignitionEvent === 'ejectioncharge'))!.ignitionDelay).toBe(1.1);
    const out = await simulateImported(imported, { presets: [], match: ref => matchImportedMotor(ref, {
      catalogue,
      // Both synthetic catalogue identities use the runtime-selected shipped curve.
      fetchSpec: (row, delay) => bundledOnlyFetchSpec({ ...row, motorId: motor.motorId }, delay),
    }) });
    const flownUpper = Object.entries(out.state.mountMotors).find(([, m]) => (m.ignition.event === 'burnout' || m.ignition.event === 'ejectioncharge'))!;
    const flownLower = Object.entries(out.state.mountMotors).find(([id]) => id !== flownUpper[0])!;
    expect(flownLower[1].spec.diameter).toBe(0.024);
    expect(flownLower[1].spec.ejectionDelay).toBe(lower.delay);
    expect(time(out.result, 'EJECTION_CHARGE', flownLower[0]) - time(out.result, 'BURNOUT', flownLower[0])).toBeCloseTo(lower.delay, 6);
    expect(time(out.result, 'IGNITION', flownUpper[0]) - time(out.result, 'BURNOUT', flownLower[0])).toBeCloseTo(6.1, 6);
  }, 60_000);

  it('keeps staging cautions with their configuration when the opened selection changes', async () => {
    const xml = staged('0');
    const sim = xml.match(/<SimulationResults>[\s\S]*?<\/SimulationResults>/)![0];
    const plugged = sim.replace('<EjectionDelay>0</EjectionDelay>', '<EjectionDelay>-2</EjectionDelay>');
    const imported = importRkt(xml.replace(sim, sim + plugged));
    const [normal, other] = imported.configs!;
    expect(imported.notes.join('\n')).not.toContain('RockSim would not stage');
    expect(imported.configNotes![normal!.id]!.join('\n')).not.toContain('RockSim would not stage');
    expect(imported.configNotes![other!.id]!.join('\n')).toContain('RockSim would not stage');
    expect(imported.noteTiers).toContainEqual(expect.objectContaining({ kind: 'I11.staging-plugged', tier: 'caution' }));
    const resolved = await resolveImportMotors(imported);
    const ctx = { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } };
    expect(planImport(imported, resolved, ctx).note.text).not.toContain('RockSim would not stage');
    // Exercise flyablePick/swapConfigNotes: the first row cannot load; the second can.
    resolved.working = {};
    const picked = planImport(imported, resolved, ctx);
    expect(picked.note.text).toContain('RockSim would not stage');
    expect(picked.note.group?.lines).toContainEqual(expect.objectContaining({ kind: 'I11.staging-plugged', tier: 'caution' }));
  }, 60_000);

  it.each(['unmatched', 'auto'])('describes an unresolved %s every-delay booster accurately', kind => {
    const catalogue = kind === 'unmatched' ? [] : [{ ...motor, delays: '' }];
    for (const second of [undefined, '1']) {
      const imported = importRkt(staged('-1', 1.1, second), { catalogue });
      const note = imported.noteTiers!.find(n => n.kind.startsWith('I11.staging-'))!;
      expect(note.kind).toBe('I11.staging-unresolved');
      expect(note.text).toContain("cannot fix the stage below's ejection delay as a number at import");
      expect(note.text).toContain("lights it 1.1 s after that stage's burnout");
      expect(note.text).toContain('Check the staging on Motors & Configuration');
      expect(note.text).not.toMatch(/plugged|would not stage|different delays/);
    }
  });

  it('states the exact export consequence of burnout ignition above a plugged booster', () => {
    const notes: string[] = [];
    exportRkt({ name: 'timer', tree: exportTree, motors: {
      lower: { ...exportMotor, delay: Infinity }, upper: { ...exportMotor, ignitionEvent: 'burnout', ignitionDelay: 2.5 },
    }, notes });
    expect(notes).toContain(`“${motor.designation}” lights 2.5 s after the burnout of the stage below, whose motor is plugged. The .rkt writes IgnitionDelay 2.5 s, which RockSim counts from that stage's separation; with no ejection charge, that stage never triggers separation, so the upper motor does not light in RockSim. Check the staging on Motors & Configuration before flying.`);
  });

  it('names mixed and empty lower stages in burnout export fallbacks', () => {
    for (const empty of [false, true]) {
      const notes: string[] = [];
      const tree = { components: [exportTree.components[0]!,
        { ...exportTree.components[1]!, children: empty ? [] : [
          ...exportTree.components[1]!.children!,
          { ...exportTree.components[1]!.children![0]!, id: 'other', name: 'Other mount' },
        ] }, exportTree.components[1]!] };
      // A third powered stage leaves the pad, with an empty or mixed stage directly below the upper.
      tree.components[2] = { ...exportTree.components[1]!, children: [
        { ...exportTree.components[1]!.children![0]!, id: 'bottom' },
      ] };
      exportRkt({ name: 'fallbacks', tree, motors: {
        upper: { ...exportMotor, ignitionEvent: 'burnout', ignitionDelay: 2.5 }, bottom: exportMotor,
        ...(empty ? {} : { lower: { ...exportMotor, delay: 1 }, other: { ...exportMotor, delay: 2 } }),
      }, notes });
      const note = notes.find(n => n.includes('lights 2.5 s after the burnout'))!;
      expect(note).toBeDefined();
      expect(note).toContain(empty ? 'which has no motor' : 'whose motors do not share one ejection delay');
      expect(note).toContain('RockSim counts from that stage\'s separation');
      if (empty) expect(note).toContain('upper motor does not light in RockSim');
    }
  });

  const corpus = rocksimCorpusPath();
  const aerobee = corpus && join(corpus, 'Cosmodrome Rocketry/Aerobee-Hi.rkt');
  it.skipIf(!aerobee || !existsSync(aerobee))('Aerobee-Hi sims 1/2: a 3 s booster delay moves upper burnout by 3 s', async () => {
    const doc = parseXml(inlineXmlCdata(readFileSync(aerobee!, 'utf8')), 'Aerobee parse');
    const sims = [...doc.querySelectorAll('SimulationResults')];
    const raw = readFileSync(aerobee!, 'utf8');
    const rawSims = raw.match(/<SimulationResults>[\s\S]*?<\/SimulationResults>/g)!;
    const stored = sims.slice(0, 2).map(s => Number(s.querySelector('TimeToBurnout')!.textContent));
    expect(Math.abs(stored[1]! - stored[0]! - 3)).toBeLessThanOrEqual(0.00125 + 1e-12);
    const burnouts: number[] = [];
    for (const selected of rawSims.slice(0, 2)) {
      const xml = raw.replace(/<SimulationResultsList>[\s\S]*?<\/SimulationResultsList>/,
        `<SimulationResultsList>${selected}</SimulationResultsList>`);
      const out = await fly(xml);
      const doc = parseXml(inlineXmlCdata(xml), 'Aerobee independent timers');
      const boosterDelay = Number(doc.querySelector('Stage2Engines > EngineSet > EjectionDelay')!.textContent);
      const stated = Number(doc.querySelector('Stage3Engines > EngineSet > IgnitionDelay')!.textContent);
      const importedUpper = Object.values(importRkt(xml).motors).find(m => m.ignitionEvent === 'ejectioncharge')!;
      expect(importedUpper.ignitionDelay).toBeCloseTo(stated, 9);
      const upper = Object.entries(out.state.mountMotors).find(([, m]) => (m.ignition.event === 'burnout' || m.ignition.event === 'ejectioncharge'))!;
      expect(upper[1].ignition.delay).toBeCloseTo(stated, 9);
      const lower = Object.entries(out.state.mountMotors).find(([id]) => id !== upper[0])!;
      expect(time(out.result, 'IGNITION', upper[0]) - time(out.result, 'BURNOUT', lower[0])).toBeCloseTo(boosterDelay + stated, 6);
      burnouts.push(time(out.result, 'BURNOUT', upper[0]));
    }
    expect(burnouts[1]! - burnouts[0]!).toBeCloseTo(3, 6);
  }, 60_000);
});

describe('Peak of Flight RockSim delay codes (121)', () => {
  it.each(['0', '-2', 'Inf', '-1', '2.5'])('flies the meaning of EjectionDelay %s', async code => {
    const xml = `<RockSimDocument><DesignInformation><RocketDesign><Name>195 delays</Name><StageCount>1</StageCount>
      <Stage3Parts>${body(3, true, '<Parachute><Name>Charge chute</Name><Dia>400</Dia></Parachute>')}</Stage3Parts>
      <Stage3Engines>${engine(3, code)}</Stage3Engines></RocketDesign></DesignInformation></RockSimDocument>`;
    const out = await fly(xml);
    const ref = Object.values(importRkt(xml).motors)[0]!;
    const burnout = time(out.result, 'BURNOUT', Object.keys(out.state.mountMotors)[0]);
    const charge = out.result.events.find(e => e.type === 'EJECTION_CHARGE');
    if (code === '-2' || code === 'Inf') {
      expect(ref.delay).toBe(Infinity);
      expect(charge).toBeUndefined();
      expect(out.importNote.text).toContain('plugged');
    } else {
      const expected = code === '-1' ? Math.max(...delayOptions(motor).filter(Number.isFinite)) : Number(code);
      expect(ref.delay).toBe(expected);
      expect(charge).toBeDefined();
      expect(charge!.time - burnout).toBeCloseTo(expected, 6);
      // BasicEventSimulationEngine schedules recovery at least 1 ms after its trigger.
      expect(time(out.result, 'RECOVERY_DEVICE_DEPLOYMENT') - charge!.time).toBeCloseTo(0.001, 6);
    }
  }, 60_000);
});
