import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildStabilityWorkerArtifact, stabilityWorkerBuild } from './stability-worker-artifact.mjs';

afterEach(() => vi.unstubAllEnvs());

it('builds production assets in an isolated directory even under NODE_ENV=test', () => {
  vi.stubEnv('NODE_ENV', 'test');
  const build = vi.fn((_command, args, options) => {
    const outDir = args[args.indexOf('--outDir') + 1];
    expect(resolve(outDir)).not.toBe(resolve(import.meta.dirname, '../dist'));
    expect(args).toContain('--emptyOutDir');
    expect(options.env.NODE_ENV).toBe('production');
    expect(options.env.REQUIRE_STABILITY_WORKER).toBe(process.env.REQUIRE_STABILITY_WORKER);
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'assets/configStabilityRange.worker-fresh.js'), 'fresh');
  });
  const artifact = buildStabilityWorkerArtifact(true, build);
  try {
    expect(build).toHaveBeenCalledOnce();
    expect(readFileSync(artifact.file, 'utf8')).toBe('fresh');
    expect(stabilityWorkerBuild(artifact.outDir).args).toContain(artifact.outDir);
  } finally { artifact.cleanup(); }
  expect(existsSync(artifact.outDir)).toBe(false);
});

it('does not build or discover existing dist assets unless explicitly required', () => {
  vi.stubEnv('REQUIRE_STABILITY_WORKER', undefined);
  const build = vi.fn();
  expect(buildStabilityWorkerArtifact(undefined, build)).toBeNull();
  expect(build).not.toHaveBeenCalled();
});

it('does not fall back to an old artifact after a build failure and cleans up', () => {
  let outDir;
  expect(() => buildStabilityWorkerArtifact(true, (_command, args) => {
    outDir = args[args.indexOf('--outDir') + 1];
    throw new Error('build failed');
  })).toThrow('build failed');
  expect(existsSync(outDir)).toBe(false);
});

it.each([{ assets: [] }, { assets: ['configStabilityRange.worker-a.js', 'configStabilityRange.worker-b.js'] }])(
  'refuses a missing or ambiguous fresh worker and cleans up: $assets', ({ assets }) => {
    let outDir;
    expect(() => buildStabilityWorkerArtifact(true, (_command, args) => {
      outDir = args[args.indexOf('--outDir') + 1];
      mkdirSync(join(outDir, 'assets'));
      for (const file of assets) writeFileSync(join(outDir, 'assets', file), 'fresh');
    })).toThrow('Expected one fresh stability worker');
    expect(existsSync(outDir)).toBe(false);
  },
);
