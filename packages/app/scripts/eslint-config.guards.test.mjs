/**
 * The repo-root eslint.config.mjs refuses three things in browser source, and this
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
 *   - A lone `typeof n[k] === 'number'` passes NaN and Infinity, where
 *     tree/nodeNum.ts is the one reader (audit 2026-09-22). It began as the
 *     private reader FUNCTION alone, then the inline test in the design-file
 *     writers and cut-file exports; since audit row 522 (2026-09-23) it is
 *     refused anywhere in src — a conditional's or an `if`'s test, a value, a
 *     return, an arrow body — and, since that row's review, as one operand of
 *     && or || too, unless the same chain has a bound or a Number.isFinite /
 *     Number.isInteger to refuse NaN.
 *   - A `markSaved` in App.tsx beyond the three reasoned sites (a .ork save, an
 *     import, ✕ New). It clears the unsaved-work guard, and a mark added to an
 *     action no test drives is invisible to every behavioural test (row 477).
 *
 * It also pins that the type-aware rules (no-floating-promises and friends)
 * still resolve for shipped source, its tests and the engine.
 *
 * Each rule is read from the config ESLint actually resolves for a real file,
 * then run on a probe with the typescript-eslint parser alone, so no type
 * program is built. (Named eslint-config.*, not eslint.config.*: the test
 * exclude in vite.config.ts, vitest 2's default list, drops `eslint.config.*`
 * with the other tools' config names, so that name never runs.)
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

  it('refuses the inline test everywhere in src, tests and the engine included (audit row 522)', async () => {
    // Until row 522 this fired inline only in the five design-file writers and
    // cut-file exports, and elsewhere only on the reader shape (line 4).
    const probe = [
      "type N = { [k: string]: unknown };",
      'export const cd = (node: N): string =>',
      "  `<cd>${typeof node['cd'] === 'number' ? node['cd'] : 'auto'}</cd>`;",
      "export const r = (n: N, k: string, fb: number): number => typeof n[k] === 'number' ? (n[k] as number) : fb;",
      "export const ok = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);",
      'export function om(node: N, out: string[]): void {',
      "  if (typeof node['overrideMass'] === 'number') out.push(`<overridemass>${node['overrideMass']}</overridemass>`);",
      "  if (typeof node['d'] === 'number' && (node['d'] as number) > 0) out.push('d');",
      '}',
    ].join('\n');
    const HITS = ['no-restricted-syntax@3', 'no-restricted-syntax@4', 'no-restricted-syntax@7'];
    for (const rel of [
      ...['orkFile', 'rocksimFile', 'rasaeroFile', 'finTemplate', 'dxfExport'].map((f) => `app/src/services/${f}.ts`),
      'app/src/tree/treeModel.ts', 'app/src/services/recoverySizing.ts', 'app/src/components/PropertyPanel.tsx',
      'app/src/services/orkFile.test.ts', 'app/src/tree/canopyVent.test.ts', 'engine/src/orkEngine.ts',
    ]) {
      expect(lint(probe, await rulesFor(`packages/${rel}`, READER)), rel).toEqual(HITS);
    }
  });

  it('refuses the lone test in every other position too: a value, a !== test, an optional chain', async () => {
    // Each read a NaN field as present before row 522. Line 3 is the shape
    // the writer block's condition-only selector missed in rocksimFile, which
    // then wrote <KnownMass>NaN</KnownMass> from it.
    const rules = await rulesFor('packages/app/src/services/rocksimFile.ts', READER);
    expect(lint([
      "type N = { [k: string]: unknown };",
      'export function f(n: N, p: N | null, xs: N[]): unknown[] {',
      "  const hasMass = typeof n['overrideMass'] === 'number';",
      "  if (typeof n['overrideCGX'] !== 'number') xs.pop();",
      "  const len = typeof p?.['length'] === 'number' ? (p['length'] as number) : 0;",
      "  const o = { hadMass: typeof n['m'] === 'number' };",
      "  return [hasMass, len, o, xs.filter((x) => typeof x['cd'] !== 'number')];",
      '}',
    ].join('\n'), rules)).toEqual([
      'no-restricted-syntax@3', 'no-restricted-syntax@4', 'no-restricted-syntax@5',
      'no-restricted-syntax@6', 'no-restricted-syntax@7',
    ]);
  });

  it('refuses a markSaved in App.tsx without a reasoned disable, and still refuses the reader there', async () => {
    // AUDIT row 477: where App may clear the unsaved-work guard is held here,
    // not by a count over App.tsx's text. The block REPLACES the reader
    // options for App.tsx, so the reader shape must still fire there (line 11).
    const rules = await rulesFor('packages/app/src/App.tsx', READER);
    expect(lint([
      'declare const useDesignDirty: () => Record<string, (m?: string) => void>;',
      'const { markSaved, markFlown } = useDesignDirty(); // where App takes it: not a site',
      "export const onLaunch = () => { markFlown(); markSaved('m'); };",
      'export const sinks = { mark: markSaved };',
      'const { markSaved: ms } = useDesignDirty();',
      'export const onSaveOrk = () => {',
      '  // eslint-disable-next-line no-restricted-syntax -- a .ork is the one format that round-trips everything',
      "  markSaved('m');",
      "  ms('m');",
      '};',
      "export const r = (n: { [k: string]: unknown }, k: string): number => typeof n[k] === 'number' ? (n[k] as number) : 0;",
    ].join('\n'), rules)).toEqual([
      'no-restricted-syntax@3', 'no-restricted-syntax@4', 'no-restricted-syntax@5', 'no-restricted-syntax@11',
    ]);
    // App.tsx only: the hook that defines it, and the tests, are not sites App decides.
    const elsewhere = "export const f = (markSaved: (m: string) => void) => markSaved('m');";
    for (const rel of ['packages/app/src/hooks/useDesignDirty.ts', 'packages/app/src/App.save.test.tsx']) {
      expect(lint(elsewhere, await rulesFor(rel, READER)), rel).toEqual([]);
    }
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

  it('leaves ordinary type narrowing, and a compound test that refuses NaN, alone', async () => {
    // A plain variable is as often a union discriminator as a field read, and
    // an operand of && / || beside a bound or Number.isFinite has a partner
    // that refuses NaN: eslint.config.mjs says why neither is matched.
    const rules = await rulesFor('packages/app/src/tree/treeModel.ts', READER);
    expect(lint([
      'export function f(v: unknown, t: number | string, n: { [k: string]: unknown }): number {',
      "  if (typeof v === 'number' && v > 0) return v;",
      "  const u = typeof t === 'number' ? t : t.length;",
      "  const w = typeof n['w'] === 'number' && Number.isFinite(n['w']) ? (n['w'] as number) * 2 : 0;",
      "  if (typeof n['x'] !== 'number' || !Number.isFinite(n['x'])) return 0;",
      "  if (n['a'] && n['b'] && n['c'] && n['e'] && typeof n['g'] === 'number' && (n['g'] as number) > 1) return 1;",
      "  if (typeof n['y'] !== 'number' || !((n['y'] as number) > 0)) return 0;",
      "  return typeof n['d'] === 'number' && (n['d'] as number) > 0 ? u + w : w;",
      '}',
    ].join('\n'), rules)).toEqual([]);
  });

  it('refuses a compound test with nothing in its chain to refuse NaN (review of audit row 522)', async () => {
    // 15 of main's compound reads were this defect, converted by hand in row
    // 522, and a revert of any of them passed lint while the rule exempted
    // every && / || operand. Lines 2-3 are the review's reproductions; line 5
    // is suppressingAncestor's own shape. Line 6: a bound in an OUTER chain
    // does not cover a test inside a callback, and line 7: a bound inside a
    // callback does not cover the chain around it.
    const rules = await rulesFor('packages/app/src/services/buildAllowance.ts', READER);
    expect(lint([
      'export function f(n: { [k: string]: unknown } | null, xs: { [k: string]: unknown }[]): unknown[] {',
      "  const a = n && typeof n['k'] === 'number' ? (n['k'] as number) : 0.2;",
      "  const b = n?.['t'] !== 'x' && typeof n?.['k'] === 'number';",
      "  const c = typeof n?.['m'] === 'number' || typeof n?.['g'] === 'number';",
      "  const d = xs.find((x) => x['f'] === true && typeof x['v'] === 'number');",
      "  const e = xs.length > 0 && xs.some((x) => x['f'] && typeof x['v'] === 'number');",
      "  const g = typeof n?.['k'] === 'number' && xs.some((x) => (x['v'] as number) > 0);",
      '  return [a, b, c, d, e, g];',
      '}',
    ].join('\n'), rules)).toEqual([
      'no-restricted-syntax@2', 'no-restricted-syntax@3', 'no-restricted-syntax@4', 'no-restricted-syntax@4',
      'no-restricted-syntax@5', 'no-restricted-syntax@6', 'no-restricted-syntax@7',
    ]);
  });

  it('refuses a partner that points the wrong way (re-verification of audit row 522)', async () => {
    // A reject test needs a partner that is TRUE for NaN, an accept test one
    // that is FALSE for it. Each line here hands a NaN through: a bare bound
    // beside a reject test (2, 4), a negated one beside an accept test (3), a
    // negated Number.isFinite beside an accept test (5) and a bare one beside
    // a reject test (6). Line 2 is the shape re-verification put into App.tsx,
    // where it passed the whole gate.
    const rules = await rulesFor('packages/app/src/services/buildAllowance.ts', READER);
    expect(lint([
      'export function f(n: { [k: string]: unknown }): unknown[] {',
      "  const a = typeof n['a'] !== 'number' || (n['a'] as number) <= 0 ? 0.02 : n['a'];",
      "  const b = typeof n['b'] === 'number' && !((n['b'] as number) <= 0);",
      "  const c = typeof n['c'] !== 'number' || (n['c'] as number) < 0 ? 2 : n['c'];",
      "  const d = typeof n['d'] === 'number' && !Number.isFinite(n['d']);",
      "  const e = typeof n['e'] !== 'number' || Number.isFinite(n['e']) ? 1 : n['e'];",
      '  return [a, b, c, d, e];',
      '}',
    ].join('\n'), rules)).toEqual([
      'no-restricted-syntax@2', 'no-restricted-syntax@3', 'no-restricted-syntax@4',
      'no-restricted-syntax@5', 'no-restricted-syntax@6',
    ]);
  });
});
