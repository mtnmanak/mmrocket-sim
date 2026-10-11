import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { OrkRocket, resetEngine } from '../packages/engine/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const anchors = JSON.parse(readFileSync(new URL('anchors.json', import.meta.url), 'utf8'));
const cases = [
  [82, 1.78, 0.438, 0.142, 0.007],
  [83, 1.78, 0.700, 0.114, 0.005],
  [101, 5.00, 0.438, 0.059, 0.005],
  [100, 5.00, 0.700, 0.083, 0.005],
  [92, 3.50, 1.000, 0.205, 0.005],
  [98, 5.00, 1.000, 0.190, 0.005],
];

// Direct single-Mach kernel evaluation is independent of the scorer's grid
// interpolation and nose-removal path. No exact kernel float literals.
function atMach(tree, flag, mach = 1.2) {
  resetEngine();
  const rocket = OrkRocket.buildTree(tree);
  if (flag === '--kbf') rocket.setRogersModifiedBarrowman(true);
  if (flag === '--supersonic') rocket.setSupersonicAero(true);
  if (flag === '--hybrid') rocket.setHybridAero(true);
  const info = rocket.staticInfo();
  const sweep = rocket.dragSweep({ machMin: mach, machMax: mach, machStep: 0.025, aoaDeg: 0 });
  return { info, pressure: sweep.powerOff.pressure[0], base: sweep.powerOff.base[0],
    total: sweep.powerOff.total[0] };
}

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
// One scorecard row, split into its columns: Mach, anchor, model, delta, tol, result.
function scoredRow(stdout, cell, series, mach) {
  const section = stdout.split(`## ${cell} `)[1]?.split('\n## ')[0];
  assert.ok(section, `missing score for ${cell}`);
  const block = section.split(`### ${series} `)[1];
  assert.ok(block, `missing series ${series} in ${cell}`);
  const row = block.split('\n').find(line => line.startsWith(`| ${mach} |`));
  assert.ok(row, `missing M${mach} row in ${cell}/${series}`);
  return row.split('|').map(s => s.trim()).slice(1, 7);
}

// Cells added 2026-10-11 (harness coverage): every one informational, so the
// gate set - and every published percentage - is untouched.
const coverageCells = ['basic-finner-fig23', 'r100-23',
  ...[78, 92, 98].map(c => `r100-${c}-finned`),
  ...[79, 80, 81, 82, 83, 93, 94, 95, 99, 100, 101, 102, 103].map(c => `r100-${c}-increment`)];

test('R-100 fixtures reproduce the six assigned geometries and informational readings', () => {
  for (const [config, lengthRatio, radiusRatio, anchor, tol] of cases) {
    const spec = anchors[`r100-${config}`];
    assert.ok(spec, `missing R-100 config ${config}`);
    assert.equal(spec.refAreaScale, 1);
    assert.deepEqual(spec.series.map(s => [s.quantity, s.gate, s.tol, s.points]),
      [['cdAfterbody', false, tol, [[1.2, anchor]]]]);
    const tree = JSON.parse(readFileSync(new URL(`fixtures/${spec.fixture}`, import.meta.url), 'utf8'));
    assert.equal(tree.components.length, 2, 'nose directly joins afterbody; no midbody or fins');
    const [nose, tail] = tree.components;
    assert.equal(nose.type, 'nosecone');
    assert.equal(nose.shape, 'parabolic');
    assert.equal(nose.shapeParameter, 1);
    assert.ok(Math.abs(nose.length / 0.0381 - 7.13) < 1e-12);
    assert.equal(nose.aftRadius, 0.01905);
    assert.ok(Math.abs(tail.length / 0.0381 - lengthRatio) < 1e-12);
    if (radiusRatio === 1) {
      assert.equal(tail.type, 'bodytube');
      assert.equal(tail.outerRadius, 0.01905);
    } else {
      assert.equal(tail.type, 'transition');
      assert.equal(tail.shape, 'conical');
      assert.equal(tail.foreRadius, 0.01905);
      assert.ok(Math.abs(tail.aftRadius / 0.01905 - radiusRatio) < 1e-12);
    }
    assert.ok(!tree.components.some(c => c.children?.length), 'no attached fins');
    const { info } = atMach(tree);
    assert.ok(Math.abs(info.length - (7.13 + lengthRatio) * 0.0381) < 1e-10);
    assert.ok(Math.abs(info.refDiameter - 0.0381) < 1e-10);
  }
});

test('the 2026-10-11 coverage cells exist, are informational, and keep 191 gates', () => {
  for (const cell of coverageCells) {
    const spec = anchors[cell];
    assert.ok(spec, `missing ${cell}`);
    for (const series of spec.series) {
      assert.equal(series.gate, false, `${cell}/${series.id} must not gate`);
      for (const point of series.points) {
        assert.ok(point.length === 2 || (point.length === 3 && point[2] > 0), `${cell}: bad point ${point}`);
      }
      if (series.quantity === 'cdDelta') assert.ok(fixture(series.referenceFixture).components.length === 2);
    }
  }
  // Fin-free on both sides of every increment: the measured difference cancels
  // the real models' identical fins, so the kernel difference must not carry any.
  for (const cell of coverageCells.filter(c => c.endsWith('-increment'))) {
    const tree = fixture(anchors[cell].fixture);
    assert.ok(!tree.components.some(c => c.children?.length), `${cell}: increment fixture carries fins`);
  }
  // And the gate set is still the 191 points it was: every gating series'
  // points inside its gate Mach window, the predicate score.mjs counts by.
  const gates = Object.entries(anchors).filter(([name]) => !name.startsWith('_'))
    .flatMap(([, spec]) => spec.series.filter(series => series.gate))
    .reduce((sum, series) => sum + series.points.filter(([m]) =>
      (series.gateMaxMach == null || m <= series.gateMaxMach)
      && (series.gateMinMach == null || m >= series.gateMinMach)).length, 0);
  assert.equal(gates, 191);
  // The finned cells carry the report's three type-A fins as drawn.
  for (const name of ['r100-78-finned.json', 'r100-92-finned.json', 'r100-98-finned.json', 'r100-23.json']) {
    const fins = fixture(name).components.flatMap(c => c.children ?? []);
    assert.equal(fins.length, 1, name);
    const [fin] = fins;
    assert.equal(fin.finCount, 3);
    assert.ok(Math.abs(fin.rootChord / 0.0254 - 1.8) < 1e-6 && Math.abs(fin.tipChord / 0.0254 - 1.8) < 1e-6);
    assert.ok(Math.abs(fin.thickness / 0.0254 - 0.05) < 1e-6);
    assert.equal(fin.airfoilSection, 'hexagonal');
    assert.ok(Math.abs(fin.sweep - fin.height) < 1e-9, `${name}: 45 deg sweep`);
  }
});

for (const flag of ['', '--kbf', '--supersonic', '--hybrid']) {
  // A real-kernel sweep of every model through the scorer: over a second each.
  test(`cdAfterbody subtracts nose pressure, includes base, excludes friction: ${flag || 'Classic'}`, { timeout: 30_000 }, () => {
    const args = ['validation/score.mjs', ...(flag ? [flag] : []), '--strict'];
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.stderr, '');
    assert.equal(result.status, 1, 'existing failed gates retain strict exit 1');
    assert.match(result.stdout, /Gate points: \d+\/191 within tolerance/);
    // Explicit nose reference, rather than the scorer's removed-afterbody tree.
    const nose = atMach({ name: 'Independent R-100 nose reference', components: [
      { type: 'nosecone', shape: 'parabolic', shapeParameter: 1,
        length: 0.271653, aftRadius: 0.01905, finish: 'polished', thickness: 0.001 },
    ] }, flag);
    for (const [config, , radiusRatio, anchor] of cases) {
      const spec = anchors[`r100-${config}`];
      assert.ok(spec, `missing R-100 config ${config}`);
      const tree = JSON.parse(readFileSync(new URL(`fixtures/${spec.fixture}`, import.meta.url), 'utf8'));
      const body = atMach(tree, flag);
      const expected = radiusRatio === 1 ? body.base : body.pressure - nose.pressure + body.base;
      const section = result.stdout.split(`## r100-${config} `)[1]?.split('\n## ')[0];
      assert.ok(section, `missing score for R-100 config ${config}`);
      const row = section.split('\n').find(line => line.startsWith('| 1.2 |'));
      const columns = row.split('|').map(s => s.trim());
      assert.equal(Number(columns[2]), anchor);
      // CLI prints four decimals: half of its last displayed digit + roundoff.
      assert.ok(Math.abs(Number(columns[3]) - expected) <= 0.000050001,
        `${config}: scored ${columns[3]}, direct kernel ${expected}`);
      assert.ok(Math.abs(Number(columns[4]) - (expected - anchor)) <= 0.000050001);
      assert.match(columns[6], /^(ok|off) \(info\)$/);
    }
    // cdDelta: this fixture's total CD minus the reference fixture's, both
    // evaluated directly here at the row's Mach.
    for (const cell of ['r100-82-increment', 'r100-95-increment', 'r100-101-increment']) {
      const [series] = anchors[cell].series;
      for (const mach of [0.9, 1.2]) {
        const expected = atMach(fixture(anchors[cell].fixture), flag, mach).total
          - atMach(fixture(series.referenceFixture), flag, mach).total;
        const [, anchor, model, , tol, verdict] = scoredRow(result.stdout, cell, series.id, mach);
        const point = series.points.find(([m]) => m === mach);
        assert.equal(Number(anchor), point[1]);
        assert.ok(Math.abs(Number(model) - expected) <= 0.000050001,
          `${cell} M${mach}: scored ${model}, direct kernel difference ${expected}`);
        // The point's own third-element tolerance is the one printed and applied.
        assert.equal(tol, `±${point[2].toFixed(4)}`);
        assert.equal(verdict, Math.abs(Number(model) - point[1]) <= point[2] ? 'ok (info)' : 'off (info)');
      }
    }
  });
}

// TN D-4013 subsonic CP (2026-10-11, board row 85): informational, one series per
// independent read of the report figure, at the Machs the report tested.
const subsonicCp = {
  'arcas-short': ['cp-subsonic-tunnel-deckread', 'cp-subsonic-tunnel-agentread', 'cp-subsonic-tunnel-scanread'],
  'arcas-long': ['cp-subsonic-tunnel-deckread', 'cp-subsonic-tunnel-scanread'],
};

test('the TN D-4013 subsonic CP reads are informational, at tested Machs, every read kept', () => {
  for (const [cell, ids] of Object.entries(subsonicCp)) {
    const series = anchors[cell].series.filter(s => s.id.startsWith('cp-subsonic-tunnel-'));
    assert.deepEqual(series.map(s => s.id), ids);
    for (const s of series) {
      assert.equal(s.quantity, 'cpPctL');
      assert.equal(s.gate, false, `${cell}/${s.id} must not gate`);
      // The report's stated CN/Cm accuracy carried through x_cp, never a read band.
      assert.equal(s.tol, 0.5);
      // TN D-4013 p.4: both models ran M0.60, 0.80, 0.90 (Short also 0.95); no 0.70/0.85.
      assert.deepEqual(s.points.map(([m]) => m), [0.6, 0.8, 0.9]);
    }
    // The reads disagree; none may be silently replaced by another.
    const atM06 = series.map(s => s.points[0][1]);
    assert.equal(new Set(atM06).size, atM06.length, `${cell}: duplicate read`);
  }
});

for (const flag of ['', '--kbf', '--supersonic', '--hybrid']) {
  test(`subsonic CP rows score the kernel's own CP at tunnel Re: ${flag || 'Classic'}`, { timeout: 30_000 }, () => {
    const args = ['validation/score.mjs', ...(flag ? [flag] : [])];
    const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Gate points: \d+\/191 within tolerance/);
    for (const [cell, ids] of Object.entries(subsonicCp)) {
      for (const mach of [0.6, 0.8, 0.9]) {
        resetEngine();
        const rocket = OrkRocket.buildTree(fixture(anchors[cell].fixture));
        if (flag === '--kbf') rocket.setRogersModifiedBarrowman(true);
        if (flag === '--supersonic') rocket.setSupersonicAero(true);
        if (flag === '--hybrid') rocket.setHybridAero(true);
        const { length } = rocket.staticInfo();
        const sweep = rocket.dragSweep({ machMin: mach, machMax: mach, machStep: 0.025, aoaDeg: 0,
          machAlt: anchors[cell].machAlt });
        const expected = (sweep.cp[0] / length) * 100;
        for (const id of ids) {
          const [, anchor, model, , tol, verdict] = scoredRow(result.stdout, cell, id, mach);
          const point = anchors[cell].series.find(s => s.id === id).points.find(([m]) => m === mach);
          assert.equal(Number(anchor), point[1]);
          assert.ok(Math.abs(Number(model) - expected) <= 0.000050001,
            `${cell}/${id} M${mach}: scored ${model}, direct kernel ${expected}`);
          assert.equal(tol, '±0.5000');
          assert.equal(verdict, Math.abs(Number(model) - point[1]) <= 0.5 ? 'ok (info)' : 'off (info)');
        }
      }
    }
  });
}
