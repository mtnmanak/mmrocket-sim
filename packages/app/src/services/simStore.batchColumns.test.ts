// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { addRuns, loadRuns, runsToCsv, runsToTable } from './simStore.js';
import type { BatchMountRecord, SimRun } from './simReport.js';

afterEach(() => localStorage.clear());
const mounts: BatchMountRecord[] = [
  { mountId: 'a', mountName: 'MMT 1', role: 'candidate', motor: 'M1780NT', count: 1 },
  { mountId: 'b', mountName: 'MMT 2', role: 'kept', motor: 'K1499N', count: 1 },
];
const row = (id: string, fields: Partial<SimRun> = {}) => ({ id, when: 0, motor: 'M1780NT', rocket: 'Batch',
  manufacturer: 'Test', comments: '', delayS: 5, ...fields }) as SimRun;

it('round trips complete batch evidence and drops a bad vector without repairing it', () => {
  addRuns([row('new', { batch: true, batchMounts: mounts }), row('legacy', { batch: true })]);
  expect(loadRuns().map(r => r.batchMounts)).toEqual([mounts, undefined]);
  localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([
    row('bad', { batch: true, batchMounts: [mounts[0]!, { ...mounts[1]!, count: 0 }] }), row('good', { batchMounts: mounts }),
  ]));
  const loaded = loadRuns();
  expect(loaded.map(r => r.id)).toEqual(['bad', 'good']);
  expect(loaded[0]).not.toHaveProperty('batchMounts');
  expect(loaded[1]?.batchMounts).toEqual(mounts);
});

it('appends batch tail columns shared by CSV and XLSX, preserving all previous positions', () => {
  const table = runsToTable([row('batch', { batch: true, batchMounts: mounts }), row('ordinary', { batchMounts: mounts }), row('legacy', { batch: true })]);
  expect(table.headers.slice(0, -3)).toEqual([
    'Designation', 'Apogee (ft)', 'Velocity (mph)', 'Manufacturer', 'Diameter (mm)', 'Type', 'Propellant', 'Case',
    'T:W', 'Guide (mph)', 'Accel (Gs)', 'Delay (s)', 'Pad Weight (g)', 'Recovery Weight (g)', 'Date', 'Rocket',
    'Max altitude (m)', 'Max velocity (m/s)', 'Max Mach', 'Max acceleration (m/s2)', 'Max roll rate (r/s)',
    'Time to apogee (s)', 'Time to burnout (s)', 'Time to launch guide exit (s)', 'Velocity at launch guide exit (m/s)',
    'Launch mass (kg)', 'Recovery weight (kg)', 'Angle of attack at launch guide exit (deg)',
    'CG at launch guide exit (m)', 'CP at launch guide exit (m)', 'Static margin at launch guide exit (cal)',
    'Altitude at deployment (m)', 'Velocity at deployment (m/s)', 'Deployments', 'Drogue descent rate (m/s)',
    'Landing rate (m/s)', 'Landing rate OK', 'Landing distance (m)', 'Landing bearing (deg from N)',
    'Ground hit velocity (m/s)', 'Total flight time (s)', 'Optimal delay (s)', 'Recommended delay (s)',
    'Lift-off speed OK', 'Thrust:weight OK', 'Safe deployment', 'Static margin OK', 'Weathercock risk',
    'Motors (cluster)', 'Motor config', 'Booster motors', 'Booster apogee (m)', 'Booster landing rate (m/s)',
    'Booster landing OK', 'Wind avg (m/s)', 'Aero model', 'Execution time (ms)', 'Sim warnings', 'Comments',
    'Flight config', 'Density altitude (m)', 'Winds aloft (levels)', 'Rail for 15.0 m/s (m)',
    'Max dynamic pressure (Pa)', 'Time at max Q (s)', 'Altitude at max Q (m)', 'Max q·α (Pa·rad)',
    'Max q·α (Pa·deg)', 'Time at max q·α (s)', 'Altitude at max q·α (m)', 'Mach at max q·α',
    'Angle of attack at max q·α (rad)', 'Angle of attack at max q·α (deg)', 'Hybrid band lower (Mach)',
    'Hybrid band upper (Mach)', 'Travel for 15.0 m/s (m)', 'Overrides', 'Status', 'Wind gusts σ at pad (m/s)',
  ]);
  expect(table.headers.slice(-3)).toEqual(['Batch candidate mount', 'Batch other mounts', 'Guide-exit value sources']);
  expect(table.rows.map(r => r.slice(-3, -1))).toEqual([['MMT 1', 'K1499N in MMT 2'], ['', ''], ['', '']]);
  expect(table.rows[0]?.[table.headers.indexOf('Motors (cluster)')]).toBe(1);
  expect(table.rows[0]?.[table.headers.indexOf('Flight config')]).toBe('Batch · M1780NT in MMT 1; K1499N in MMT 2');
  expect(table.rows[2]?.[table.headers.indexOf('Flight config')]).toBe('');
  const csv = runsToCsv([row('batch', { batch: true, batchMounts: mounts })]).split('\n');
  expect(csv[0]).toBe(table.headers.join(','));
  expect(csv[1]?.endsWith(',MMT 1,K1499N in MMT 2,CG: unavailable; CP: unavailable; Static margin: unavailable')).toBe(true);
});

it('Round 2 keeps duplicate mount numbering across both export columns and rejects truthy flags', () => {
  const batchMounts = [mounts[0]!, mounts[1]!, { ...mounts[1]!, mountId: 'c' }, { ...mounts[1]!, mountId: 'd' }]
    .map(m => ({ ...m, mountName: 'Inner Tube' }));
  const table = runsToTable([row('batch', { batch: true, batchMounts }), row('bad-flag', { batch: 'true' as never, batchMounts })]);
  expect(table.rows[0]?.slice(-3, -1)).toEqual(['Inner Tube 1', 'K1499N in Inner Tube 2, Inner Tube 3, Inner Tube 4']);
  expect(table.rows[1]?.slice(-3, -1)).toEqual(['', '']);
  const csv = runsToCsv([row('batch', { batch: true, batchMounts })]);
  expect(csv).toContain('Inner Tube 1,"K1499N in Inner Tube 2, Inner Tube 3, Inner Tube 4"');
});
