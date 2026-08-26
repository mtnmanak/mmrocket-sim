import { describe, expect, it } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { machProbeSeconds } from './machProbe.js';

/** A motor that burns for `burn` seconds and carries a 5 s ejection delay. */
const motor = (burn: number): MotorSpec => ({
  designation: `X${burn}`, diameter: 0.029, length: 0.2,
  times: [0, burn / 2, burn], thrusts: [0, 100, 0], masses: [0.1, 0.05, 0.02],
  cgX: 0.1, ejectionDelay: 5,
});

describe('machProbeSeconds', () => {
  it('floors at 10 s — short motors still need a run long enough to see peak Mach', () => {
    expect(machProbeSeconds([{ spec: motor(1.6) }])).toBe(10);
  });

  it('covers a long burn plus the coast that follows thrust tail-off', () => {
    expect(machProbeSeconds([{ spec: motor(9) }])).toBe(12);
  });

  it('waits for a motor that ignites on a timer, not just for its burn', () => {
    expect(machProbeSeconds([{ spec: motor(4), ignition: { event: 'launch', delay: 20 } }]))
      .toBe(27);
  });

  it('takes the LATEST finisher when several motors fire off the clock', () => {
    const onPad = (burn: number) => ({
      spec: motor(burn), onLaunchStage: true,
      ignition: { event: 'automatic' as const, delay: 0 },
    });
    expect(machProbeSeconds([onPad(2), onPad(30)])).toBe(33);
  });

  // The bound that keeps a staged supersonic flight from being flown on the
  // classic model: if the probe ends before the sustainer lights, Auto sees
  // only the booster's Mach and picks the wrong aero model, silently.
  it('bounds a burnout-triggered sustainer by the whole stack, ejection delays included', () => {
    const booster = {
      spec: motor(6), onLaunchStage: true, ignition: { event: 'automatic' as const, delay: 0 },
    };
    const sustainer = { spec: motor(8), ignition: { event: 'burnout' as const, delay: 2 } };
    // chain bound = (6 burn + 5 ejection) + (8 + 5) = 24; sustainer lights by
    // 2 + 24 = 26 and finishes by 34; +3 s of post-burn acceleration.
    expect(machProbeSeconds([booster, sustainer])).toBe(37);
  });

  // The kernel's AUTOMATIC means LAUNCH only on the launch stage; anywhere
  // above it means the ejection charge of the stage below. Treating it as
  // clock-relative collapsed the cutoff to the 10 s floor on staged designs.
  it('treats AUTOMATIC on an upper stage as a chained ignition, not a launch one', () => {
    const booster = { spec: motor(4), onLaunchStage: true };
    const upper = { spec: motor(3), onLaunchStage: false };
    const chained = machProbeSeconds([booster, upper]);
    // chain bound = (4+5) + (3+5) = 17; upper finishes by 17 + 3 = 20.
    expect(chained).toBe(23);
    // …and it must be strictly longer than if both had been read as launch-clock.
    expect(chained).toBeGreaterThan(machProbeSeconds([
      { ...booster, ignition: { event: 'launch', delay: 0 } },
      { ...upper, ignition: { event: 'launch', delay: 0 } },
    ]));
  });

  it('is conservative when stage position is unknown and more than one motor is aboard', () => {
    // No onLaunchStage flags: assume the worst (chained), because reading a
    // chained sustainer as clock-relative is the silent-wrong-answer direction.
    expect(machProbeSeconds([{ spec: motor(2) }, { spec: motor(30) }])).toBeGreaterThan(33);
  });

  it('does not chain off a plugged motor — it fires no ejection charge', () => {
    const plugged = { spec: { ...motor(4), ejectionDelay: Infinity }, onLaunchStage: true };
    expect(Number.isFinite(machProbeSeconds([plugged]))).toBe(true);
    expect(machProbeSeconds([plugged])).toBe(10);
  });

  it('survives a motor with no thrust samples rather than returning NaN', () => {
    const empty: MotorSpec = { ...motor(1), times: [], thrusts: [], masses: [] };
    expect(machProbeSeconds([{ spec: empty }])).toBe(10);
  });
});
