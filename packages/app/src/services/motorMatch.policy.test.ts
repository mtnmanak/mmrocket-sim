// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findDbMotor, matchDbMotor, MOTOR_DB } from './motorDb.js';
import { matchImportedMotor } from './motorMatch.js';
import { MOTOR_MATCH_POLICY as P, type MotorMatchContext } from './motorMatchPolicy.js';
import { importRkt, rktEveryDelay } from './rocksimFile.js';
import { rocksimMotorEvidence } from './rocksimMotorEvidence.js';
import { importCdx1 } from './rasaeroFile.js';
import { defaultDelay, fetchMotorSpec } from './thrustcurve.js';
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
function evidence(xml: string): MotorMatchContext {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return rocksimMotorEvidence(doc, doc.querySelector('EngineSet')!);
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline')))));
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

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
    const result = await matchImportedMotor(ref('I170', 'Kosdon'), { fetchSpec: vi.fn(fetchMotorSpec) });
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
