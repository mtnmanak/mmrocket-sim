// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { addExMotors, exToDbEntry, parseEng } from './exMotors.js';
import { exportOrk, importOrk } from './orkFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { fetchMotorSpec } from './thrustcurve.js';
import { MOTOR_DB } from './motorDb.js';
import {
  includedMotorOf, namesSameMotor, OVERRIDE_INCLUDES_MOTOR, reconcileAllIncludedMotors,
  reconcileIncludedMotor,
} from './statedLaunchWeight.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, '__fixtures__', name), 'utf8');

/**
 * Local-only inputs (`docs/` is gitignored — CLAUDE.md "Two machines"). Found
 * by walking up from the working directory, not from `import.meta.url`: under
 * happy-dom this module's URL is a served `/@fs/` path and a URL-relative walk
 * silently resolves to nothing. Same helper as lemivSweep.test.ts.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
const localEng = (name: string) =>
  join(repoRoot(), 'docs', 'User files', 'TRF RASAero Files', name);

const LB = 2.2046226218487757;
const lb = (kg: number) => kg * LB;

/** lb/in formatters, so an assertion can read the file's own units. */
const TEXT = {
  mass: (kg: number) => `${lb(kg).toFixed(3)} lb`,
  length: (m: number) => `${(m * 39.37007874015748).toFixed(2)} in`,
};

/**
 * The two MESOS motors, as their author published them. The real `.eng` files
 * live in `docs/User files/TRF RASAero Files/` and are NOT in the repo, so the
 * header line each test needs is written out here — the same choice
 * `tree/motorRoom.test.ts` makes for the file it was built from. Every number
 * is copied from those files verbatim (RASP header:
 * `name diameter_mm length_mm delays prop_kg total_kg manufacturer`), and the
 * local-file test at the bottom re-reads the originals and checks that these
 * still match.
 */
const M787_ENG = [
  '; MESOS sustainer, expanded nozzle, sea level',
  'M787 75 954 200 4.05512 6.97171 KIP',
  '  0.01 35.6925',
  '  5.0 925.897',
  '  9.845 0.0',
].join('\n');
const O4374_ENG = [
  '; MESOS booster, sea level',
  'O4374 114 1508 200 14.69186 24.3942 KIP',
  '  0.01 929.475',
  '  5.0 4740.06',
  '  7.532 0.0',
].join('\n');

/** The file's own stated numbers, read straight out of the fixture. */
const MESOS_SUSTAINER_LB = 23.31;
const MESOS_STACK_LB = 87.05;

/** Loads an `.eng` the way Browse motor database does, and returns its spec. */
async function exSpec(engText: string) {
  const ex = parseEng(engText)[0]!;
  addExMotors([ex]);
  const db = exToDbEntry(ex);
  const spec = await fetchMotorSpec(db, 0);
  return spec;
}

const stagesOf = (t: RocketTree) => t.components.filter((n) => n.type === 'stage');
const mountOf = (st: ComponentNode) =>
  [...(st.children ?? [])].reverse().find((c) => c.type === 'bodytube')!;

beforeEach(() => {
  localStorage.clear();
});

/**
 * The bug, end to end. MEASURED 2026-09-08 against the author's own file and
 * his own two `.eng` motors — see services/statedLaunchWeight.ts for the
 * mechanism and docs/open-items.md.
 */
describe('MESOS: the stated launch weight and the motor that was still inside it', () => {
  it('imports at the file’s own 87.05 lb with neither motor loaded', () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const [sus, boo] = stagesOf(r.tree);
    // 23.310 lb applied whole (no motor to back out), and the booster's own
    // 87.050 − 23.310 = 63.740 lb.
    expect(lb(sus!['overrideMass'] as number)).toBeCloseTo(MESOS_SUSTAINER_LB, 3);
    expect(lb(boo!['overrideMass'] as number)).toBeCloseTo(MESOS_STACK_LB - MESOS_SUSTAINER_LB, 3);
    const total = stagesOf(r.tree).reduce((s, st) => s + (st['overrideMass'] as number), 0);
    expect(lb(total)).toBeCloseTo(MESOS_STACK_LB, 3);
  });

  it('marks both stages with the motor whose weight is still in them', () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const [sus, boo] = stagesOf(r.tree);
    expect(sus![OVERRIDE_INCLUDES_MOTOR]).toBe('M787');
    expect(boo![OVERRIDE_INCLUDES_MOTOR]).toBe('O4374');
    // Reachable from any node in the stage — the assignment path only has a
    // mount id.
    expect(includedMotorOf(r.tree, mountOf(sus!).id!)).toBe('M787');
    expect(includedMotorOf(r.tree, mountOf(boo!).id!)).toBe('O4374');
  });

  it('stays at 87.05 lb once both EX motors are loaded — not 156 lb', async () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    let tree = r.tree;
    const m787 = await exSpec(M787_ENG);
    const o4374 = await exSpec(O4374_ENG);
    // The masses this whole test rests on, stated so a changed parser is
    // caught here rather than in the total below.
    expect(m787.masses[0]).toBeCloseTo(6.97171, 5);
    expect(o4374.masses[0]).toBeCloseTo(24.3942, 4);

    for (const [i, spec] of [m787, o4374].entries()) {
      const st = stagesOf(tree)[i]!;
      const fix = reconcileIncludedMotor(tree, mountOf(st).id!, {
        designation: spec.designation,
        launchMassKg: spec.masses[0]!,
        lengthM: spec.length,
        cgXFromFrontM: spec.cgX,
      }, TEXT);
      expect(fix).not.toBeNull();
      tree = fix!.tree;
    }

    const airframe = stagesOf(tree).reduce((s, st) => s + (st['overrideMass'] as number), 0);
    const motors = m787.masses[0]! + o4374.masses[0]!;
    // What the rocket now weighs on the pad: the airframe overrides plus the
    // two motors the kernel adds on top of them.
    expect(lb(airframe + motors)).toBeCloseTo(MESOS_STACK_LB, 3);
    expect(airframe + motors).toBeCloseTo(39.4852, 3);
    // And the number this replaces: 87.050 + 31.366 kg = 156.2 lb, +79 %.
    expect(lb(39.48521584161193 + motors)).toBeCloseTo(156.20, 2);

    // Each stage is now a dry airframe mass.
    expect(lb(stagesOf(tree)[0]!['overrideMass'] as number)).toBeCloseTo(7.940, 3);
    expect(lb(stagesOf(tree)[1]!['overrideMass'] as number)).toBeCloseTo(9.960, 3);
    // The mark is spent — a second motor on the same stage must not subtract
    // again.
    for (const st of stagesOf(tree)) expect(st[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(reconcileIncludedMotor(tree, mountOf(stagesOf(tree)[0]!).id!, {
      designation: 'M787', launchMassKg: 6.97171, lengthM: 0.954, cgXFromFrontM: 0.477,
    }, TEXT)).toBeNull();
  });

  it('backs the motor out of the stated CG as well, and keeps it inside the stage', async () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const sus = stagesOf(r.tree)[0]!;
    const before = sus['overrideCGX'] as number;
    const m787 = await exSpec(M787_ENG);
    const fix = reconcileIncludedMotor(r.tree, mountOf(sus).id!, {
      designation: m787.designation,
      launchMassKg: m787.masses[0]!,
      lengthM: m787.length,
      cgXFromFrontM: m787.cgX,
    }, TEXT)!;
    const after = stagesOf(fix.tree)[0]!;
    const cg = after['overrideCGX'] as number;
    // The file states the LAUNCH CG (46.00 in from the stage front), so the
    // airframe's own CG has to be FORWARD of it once the motor comes out.
    expect(cg).toBeLessThan(before);
    expect(cg).toBeGreaterThan(0);
    const len = (sus.children ?? []).reduce(
      (s, c) => s + (typeof c['length'] === 'number' ? (c['length'] as number) : 0), 0);
    expect(cg).toBeLessThan(len);
    expect(after['overrideSubcomponentsCG']).toBe(true);
    expect(fix.severity).toBe('info');
  });

  it('says in plain words what changed and what to do', async () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const boo = stagesOf(r.tree)[1]!;
    const o4374 = await exSpec(O4374_ENG);
    const fix = reconcileIncludedMotor(r.tree, mountOf(boo).id!, {
      designation: o4374.designation,
      launchMassKg: o4374.masses[0]!,
      lengthM: o4374.length,
      cgXFromFrontM: o4374.cgX,
    }, TEXT)!;
    const note = fix.note!;
    expect(note).toContain('“Booster”');
    expect(note).toContain('63.740 lb');   // the number that was wrong
    expect(note).toContain('“O4374”');
    expect(note).toContain('53.780 lb');   // what came back out
    expect(note).toContain('9.960 lb');    // what the stage carries now
    expect(note).toContain('counted twice');
    expect(note).toContain('Clear the overrides under Overrides');
    // House voice: no "we", no marketing.
    expect(note).not.toMatch(/\bwe\b/i);
  });
});

describe('the import note tells the user what will happen when they load the motor', () => {
  it('says the weight is right as it stands, and that loading the motor takes it back out', () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const note = r.notes.find((n) => n.startsWith('Applied WITH the motor still included'))!;
    expect(note).toBeDefined();
    expect(note).toContain('“M787” isn’t in the motor database');
    expect(note).toContain('the stated 23.310 lb is used as it stands');
    expect(note).toContain('right for the rocket as it stands here');
    expect(note).toContain('takes its weight back out of the stage mass and CG first');
    expect(note).toContain('never counted twice');
  });
});

describe('a design whose motors are all in the catalogue is untouched', () => {
  /*
   * MEASURED 2026-09-08 by importing every bundled `.CDX1` fixture through
   * this build AND through the file at HEAD (3686d38) and comparing the two
   * results with ids remapped: all twelve are identical once the new mark is
   * removed, and only the two files naming an uncatalogued motor — MESOS
   * (M787/O4374) and ThreeCarbYen-2018 (N2501-WH) — carry it at all. The
   * assertions below are what remains of that comparison in CI: nothing but
   * those files may ever gain the key, and a stage without it must be left
   * exactly alone.
   */
  const catalogued = ['38-54 2-stage.CDX1', 'Complex.Two-Stage.CDX1', 'Show-off.CDX1',
    'Three-stage rocket.CDX1', 'Wildman_Mach 2 this one.CDX1', 'RMA53D02 - 2.CDX1',
    'LEM-M2B Scratch.CDX1', 'vb38-dragstudy02.CDX1', 'ARCAS-Long - 2.CDX1',
    'launch-stage-motorless.CDX1'];

  for (const name of catalogued) {
    it(`${name} carries no mark`, () => {
      const r = importCdx1(fixture(name));
      expect(JSON.stringify(r.tree)).not.toContain(OVERRIDE_INCLUDES_MOTOR);
    });
  }

  it('38-54 2-stage still applies its catalogued K627LR the old way', () => {
    const r = importCdx1(fixture('38-54 2-stage.CDX1'));
    // 3.500 lb stated − K627LR 2.725 lb = 0.775 lb: the motor WAS backed out
    // at import, so nothing is left to take out later.
    const sus = stagesOf(r.tree)[0]!;
    expect(lb(sus['overrideMass'] as number)).toBeCloseTo(0.775, 3);
    expect(sus[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(includedMotorOf(r.tree, mountOf(sus).id!)).toBeNull();
  });

  it('reconciling an unmarked stage changes nothing and returns null', () => {
    const r = importCdx1(fixture('38-54 2-stage.CDX1'));
    const sus = stagesOf(r.tree)[0]!;
    expect(reconcileIncludedMotor(r.tree, mountOf(sus).id!, {
      designation: 'K627LR', launchMassKg: 1.236, lengthM: 0.4, cgXFromFrontM: 0.2,
    }, TEXT)).toBeNull();
  });

  it('a mount that is in no stage returns null', () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    expect(reconcileIncludedMotor(r.tree, 'not-a-node', {
      designation: 'M787', launchMassKg: 6.97171, lengthM: 0.954, cgXFromFrontM: 0.477,
    }, TEXT)).toBeNull();
  });
});

describe('the refusals — a wrong override is worse than none', () => {
  const marked = (over: Partial<ComponentNode> = {}): RocketTree => ({
    components: [{
      type: 'stage',
      id: 'st',
      name: 'Sustainer',
      overrideMass: 2,
      overrideSubcomponentsMass: true,
      overrideCGX: 0.5,
      overrideSubcomponentsCG: true,
      [OVERRIDE_INCLUDES_MOTOR]: 'M787',
      ...over,
      children: [{ type: 'bodytube', id: 'bt', length: 1, outerRadius: 0.04, thickness: 0.002 }],
    }],
  });
  const motor = (massKg: number, lengthM = 0.3) => ({
    designation: 'M787', launchMassKg: massKg, lengthM, cgXFromFrontM: lengthM / 2,
  });

  it('clears both overrides when the motor weighs as much as the whole stage', () => {
    const fix = reconcileIncludedMotor(marked(), 'bt', motor(2.5), TEXT)!;
    const st = fix.tree.components[0]!;
    expect(st['overrideMass']).toBeUndefined();
    expect(st['overrideSubcomponentsMass']).toBeUndefined();
    expect(st['overrideCGX']).toBeUndefined();
    expect(st['overrideSubcomponentsCG']).toBeUndefined();
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(fix.severity).toBe('warn');
    expect(fix.note).toContain('cannot be right for this motor');
    expect(fix.note).toContain('back on its computed geometry');
  });

  it('clears rather than subtracts when the motor is NOT the one the file named', () => {
    // v0.120 subtracted whatever motor arrived — `stated − loaded` — which is
    // arithmetic on two unrelated numbers unless the loaded motor is the one
    // still inside `stated`. Measured on PePe2 below; the rule is in the
    // module header (2026-09-08, from review).
    const fix = reconcileIncludedMotor(marked(), 'bt', {
      designation: 'M1297', launchMassKg: 1, lengthM: 0.3, cgXFromFrontM: 0.15,
    }, TEXT)!;
    const st = fix.tree.components[0]!;
    expect(st['overrideMass']).toBeUndefined();
    expect(st['overrideSubcomponentsMass']).toBeUndefined();
    expect(st['overrideCGX']).toBeUndefined();
    expect(st['overrideSubcomponentsCG']).toBeUndefined();
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(fix.severity).toBe('warn');
    // Both motors named, and the file's own figure quoted so it can be retyped.
    expect(fix.note).toContain('“M787”');
    expect(fix.note).toContain('“M1297”');
    expect(fix.note).toContain(TEXT.mass(2));
    expect(fix.note).toContain('Type what the stage weighs without a motor');
    expect(fix.note).not.toMatch(/\bwe\b/i);
  });

  it('drops the mark quietly when a different motor lands on an already-cleared stage', () => {
    const tree = marked({ overrideMass: undefined, overrideCGX: undefined, overrideSubcomponentsCG: undefined });
    const fix = reconcileIncludedMotor(tree, 'bt', {
      designation: 'K550', launchMassKg: 1, lengthM: 0.3, cgXFromFrontM: 0.15,
    }, TEXT)!;
    expect(fix.note).toBeNull();
    expect(fix.tree.components[0]![OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
  });

  it('still corrects a motor whose catalogue spelling differs from the file’s', () => {
    // The mark carries the RASAero file's designation and the loaded spec
    // carries the catalogue's, and `findDbMotor` is what paired them — so the
    // same rank-0/rank-1 rules decide "this IS that motor" here.
    for (const [named, loaded] of [
      ['N5800-CS', '5800N5800-CS'],   // Cesaroni impulse prefix
      ['I224', 'I224-15A'],           // delay suffix in the catalogue
      ['M1297W', 'm1297w'],           // case
    ] as const) {
      expect(namesSameMotor(loaded, named)).toBe(true);
      const fix = reconcileIncludedMotor(
        marked({ [OVERRIDE_INCLUDES_MOTOR]: named }), 'bt',
        { designation: loaded, launchMassKg: 1, lengthM: 0.3, cgXFromFrontM: 0.15 }, TEXT)!;
      expect(fix.tree.components[0]!['overrideMass'], loaded).toBeCloseTo(1, 9);
      expect(fix.severity, loaded).toBe('info');
    }
    // And two motors that merely start with the same letter are NOT the same.
    expect(namesSameMotor('K510', 'K550')).toBe(false);
    expect(namesSameMotor('M1297W', '')).toBe(false);
  });

  it('will not let a prefix match cut a thrust number in half', () => {
    // 2026-09-08, from review: the prefix rule had no floor, so a mark naming a
    // short designation swallowed any longer one starting with it — and the
    // subtraction that follows is a whole motor's weight off the stated launch
    // weight. A delay or propellant suffix never starts with a digit, which is
    // what separates the pairs below from the ones above.
    expect(namesSameMotor('M1297W', 'M1')).toBe(false);
    expect(namesSameMotor('M787', 'M7871')).toBe(false);
    expect(namesSameMotor('M1297W', 'M')).toBe(false);
    // Still the same motor: the longer side continues with a delimiter or a
    // propellant letter, not another digit.
    expect(namesSameMotor('I224', 'I224-15A')).toBe(true);
    expect(namesSameMotor('I224W', 'I224')).toBe(true);
    expect(namesSameMotor('J540R', 'J540R-14A')).toBe(true);
  });

  it('drops a stale mark quietly when BOTH overrides have already been cleared', () => {
    const tree = marked({ overrideMass: undefined, overrideCGX: undefined, overrideSubcomponentsCG: undefined });
    const fix = reconcileIncludedMotor(tree, 'bt', motor(1), TEXT)!;
    expect(fix.note).toBeNull();
    expect(fix.tree.components[0]![OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
  });

  it('clears a CG it can no longer back the motor out of, rather than leaving it', () => {
    // The mass override is gone (cleared by hand, or never applied because the
    // file stated only a CG) and the CG override is still motor-inclusive —
    // which is what the mark says. There is no stage mass left to divide by, so
    // it cannot be corrected, and a CG that counts the motor twice is a
    // stability number the user would trust. Same ruling as the branch above:
    // a wrong override is worse than none (2026-09-08, from review).
    const tree = marked({ overrideMass: undefined });
    const fix = reconcileIncludedMotor(tree, 'bt', motor(1), TEXT)!;
    expect(fix.severity).toBe('warn');
    expect(fix.note).toContain('LAUNCH CG');
    const st = fix.tree.components[0]!;
    expect(st['overrideCGX']).toBeUndefined();
    expect(st['overrideSubcomponentsCG']).toBeUndefined();
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
  });

  it('corrects the mass but clears a CG that lands outside the stage', () => {
    // A motor heavy enough to drag the airframe CG past the stage's own aft
    // end once it is backed out of a forward launch CG.
    const fix = reconcileIncludedMotor(
      marked({ overrideMass: 10, overrideCGX: 0.1 }), 'bt', motor(9.5, 0.9), TEXT)!;
    const st = fix.tree.components[0]!;
    expect(st['overrideMass']).toBeCloseTo(0.5, 9);
    expect(st['overrideCGX']).toBeUndefined();
    expect(st['overrideSubcomponentsCG']).toBeUndefined();
    expect(fix.severity).toBe('warn');
    expect(fix.note).toContain('CG override could not be corrected');
  });

  it('still corrects the mass when the stage carries no CG override at all', () => {
    const fix = reconcileIncludedMotor(
      marked({ overrideCGX: undefined, overrideSubcomponentsCG: undefined }), 'bt', motor(1), TEXT)!;
    expect(fix.tree.components[0]!['overrideMass']).toBeCloseTo(1, 9);
    expect(fix.severity).toBe('info');
    expect(fix.note).toContain('mass override is now');
    expect(fix.note).not.toContain('CG override is now');
  });
});

describe('the mark survives Save .ork — the motor may only turn up next session', () => {
  it('round-trips beside the mass override it belongs to', () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const xml = exportOrk({ name: 'MESOS', tree: r.tree });
    expect(xml).toContain('<overrideincludesmotor>M787</overrideincludesmotor>');
    expect(xml).toContain('<overrideincludesmotor>O4374</overrideincludesmotor>');
    const back = importOrk(xml);
    const [sus, boo] = stagesOf(back.tree);
    expect(sus![OVERRIDE_INCLUDES_MOTOR]).toBe('M787');
    expect(boo![OVERRIDE_INCLUDES_MOTOR]).toBe('O4374');
    expect(lb(sus!['overrideMass'] as number)).toBeCloseTo(MESOS_SUSTAINER_LB, 3);
  });

  it('is emitted for no other design, so a plain .ork is unchanged', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    expect(exportOrk({ name: 'plain', tree: r.tree })).not.toContain('overrideincludesmotor');
  });

  it('survives on a CG-ONLY stage — the writer emitted what the reader dropped', () => {
    // The reader kept the mark only beside a numeric `overrideMass`, while the
    // importer marks a CG-only stage and the writer emits the element whenever
    // the mark is set. So this tree round-tripped to a motor-inclusive LAUNCH
    // CG with no mark: the next motor's moment landed on top of one already in
    // it and the stability margin counted the motor twice, silently, while the
    // same tree in session clears that CG with a note (2026-09-08, from review).
    const cgOnly: RocketTree = {
      name: 'cg only',
      components: [{
        type: 'stage',
        id: 'st',
        name: 'Sustainer',
        overrideCGX: 0.6,
        overrideSubcomponentsCG: true,
        [OVERRIDE_INCLUDES_MOTOR]: 'M787',
        children: [{ type: 'bodytube', id: 'bt', length: 1.2, outerRadius: 0.04, thickness: 0.002 }],
      }],
    } as unknown as RocketTree;
    const xml = exportOrk({ name: 'cg only', tree: cgOnly });
    expect(xml).toContain('<overrideincludesmotor>M787</overrideincludesmotor>');
    const back = importOrk(xml);
    const st = back.tree.components.find((c) => c.type === 'stage')!;
    expect(st['overrideCGX']).toBeCloseTo(0.6, 9);
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBe('M787');
  });

  it('is still dropped when the stage carries NEITHER override', () => {
    // A bare mark corrects nothing and would only fire a notice, so the reader
    // still refuses it — that half of the rule is unchanged.
    const bare: RocketTree = {
      name: 'bare',
      components: [{
        type: 'stage',
        id: 'st',
        name: 'Sustainer',
        [OVERRIDE_INCLUDES_MOTOR]: 'M787',
        children: [{ type: 'bodytube', id: 'bt', length: 1.2, outerRadius: 0.04, thickness: 0.002 }],
      }],
    } as unknown as RocketTree;
    const back = importOrk(exportOrk({ name: 'bare', tree: bare }));
    expect(back.tree.components.find((c) => c.type === 'stage')![OVERRIDE_INCLUDES_MOTOR])
      .toBeUndefined();
  });
});

/**
 * The same assertion against the author's own `.eng` files when this machine
 * has them. Skipped in CI and on a machine without `docs/` — the inline
 * headers above are the copy that always runs, and this is what keeps them
 * honest.
 */
const ENGS = ['M787_Expanded_Nozzle_Sea_Level.eng', 'O4374_Sea_Level.eng'].map(localEng);
const HAVE_ENGS = ENGS.every((p) => existsSync(p));

describe.skipIf(!HAVE_ENGS)('against the author’s own .eng files', () => {
  it('matches the inline headers, and lands on the file’s own 87.05 lb', async () => {
    const specs = [];
    for (const path of ENGS) specs.push(await exSpec(readFileSync(path, 'utf8')));
    expect(specs[0]!.masses[0]).toBeCloseTo(6.97171, 5);
    expect(specs[1]!.masses[0]).toBeCloseTo(24.3942, 4);
    expect(specs[0]!.length).toBeCloseTo(0.954, 6);
    expect(specs[1]!.length).toBeCloseTo(1.508, 6);

    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    let tree = r.tree;
    for (const [i, spec] of specs.entries()) {
      const st = stagesOf(tree)[i]!;
      tree = reconcileIncludedMotor(tree, mountOf(st).id!, {
        designation: spec.designation,
        launchMassKg: spec.masses[0]!,
        lengthM: spec.length,
        cgXFromFrontM: spec.cgX,
      }, TEXT)!.tree;
    }
    const total = stagesOf(tree).reduce((s, st) => s + (st['overrideMass'] as number), 0)
      + specs.reduce((s, sp) => s + sp.masses[0]!, 0);
    expect(lb(total)).toBeCloseTo(MESOS_STACK_LB, 3);
  });
});

/**
 * THE FILE THE CROSS-DESIGNATION SUBTRACTION WAS MEASURED ON (2026-09-08, from
 * review). `PePe2.CDX1` is one airframe with EIGHT simulations, each stating
 * its own launch weight for its own motor: 47 lb with N5800-CS (which the
 * catalogue does not have, so the stage imports marked), 24.2 lb with M1297W,
 * 19.7 lb with K510. Only the applied simulation's weight is read at import,
 * so switching configuration mounts a motor that has nothing to do with the
 * figure on the stage — and v0.120 subtracted it from that figure anyway.
 *
 * Local-only input, like the `.eng` files above.
 */
const PEPE2 = localEng('PePe2.CDX1');

describe.skipIf(!existsSync(PEPE2))('PePe2: another simulation’s motor on a marked stage', () => {
  it('clears the stated weight rather than subtracting a motor it never held', () => {
    const r = importCdx1(readFileSync(PEPE2, 'utf8'));
    const st = stagesOf(r.tree)[0]!;
    // The file's simulation 1, applied whole because N5800-CS is not catalogued.
    expect(lb(st['overrideMass'] as number)).toBeCloseTo(47.0, 3);
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBe('N5800-CS');

    // Simulation 6's motor, straight off the shipped catalogue — the same
    // numbers `App.attachedOf` builds from a loaded `MotorSpec`.
    const m1297 = MOTOR_DB.find((m) => m.designation === 'M1297W' && m.totalWeightG > 0)!;
    expect(m1297.totalWeightG / 1000).toBeCloseTo(4.637, 3);
    const mountId = (st.children ?? []).find((c) => c['motorMount'] === true)!.id!;
    const out = reconcileAllIncludedMotors(r.tree, {
      [mountId]: {
        designation: m1297.designation,
        launchMassKg: m1297.totalWeightG / 1000,
        lengthM: m1297.length / 1000,
        cgXFromFrontM: m1297.length / 2000,
      },
    }, TEXT);

    const after = stagesOf(out.tree)[0]!;
    expect(after['overrideMass']).toBeUndefined();
    expect(after['overrideCGX']).toBeUndefined();
    expect(after[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
    expect(out.severity).toBe('warn');
    expect(out.notes[0]).toContain('47.000 lb');
    expect(out.notes[0]).toContain('“N5800-CS”');
    expect(out.notes[0]).toContain('“M1297W”');

    // What v0.120 wrote instead, and what it cost: 47.000 − 10.222 = 36.777 lb
    // called "airframe" against simulation 6's own 24.2 − 10.222 = 13.98 lb, so
    // the rocket flew at the 47.0 lb of a simulation it was no longer running —
    // +94 % — at severity 'info', with the mark spent.
    expect(lb((st['overrideMass'] as number) - m1297.totalWeightG / 1000)).toBeCloseTo(36.777, 3);
    expect(lb(m1297.totalWeightG / 1000)).toBeCloseTo(10.223, 3);
  });
});


/**
 * THE OTHER TWO WAYS A MOTOR LANDS ON A MOUNT, both of which put the double
 * count straight back until 2026-09-08 (found in review).
 *
 * `reconcileIncludedMotor` was wired into Browse motor database and the file
 * open. It was NOT wired into applying a flight configuration, and it could not
 * survive undo — motors live outside the tree and the undo stack is the tree
 * alone, so Ctrl+Z restored the marked, uncorrected override under a motor that
 * was still mounted. Both paths now call `reconcileAllIncludedMotors`, and both
 * shapes are pinned here.
 */
describe('every path that mounts a motor spends the mark', () => {
  const bothMotors = async () => {
    const m787 = await exSpec(M787_ENG);
    const o4374 = await exSpec(O4374_ENG);
    return [m787, o4374] as const;
  };
  const attach = (spec: Awaited<ReturnType<typeof exSpec>>) => ({
    designation: spec.designation,
    launchMassKg: spec.masses[0]!,
    lengthM: spec.length,
    cgXFromFrontM: spec.cgX,
  });

  it('corrects every marked stage in one call, and says so once per stage', async () => {
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const [m787, o4374] = await bothMotors();
    const st = stagesOf(r.tree);
    const out = reconcileAllIncludedMotors(r.tree, {
      [mountOf(st[0]!).id!]: attach(m787),
      [mountOf(st[1]!).id!]: attach(o4374),
    }, TEXT);
    expect(out.tree).not.toBe(r.tree);
    expect(out.notes).toHaveLength(2);
    const total = stagesOf(out.tree).reduce((sum, s2) => sum + (s2['overrideMass'] as number), 0);
    // The airframe alone: the file's own 87.05 lb less both motors.
    expect(lb(total + m787.masses[0]! + o4374.masses[0]!)).toBeCloseTo(MESOS_STACK_LB, 3);
    expect(JSON.stringify(out.tree)).not.toContain(OVERRIDE_INCLUDES_MOTOR);
  });

  it('is idempotent — running it again on its own output changes nothing', async () => {
    // This is what makes it safe on the undo path, which re-runs it on every
    // tree that comes off the stack.
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const [m787, o4374] = await bothMotors();
    const st = stagesOf(r.tree);
    const motors = {
      [mountOf(st[0]!).id!]: attach(m787),
      [mountOf(st[1]!).id!]: attach(o4374),
    };
    const once = reconcileAllIncludedMotors(r.tree, motors, TEXT);
    const twice = reconcileAllIncludedMotors(once.tree, motors, TEXT);
    expect(twice.notes).toEqual([]);
    expect(twice.tree).toBe(once.tree);
  });

  it('UNDO: a marked tree coming back off the stack is corrected again', async () => {
    // The defect exactly: load the motor (tree corrected, mark gone), press
    // Ctrl+Z, and the stack hands back the tree as it was — marked, 23.310 lb —
    // while the motor is still mounted. Re-running the reconcile on the
    // restored tree is what App.tsx's `spendSpentMarks` does.
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const [m787] = await bothMotors();
    const mountId = mountOf(stagesOf(r.tree)[0]!).id!;
    const restored = r.tree; // what the history stack still holds
    expect(includedMotorOf(restored, mountId)).toBe('M787');
    const guarded = reconcileAllIncludedMotors(restored, { [mountId]: attach(m787) }, TEXT).tree;
    expect(includedMotorOf(guarded, mountId)).toBeNull();
    expect(lb(stagesOf(guarded)[0]!['overrideMass'] as number))
      .toBeCloseTo(MESOS_SUSTAINER_LB - lb(m787.masses[0]!), 3);
  });

  it('CONFIGURATION SWITCH: a different motor CLEARS the stated weight, it does not subtract', async () => {
    // Applying a flight configuration mounts whatever THAT simulation names,
    // which is often not the motor the marked stage was named after — the file
    // may have eight simulations and only the applied one is read at open.
    // v0.120 subtracted the newcomer from the OTHER simulation's stated weight
    // (PePe2: 47 − 10.22 = 36.78 lb of “airframe” against a true ~13.98, and the
    // mark spent, so no route could put it right). The stated figure belongs to
    // a motor that is not loaded, so it goes (2026-09-08, from review).
    const r = importCdx1(fixture('MESOS_Last_Preflight_File.CDX1'));
    const other = await exSpec([
      '; a catalogued motor the user switched to',
      'M1297W 75 700 200 2.00000 3.50000 AT',
      '  0.01 100.0',
      '  3.0 1400.0',
      '  4.0 0.0',
    ].join('\n'));
    const mountId = mountOf(stagesOf(r.tree)[0]!).id!;
    const out = reconcileAllIncludedMotors(r.tree, { [mountId]: attach(other) }, TEXT);
    expect(out.severity).toBe('warn');
    expect(out.notes[0]).toContain('M1297W');
    expect(out.notes[0]).toContain('M787');
    const st = stagesOf(out.tree)[0]!;
    expect(st['overrideMass']).toBeUndefined();
    expect(st['overrideSubcomponentsMass']).toBeUndefined();
    expect(st['overrideCGX']).toBeUndefined();
    expect(st['overrideSubcomponentsCG']).toBeUndefined();
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
  });

  it('two mounts in one stage: the motor the mark NAMES is the one backed out', async () => {
    // The mark is on the STAGE and the first mount to reach it spends it, so
    // `Object.keys` insertion order decided which motor was subtracted — load
    // them the other way round and the stage weighed something else. Measured
    // at 15.0 kg against a correct 10.5 (2026-09-08, from review).
    const [m787] = await bothMotors();
    const other = { designation: 'K550', launchMassKg: 1.2, lengthM: 0.3, cgXFromFrontM: 0.15 };
    const twoMounts = (): RocketTree => ({
      components: [{
        type: 'stage',
        id: 'st',
        name: 'Sustainer',
        overrideMass: 10.573,
        overrideSubcomponentsMass: true,
        [OVERRIDE_INCLUDES_MOTOR]: 'M787',
        children: [
          { type: 'bodytube', id: 'a', length: 1, outerRadius: 0.04, thickness: 0.002 },
          { type: 'bodytube', id: 'b', length: 1, outerRadius: 0.04, thickness: 0.002 },
        ],
      }],
    } as RocketTree);
    // Both load orders, one answer: the M787 is what comes out, and a K550 that
    // is not the motor the file named cannot spend the mark ahead of it.
    for (const motors of [
      { a: other, b: attach(m787) },
      { b: attach(m787), a: other },
    ]) {
      const out = reconcileAllIncludedMotors(twoMounts(), motors, TEXT);
      expect(out.tree.components[0]!['overrideMass']).toBeCloseTo(10.573 - 6.97171, 6);
      expect(out.severity).toBe('info');
      // The order-dependent number this replaces: 10.573 − 1.2 = 9.373 kg of
      // “airframe”, which flies 15.0 kg with both motors on against 10.5 correct.
      expect(out.tree.components[0]!['overrideMass']).not.toBeCloseTo(10.573 - 1.2, 6);
    }
  });

  it('returns identity for a design with no mark at all', () => {
    const r = importCdx1(fixture('38-54 2-stage.CDX1'));
    const mountId = mountOf(stagesOf(r.tree)[0]!).id!;
    const out = reconcileAllIncludedMotors(r.tree, {
      [mountId]: { designation: 'K627LR', launchMassKg: 1.236, lengthM: 0.4, cgXFromFrontM: 0.2 },
    }, TEXT);
    expect(out.tree).toBe(r.tree);
    expect(out.notes).toEqual([]);
  });
});

describe('a stage that states a CG and no usable weight', () => {
  /**
   * Narrow — no file in the 138-simulation corpus has this shape — but it is
   * the same double count on the stability number instead of the mass, and it
   * used to escape entirely: `unbacked` was gated on the stated WEIGHT, so a
   * CG-only stage got a motor-inclusive `overrideCGX`, no mark, and no
   * correction when the motor was loaded (2026-09-08, from review).
   */
  const cgOnly = (): RocketTree => ({
    components: [{
      type: 'stage',
      id: 'st',
      name: 'Sustainer',
      [OVERRIDE_INCLUDES_MOTOR]: 'M787',
      overrideCGX: 1.2,
      overrideSubcomponentsCG: true,
      children: [{ type: 'bodytube', id: 'bt', length: 2 } as ComponentNode],
    } as ComponentNode],
  } as RocketTree);

  it('clears the CG it cannot back the motor out of, and says why', () => {
    const fix = reconcileIncludedMotor(cgOnly(), 'bt', {
      designation: 'M787', launchMassKg: 6.97171, lengthM: 0.954, cgXFromFrontM: 0.477,
    }, TEXT)!;
    expect(fix.severity).toBe('warn');
    expect(fix.note).toContain('LAUNCH CG');
    const st = fix.tree.components[0]!;
    expect(st['overrideCGX']).toBeUndefined();
    expect(st['overrideSubcomponentsCG']).toBeUndefined();
    expect(st[OVERRIDE_INCLUDES_MOTOR]).toBeUndefined();
  });
});

describe('the motor CG both halves assume', () => {
  /**
   * A PIN ON A COINCIDENCE, not on a shared computation (2026-09-08, from
   * review). The importer's `cgWithoutMotor` places a motor's CG at its
   * geometric MIDPOINT, because a `MOTOR_DB` row publishes no CG;
   * `reconcileIncludedMotor` uses `spec.cgX`. The two agree only because
   * `thrustcurve.ts` synthesises `cgX = length / 2` on BOTH paths. When a
   * source starts supplying a real motor CG — `.rse` files carry one — this
   * test fails, and the fix is to teach `rasaeroFile.cgWithoutMotor` the real
   * CG, not to change the reconcile.
   */
  it('is the geometric midpoint on the catalogue path', async () => {
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes'
      && m.designation === 'C6' && m.length > 0)!;
    const spec = await fetchMotorSpec(c6, 5);
    expect(spec.cgX).toBeCloseTo(spec.length / 2, 9);
  });

  it('is the geometric midpoint on the EX .eng path too', async () => {
    const spec = await exSpec(M787_ENG);
    expect(spec.cgX).toBeCloseTo(spec.length / 2, 9);
  });
});
