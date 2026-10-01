import { describe, expect, it } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { labelWithDelay, withAuto, withDelay, withPlugged } from './mountDelayEdits.js';
import type { MotorMeta } from './simReport.js';

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
      .toEqual([10, false, 'H220-10']);
  });

  it('leaves the rest of the record as it was, and the record handed in untouched', () => {
    const before = motor({ meta: { autoDelay: true } });
    const copy = structuredClone(before);
    const after = withDelay(before, 10);
    expect(before).toEqual(copy);
    expect({ ...after, spec: { ...after.spec, ejectionDelay: 14 }, meta: { ...after.meta, autoDelay: true }, label: 'H220-14' })
      .toEqual(copy);
  });
});

describe('withPlugged — the plugged box', () => {
  it('ticked: no ejection charge, labelled "-P", Auto off', () => {
    expect(fields(withPlugged(motor({ meta: { autoDelay: true } }), true))).toEqual([Infinity, false, 'H220-P']);
  });

  it('unticked: the longest delay the motor is sold with, not the one it had before', () => {
    // Plugged from 6 s; the longest finite delay it lists is 14 s.
    const plugged = withPlugged(motor({ delay: 6, label: 'H220-6' }), true);
    expect(fields(withPlugged(plugged, false))).toEqual([14, false, 'H220-14']);
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
    expect(fields(withAuto(motor(), true))).toEqual([14, true, 'H220 (auto delay)']);
  });

  it('off: labelled with the delay it still has, plugged included', () => {
    expect(fields(withAuto(motor({ meta: { autoDelay: true }, label: 'H220 (auto delay)' }), false)))
      .toEqual([14, false, 'H220-14']);
    expect(fields(withAuto(motor({ delay: Infinity, meta: { autoDelay: true }, label: 'H220 (auto delay)' }), false)))
      .toEqual([Infinity, false, 'H220-P']);
  });

  it('leaves the record handed in untouched', () => {
    const before = motor();
    const copy = structuredClone(before);
    withAuto(before, true);
    expect(before).toEqual(copy);
  });
});
