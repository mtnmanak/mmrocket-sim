// @vitest-environment happy-dom
/**
 * LEM-IV input sweep — a MEASUREMENT DRIVER, not a test.
 *
 * It lives here rather than in a scratch directory because rebuilding it cost
 * a sitting once already: the 2026-08-29 re-fly was driven by a hand-written
 * esbuild bundle with happy-dom shims, which went away with the session, and
 * the next question about the same flight had to rebuild it from a recipe in a
 * handoff. Run as a vitest file it needs no bundling at all — the environment
 * comment supplies `DOMParser` and the app's own module graph supplies the
 * importer, the .eng parser and the tree translator.
 *
 * It is inert in CI and in `npm test`, twice over:
 *   - it skips unless LEMIV=1 is set;
 *   - it skips if the design file is missing, and it always is on CI —
 *     `docs/User files/` is local-only (gitignored).
 *
 *   cd packages/app && LEMIV=1 npx vitest run src/services/lemivSweep.test.ts
 *
 * What it answers, and the numbers it produced on 2026-08-29 (v0.078 kernel):
 * `validation/scorecard-lemiv-inputsweep-2026-08-29.md`. In one line — a burn
 * 10-20 % shorter than the published curve explains the peak-acceleration
 * deficit exactly, no mass error explains the apogee (it would take a 27-40 %
 * heavier airframe, which then breaks the acceleration again), and a +6.2 %
 * (Kbf) / +2.4 % (Supersonic) apogee residual survives both.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type MotorSpec } from '@online-openrocket/engine';
import { importOrk } from './orkFile.js';
import { parseEng } from './exMotors.js';
import { samplesToMotorSpec, type TcMotor } from './thrustcurve.js';
import { engineTree } from '../tree/treeModel.js';

/**
 * Local-only inputs (docs/ is gitignored — see CLAUDE.md "Two machines").
 * Found by walking up from the working directory rather than from
 * `import.meta.url`: under the happy-dom environment Vite hands this module a
 * served `/@fs/` URL, so a URL-relative path silently resolves to nothing.
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
const local = (rel: string) => join(repoRoot(), 'docs', 'User files', rel);
const ORK = local('LEM-IV.ork');
const ENG = local(join('TRF RASAero Files', 'rasp.eng'));
/** The M1500G flight configuration — NOT the file's default (an HP-K535W). */
const CONFIG = '91154772-767b-49ec-aefd-9bc1607a57f3';

const FT = 1 / 0.3048;
/** As flown and recorded. */
const MEASURED_APOGEE_FT = 11755;
const MEASURED_ACCEL_FT: readonly [number, number] = [598, 685];

const ENABLED = process.env['LEMIV'] === '1' && existsSync(ORK) && existsSync(ENG);

/**
 * Imported ONCE per process. The editor node ids the importer hands out come
 * from a module-level counter, so a second parse of the same file numbers the
 * same components differently — and the mount id captured from the first parse
 * then names something that is not a mount.
 */
let cached: ReturnType<typeof importOrk> | null = null;
function loadOrk() {
  if (cached) return cached;
  const buf = readFileSync(ORK);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  cached = importOrk(ab, { configId: CONFIG });
  return cached;
}

/** The mount this configuration's motor is on, from the import itself. */
function mountId(): string {
  const id = Object.keys(loadOrk().motors)[0];
  if (!id) throw new Error('no motor mount in the chosen configuration');
  return id;
}

/** The reload as published, from the local RASP file. */
function m1500g(): MotorSpec {
  const ex = parseEng(readFileSync(ENG, 'utf8')).find((m) => m.designation === 'M1500G');
  if (!ex) throw new Error('M1500G not found in rasp.eng');
  const tc = {
    motorId: ex.motorId, manufacturerAbbrev: 'AT', designation: ex.designation,
    commonName: ex.designation, impulseClass: 'M', diameter: ex.diameter, length: ex.length,
    avgThrustN: 1500, maxThrustN: 0, totImpulseNs: 0, burnTimeS: 0,
    totalWeightG: ex.totalWeightG, propWeightG: ex.propWeightG, availability: 'OOP',
  } as unknown as TcMotor;
  return samplesToMotorSpec(tc, ex.samples, Infinity);
}

/**
 * `times × s`, `thrusts ÷ s` — the same propellant burning s times as long.
 * Total impulse is conserved exactly, so this is a pure curve-SHAPE hypothesis
 * and cannot be confused with "the motor was underrated".
 */
const timeScaled = (spec: MotorSpec, s: number): MotorSpec =>
  ({ ...spec, times: spec.times.map((t) => t * s), thrusts: spec.thrusts.map((f) => f / s) });

/** Every structural mass × f; the motor is untouched. */
function massScaled(tree: unknown, f: number): unknown {
  const walk = (n: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...n };
    for (const k of ['overrideMass', 'mass']) {
      if (typeof out[k] === 'number') out[k] = (out[k] as number) * f;
    }
    if (Array.isArray(out['children'])) {
      out['children'] = (out['children'] as Record<string, unknown>[]).map(walk);
    }
    return out;
  };
  const t = tree as { components: Record<string, unknown>[] };
  return { ...t, components: t.components.map(walk) };
}

interface Shot { apogeeFt: number; accelFt: number; maxMach: number }

function fly(tree: unknown, motor: MotorSpec, launch: Record<string, unknown>, supersonic: boolean): Shot {
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(tree as never));
  rocket.setRogersModifiedBarrowman(true);
  rocket.setSupersonicAero(supersonic);
  rocket.setMotorById(mountId(), motor);
  const r = rocket.simulate({
    launchRodLength: launch['launchRodLengthM'] as number,
    launchRodAngle: ((launch['launchRodAngleDeg'] as number) * Math.PI) / 180,
    windAverage: launch['windAverage'] as number,
    windStdDeviation: launch['windStdDev'] as number,
    launchAltitude: launch['launchAltitudeM'] as number,
    launchLatitude: launch['latitudeDeg'] as number,
    timeStep: launch['timeStepS'] as number,
  });
  return {
    apogeeFt: r.summary.maxAltitude * FT,
    accelFt: r.summary.maxAcceleration * FT,
    maxMach: r.summary.maxMachNumber,
  };
}

const mid = (MEASURED_ACCEL_FT[0] + MEASURED_ACCEL_FT[1]) / 2;
const row = (label: string, s: Shot) =>
  `${label.padEnd(28)} apogee ${s.apogeeFt.toFixed(0).padStart(6)} ft `
  + `(${((s.apogeeFt / MEASURED_APOGEE_FT - 1) * 100).toFixed(1).padStart(5)} %)   `
  + `peak a ${s.accelFt.toFixed(0).padStart(5)} ft/s2 `
  + `(${((s.accelFt / mid - 1) * 100).toFixed(1).padStart(6)} %)   Mmax ${s.maxMach.toFixed(2)}`;

describe.skipIf(!ENABLED)('LEM-IV input sweep', () => {
  it('sweeps burn rate and structural mass against both observables', () => {
    const imp = loadOrk();
    const launch = imp.launch as unknown as Record<string, unknown>;
    const base = m1500g();
    const out = [
      `measured: apogee ${MEASURED_APOGEE_FT} ft, peak a ${MEASURED_ACCEL_FT[0]}-${MEASURED_ACCEL_FT[1]} ft/s2`,
      '',
      row('baseline (published, Kbf)', fly(imp.tree, base, launch, false)),
      '',
      '-- burn compressed, SAME total impulse (a hotter, shorter reload) --',
      ...[0.9, 0.85, 0.8, 0.7, 0.6, 0.5].map((s) =>
        row(`  burn x${s.toFixed(2)}`, fly(imp.tree, timeScaled(base, s), launch, false))),
      '',
      '-- structural mass scaled, published curve --',
      ...[0.9, 0.95, 1.05, 1.1, 1.2].map((f) =>
        row(`  mass x${f.toFixed(2)}`, fly(massScaled(imp.tree, f), base, launch, false))),
    ];
    // eslint-disable-next-line no-console
    console.log(`\n${out.join('\n')}\n`);
    expect(out.length).toBeGreaterThan(5);
  }, 180_000);

  it('solves for the structural mass that lands the measured apogee, and prices it', () => {
    const imp = loadOrk();
    const launch = imp.launch as unknown as Record<string, unknown>;
    const base = m1500g();
    const cases: [string, MotorSpec, boolean][] = [
      ['published curve, Kbf', base, false],
      ['burn x0.85, Kbf', timeScaled(base, 0.85), false],
      ['published curve, Supersonic', base, true],
      ['burn x0.85, Supersonic', timeScaled(base, 0.85), true],
    ];
    const out: string[] = [];
    for (const [label, motor, sup] of cases) {
      const plain = fly(imp.tree, motor, launch, sup);
      let lo = 1.0;
      let hi = 3.0;
      let shot = plain;
      for (let i = 0; i < 18; i++) {
        const f = (lo + hi) / 2;
        shot = fly(massScaled(imp.tree, f), motor, launch, sup);
        if (shot.apogeeFt > MEASURED_APOGEE_FT) lo = f; else hi = f;
      }
      out.push(
        `${label.padEnd(28)} as modelled ${plain.apogeeFt.toFixed(0)} ft / ${plain.accelFt.toFixed(0)} ft/s2`
        + `  ->  structure x${((lo + hi) / 2).toFixed(3)} reaches ${MEASURED_APOGEE_FT} ft,`
        + ` peak a there ${shot.accelFt.toFixed(0)} ft/s2`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n${out.join('\n')}\n`);
    expect(out).toHaveLength(4);
  }, 600_000);
});
