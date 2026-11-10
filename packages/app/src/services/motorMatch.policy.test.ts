// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDbMotor, matchDbMotor, MOTOR_DB, MOTOR_DB_DATE, setCatalogueOverlay } from './motorDb.js';
import { fetchSpecByDigest, matchImportedMotor } from './motorMatch.js';
import { E31_CONFLICT, MOTOR_MATCH_POLICY as P, type MotorMatchContext } from './motorMatchPolicy.js';
import type { ExMotor } from './exMotors.js';
import { importRkt, rktEveryDelay } from './rocksimFile.js';
import { indexRocksimMotors, rocksimBurnTime, rocksimMotorEvidence } from './rocksimMotorEvidence.js';
import { importCdx1 } from './rasaeroFile.js';
import { defaultDelay } from './thrustcurve.js';
import type { OrkMotorRef } from './orkFile.js';
import { readFileSync } from 'node:fs';
import { resolveImportMotors, planImport, planConfigSwitch } from './importApply.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';

const ref = (designation: string, manufacturer = '', matchContext?: MotorMatchContext): OrkMotorRef =>
  ({ designation, manufacturer, diameter: 0, length: 0, delay: Infinity, matchContext });
const lookup = (name: string, maker = 'Cesaroni', context?: MotorMatchContext) => matchDbMotor(name, undefined, undefined, maker, context);
const physical = (mass: number, burn: number): MotorMatchContext => ({ source: 'rocksim', physical: {
  provenance: 'rocksim-single-stage-single-motor-known-dry-mass', loadedMassG: 2010 + mass, dryMassG: 2010, motorMassG: mass, burnTimeS: burn,
} });
const bore = (mm: number): MotorMatchContext => ({ source: 'rocksim', mountBoreMm: mm });

/** Synthetic v4 fixture: explicit source units, dry override, one mount/motor. */
function rkt(code = 'K700BB', mass = 4098, burn = 2.38, diameter = 54.4): string {
  return `<RockSimDocument><FileVersion>4</FileVersion><DesignInformation><RocketDesign>
    <Name>Identity evidence</Name><StageCount>1</StageCount><UseKnownMass>1</UseKnownMass><Stage3Mass>2010</Stage3Mass>
    <Stage3Parts><BodyTube><Name>Mount</Name><SerialNo>6</SerialNo><IsMotorMount>1</IsMotorMount><OD>56</OD><ID>${diameter}</ID><Len>600</Len></BodyTube></Stage3Parts>
    </RocketDesign></DesignInformation><SimulationResults><Mass0>${mass}</Mass0><TimeToBurnout>${burn}</TimeToBurnout>
    <Stage3Engines><EngineSet><EngineCount>1</EngineCount><MountSerialNo>6</MountSerialNo><EngineMfg>Cesaroni</EngineMfg>
    <EngineCode>${code}</EngineCode><IgnitionDelay>0</IgnitionDelay><EjectionDelay>-1</EjectionDelay></EngineSet></Stage3Engines>
    </SimulationResults></RockSimDocument>`;
}
function motorIndex(doc: Document) {
  const design = doc.querySelector('RockSimDocument > DesignInformation > RocketDesign')!;
  const sets = new Map([...doc.querySelectorAll('SimulationResults')].map(sim => [sim, [...sim.querySelectorAll('EngineSet')]]));
  return indexRocksimMotors(doc, design, sets);
}
function evidence(xml: string): MotorMatchContext {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return rocksimMotorEvidence(doc.querySelector('EngineSet')!, motorIndex(doc));
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline')))));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); setCatalogueOverlay(null); });

describe('reviewed historical motor policies', () => {
  it('G80 uses only the makerless equivalent after its real offline curve loads', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const result = await matchImportedMotor(ref('G80'));
    expect(result.motor?.meta.motorId).toBe(P.aeroTechG80);
    expect(result.openNote).toContain("No maker named; Estes' G80");
    for (const maker of ['Estes', 'AeroTech', 'PML', 'Roadrunner']) {
      expect(lookup('G80', maker)?.curveEquivalent).toBeUndefined();
    }
    expect(lookup('G80T', 'PML')?.motor.manufacturerAbbrev).toBe('PML');
    expect(lookup('G80', 'Roadrunner')?.motor.manufacturerAbbrev).toBe('Roadrunner');
    expect((await matchImportedMotor(ref('G80', 'Estes'))).missing).toBe('curve');
  });
  it('G80 refuses missing/changed equivalents and failed target curves', async () => {
    const changed = MOTOR_DB.map(m => m.motorId === P.aeroTechG80 ? { ...m, totImpulseNs: 150 } : m);
    expect(matchDbMotor('G80', undefined, changed)?.curveEquivalent).toBeUndefined();
    expect(matchDbMotor('G80', undefined, MOTOR_DB.filter(m => m.motorId !== P.aeroTechG80))?.curveEquivalent).toBeUndefined();
    const fetchSpec = vi.fn(() => Promise.reject(new Error('no usable curve')));
    expect((await matchImportedMotor(ref('G80'), { fetchSpec })).missing).toBe('curve');
    expect(fetchSpec.mock.calls).toHaveLength(1);
    expect(matchDbMotor('G80', 38)?.curveEquivalent).toBeUndefined();
    expect(matchDbMotor('G80', undefined, [...MOTOR_DB].reverse(), 'Estes')?.curveEquivalent).toBeUndefined();
  });
  it('J360 uses capacity, allows adapters, and retains the cross-tier alternative', async () => {
    expect(lookup('J360SK', 'CTI', bore(38))?.motor.designation).toBe('J360');
    expect(lookup('J360SK', 'CTI', bore(54))?.motor.designation).toBe('1016J360-15A');
    expect(lookup('J360SK', 'CTI', bore(54))?.rivals.map(m => m.designation)).toContain('J360');
    expect(lookup('J360SK', 'CTI', bore(75))?.rivals.map(m => m.designation)).toContain('J360');
    expect(lookup('J360SK', 'CTI', bore(NaN))?.motor.designation).toBe('1016J360-15A');
    const result = await matchImportedMotor(ref('J360SK', 'CTI', bore(54)));
    expect(result.openNote).toContain('38 mm');
    expect(result.openNote).toContain('plausible alternative');
    expect(lookup('1016J360-15A', 'CTI')?.rivals).toEqual([]);
    expect(lookup('H123-SK-14A', 'CTI', bore(54))?.motor.diameter).toBe(38);
    // The corpus has contradictory mount geometry for uniquely named motors.
    // Applying a new global rejection here would violate no right -> nothing.
    expect(lookup('F31-CL', 'CTI', bore(24))?.motor.designation).toBe('56F31-12A');
  });
  it('bare G69 keeps Skidmark with a historical identity warning', async () => {
    expect(lookup('G69')?.reason).toContain('132.997');
    expect(lookup('G69')?.reason).toContain('121.1');
    expect(lookup('G69')?.motor.motorId).toBe(P.skidmarkG69);
    expect(lookup('117G69-14A')?.reason).toBeUndefined();
    expect(lookup('G69-Classic')).toBeNull();
    const result = await matchImportedMotor(ref('G69', 'CTI'));
    expect(result.openNote).toContain('does not confirm');
  });
  it('K700BB requires corroborating mass AND burn, preserving Blue Baboon otherwise', () => {
    expect(lookup('K700BB', 'CTI', physical(2088, 2.38))?.motor.motorId).toBe(P.blackBearK700);
    for (const context of [undefined, physical(1483.1, 2.24), physical(2088, 9), physical(52, 2.38), physical(NaN, 2.38)]) {
      expect(lookup('K700BB', 'CTI', context)?.motor.motorId).toBe(P.blueBaboonK700);
    }
    expect(lookup('K700BB', 'CTI', { ...physical(2088, 2.38), source: 'rasaero' })?.motor.motorId).toBe(P.blueBaboonK700);
    expect(lookup('K700BB', 'CTI', { ...physical(2088, 2.38), mountBoreMm: 38 })?.motor.motorId).toBe(P.blueBaboonK700);
    expect(lookup('K700BB', 'CTI')?.reason).toContain('kept Blue Baboon');
  });
  it('explicit plugged tokens rank at the delay position; an Infinity setting does not', async () => {
    for (const name of ['I170-P', 'I170-p', 'I170_P', 'I170 P']) expect(lookup(name, 'Kosdon')?.motor.designation).toBe('I170S');
    for (const name of ['I170', 'I170-11', 'I170DH-P']) expect(lookup(name, 'Kosdon')?.motor.designation).toBe('I170DH');
    const result = await matchImportedMotor(ref('I170', 'Kosdon'), { fetchSpec: vi.fn(fetchSpecByDigest) });
    expect(result.missing).toBe('curve');
    expect(lookup('I170', 'Kosdon', { source: 'rasaero', explicitDelay: 'plugged' })?.motor.designation).toBe('I170S');
  });
  it('E31 WH requires physical evidence; WT and legitimate WH motors keep their meanings', async () => {
    expect(lookup('26-E31-WH-15A', 'CTI', physical(52, 0.87125))?.motor.motorId).toBe(P.whiteThunderE31);
    for (const context of [undefined, physical(52, 1.8), physical(100, 0.87125)]) expect(lookup('26-E31-WH-15A', 'CTI', context)).toBeNull();
    expect(lookup('26-E31-WH-15A', 'AT', physical(52, 0.87125))).toBeNull();
    expect(lookup('26-E31-WT-15A')?.motor.motorId).toBe(P.whiteThunderE31);
    for (const name of ['F30', 'G65', 'G107']) {
      expect(lookup(`${name}WH`)).toBeNull();
      expect(lookup(`${name}WT`)?.motor.propInfo).toBe('White Thunder');
    }
    expect((await matchImportedMotor(ref('26-E31-WH-15A', 'CTI'))).note).toContain('no motor was loaded');
  });
  it('H135 only crosses the maker with a complete unique exact-prefix identity', async () => {
    expect(lookup('217-H135-WH-12A', 'AT')?.motor.designation).toBe('217H135-12A');
    expect(lookup('H135W', 'AT')?.motor.manufacturerAbbrev).toBe('AeroTech');
    expect(lookup('H135-WH-12A', 'AT')).toBeNull();
    expect(lookup('218-H135-WH-12A', 'AT')).toBeNull();
    expect(lookup('217-H135-WH', 'AT')).toBeNull();
    const row = findDbMotor('217H135-12A')!;
    expect(matchDbMotor('217-H135-WH-12A', undefined, [...MOTOR_DB, { ...row, motorId: 'rival' }], 'AT')).toBeNull();
    const result = await matchImportedMotor(ref('217-H135-WH-12A', 'AT'));
    expect(result.openNote).toContain('file names AT');
    expect(result.motor?.meta.orkManufacturer).toBeUndefined();
    expect(result.motor?.meta.manufacturer).toBe('Cesaroni');
  });
});

describe('physical evidence provenance and importer seams', () => {
  function doubled(xml: string, change: (sim: string) => string = sim => sim): string {
    const sim = xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length);
    return xml.replace('</RockSimDocument>', `${change(sim)}</RockSimDocument>`);
  }

  it('folds ordinary same-loadout simulations despite stale masses', () => {
    const xml = rkt('F31-CL', 2110, 1).replace('<EjectionDelay>-1', '<EjectionDelay>8');
    const imported = importRkt(doubled(xml, sim => sim.replace('<Mass0>2110', '<Mass0>2210')));
    expect(imported.configs).toHaveLength(1);
  });

  it('deduplicates hundreds of identical qualifying simulations before checking evidence', () => {
    const motor = MOTOR_DB.find(m => m.motorId === P.blackBearK700)!;
    const xml = rkt('K700BB', 2010 + motor.totalWeightG, motor.burnTimeS).replace('<EjectionDelay>-1', '<EjectionDelay>-2');
    const sim = xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length);
    const imported = importRkt(xml.replace('</RockSimDocument>', `${sim.repeat(399)}</RockSimDocument>`));
    expect(imported.configs).toHaveLength(1);
    const context = Object.values(imported.configs[0]!.motors)[0]!.matchContext;
    expect(context?.physical).toBeDefined();
    expect(context?.foldedPhysical ?? []).toHaveLength(0);
    expect(lookup('K700BB', 'Cesaroni', context)?.motor.motorId).toBe(motor.motorId);
  });

  it('loads the named-maker EX library motor after an agreeing fold with no catalogue row', async () => {
    const ex: ExMotor = { motorId: 'ex:test-t1', designation: 'T1', realManufacturer: 'Test',
      diameter: 24, length: 100, totalWeightG: 100, propWeightG: 40, delays: 'P',
      samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 1 }, { time: 1, thrust: 0 }],
      source: 'eng', addedAt: 0 };
    const imported = importRkt(doubled(rkt('T1', 2110, 1, 24).replace('<EngineMfg>Cesaroni', '<EngineMfg>Test'), sim => sim.replace('<Mass0>2110', '<Mass0>2111')));
    expect(imported.configs).toHaveLength(1);
    expect(Object.values(imported.configs[0]!.motors)[0]!.matchContext?.foldedPhysical).toHaveLength(1);
    const result = await matchImportedMotor(Object.values(imported.configs[0]!.motors)[0]!, { catalogue: [], exMotors: [ex] });
    expect(result.motor?.meta.exMotorId).toBe(ex.motorId);
    expect(result.note).toContain('imported EX motor');
  });

  it('retains E31_CONFLICT for agreeing evidence that does not fit White Thunder', async () => {
    const motor = MOTOR_DB.find(m => m.motorId === P.whiteThunderE31)!;
    const mass = 2010 + motor.totalWeightG * 2;
    const imported = importRkt(doubled(rkt('26-E31-WH-15A', mass, motor.burnTimeS, 24), sim => sim.replace(`<Mass0>${mass}`, `<Mass0>${mass + motor.totalWeightG * 0.01}`)));
    expect(imported.configs).toHaveLength(1);
    expect(Object.values(imported.configs[0]!.motors)[0]!.matchContext?.foldedPhysical).toHaveLength(1);
    const result = await matchImportedMotor(Object.values(imported.configs[0]!.motors)[0]!);
    expect(result.motor).toBeUndefined();
    expect(result.note).toContain(E31_CONFLICT);
  });

  it('rechecks an earlier EX fallback when a later await changes null matching into conflict', async () => {
    const motor = MOTOR_DB.find(m => m.motorId === P.whiteThunderE31)!;
    const target = motor.totalWeightG;
    const mass = 2010 + target * 1.04;
    const imported = importRkt(doubled(rkt('26-E31-WH-15A', mass, motor.burnTimeS, 24),
      sim => sim.replace(`<Mass0>${mass}`, `<Mass0>${2010 + target * 1.06}`)));
    expect(imported.configs).toHaveLength(1);
    const first = Object.values(imported.motors)[0]!;
    expect(first.matchContext?.foldedPhysical).toHaveLength(1);
    const ex: ExMotor = { motorId: 'ex:e31', designation: first.designation, realManufacturer: 'Cesaroni',
      diameter: 24, length: 100, totalWeightG: target, propWeightG: target / 2, delays: 'P',
      samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 1 }, { time: 1, thrust: 0 }], source: 'eng', addedAt: 0 };
    imported.motors = { first, second: ref('G80') };
    let calls = 0;
    const resolved = await resolveImportMotors(imported, async r => {
      calls++;
      if (r === first) {
        const result = await matchImportedMotor(r, { exMotors: [ex] });
        if (calls === 1) expect(result.motor?.meta.exMotorId).toBe(ex.motorId);
        return result;
      }
      setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: MOTOR_DB.length,
        added: [], removed: [], rejected: [], changed: [{ motorId: motor.motorId, before: motor,
          after: { ...motor, totalWeightG: target * 1.02 }, fields: ['totalWeightG'] }] });
      return { note: '' };
    });
    expect(calls).toBeGreaterThan(2);
    expect(resolved.working.first?.motor).toBeUndefined();
    expect(resolved.working.first?.note).toContain('folded simulations');
  });

  it.each([false, true])('keeps boundary-disagreeing evidence in separate configurations (reverse=%s)', async reverse => {
    const masses = reverse ? [1020.2, 1000] : [1000, 1020.2];
    const xml = rkt('K700BB', 2010 + masses[0]!, 2.38);
    const imported = importRkt(doubled(xml, sim => sim.replace(`<Mass0>${2010 + masses[0]!}`, `<Mass0>${2010 + masses[1]!}`)));
    expect(imported.configs).toHaveLength(2);
    for (const config of imported.configs) {
      const result = await matchImportedMotor(Object.values(config.motors)[0]!);
      expect(result.motor?.meta.motorId).toBe(P.blueBaboonK700);
    }
  });

  it.each([false, true])('folds ordinary same-loadout references reached by known and stale serials (reverse=%s)', reverse => {
    const xml = rkt('F31-CL');
    const stale = (sim: string) => sim.replace('<MountSerialNo>6', '<MountSerialNo>999');
    const imported = importRkt(reverse
      ? doubled(xml.replace('<MountSerialNo>6', '<MountSerialNo>999'), sim => sim.replace('<MountSerialNo>999', '<MountSerialNo>6'))
      : doubled(xml, stale));
    expect(imported.configs).toHaveLength(1);
    expect(Object.values(imported.configs[0]!.motors)[0]!.matchContext?.mountBoreMm).toBeCloseTo(54.4);
  });

  it.each([-2, -1])('uses later folded evidence for E31 with delay %s', async delay => {
    const motor = MOTOR_DB.find(m => m.motorId === P.whiteThunderE31)!;
    const xml = rkt('26-E31-WH-15A', 2010 + motor.totalWeightG, motor.burnTimeS, 24)
      .replace('<EjectionDelay>-1', `<EjectionDelay>${delay}`);
    const sim = xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length);
    const first = xml.replace(/<Mass0>[^<]+<\/Mass0>/, '').replace(/<TimeToBurnout>[^<]+<\/TimeToBurnout>/, '');
    const imported = importRkt(first.replace('</RockSimDocument>', `${sim}</RockSimDocument>`));
    expect(imported.configs).toHaveLength(1);
    const ref = Object.values(imported.configs[0]!.motors)[0]!;
    expect((await matchImportedMotor(ref)).motor?.meta.motorId).toBe(motor.motorId);
    if (delay === -1) expect(ref.delay).toBe(defaultDelay(motor));
  });

  it.each([false, true])('keeps Black Bear and Blue Baboon evidence separate in either order (reverse=%s)', async reverse => {
    const black = MOTOR_DB.find(m => m.motorId === P.blackBearK700)!;
    const blue = MOTOR_DB.find(m => m.motorId === P.blueBaboonK700)!;
    const xml = rkt('K700BB', 2010 + black.totalWeightG, black.burnTimeS);
    const sim = xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length);
    // RockSim's stored Blue Baboon mass, not a catalogue assertion (that row
    // need not publish totalWeightG). Keep burn equal to exercise the mass gate.
    const other = sim.replace(`<Mass0>${2010 + black.totalWeightG}`, `<Mass0>${2010 + 1483.1}`);
    const imported = importRkt(xml.replace(sim, reverse ? other : sim).replace('</RockSimDocument>', `${reverse ? sim : other}</RockSimDocument>`));
    expect(imported.configs).toHaveLength(2);
    const ids = [];
    for (const config of imported.configs) ids.push((await matchImportedMotor(Object.values(config.motors)[0]!)).motor?.meta.motorId);
    expect(ids).toEqual(reverse ? [blue.motorId, black.motorId] : [black.motorId, blue.motorId]);
  });

  it('keeps the existing Blue Baboon fallback when folded evidence agrees', async () => {
    const motor = MOTOR_DB.find(m => m.motorId === P.blueBaboonK700)!;
    const blackBear = MOTOR_DB.find(m => m.motorId === P.blackBearK700)!;
    const mass = 2010 + blackBear.totalWeightG * 0.7;
    const xml = rkt('K700BB', mass, blackBear.burnTimeS);
    const sim = xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length);
    const imported = importRkt(xml.replace('</RockSimDocument>', `${sim.replace(`<Mass0>${mass}`, `<Mass0>${mass + blackBear.totalWeightG * 0.001}`)}</RockSimDocument>`));
    expect(imported.configs).toHaveLength(1);
    const ref = Object.values(imported.configs[0]!.motors)[0]!;
    expect(ref.matchContext?.physical).toBeDefined();
    expect(ref.matchContext?.foldedPhysical).toHaveLength(1);
    expect((await matchImportedMotor(ref)).motor?.meta.motorId).toBe(motor.motorId);
  });
  it.each(['K700BB', '26-E31-WH-15A'])('splits nearby evidence across the identity boundary for %s', async designation => {
    const motor = MOTOR_DB.find(m => m.motorId === (designation === 'K700BB' ? P.blackBearK700 : P.whiteThunderE31))!;
    const mass = motor.totalWeightG * 1.019;
    const xml = rkt(designation, 2010 + mass, motor.burnTimeS, motor.diameter);
    const imported = importRkt(doubled(xml, sim => sim.replace(`<Mass0>${2010 + mass}`, `<Mass0>${2010 + motor.totalWeightG * 1.021}`)));
    expect(imported.configs).toHaveLength(2);
    const results = [];
    for (const config of imported.configs) results.push((await matchImportedMotor(Object.values(config.motors)[0]!)).motor?.meta.motorId);
    expect(results).toEqual([motor.motorId, designation === 'K700BB' ? P.blueBaboonK700 : undefined]);
  });
  it('checks all retained evidence when a third simulation could bridge two conflicting masses', () => {
    const base = MOTOR_DB.find(m => m.motorId === P.blackBearK700)!.totalWeightG * 0.7;
    const xml = rkt('K700BB', 2010 + base * 1.01);
    const sims = (factor: number) => xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length)
      .replace(`<Mass0>${2010 + base * 1.01}`, `<Mass0>${2010 + base * factor}`);
    const imported = importRkt(xml.replace('</RockSimDocument>', `${sims(1)}${sims(1.0202)}</RockSimDocument>`));
    expect(imported.configs).toHaveLength(2);
    expect(Object.values(imported.configs[0]!.motors)[0]!.matchContext?.foldedPhysical).toHaveLength(1);
  });
  it('still refuses an inseparable conflicting context supplied directly to the matcher', async () => {
    const motor = MOTOR_DB.find(m => m.motorId === P.blackBearK700)!;
    const context = physical(motor.totalWeightG, motor.burnTimeS);
    context.foldedPhysical = [physical(motor.totalWeightG * 0.7, motor.burnTimeS).physical!];
    const result = await matchImportedMotor(ref('K700BB', 'CTI', context));
    expect(result.motor).toBeUndefined();
    expect(result.note).toContain('folded simulations');
  });
  it('refuses evidence and burn duration if the indexed simulation count is unavailable', () => {
    const doc = new DOMParser().parseFromString(rkt(), 'text/xml');
    const index = { ...motorIndex(doc), simulationSets: new Map() };
    const engineSet = doc.querySelector('EngineSet')!;
    expect(rocksimMotorEvidence(engineSet, index).physical).toBeUndefined();
    expect(rocksimBurnTime(engineSet, index)).toBeUndefined();
  });

  it('rejects mixed/clustered/staged, unknown units, unqualified dry masses, stale mounts and invalid numbers', () => {
    expect(evidence(rkt()).physical?.motorMassG).toBe(2088);
    const invalid = [
      ['<FileVersion>4', '<FileVersion>3'], ['<UseKnownMass>1', '<UseKnownMass>0'], ['<StageCount>1', '<StageCount>2'],
      ['<EngineCount>1', '<EngineCount>2'], ['<Stage3Mass>2010', '<Stage3Mass>0'], ['<Mass0>4098', '<Mass0>NaN'],
      ['<MountSerialNo>6', '<MountSerialNo>999'], ['<IgnitionDelay>0', '<IgnitionDelay>-1'],
      ['</Stage3Engines>', '<EngineSet><EngineCount>1</EngineCount></EngineSet></Stage3Engines>'],
    ];
    for (const [a, b] of invalid) expect(evidence(rkt().replace(a!, b!)).physical, a).toBeUndefined();
    expect(evidence(rkt().replace('<ID>54.4</ID>', '')).mountBoreMm).toBeUndefined();
    expect(evidence(rkt().replace('<IgnitionDelay>0', '<IgnitionDelay>1').replace('<TimeToBurnout>2.38', '<TimeToBurnout>3.38')).physical?.burnTimeS).toBeCloseTo(2.38);
  });
  it('normal import, every-delay, resolved configs and switched notes use the same evidence', async () => {
    const imported = importRkt(rkt());
    const r = Object.values(imported.motors)[0]!;
    expect(r.matchContext?.physical?.motorMassG).toBe(2088);
    expect(rktEveryDelay('J360SK', 'CTI', bore(38))?.delay).toBe(defaultDelay(findDbMotor('J360', 38)!));
    expect(rktEveryDelay('26-E31-WH-15A', 'CTI', physical(52, 0.87125))).not.toBeNull();
    expect(rktEveryDelay('G80', 'unknown')?.delay).toBe(defaultDelay(MOTOR_DB.find(m => m.motorId === P.aeroTechG80)!));
    const resolved = await resolveImportMotors(imported);
    const text = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };
    const plan = planImport(imported, resolved, { launch: { ...DEFAULT_CONDITIONS }, text });
    expect(JSON.stringify(plan)).toContain('Black Bear');
    for (const config of plan.snapshot.savedConfigs) {
      const switched = planConfigSwitch({ ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs }, config, text);
      expect(JSON.stringify(switched)).toContain('Black Bear');
    }
  });
  it('keeps differently evidenced copies of the same motor name as separate configurations', async () => {
    const xml = rkt();
    const sim = xml.slice(xml.indexOf('<SimulationResults>'), xml.indexOf('</SimulationResults>') + '</SimulationResults>'.length);
    const second = sim.replace('<Mass0>4098', '<Mass0>3493.1').replace('<TimeToBurnout>2.38', '<TimeToBurnout>2.24');
    const imported = importRkt(xml.replace('</RockSimDocument>', `${second}</RockSimDocument>`));
    expect(imported.configs).toHaveLength(2);
    const ids = [];
    for (const cfg of imported.configs) ids.push((await matchImportedMotor(Object.values(cfg.motors)[0]!)).motor?.meta.motorId);
    expect(ids).toEqual([P.blackBearK700, P.blueBaboonK700]);
  });
  it('RASAero retains explicit P evidence but does not invent it for a sustainer', () => {
    const xml = readFileSync('src/services/__fixtures__/LEM-M2B Scratch.CDX1', 'utf8');
    const changed = xml.replace(/<SustainerEngine>[^<]*<\/SustainerEngine>/g, '<SustainerEngine>I170-P  (Kosdon)</SustainerEngine>');
    const withP = Object.values(importCdx1(changed).motors)[0]!;
    expect(withP.matchContext?.explicitDelay).toBe('plugged');
    expect(lookup(withP.designation, withP.manufacturer, withP.matchContext)?.motor.designation).toBe('I170S');
    const bare = Object.values(importCdx1(changed.replace('I170-P  ', 'I170  ')).motors)[0]!;
    expect(bare.delay).toBe(Infinity);
    expect(bare.matchContext?.explicitDelay).toBeUndefined();
    expect(lookup(bare.designation, bare.manufacturer, bare.matchContext)?.motor.designation).toBe('I170DH');
    const h123 = importCdx1(changed.replace('I170-P  (Kosdon)', 'H123-SK-14  (CTI)'));
    const motor = findDbMotor('H123-SK-14', undefined, undefined, 'CTI')!;
    expect(h123.tree.components[0]?.['overrideMass']).toBeCloseTo(4.2 * 0.45359237 - motor.totalWeightG / 1000, 8);
    const g80 = importCdx1(changed.replace('I170-P  (Kosdon)', 'G80  (unknown)'));
    const equivalent = MOTOR_DB.find(m => m.motorId === P.aeroTechG80)!;
    expect(g80.tree.components[0]?.['overrideMass']).toBeCloseTo(4.2 * 0.45359237 - equivalent.totalWeightG / 1000, 8);
  });
});


describe('stored RockSim burn duration is diagnostic only', () => {
  function burn(xml: string): number | undefined {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return rocksimBurnTime(doc.querySelector('EngineSet')!, motorIndex(doc));
  }
  it('reads legacy seconds without promoting legacy masses to matcher evidence', () => {
    for (const version of [2, 3, 4]) {
      const xml = rkt('E15', 0.1, 3.7, 24).replace('<FileVersion>4', '<FileVersion>' + version)
        .replace('<UseKnownMass>1', '<UseKnownMass>0').replace('<IgnitionDelay>0', '<IgnitionDelay>1');
      expect(burn(xml)).toBeCloseTo(2.7);
      const imported = importRkt(xml);
      expect(Object.values(imported.motors)[0]?.rktBurnTimeS).toBeCloseTo(2.7);
      expect(Object.values(imported.motors)[0]?.matchContext?.physical).toBeUndefined();
    }
  });
  it('refuses multi-stage/cluster/invalid burnout evidence', () => {
    const invalid = [
      ['<StageCount>1', '<StageCount>2'], ['<EngineCount>1', '<EngineCount>2'],
      ['<IgnitionDelay>0', '<IgnitionDelay>-1'], ['<IgnitionDelay>0</IgnitionDelay>', ''],
      ['<TimeToBurnout>2.38', '<TimeToBurnout>NaN'], ['<TimeToBurnout>2.38', '<TimeToBurnout>0'],
      ['<IgnitionDelay>0', '<IgnitionDelay>3'],
      ['</Stage3Engines>', '<EngineSet><EngineCount>1</EngineCount></EngineSet></Stage3Engines>'],
    ];
    for (const [a, b] of invalid) expect(burn(rkt().replace(a!, b!)), a).toBeUndefined();
  });
  it('surfaces the curve note on open and when switching to its saved configuration', async () => {
    const imported = importRkt(rkt('E15', 100, 2.7, 24).replace(/Cesaroni/g, 'AeroTech'));
    const resolved = await resolveImportMotors(imported);
    const text = { mass: (kg: number) => kg + ' kg', length: (m: number) => m + ' m' };
    const plan = planImport(imported, resolved, { launch: { ...DEFAULT_CONDITIONS }, text });
    expect(plan.note.text).toContain('Published alternatives with similar duration');
    expect(plan.note.severity).toBe('warn');
    for (const config of plan.snapshot.savedConfigs) {
      const switched = planConfigSwitch({ ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs }, config, text);
      expect(switched.note.text).toContain('Published alternatives with similar duration');
    }
  });
});
