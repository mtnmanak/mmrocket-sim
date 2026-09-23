/**
 * The repo-root eslint.config.mjs refuses two things in browser source, and this
 * pins that it still does. A lint rule's config is easy to break silently: a
 * later block can switch a rule off for a glob that happens to cover src/, a
 * selector can be edited into one that matches nothing, and `npx eslint .` then
 * reports 0 problems — which is exactly what a working guard also reports.
 *
 *   - Node-only globals (`Buffer.from`, `process.env.X`) lint and test clean —
 *     typescript-eslint turns no-undef off for .ts and vitest runs under Node —
 *     and packages/engine's tsc still sees @types/node (packages/app's shipped
 *     source stopped seeing it in the 2026-09-22 tsconfig split); then they
 *     throw or read `undefined` in a user's browser. The tests themselves DO
 *     run under Node, so the rule must stay off there.
 *   - A private `typeof n[k] === 'number' ? n[k] : fb` reader passes NaN, where
 *     tree/nodeNum.ts is the one reader (audit 2026-09-22).
 *
 * It also pins that the type-aware rules (no-floating-promises and friends)
 * still resolve for shipped source, its tests and the engine.
 *
 * Each rule is read from the config ESLint actually resolves for a real file,
 * then run on a probe with the typescript-eslint parser alone, so no type
 * program is built. (Named eslint-config.*, not eslint.config.*: vitest's
 * default exclude drops every `*.config.*` file, so that name never runs.)
 */
import { describe, expect, it } from 'vitest';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

/** The listed rules exactly as the repo config resolves them for `rel`. */
async function rulesFor(rel, names) {
  const { rules } = await eslint.calculateConfigForFile(rel);
  return Object.fromEntries(names.map((n) => [n, rules[n] ?? 'off']));
}

function lint(code, rules) {
  return new Linter().verify(code, [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules,
  }], 'probe.ts').map((m) => `${m.ruleId}@${m.line}`);
}

const GLOBALS = ['no-restricted-globals'];
const READER = ['no-restricted-syntax'];

describe('eslint.config.mjs — the browser-source guards resolve and fire', () => {
  it('refuses Node-only and coercing globals in shipped source', async () => {
    const rules = await rulesFor('packages/app/src/services/shareLink.ts', GLOBALS);
    expect(lint([
      "export const a = Buffer.from('x');",
      'export const b = process.env.X;',
      'export const c = isNaN(Number(a));',
      'export const d = Number.isNaN(1) || Number.isFinite(2);',
      "export const e = globalThis.crypto?.randomUUID?.();",
    ].join('\n'), rules)).toEqual([
      'no-restricted-globals@1', 'no-restricted-globals@2', 'no-restricted-globals@3',
    ]);
    // The engine package ships to the browser too.
    expect((await rulesFor('packages/engine/src/index.ts', GLOBALS))['no-restricted-globals'][0]).toBe(2);
  });

  it('leaves them to the tests, which run under Node', async () => {
    const rules = await rulesFor('packages/app/src/services/shareLink.test.ts', GLOBALS);
    expect(lint('export const cwd = process.cwd();', rules)).toEqual([]);
  });

  it('refuses a private NaN-passing number reader, in both shapes', async () => {
    const rules = await rulesFor('packages/app/src/tree/treeModel.ts', READER);
    expect(lint([
      "type N = { [k: string]: unknown };",
      'export const r1 = (n: N, k: string, fb: number): number =>',
      "  typeof n[k] === 'number' ? (n[k] as number) : fb;",
      'export function r2(n: N): number {',
      "  return typeof n['length'] === 'number' ? (n['length'] as number) : 0;",
      '}',
    ].join('\n'), rules)).toEqual(['no-restricted-syntax@3', 'no-restricted-syntax@5']);
  });

  it('turns the type-aware rules on for shipped source, its tests and the engine', async () => {
    // Resolution only: the rules themselves need a type program, which the
    // lint run builds. A files glob that stopped covering one of these would
    // switch no-floating-promises off there with 0 problems reported.
    const TYPED = ['@typescript-eslint/no-floating-promises', '@typescript-eslint/no-misused-promises'];
    for (const rel of ['packages/app/src/App.tsx', 'packages/app/src/App.session.test.tsx',
      'packages/engine/src/index.ts']) {
      const rules = await rulesFor(rel, TYPED);
      expect(TYPED.map((r) => rules[r][0]), rel).toEqual([2, 2]);
    }
  });

  it('leaves ordinary type narrowing alone', async () => {
    const rules = await rulesFor('packages/app/src/tree/treeModel.ts', READER);
    expect(lint([
      'export function f(v: unknown, n: { [k: string]: unknown }): number {',
      "  if (typeof v === 'number' && v > 0) return v;",
      "  const w = typeof n['w'] === 'number' ? (n['w'] as number) * 2 : 0;",
      '  return w;',
      '}',
    ].join('\n'), rules)).toEqual([]);
  });
});
