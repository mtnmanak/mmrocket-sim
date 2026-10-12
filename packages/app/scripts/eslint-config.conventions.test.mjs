import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: root });
const probe = async (path, rule, code) => {
  const { rules } = await eslint.calculateConfigForFile(path);
  return new Linter().verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser },
    rules: { [rule]: rules[rule] ?? 'off' } }], 'probe.ts').filter((m) => m.ruleId === rule);
};

// Each config is resolved independently: App replaces the shared rule options.
describe('audit 2026-10-11 lint delta', () => {
  it.each(['packages/app/src/App.tsx', 'packages/app/src/services/motorDb.ts', 'packages/engine/src/index.ts'])(
    'item 1: %s refuses default exports', async (path) => {
      expect(await probe(path, 'no-restricted-syntax', 'export default function sample() {}')).toHaveLength(1);
      expect(await probe(path, 'no-restricted-syntax', 'export function sample() {}')).toHaveLength(0);
    }, 30_000);

  it.each(['packages/app/src/App.tsx', 'packages/app/src/services/motorDb.ts', 'packages/engine/src/index.ts'])(
    'item 2: %s refuses test-support imports', async (path) => {
      for (const name of ['./sample.testSupport', './sample.testSupport.js', '../services/sample.testSupport.ts']) {
        expect(await probe(path, 'no-restricted-imports', `import { sample } from '${name}';`)).toHaveLength(1);
      }
    }, 30_000);

  it('item 2: test files may still import test support', async () => {
    expect(await probe('packages/app/src/services/simulateFile.test.ts', 'no-restricted-imports',
      "import { sample } from './sample.testSupport.js';")).toHaveLength(0);
  });

  it('item 3: every suppression under packages is next-line with a reason', () => {
    const paths = execFileSync('git', ['ls-files', '--', 'packages'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
    const bad = [];
    let count = 0;
    for (const path of paths.filter((p) => /\.(?:[cm]?[jt]sx?)$/.test(p))) {
      readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8').split('\n').forEach((line, i) => {
        // Match directives, not prose or test fixture strings naming the directive.
        if (!/^\s*(?:\/\/|\/\*)\s*eslint-disable\b/.test(line)) return;
        count++;
        if (!/^\s*\/\/ eslint-disable-next-line [\w@/,-]+(?: [\w@/,-]+)* -- \S/.test(line)) bad.push(`${path}:${i + 1}`);
      });
    }
    expect(count).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });
});
