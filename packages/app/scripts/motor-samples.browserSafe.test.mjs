import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import * as samples from './motor-samples.mjs';

const impl = readFileSync(new URL('./motor-samples.mjs', import.meta.url), 'utf8');
const decl = readFileSync(new URL('./motor-samples.d.mts', import.meta.url), 'utf8');

it('declares exactly the motor sample helper runtime exports', () => {
  const declared = [...decl.matchAll(/^export\s+(?:declare\s+)?(?:const|function)\s+(\w+)/gm)]
    .map(m => m[1]).sort();
  expect(declared).toEqual(Object.keys(samples).sort());
});

it('validates and repairs samples without Node imports or globals', () => {
  const code = impl.replace(/^export /gm, '');
  expect(code).not.toMatch(/\b(?:import|require)\s*\(/);
  const result = runInNewContext(`${code}\n({
    valid: sampleListProblem([{ time: 0, thrust: 1 }, { time: 0, thrust: 2 }]),
    invalid: sampleListProblem([{ time: -1, thrust: 1 }, { time: 1, thrust: 0 }]),
    times: flownCurve([{ time: 1, thrust: 1 }, { time: 1, thrust: 1 }]).samples.map(p => p.time)
  })`, {});
  expect(result.valid).toBeNull();
  expect(result.invalid).toMatch(/negative/);
  expect(result.times).toEqual([0, 1]);
});
