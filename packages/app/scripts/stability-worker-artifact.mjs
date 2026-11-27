import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');

/** Vitest sets NODE_ENV=test; the artifact must still be a production build. */
export function stabilityWorkerBuild(outDir) {
  return {
    args: [resolve(app, '../../node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'],
    options: { cwd: app, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' } },
  };
}

/** Required CI check only: never consume or overwrite the release dist directory. */
export function buildStabilityWorkerArtifact(
  required = process.env['REQUIRE_STABILITY_WORKER'] === '1',
  build = execFileSync,
) {
  if (!required) return null;
  const outDir = mkdtempSync(join(tmpdir(), 'mmrsim-stability-worker-'));
  const cleanup = () => rmSync(outDir, { recursive: true, force: true });
  try {
    const { args, options } = stabilityWorkerBuild(outDir);
    build(process.execPath, args, options);
    const assets = join(outDir, 'assets');
    const files = readdirSync(assets).filter(file => /^configStabilityRange\.worker-.*\.js$/.test(file));
    if (files.length !== 1) throw new Error('Expected one fresh stability worker after vite build');
    return { outDir, file: join(assets, files[0]), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
