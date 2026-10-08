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
function atMach(tree, flag) {
  resetEngine();
  const rocket = OrkRocket.buildTree(tree);
  if (flag === '--kbf') rocket.setRogersModifiedBarrowman(true);
  if (flag === '--supersonic') rocket.setSupersonicAero(true);
  if (flag === '--hybrid') rocket.setHybridAero(true);
  const info = rocket.staticInfo();
  const sweep = rocket.dragSweep({ machMin: 1.2, machMax: 1.2, machStep: 0.025, aoaDeg: 0 });
  return { info, pressure: sweep.powerOff.pressure[0], base: sweep.powerOff.base[0] };
}

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

for (const flag of ['', '--kbf', '--supersonic', '--hybrid']) {
  test(`cdAfterbody subtracts nose pressure, includes base, excludes friction: ${flag || 'Classic'}`, () => {
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
  });
}
