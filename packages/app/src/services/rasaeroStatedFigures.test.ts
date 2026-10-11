// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { exportCdx1, importCdx1, importCdx1Flown } from './rasaeroFile.js';
import { findDbMotor, MOTOR_DB, type MotorDbEntry } from './motorDb.js';
import {
  reconcileAllIncludedMotors, reconcileIncludedMotor, STATED_STAGE_FIGURES, statedFiguresOf, type AttachedMotor,
} from './statedLaunchWeight.js';
import { captureStageMass } from './stageMassOverrides.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import { simulateFile } from './simulateFile.js';

/**
 * A RASAero file's stated launch weight, with the motor backed out by what the
 * flight really loads (board Tier 0 row 81, ruled exact 2026-10-11), and
 * backed out again when that motor is loaded with other figures (board Tier 2,
 * "re-picking a motor on a RASAero design that states its CG keeps the stage
 * CG override worked out for the old motor").
 */

const LB = 2.20462262; // rasaeroFile.ts's own pounds per kilogram
const IN = 39.37;
const TEXT = { mass: (kg: number) => `${kg.toFixed(4)} kg`, length: (m: number) => `${m.toFixed(4)} m` };

beforeEach(() => { localStorage.clear(); });

/** A one-stage design flying `designation` (AeroTech), written to .CDX1 stating `massKg` and `cgM`. */
function statedFile(designation: string, radius: number, tubeM: number, massKg: number, cgM: number): string {
  return exportCdx1({
    name: 'Stated',
    tree: {
      name: 'Stated',
      components: [{
        type: 'stage', id: 's0', name: 'Sustainer',
        children: [
          { type: 'nosecone', id: 'n', length: 0.25, aftRadius: radius, thickness: 0.002, shape: 'ogive', shapeParameter: 1 },
          {
            type: 'bodytube', id: 'b', length: tubeM, outerRadius: radius, thickness: 0.001,
            children: [{
              type: 'trapezoidfinset', id: 'f', finCount: 4, rootChord: 0.15, tipChord: 0.07,
              sweep: 0.05, height: 0.11, thickness: 0.004, position: { method: 'bottom', offset: 0 },
            }],
          },
        ],
      }],
    },
    launchMassKg: massKg,
    launchCgM: cgM,
    motors: { b: { designation, manufacturer: 'AeroTech' } },
    engineExport: true,
  });
}

/** The figures as the file states them, read back out of its cells. */
const statedOf = (xml: string) => ({
  massKg: Number(/<SustainerLaunchWt>([^<]*)</.exec(xml)![1]) / LB,
  cgM: Number(/<SustainerCG>([^<]*)</.exec(xml)![1]) / IN,
});

const attached = (spec: MotorSpec): AttachedMotor => ({
  designation: spec.designation, launchMassKg: spec.masses[0]!, lengthM: spec.length, cgXFromFrontM: spec.cgX,
});

async function weigh(tree: RocketTree, mountId: string, spec: MotorSpec) {
  const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
  const { engineTree } = await import('../tree/treeModel.js');
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(tree));
  rocket.setMotorById(mountId, spec);
  return rocket.staticInfo();
}

const mountIdOf = (r: { motors: Record<string, unknown> }) => Object.keys(r.motors)[0]!;
const stage0 = (t: RocketTree) => t.components[0]! as ComponentNode & Record<string, unknown>;

describe('the stated launch weight is backed out with the curve file the flight loads (Tier 0 row 81)', () => {
  const g12 = () => findDbMotor('G12ST', undefined, undefined, 'AeroTech')!;

  it('the premise: the G12ST catalogue row and its curve files disagree on loaded mass', async () => {
    const row = g12();
    const spec = await bundledOnlyFetchSpec(row, 0);
    // 150.3 g catalogued, 150.0 g in the curve files the flight picks.
    expect(Math.abs(spec.masses[0]! - row.totalWeightG / 1000)).toBeGreaterThan(1e-4);
  }, 30_000);

  it('flies the file’s stated weight and CG exactly, where the catalogue’s mass flew 0.3 g light', async () => {
    const xml = statedFile('G12ST', 0.0145, 0.6, 0.51 / LB, 0.55);
    const stated = statedOf(xml);
    const spec = await bundledOnlyFetchSpec(g12(), 0);

    const exact = await importCdx1Flown(xml, { flownSpec: bundledOnlyFetchSpec });
    const flown = await weigh(exact.tree, mountIdOf(exact), spec);
    expect(flown.mass).toBeCloseTo(stated.massKg, 9);
    expect(flown.cg).toBeCloseTo(stated.cgM, 9);
    expect(exact.notes.join(' ')).not.toContain('could not be loaded during the import');

    // The catalogue's mass, as the import alone backs it out: off by the 0.3 g.
    const old = importCdx1(xml);
    const before = await weigh(old.tree, mountIdOf(old), spec);
    expect(Math.abs(before.mass - stated.massKg)).toBeGreaterThan(1e-4);
  }, 30_000);

  it('the headless open flies it too: the file door hands its own curve load to the import', async () => {
    const xml = statedFile('G12ST', 0.0145, 0.6, 0.51 / LB, 0.55);
    const stated = statedOf(xml);
    const out = await simulateFile(new TextEncoder().encode(xml), 'g12.CDX1', { presets: [] });
    expect(out.build.info.mass).toBeCloseTo(stated.massKg, 9);
    expect(out.build.info.cg).toBeCloseTo(stated.cgM, 9);
    // At the import, not after it: a motor mounted with other figures than the
    // import backed out would be put right on mounting, with a note of its own.
    expect(out.importNote.text).toContain('Applied from simulation 1');
    expect(out.importNote.text).not.toContain('backed out again');
  }, 60_000);

  it('a curve that cannot load falls back to the catalogue’s mass and says so', async () => {
    const xml = statedFile('G12ST', 0.0145, 0.6, 0.51 / LB, 0.55);
    const offline = await importCdx1Flown(xml, { flownSpec: async () => { throw new TypeError('Failed to fetch'); } });
    const plain = importCdx1(xml);
    expect(stage0(offline.tree)['overrideMass']).toBe(stage0(plain.tree)['overrideMass']);
    expect(stage0(offline.tree)['overrideCGX']).toBe(stage0(plain.tree)['overrideCGX']);
    expect(offline.notes.join(' ')).toMatch(/The thrust curve for G12ST \(0\.331 lb\) could not be loaded during the import/);
    // Never asked (no flownSpec) is not a failure, and says nothing.
    expect(plain.notes.join(' ')).not.toContain('could not be loaded during the import');
  }, 30_000);

  it('the curve is loaded once per catalogue row, through the caller’s own curve load', async () => {
    const xml = statedFile('G12ST', 0.0145, 0.6, 0.51 / LB, 0.55);
    const asked: string[] = [];
    await importCdx1Flown(xml, { flownSpec: (row, delay) => { asked.push(row.motorId); return bundledOnlyFetchSpec(row, delay); } });
    expect(asked).toEqual([g12().motorId]);
  }, 30_000);
});

describe('re-picking the motor backs it out again, as re-opening the file does (board Tier 2)', () => {
  /**
   * THE K62N CASE. v0.148 corrected the K62N's length from 274 to 374.25 mm. A
   * RASAero design stating its CG, opened before that, holds a stage CG
   * override worked out for a 274 mm motor; picking the motor again loaded the
   * 374.25 mm one under it, and the margin read more than the file states
   * until the file was opened again. No corpus file flies a K62N (v0.148's
   * notes say so too), so the design is written here.
   */
  const current = () => findDbMotor('K62N', undefined, undefined, 'AeroTech')!;
  const before148 = (): MotorDbEntry[] => MOTOR_DB.map((m) => (m.motorId === current().motorId ? { ...m, length: 274 } : m));
  const k62nFile = () => statedFile('K62N', 0.033, 1.2, 3.5, 0.95);

  it('a re-pick lands on the overrides a re-open writes, and the rocket weighs and balances as the file states', async () => {
    const xml = k62nFile();
    const stated = statedOf(xml);
    const spec = await bundledOnlyFetchSpec(current(), 0);
    expect(spec.length).toBeCloseTo(0.37425, 9);

    const stale = importCdx1(xml, { catalogue: before148() });
    const mountId = mountIdOf(stale);
    const fix = reconcileIncludedMotor(stale.tree, mountId, attached(spec), TEXT)!;
    expect(fix).not.toBeNull();
    expect(fix.severity).toBe('info');
    expect(fix.note).toMatch(/“K62N” loaded now weighs .* and is 0\.3743 m long, so it has been backed out again, as opening the file again would do — .*its CG override/);

    const reopened = await importCdx1Flown(xml, { flownSpec: bundledOnlyFetchSpec });
    const a = stage0(fix.tree);
    const b = stage0(reopened.tree);
    expect(a['overrideMass'] as number).toBeCloseTo(b['overrideMass'] as number, 12);
    expect(a['overrideCGX'] as number).toBeCloseTo(b['overrideCGX'] as number, 12);

    const restated = await weigh(fix.tree, mountId, spec);
    expect(restated.mass).toBeCloseTo(stated.massKg, 9);
    expect(restated.cg).toBeCloseTo(stated.cgM, 9);
    // The stale override under the 374.25 mm motor: the CG sits forward of the
    // file's, so the margin reads more than the file states.
    const kept = await weigh(stale.tree, mountId, spec);
    expect(kept.cg).toBeLessThan(stated.cgM - 0.01);
    expect(kept.stabilityCalibers).toBeGreaterThan(restated.stabilityCalibers + 0.1);
  }, 30_000);

  it('runs on every route that mounts a motor (configuration switch, open, undo), and once', async () => {
    const xml = k62nFile();
    const spec = await bundledOnlyFetchSpec(current(), 0);
    const stale = importCdx1(xml, { catalogue: before148() });
    const mountId = mountIdOf(stale);
    const all = reconcileAllIncludedMotors(stale.tree, { [mountId]: attached(spec) }, TEXT);
    expect(all.notes).toHaveLength(1);
    // Done: the same motor again changes nothing and says nothing.
    const again = reconcileAllIncludedMotors(all.tree, { [mountId]: attached(spec) }, TEXT);
    expect(again.tree).toBe(all.tree);
    expect(again.notes).toEqual([]);
  }, 30_000);

  it('another motor leaves the airframe figure alone, as a re-open would', async () => {
    const xml = k62nFile();
    const stale = importCdx1(xml, { catalogue: before148() });
    const mountId = mountIdOf(stale);
    const other = { designation: 'K185W', launchMassKg: 0.9, lengthM: 0.3, cgXFromFrontM: 0.15 };
    expect(reconcileIncludedMotor(stale.tree, mountId, other, TEXT)).toBeNull();
  }, 30_000);

  it('two mounts in the stage: only the mount the figures were worked out for restates them', async () => {
    const xml = k62nFile();
    const spec = await bundledOnlyFetchSpec(current(), 0);
    const stale = importCdx1(xml, { catalogue: before148() });
    const mountId = mountIdOf(stale);
    expect(statedFiguresOf(stage0(stale.tree))!.mountId).toBe(mountId);
    // A second body tube the user added to the stage, loaded with the same motor.
    const kids = stage0(stale.tree).children!;
    const aft = kids.findIndex((c) => c.id === mountId);
    const second: ComponentNode = { ...kids[aft]!, id: 'second-mount', children: [] };
    const withSecond = (at: number): RocketTree => ({
      ...stale.tree,
      components: [{ ...stage0(stale.tree), children: [...kids.slice(0, at), second, ...kids.slice(at)] }],
    });
    // Ahead of the import's mount, and aft of it (where it is the stage's aft-most tube).
    for (const tree of [withSecond(aft), withSecond(aft + 1)]) {
      expect(reconcileIncludedMotor(tree, 'second-mount', attached(spec), TEXT)).toBeNull();
      const all = reconcileAllIncludedMotors(tree, { 'second-mount': attached(spec) }, TEXT);
      expect(all.tree).toBe(tree);
      expect(all.notes).toEqual([]);
      // The import's own mount still restates them, once.
      const both = reconcileAllIncludedMotors(tree, { 'second-mount': attached(spec), [mountId]: attached(spec) }, TEXT);
      expect(both.notes).toHaveLength(1);
      expect(statedFiguresOf(stage0(both.tree))!.mountId).toBe(mountId);
    }
    // A record kept without its mount restates only for the stage's aft-most body tube.
    const { mountId: _m, ...unmounted } = statedFiguresOf(stage0(stale.tree))!;
    const legacy = (tree: RocketTree): RocketTree => ({
      ...tree, components: [{ ...stage0(tree), [STATED_STAGE_FIGURES]: unmounted }],
    });
    expect(reconcileIncludedMotor(legacy(withSecond(aft)), 'second-mount', attached(spec), TEXT)).toBeNull();
    expect(reconcileIncludedMotor(legacy(withSecond(aft)), mountId, attached(spec), TEXT)).not.toBeNull();
    expect(reconcileIncludedMotor(legacy(withSecond(aft + 1)), mountId, attached(spec), TEXT)).toBeNull();
  }, 30_000);

  it('overrides typed since are the user’s: the record goes, quietly, and nothing else moves', async () => {
    const xml = k62nFile();
    const spec = await bundledOnlyFetchSpec(current(), 0);
    const stale = importCdx1(xml, { catalogue: before148() });
    const mountId = mountIdOf(stale);
    const typed = { ...stale.tree, components: [{ ...stage0(stale.tree), overrideMass: 2.0 }] };
    const fix = reconcileIncludedMotor(typed, mountId, attached(spec), TEXT)!;
    expect(fix.note).toBeNull();
    expect(stage0(fix.tree)['overrideMass']).toBe(2.0);
    expect(stage0(fix.tree)['overrideCGX']).toBe(stage0(stale.tree)['overrideCGX']);
    expect(stage0(fix.tree)[STATED_STAGE_FIGURES]).toBeUndefined();
    // And a configuration snapshot of a typed stage does not carry it either.
    expect(captureStageMass(stage0(typed)).statedStageFigures).toBeUndefined();
    expect(captureStageMass(stage0(stale.tree)).statedStageFigures).toBeDefined();
  }, 30_000);

  it('a back-out that no longer leaves the CG inside the stage clears the CG override, with a warning', () => {
    const xml = k62nFile();
    const stale = importCdx1(xml);
    const mountId = mountIdOf(stale);
    const rec = statedFiguresOf(stage0(stale.tree))!;
    expect(rec.motor).toBe('K62N');
    // A motor of the same name so heavy that the stage's own CG lands ahead of its nose.
    const fix = reconcileIncludedMotor(stale.tree, mountId,
      { designation: 'K62N', launchMassKg: rec.launchKg! * 0.97, lengthM: 0.37425, cgXFromFrontM: 0.187 }, TEXT)!;
    expect(fix.severity).toBe('warn');
    expect(stage0(fix.tree)['overrideCGX']).toBeUndefined();
    expect(stage0(fix.tree)['overrideMass']).toBeCloseTo(rec.launchKg! * 0.03, 9);
    expect(fix.note).toMatch(/no longer leaves a CG inside the stage, so the stage’s CG override has been cleared/);
  });

  it('a weight the motor now fills completely clears both overrides, with a warning', () => {
    const xml = k62nFile();
    const stale = importCdx1(xml);
    const mountId = mountIdOf(stale);
    const rec = statedFiguresOf(stage0(stale.tree))!;
    const fix = reconcileIncludedMotor(stale.tree, mountId,
      { designation: 'K62N', launchMassKg: rec.launchKg! + 0.1, lengthM: 0.37425, cgXFromFrontM: 0.187 }, TEXT)!;
    expect(fix.severity).toBe('warn');
    expect(stage0(fix.tree)['overrideMass']).toBeUndefined();
    expect(stage0(fix.tree)['overrideCGX']).toBeUndefined();
    expect(stage0(fix.tree)[STATED_STAGE_FIGURES]).toBeUndefined();
    expect(fix.note).toMatch(/mass or CG inside the stage, so the stage’s mass and CG overrides have been cleared/);
  });
});
