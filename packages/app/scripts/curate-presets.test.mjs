import { expect, it } from 'vitest';
import { applyCurationPlan, CURATIONS, planCurations } from './curate-presets.mjs';
import { presetKey } from './manufacturers.mjs';

// Fresh-merge fixtures: the shipped catalogue is deliberately not regenerated
// by this lane. Exercise the real table, including exact description matching.
const unwanted = [
  ['Quest', 'Quest', 'PNC25'], ['Quest', 'Quest', 'PNC35'], ['Quest', 'Quest', 'PNC35N'],
  ['Estes', 'Reliant/Viking BT-20', ''], ['Estes', 'Solar racer', ''],
  ['BalsaMachining', '20140', 'PNC-3.00'], ['Public Missiles', 'FNC-11.4HRPN', 'Fiberglass nose cone'],
].map(([manufacturer, partNo, description]) => ({ kind: 'NoseCone', manufacturer, partNo, description, source: 'rocksim' }));

it.each(unwanted)('curates the re-listed nose $manufacturer $partNo $description', row => {
  const plan = planCurations(unwanted, CURATIONS.filter(c => unwanted.some(p => presetKey(p) === c.key)));
  expect(plan.filter(p => p.status === 'error')).toEqual([]);
  expect(plan.filter(p => p.status === 'todo' && p.c.action === 'drop').map(p => unwanted[p.index])).toContain(row);
});

it.each(['20147', '20148'])('keeps only the catalogue-mass solid Madcow %s', partNo => {
  const common = { kind: 'NoseCone', manufacturer: 'Madcow', partNo, source: 'rocksim', shape: 'ELLIPSOID' };
  const hollow = { ...common, thickness: 0.0025 };
  const solid = { ...common, filled: true, mass: partNo === '20147' ? 0.1835 : 0.2981 };
  const rows = [hollow, solid];
  const rules = CURATIONS.filter(c => c.action === 'drop' && c.key === `NoseCone|madcow|${partNo}`);
  const plan = planCurations(rows, rules);
  expect(plan.filter(p => p.status === 'error')).toEqual([]);
  expect(plan.filter(p => p.status === 'todo').map(p => rows[p.index])).toEqual([hollow]);
  expect(applyCurationPlan(rows, plan)).toEqual([solid]);
  expect(planCurations([solid], rules).every(p => p.status === 'already')).toBe(true);
  expect(rules.every(c => !c.dropsGroup)).toBe(true);
  expect(planCurations([], rules).map(p => p.status)).toEqual(['error']);
});

it('corrects only the copied length in the solid 20148 description, with drift and repeat guards', () => {
  const row = { kind: 'NoseCone', manufacturer: 'Madcow', partNo: '20148', source: 'rocksim',
    filled: true, mass: 0.2981, length: 16.5 * 0.0254, description: 'PNC-4.00" (98mm) x 9.5' };
  const rules = CURATIONS.filter(c => c.action === 'describe');
  const plan = planCurations([row], rules);
  expect(plan.map(p => p.status)).toEqual(['todo']);
  const corrected = applyCurationPlan([row], plan);
  expect(corrected).toEqual([{ ...row, description: 'PNC-4.00" (98mm) x 16.5' }]);
  expect(planCurations(corrected, rules).map(p => p.status)).toEqual(['already']);
  const drift = planCurations([{ ...row, description: 'different upstream text' }], rules);
  expect(drift.map(p => p.status)).toEqual(['error']);
  expect(() => applyCurationPlan([row], drift)).toThrow(/errors/);
  expect(planCurations([{ ...row, mass: 0.300 }], rules).map(p => p.status)).toEqual(['error']);
});

it.each(['describe', 'rename'])('r3 refuses an unmatched %s even if dropsGroup is set', action => {
  const row = { kind: 'NoseCone', manufacturer: 'Madcow', partNo: '20148', source: 'rocksim', mass: 0.300 };
  const rule = { action, key: presetKey(row), match: { mass: 0.2981 }, dropsGroup: true, to: 'new' };
  expect(planCurations([row], [rule]).map(p => p.status)).toEqual(['error']);
  expect(planCurations([], [rule]).map(p => p.status)).toEqual(['error']);
});

it('does not re-file the existing Madcow fiberglass part numbers or drop desktop noses', () => {
  const rows = [
    { kind: 'NoseCone', manufacturer: 'Madcow', partNo: '2.6" Fiberglass 5:1 Ogive Nose Cone', source: 'rocksim', filled: true },
    { kind: 'NoseCone', manufacturer: 'Madcow', partNo: '5.5" Fiberglass 5:1 Conical Nose Cone', source: 'rocksim', filled: true },
    ...unwanted.filter(p => p.description !== 'PNC35N').map(p => ({ ...p, source: 'desktop-24.12' })),
  ];
  const rules = CURATIONS.filter(c => rows.some(p => presetKey(p) === c.key));
  expect(planCurations(rows, rules).filter(p => p.status !== 'already')).toEqual([]);
});

it.each([
  { kind: 'BodyTube', manufacturer: 'Other' },
  { kind: 'NoseCone', manufacturer: 'SEMROC' },
])('does not accept a rename target with another identity: %j', identity => {
  const c = { key: 'BodyTube|semroc|old', action: 'rename', to: 'new' };
  expect(planCurations([{ ...identity, partNo: 'new' }], [c])[0].status).toBe('error');
  expect(planCurations([{ kind: 'BodyTube', manufacturer: 'SEMROC', partNo: 'new' }], [c])[0].status).toBe('already');
});
