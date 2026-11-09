import { afterEach, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

// Invalid arguments must be rejected before corpus reads, downloads or writes.
vi.mock('node:fs', async (original) => {
  const real = await original();
  const blocked = () => { throw new Error('unexpected filesystem access'); };
  return { ...real, mkdirSync: blocked, readFileSync: blocked, existsSync: blocked };
});

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const commands = [
  ['digest-census', ['--dropbox', '--out', '--list']],
  ['merge-rocksim-parts', ['--json', '--csv-dir']],
  ['build-nozzle-db', ['--loki', '--source']],
  ['motor-diff-summary', ['--before', '--after', '--markdown', '--title', '--commit-message', '--github-output']],
  ['matcher-sweep', ['--manifest', '--baseline', '--out', '--batch', '--limit']],
];
const load = {
  'digest-census': () => import('./digest-census.mjs'),
  'merge-rocksim-parts': () => import('./merge-rocksim-parts.mjs'),
  'build-nozzle-db': () => import('./build-nozzle-db.mjs'),
  'motor-diff-summary': () => import('./motor-diff-summary.mjs'),
  'matcher-sweep': () => import('./matcher-sweep.mjs'),
};

for (const [script, flags] of commands) {
  for (const flag of flags) {
    for (const tail of [[], ['--dry-run'], ['', flag]]) {
      it(`${script} refuses a missing ${flag} value (${JSON.stringify(tail)}) before IO`, async () => {
        // Entry-point execution also covers default option expressions and
        // optional output flags that would otherwise be read only after work.
        const argv = ['node', fileURLToPath(new URL(`./${script}.mjs`, import.meta.url)), flag, ...tail];
        vi.stubGlobal('process', { ...process, argv });
        await expect(load[script]()).rejects.toThrow(`${flag} requires a value`);
      });
    }
  }
}
