import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('ships an ASCII Worker bundle so V8 can retain one-byte source', () => {
  const apiDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  // Keep interrupted builds ignored by Git and ESLint, including config/log writes.
  const parent = join(apiDir, '.wrangler');
  mkdirSync(parent, { recursive: true });
  const temp = mkdtempSync(join(parent, 'ascii-'));
  try {
    const require = createRequire(import.meta.url);
    // Launch the CLI itself so the timeout kills the process doing the build.
    const cli = join(dirname(require.resolve('wrangler/package.json')), 'wrangler-dist', 'cli.js');
    const build = spawnSync(process.execPath, [cli, 'deploy', '--dry-run', '--outdir', temp], {
      cwd: apiDir, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true',
        CLOUDFLARE_CF_FETCH_ENABLED: 'false', WRANGLER_LOG_PATH: join(temp, 'wrangler.log'),
        XDG_CONFIG_HOME: join(temp, 'config') },
    });
    expect(build.error, 'Wrangler dry-run error').toBeUndefined();
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const bundle = readFileSync(join(temp, 'index.js'));
    const index = bundle.findIndex(byte => byte > 0x7f);
    const snippet = index < 0 ? '' : JSON.stringify(bundle.subarray(Math.max(0, index - 60), index + 60).toString('utf8'));
    expect(index, `Non-ASCII Worker source at byte ${index}: ${snippet}`).toBe(-1);
  } finally {
    if (dirname(temp) === parent) rmSync(temp, { recursive: true, force: true });
  }
}, 35_000);
