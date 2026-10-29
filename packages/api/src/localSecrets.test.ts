import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps local Worker secrets and their variants out of git', () => {
  const paths = ['packages/api/.dev.vars', 'packages/api/.dev.vars.local', 'packages/api/.dev.vars.production'];
  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    input: paths.join('\n') + '\n', encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split(/\r?\n/)).toEqual(paths);
});
