import { expect, it, vi } from 'vitest';
import { workerBuild } from '../vite.config.js';

it.each(['0.210', '0.211', '1.2.3'])('emits worker identity for %s before workbox scans the output', version => {
  const { plugin, importScripts } = workerBuild(version);
  const emitFile = vi.fn();
  // Vite writes generateBundle assets before PWA's closeBundle generates sw.js.
  plugin.generateBundle.call({ emitFile } as unknown as ThisParameterType<typeof plugin.generateBundle>);
  expect(plugin.apply).toBe('build');
  expect(emitFile).toHaveBeenCalledExactlyOnceWith({
    type: 'asset', fileName: `sw-build-${version}.js`, source: `self.__MMR_BUILD_VERSION = "${version}";`,
  });
  expect(importScripts).toEqual(['sw-update-protocol-v1.js', `sw-build-${version}.js`]);
});

it('changes the import filename with the build version to avoid a cached import from another release', () => {
  expect(workerBuild('0.210').importScripts[1]).not.toBe(workerBuild('0.211').importScripts[1]);
});
