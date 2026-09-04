/**
 * manufacturers.mjs ships to browsers. Nothing else in the toolchain knows that.
 *
 * It sits in packages/app/scripts/, a directory of 14 Node-only pipeline scripts of
 * which 12 import `node:` builtins — but it is ALSO imported by two app modules that
 * run in the browser (src/services/presets.ts imports mfrKey and partKey,
 * src/services/recoverySizing.ts imports mfrKey), so vite bundles it into the entry
 * chunk. It is browser-safe today for exactly one reason: it has zero imports.
 *
 * Adding `import { readFileSync } from 'node:fs'` here is the natural move — every
 * sibling script in the same folder does it — and every gate that guards the deploy
 * would stay green while it happened:
 *
 *   - `npm test` runs this file under Node, where node:fs resolves fine
 *   - `tsc -b` never reads the .mjs; tsconfig has no allowJs, so the app's view of
 *     this module is the hand-written manufacturers.d.mts beside it
 *   - `vite build` externalises node:fs with a warning nobody reads in CI
 *
 * The deployed app would then throw on the first preset match — the moment a user
 * opens a .ork or .rkt with a <PartMfg> in it. This file is the guard; the ESLint
 * config carries a matching no-restricted-imports rule for the static-import case,
 * and the source scan below is what catches a dynamic import() or a require().
 *
 * The second test guards the OTHER half of the same arrangement: manufacturers.d.mts
 * is hand-written and is the only thing tsc checks the app's imports against, so a
 * rename in the .mjs that is not mirrored there compiles clean and fails at runtime.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mfr from './manufacturers.mjs';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const IMPL = readFileSync(here('./manufacturers.mjs'), 'utf8');
const DECL = readFileSync(here('./manufacturers.d.mts'), 'utf8');

// Node builtins that would each break the browser bundle. `node:`-prefixed and bare
// forms both, because vite treats them the same way and both resolve under vitest.
const NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https',
  'module', 'os', 'path', 'process', 'stream', 'url', 'util', 'worker_threads', 'zlib',
];

describe('scripts/manufacturers.mjs is browser-safe (it is bundled into the app)', () => {
  it('imports nothing at all — static, dynamic or require', () => {
    // Strip block and line comments first: the prose above a script legitimately
    // talks about imports, and matching that would make this test unfalsifiable.
    const code = IMPL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const statics = [...code.matchAll(/^\s*import\b[^\n]*/gm)].map((m) => m[0].trim());
    expect(statics, 'manufacturers.mjs must stay import-free; it ships in the browser bundle')
      .toEqual([]);

    const dynamics = [...code.matchAll(/\bimport\s*\(/g)].map((m) => m[0]);
    expect(dynamics, 'a dynamic import() here still pulls the module into the browser graph')
      .toEqual([]);

    const requires = [...code.matchAll(/\brequire\s*\(/g)].map((m) => m[0]);
    expect(requires, 'require() is not defined in the browser bundle').toEqual([]);
  });

  it('names no Node builtin as a module specifier', () => {
    const code = IMPL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A specifier is a quoted string, so match only quoted forms — `path` and `url`
    // are ordinary words that a comment or a variable name may legitimately use.
    const named = NODE_BUILTINS.filter(
      (b) => new RegExp(`['"\`](?:node:)?${b}['"\`]`).test(code),
    );
    expect(named, 'no Node builtin may be referenced from a browser-bundled module')
      .toEqual([]);
  });

  it('touches no Node-only global', () => {
    const code = IMPL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // These are the ones that survive a bundle silently and throw on first use in a
    // browser: `process.env`, `__dirname`, `Buffer.from`.
    expect(/\bprocess\s*\./.test(code), 'process is undefined in the browser bundle').toBe(false);
    expect(/\b__dirname\b|\b__filename\b/.test(code), 'CJS path globals do not exist here')
      .toBe(false);
    expect(/\bBuffer\s*\./.test(code), 'Buffer is Node-only; use Uint8Array').toBe(false);
  });

  it('has the two app consumers it is documented as having', () => {
    // If these imports ever go away, this whole guard can be dropped and the module
    // can rejoin its Node-only siblings. Until then, the constraint is real.
    const presets = readFileSync(here('../src/services/presets.ts'), 'utf8');
    const recovery = readFileSync(here('../src/services/recoverySizing.ts'), 'utf8');
    expect(presets).toMatch(/from '\.\.\/\.\.\/scripts\/manufacturers\.mjs'/);
    expect(recovery).toMatch(/from '\.\.\/\.\.\/scripts\/manufacturers\.mjs'/);
  });
});

describe('manufacturers.d.mts is the only type surface tsc sees — keep it in step', () => {
  const declared = [
    ...DECL.matchAll(/^export\s+(?:declare\s+)?(?:const|function|let|var)\s+([A-Za-z_$][\w$]*)/gm),
  ].map((m) => m[1]).sort();

  it('declares every runtime export, and nothing that does not exist', () => {
    const runtime = Object.keys(mfr).sort();
    // Equality both ways on purpose. A declaration with no implementation typechecks
    // and then throws `undefined is not a function`; an implementation with no
    // declaration is invisible to the app and cannot be imported from src at all.
    expect(declared).toEqual(runtime);
  });

  it('every declared name is actually callable or readable at runtime', () => {
    for (const name of declared) {
      expect(mfr[name], `${name} is declared in manufacturers.d.mts but is undefined`)
        .toBeDefined();
    }
  });
});
