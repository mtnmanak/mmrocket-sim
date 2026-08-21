import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { buildSimRun } from './simReport.js';
import { runsToCsv } from './simStore.js';
import { formatWarning } from './simWarnings.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';

/**
 * Simulation warnings and landing drift, end-to-end through the REAL kernel
 * (TeaVM artifact): the engine must emit the warning/series, and simReport
 * must surface them into the SimRun the report and CSV render.
 */

const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};

/** The reference test rocket, with or without its parachute. */
const tree = (withChute: boolean): RocketTree => ({
  name: withChute ? 'Chuted' : 'Ballistic',
  components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' } as ComponentNode,
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        ...(withChute ? [{ type: 'parachute', diameter: 0.3 } as ComponentNode] : []),
      ],
    } as ComponentNode,
  ],
});

describe('kernel warnings + drift, end-to-end', () => {
  it('a recovery-device-less rocket surfaces NO_RECOVERY_DEVICE into the SimRun', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const rocket = OrkRocket.buildTree(tree(false));
    rocket.setMotorById('mount', C6);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    const w = (result.warnings ?? []).find((x) => x.key === 'NO_RECOVERY_DEVICE');
    expect(w, 'engine must emit the NO_RECOVERY_DEVICE warning').toBeTruthy();
    expect(w!.priority).toBe('HIGH');

    const run = buildSimRun({
      result, info: rocket.staticInfo(), motor: C6, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Ballistic', execMs: 1,
    });
    expect(run.simWarnings?.some((x) => x.key === 'NO_RECOVERY_DEVICE')).toBe(true);
    expect(formatWarning(run.simWarnings!.find((x) => x.key === 'NO_RECOVERY_DEVICE')!).high).toBe(true);
    // …and it reaches the run-table CSV's Sim warnings column.
    expect(runsToCsv([run])).toContain('NO_RECOVERY_DEVICE');
  }, 30000);

  it('wind > 0 → real downwind drift; wind = 0 → drift ≈ 0', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();

    const fly = (windAverage: number) => {
      const rocket = OrkRocket.buildTree(tree(true));
      rocket.setMotorById('mount', C6);
      const result = rocket.simulate({
        launchRodLength: 1.0, timeStep: 0.05, windAverage, randomSeed: 42,
      });
      return buildSimRun({
        result, info: rocket.staticInfo(), motor: C6, meta: { label: 'C6-5' },
        launch: { ...DEFAULT_CONDITIONS, windAverage }, rocketName: 'Chuted', execMs: 1,
      });
    };

    const calm = fly(0);
    const windy = fly(4);

    // Calm + straight-up rod: essentially no lateral travel.
    expect(calm.landingDistanceM).not.toBeNull();
    expect(calm.landingDistanceM!).toBeLessThan(2);

    // 4 m/s wind for a minute-plus under canopy: tens of meters, downwind.
    // The kernel's wind is a fixed EAST wind (PinkNoiseWindModel direction
    // π/2, meteorological "from"; the stepper ADDS the vector to rocket
    // velocity) — so downwind is compass 270° and the rocket lands west.
    expect(windy.landingDistanceM!).toBeGreaterThan(20);
    expect(windy.landingDistanceM!).toBeGreaterThan(calm.landingDistanceM! * 10);
    expect(windy.landingBearingDeg!).toBeGreaterThan(210);
    expect(windy.landingBearingDeg!).toBeLessThan(330);
  }, 30000);
});
