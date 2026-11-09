import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { build, loadConfigFromFile } from 'vite';
import { CHANGELOG } from '../src/changelog.ts';

it('ships only the newest bullets and eleven release headers in the dialog chunk', async () => {
  // Use the production plugin list: a pure projection test cannot catch a missing hookup.
  const config = await loadConfigFromFile({ command: 'build', mode: 'production' });
  const plugin = config.config.plugins.find(plugin => plugin.name === 'compact-changelog');
  expect(plugin).toBeDefined();
  const projected = JSON.parse(plugin.transform('', '/app/src/changelog.ts').code
    .replace('export const CHANGELOG = ', '').replace(/;$/, ''));
  expect(projected).toEqual(CHANGELOG.slice(0, 11).map(({ version, date, title, summary, items }, i) => ({
    version, date, title, ...(i === 0 ? { items: summary ?? items } : {}),
  })));
  const result = await build({ configFile: false, build: { write: false, lib: {
    entry: 'src/changelog.ts', formats: ['es'], fileName: 'dialog',
  } }, plugins: [plugin, {
    name: 'inspect-dialog-payload',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
      const source = readFileSync(new URL('../src/changelog.ts', import.meta.url), 'utf8');
      expect(source.length).toBeGreaterThan(100_000);
      const changelog = chunks.find(chunk => Object.keys(chunk.modules).some(id => id.replaceAll('\\', '/').endsWith('/src/changelog.ts')));
      expect(changelog).toBeDefined();
      expect(changelog.code.length).toBeLessThan(30_000);
    },
  }] });
  expect(result).toBeDefined();
}, 120_000);
