import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import type { HardwareMassResult } from './hardwareMass.js';
import {
  reconcileLegacyPadMass, restoredPadMassNote, type LegacyPadMassInput, type PadMassText,
} from './padMassReconcile.js';

/**
 * WHAT BECAME OF A WEIGHED PAD MASS AT RESTORE (audit 2026-09-22, row 501 —
 * extraction #7 of 8 September). Every branch of the decision App's reconcile
 * effect and its note seed made inline, with the sentence each one puts on the
 * notice bar. App.render.test.tsx mounts App on a v0.117 session for the
 * placed and the lighter-than-rocket outcomes; this is the rest.
 */

const TEXT: PadMassText = {
  mass: (kg) => `${Math.round(kg * 1000)} g`,
  // App's baseLabel: the weighing belongs to the motor, not its delay grain.
  motorName: (label) => label.replace(/-(\d+|P)$/, ''),
};

const SPEC = { designation: 'H220' } as MotorSpec;
const motor = (label: string, pad?: { kg: number; key: string }): MountMotor => ({
  label, spec: SPEC, meta: { label }, ignition: { event: 'automatic', delay: 0 },
  ...(pad ? { padMassKg: pad.kg, padMassWeighedWith: pad.key } : {}),
});

/** A booster and a sustainer, each with a named mount. */
const TREE: RocketTree = {
  name: 'Two stage',
  components: [
    { type: 'stage', id: 'sus', name: 'Sustainer', children: [
      { type: 'bodytube', id: 'bt1', children: [{ type: 'innertube', id: 'm-sus', name: 'Sustainer MMT' }] },
    ] },
    { type: 'stage', id: 'boo', name: 'Booster', children: [
      { type: 'bodytube', id: 'bt2', children: [{ type: 'innertube', id: 'm-boo', name: 'Booster MMT' }] },
    ] },
  ] as ComponentNode[],
};

describe('restoredPadMassNote — what the restore already knows', () => {
  it('says a v0.117 pad mass with no motor to belong to was not kept, as a warning', () => {
    expect(restoredPadMassNote({ outcome: 'dropped', kg: 1.25 }, null, { tree: TREE, motors: {}, text: TEXT }))
      .toEqual({
        severity: 'warn',
        text: 'The weighed pad mass you entered before this version (1250 g) had no motor loaded to belong to'
          + ' and was not kept. Weigh the rocket with the motor in and type it under that motor on Motors & Launch.',
      });
  });

  it('says where the core-first ranking moved a weighing, naming both motors and both mounts', () => {
    const motors = { 'm-sus': motor('H220-14'), 'm-boo': motor('J350-P') };
    expect(restoredPadMassNote(null, { from: 'm-boo', to: 'm-sus', kg: 2.5 }, { tree: TREE, motors, text: TEXT }))
      .toEqual({
        severity: 'info',
        text: 'The weighed pad mass (2500 g) now sits under H220 on Sustainer MMT, not under J350 on Booster MMT:'
          + ' the weighed hardware now rides with the core\'s motor ahead of a pod\'s or a strap-on\'s, where it'
          + ' used to ride with whichever was picked first. The value itself is unchanged.',
      });
  });

  it('falls back to plain words for a record or a mount it cannot find', () => {
    const note = restoredPadMassNote(null, { from: 'gone', to: 'also-gone', kg: 1 }, { tree: TREE, motors: {}, text: TEXT });
    expect(note?.text).toContain('now sits under another motor on its mount, not under the motor on its mount:');
  });

  it('puts the dropped value first: nothing moved it anywhere', () => {
    const note = restoredPadMassNote({ outcome: 'dropped', kg: 1 }, { from: 'm-boo', to: 'm-sus', kg: 1 },
      { tree: TREE, motors: {}, text: TEXT });
    expect(note?.severity).toBe('warn');
    expect(note?.text).toContain('had no motor loaded to belong to');
  });

  it('says nothing when the value attached, or nothing moved', () => {
    const ctx = { tree: TREE, motors: {}, text: TEXT };
    expect(restoredPadMassNote({ outcome: 'attached', kg: 1 }, null, ctx)).toBeNull();
    expect(restoredPadMassNote({ outcome: 'none' }, { }, ctx)).toBeNull();
    expect(restoredPadMassNote(null, null, ctx)).toBeNull();
    // A drop with no value to name is not a note.
    expect(restoredPadMassNote({ outcome: 'dropped' }, null, ctx)).toBeNull();
  });
});

describe('reconcileLegacyPadMass — after the first build', () => {
  const legacy = { kg: 2.2, key: 'legacy' };
  const input = (over: Partial<LegacyPadMassInput> = {}): LegacyPadMassInput => ({
    hardware: { state: 'ok' } as HardwareMassResult,
    primaryMountId: 'm-sus',
    filePrimaryMountId: 'm-sus',
    motors: { 'm-sus': motor('H220-14', legacy) },
    unmatchedRefs: {},
    tree: TREE,
    currentSetKey: 'AeroTech/H220',
    text: TEXT,
    ...over,
  });

  it('re-keys an accepted value to the set now loaded, and says where it went', () => {
    expect(reconcileLegacyPadMass(input())).toEqual({
      kind: 'rekey',
      mountId: 'm-sus',
      key: 'AeroTech/H220',
      note: {
        severity: 'info',
        text: 'The weighed pad mass you entered in the Measured mass & CG box (2200 g) now belongs to the motor it'
          + ' was weighed with: it sits under H220 on Motors & Launch, and the line there says what it carries.'
          + ' If that is not the motor you weighed with, clear it and re-weigh.',
      },
    });
  });

  it('keeps a value it cannot check against a motor with no mass curve, and says nothing is carried yet', () => {
    const step = reconcileLegacyPadMass(input({ hardware: { state: 'none', why: 'no-mass-curve' } }));
    expect(step?.kind).toBe('rekey');
    expect(step?.note.text).toMatch(
      / If that is not the motor you weighed with, clear it and re-weigh\. H220 carries no mass curve, so nothing is carried until a motor with one is loaded\.$/);
  });

  it('drops a value lighter than the rocket plus the motor, naming both', () => {
    const step = reconcileLegacyPadMass(input({
      hardware: { state: 'implausible', reason: 'negative' } as HardwareMassResult,
    }));
    expect(step).toEqual({
      kind: 'drop',
      mountId: 'm-sus',
      note: {
        severity: 'warn',
        text: 'The weighed pad mass entered before this version (2200 g) was not kept: it is lighter than the dry'
          + ' rocket plus the catalogue H220, so it was weighed with a different motor. Re-weigh with this motor'
          + ' in and type it under it on Motors & Launch.',
      },
    });
  });

  it('drops a value that would carry more hardware than the airframe', () => {
    const step = reconcileLegacyPadMass(input({
      hardware: { state: 'implausible', reason: 'heavier-than-airframe' } as HardwareMassResult,
    }));
    expect(step?.kind).toBe('drop');
    expect(step?.note).toEqual({
      severity: 'warn',
      text: 'The weighed pad mass entered before this version (2200 g) was not kept: against the catalogue H220 it'
        + ' would carry more hardware than the airframe itself. Re-weigh with this motor in and type it under it'
        + ' on Motors & Launch.',
    });
  });

  /**
   * The file's own primary could not be loaded, so the field is withheld on
   * that card and the export keeps the reference's slot: a value placed on the
   * booster would be flown, invisible, and absent from the saved file.
   */
  it('drops a value whose file-primary motor is not loaded — WHATEVER the arithmetic said — naming it', () => {
    const step = reconcileLegacyPadMass(input({
      primaryMountId: 'm-boo',
      filePrimaryMountId: 'm-sus',
      motors: { 'm-boo': motor('J350-P', legacy) },
      unmatchedRefs: { 'm-sus': { designation: 'K550W', manufacturer: 'AeroTech' } as never },
    }));
    expect(step).toEqual({
      kind: 'drop',
      mountId: 'm-boo',
      note: {
        severity: 'warn',
        text: 'The weighed pad mass you entered before this version (2200 g) could not be placed: the motor the file'
          + ' names on Sustainer MMT (K550W) is not loaded, so the app cannot tell which motors it was weighed with.'
          + ' Load that motor, or re-weigh with the motors you have in and type it under the top motor on Motors'
          + ' & Launch.',
      },
    });
  });

  it('names what it can when the file\'s primary is gone or unnamed', () => {
    const gone = reconcileLegacyPadMass(input({
      primaryMountId: 'm-boo', filePrimaryMountId: null, motors: { 'm-boo': motor('J350-P', legacy) },
    }));
    expect(gone?.note.text).toContain('the motor the file names on a removed mount (unknown) is not loaded');
  });

  it('waits — returns nothing — until there is a verdict to act on', () => {
    // No build yet, or no primary.
    expect(reconcileLegacyPadMass(input({ hardware: null }))).toBeNull();
    expect(reconcileLegacyPadMass(input({ primaryMountId: null }))).toBeNull();
    // The kernel refused the primary's curve: the next build that accepts one decides.
    expect(reconcileLegacyPadMass(input({ hardware: { state: 'none', why: 'no-motor' } }))).toBeNull();
    expect(reconcileLegacyPadMass(input({ hardware: { state: 'stale-set', changes: [] } }))).toBeNull();
  });

  it('leaves every value that is not a legacy one alone', () => {
    expect(reconcileLegacyPadMass(input({ motors: { 'm-sus': motor('H220-14', { kg: 2.2, key: 'AeroTech/H220' }) } })))
      .toBeNull();
    expect(reconcileLegacyPadMass(input({ motors: { 'm-sus': motor('H220-14') } }))).toBeNull();
    expect(reconcileLegacyPadMass(input({ motors: {} }))).toBeNull();
  });
});
