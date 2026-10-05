import { describe, expect, it } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { labelWithDelay, withAuto, withDelay, withPlugged } from './mountDelayEdits.js';
import type { MotorMeta } from './simReport.js';
import { exToMotorSpec, parseEng } from './exMotors.js';
import { motorTooltip } from './motorLabels.js';

/**
 * THE MOTOR CARD'S DELAY WRITERS (audit 2026-09-30, item 20). Each rewrites a
 * mount's delay, its Auto flag and its label together, and the label's suffix
 * is read elsewhere — the pad-mass line and the batch note strip it to name the
 * motor. App.render.test.tsx drives the three controls on a real card; these
 * are the rules, one at a time.
 */

const motor = (over: { delay?: number; meta?: Partial<MotorMeta>; label?: string } = {}): MountMotor => ({
  label: over.label ?? 'H220-14',
  spec: { designation: 'H220T', diameter: 0.029, length: 0.194, ejectionDelay: over.delay ?? 14 } as MotorSpec,
  meta: { label: 'H220-14', manufacturer: 'AeroTech', availableDelays: [6, 10, 14, Infinity], ...over.meta },
  ignition: { event: 'automatic', delay: 0 },
  padMassKg: 1.2,
  padMassWeighedWith: 'AeroTech/H220T',
});

/** What every writer rewrites: delay, Auto flag, label. */
const fields = (mm: MountMotor) => [mm.spec.ejectionDelay, mm.meta.autoDelay, mm.label];

describe('labelWithDelay', () => {
  it('rewrites a delay suffix as a whole second, "P" for plugged, or "(auto delay)"', () => {
    expect(labelWithDelay('H220-14', 7)).toBe('H220-7');
    expect(labelWithDelay('H220-14', Infinity)).toBe('H220-P');
    expect(labelWithDelay('H220-14', 'auto')).toBe('H220 (auto delay)');
    expect(labelWithDelay('C6-5', 2.5)).toBe('C6-2.5');
    expect(labelWithDelay('C6-2.5', 3)).toBe('C6-3');
    expect(labelWithDelay('ROS-40-5', 3)).toBe('ROS-40-3');
    expect(labelWithDelay('ROS-40 (auto delay)', 3)).toBe('ROS-40-3');
    expect(labelWithDelay('BB-54-2550 (auto delay)', Infinity)).toBe('BB-54-2550-P');
    expect(labelWithDelay('F115SN-12A', 8)).toBe('F115SN-8');
    expect(labelWithDelay('N1975W-PS', Infinity)).toBe('N1975W-PS');
    expect(labelWithDelay('N1975W-PS (auto delay)', Infinity)).toBe('N1975W-PS');
    expect(labelWithDelay('N1975W-PS', 9)).toBe('N1975W-PS-9');
  });

  it('replaces whichever suffix the label has, never stacking two', () => {
    expect(labelWithDelay('H220 (auto delay)', 14)).toBe('H220-14');
    expect(labelWithDelay('H220-P', 'auto')).toBe('H220 (auto delay)');
    expect(labelWithDelay('H220 (auto delay)', 'auto')).toBe('H220 (auto delay)');
    expect(labelWithDelay('H220', 6)).toBe('H220-6');
  });
});

describe('withDelay — a typed delay', () => {
  it('sets the delay and the label, and turns Auto off', () => {
    expect(fields(withDelay(motor({ meta: { autoDelay: true }, label: 'H220 (auto delay)' }), 10)))
      .toEqual([10, false, 'H220T-10']);
  });

  it('leaves the rest of the record as it was, and the record handed in untouched', () => {
    const before = motor({ meta: { autoDelay: true } });
    const copy = structuredClone(before);
    const after = withDelay(before, 10);
    expect(before).toEqual(copy);
    expect({ ...after, spec: { ...after.spec, ejectionDelay: 14 }, meta: { ...after.meta, autoDelay: true, label: before.meta.label }, label: 'H220-14' })
      .toEqual(copy);
  });
});

describe('withPlugged — the plugged box', () => {
  it('ticked: no ejection charge, labelled "-P", Auto off', () => {
    expect(fields(withPlugged(motor({ meta: { autoDelay: true } }), true))).toEqual([Infinity, false, 'H220T-P']);
  });

  it('unticked: the longest delay the motor is sold with, not the one it had before', () => {
    // Plugged from 6 s; the longest finite delay it lists is 14 s.
    const plugged = withPlugged(motor({ delay: 6, label: 'H220-6' }), true);
    expect(fields(withPlugged(plugged, false))).toEqual([14, false, 'H220T-14']);
  });

  it('unticked on a motor that lists no finite delay: 6 s', () => {
    expect(withPlugged(motor({ delay: Infinity, meta: { availableDelays: [] } }), false).spec.ejectionDelay).toBe(6);
    expect(withPlugged(motor({ delay: Infinity, meta: { availableDelays: [Infinity] } }), false).spec.ejectionDelay)
      .toBe(6);
    expect(withPlugged(motor({ delay: Infinity, meta: { availableDelays: undefined } }), false).spec.ejectionDelay)
      .toBe(6);
  });

  it('turns Auto off unticked as well', () => {
    expect(withPlugged(motor({ meta: { autoDelay: true } }), false).meta.autoDelay).toBe(false);
  });
});

describe('withAuto — the auto box', () => {
  it('on: labelled "(auto delay)", the delay left as it was', () => {
    expect(fields(withAuto(motor(), true))).toEqual([14, true, 'H220T (auto delay)']);
  });

  it('off: labelled with the delay it still has, plugged included', () => {
    expect(fields(withAuto(motor({ meta: { autoDelay: true }, label: 'H220 (auto delay)' }), false)))
      .toEqual([14, false, 'H220T-14']);
    expect(fields(withAuto(motor({ delay: Infinity, meta: { autoDelay: true }, label: 'H220 (auto delay)' }), false)))
      .toEqual([Infinity, false, 'H220T-P']);
  });

  it('leaves the record handed in untouched', () => {
    const before = motor();
    const copy = structuredClone(before);
    withAuto(before, true);
    expect(before).toEqual(copy);
  });
});

it('keeps designation letters through fixed, plugged and automatic delay edits', () => {
  const mm = { ...motor(), spec: { ...motor().spec, designation: 'F115SN-12A' } };
  for (const [next, label] of [
    [withDelay(mm, 8), 'F115SN-8'], [withPlugged(mm, true), 'F115SN-P'],
    [withAuto(mm, true), 'F115SN (auto delay)'],
  ] as const) {
    expect(next.label).toBe(label);
    expect(next.meta.label).toBe(label);
  }
});

it('falls back to the loaded spec when the catalogue id cannot be resolved', () => {
  const mm = motor({ meta: { motorId: 'missing-id' } });
  expect(withDelay(mm, 9).label).toBe('H220T-9');
  expect(withAuto(mm, true).label).toBe('H220T (auto delay)');
  expect(withPlugged(mm, true).label).toBe('H220T-P');
  expect(motorTooltip(mm)).toBe('AeroTech H220T, 14 s delay (H220T-14)');
});

it('keeps the embedded EX file designation through delay edits and the tooltip', () => {
  const ex = parseEng('F67 29 100 9 0.02 0.05 Home\n0 0\n0.5 67\n1 0\n')[0]!;
  const mm = { ...motor(), spec: exToMotorSpec(ex, 9), meta: { label: 'F67-9', exMotorId: ex.motorId } };
  expect(withDelay(mm, 8).label).toBe('F67-8');
  expect(withAuto(mm, true).label).toBe('F67 (auto delay)');
  expect(withPlugged(mm, true).label).toBe('F67-P');
  expect(motorTooltip(mm)).toBe('EX F67, 9 s delay (F67-9)');
});

it('shows an EX file maker without applying catalogue-specific designation cleanup', () => {
  const ex = parseEng('1013J453 29 100 9 0.02 0.05 Cesaroni\n0 0\n0.5 67\n1 0\n')[0]!;
  const mm = { ...motor(), spec: exToMotorSpec(ex, 9),
    meta: { label: '1013J453-9', exMotorId: ex.motorId, manufacturer: 'Cesaroni' } };
  expect(withDelay(mm, 8).label).toBe('1013J453-8');
  expect(motorTooltip(mm)).toBe('Cesaroni 1013J453, 9 s delay (1013J453-9)');
});
