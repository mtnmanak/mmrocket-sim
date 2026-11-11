import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([{ tail: [] }, { tail: ['--other-flag'] }, { tail: [''] }])('carve refuses missing --source before filesystem access ($tail)', ({ tail }) => {
  // Block filesystem probes so this regression can never start a carve,
  // even on a machine with a configured reference checkout.
  const guard = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
  if (/[/\\\\](carve|openrocket-src|machine-profile|atomic-write)\\.mjs$/.test(String(path))) return read(path, ...args);
  throw new Error('unexpected filesystem access');
};
for (const name of ['existsSync', 'mkdirSync', 'copyFileSync', 'readdirSync']) {
  fs[name] = () => { throw new Error('unexpected filesystem access'); };
}
syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(guard)}`,
    fileURLToPath(new URL('../../../engine-java/scripts/carve.mjs', import.meta.url)),
    '--source', ...tail,
  ], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('--source requires a value');
  expect(result.stderr).not.toContain('unexpected filesystem access');
});
