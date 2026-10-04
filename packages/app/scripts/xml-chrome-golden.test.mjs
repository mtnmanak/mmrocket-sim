import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./xml-chrome-golden.mjs', import.meta.url));
const dataUrl = (code) => `data:text/javascript,${encodeURIComponent(code)}`;

describe('xml-chrome-golden --check cleanup', () => {
  it.each([false, true])('removes its build directory when the golden differs: %s', (differs) => {
    const temp = mkdtempSync(join(tmpdir(), 'xml-golden-test-'));
    // Exercise the real CLI in a child: process.exit cannot be mocked with a
    // thrown error, because that would run finally and hide the original leak.
    const modules = {
      vite: `
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        export async function build({ build: { outDir } }) {
          console.log('BUILD_DIR=' + outDir);
          writeFileSync(join(outDir, 'parity.js'), '');
        }`,
      'playwright-core': `
        export const chromium = { launch: async () => ({
          version: () => 'test',
          newPage: async () => ({
            route: async () => {}, goto: async () => {},
            evaluate: async () => ({ hostile: {}, conformance: {}, fixtures: {} }),
          }),
          close: async () => { console.log('BROWSER_CLOSED'); },
        }) };`,
      './xml-golden-key.mjs': "export const importerKey = () => 'test';",
      'node:fs': `
        export * from 'node:fs';
        import * as fs from 'node:fs';
        export function readFileSync(path, ...args) {
          if (String(path).endsWith('chrome-golden.json')) {
            return JSON.stringify({ importKey: ${JSON.stringify(differs ? 'old' : 'test')},
              hostile: {}, conformance: {}, fixtures: {} });
          }
          return fs.readFileSync(path, ...args);
        }
        export function writeFileSync() { throw new Error('--check must not write the golden'); }`,
    };
    const loader = dataUrl(`
      const modules = ${JSON.stringify(modules)};
      export async function resolve(specifier, context, nextResolve) {
        if (context.parentURL?.endsWith('/xml-chrome-golden.mjs') && modules[specifier]) {
          return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }`);
    try {
      const result = spawnSync(process.execPath, [
        '--import', dataUrl(`import { register } from 'node:module'; register(${JSON.stringify(loader)});`),
        SCRIPT, '--check',
      ], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp, PLAYWRIGHT_CORE: '' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(differs ? 1 : 0);
      expect(result.stdout).toContain('BROWSER_CLOSED');
      expect(result.stdout).toContain(differs ? 'now differs on:' : 'golden is current.');
      const outDir = result.stdout.match(/BUILD_DIR=(.+)/)?.[1].trim();
      expect(outDir).toBeTruthy();
      expect(existsSync(outDir), `leaked build directory: ${outDir}`).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
