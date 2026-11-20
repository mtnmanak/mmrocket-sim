// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { decodeXml } from '../src/services/xmlUtil.ts';
import * as routing from '../src/services/designFile.ts';

it.each([17000, 16373, 16378])('r5 matcher routes a misleading filename past a %i-character prolog', length => {
  // Exercise the worker's actual routing expression without running its corpus loop.
  const worker = readFileSync(resolve('scripts/matcher-sweep.worker.mjs'), 'utf8');
  const expression = /kind = ([^;]+) \?\? kind;/.exec(worker)[1];
  const route = new Function('bytes', 'lib', ...Object.keys(routing), `return ${expression};`);
  const bytes = new TextEncoder().encode('<!--' + 'x'.repeat(length) + '--><openrocket version="1.10"/>');
  expect(route(bytes, { decodeXml }, ...Object.values(routing))).toBe('ork');
});
