// ESLint flat config for the whole monorepo.
//
// WHY THIS EXISTS. Ten `// eslint-disable-next-line` comments were sitting in the
// source — seven in src/App.tsx, one in src/components/StatTiles.tsx, two in
// src/services/lemivSweep.test.ts — with NO ESLint installed anywhere in the repo.
// They read as deliberate, reviewed overrides of rules that no tool would ever
// apply. The eight react-hooks/exhaustive-deps ones sit over an app with 111
// non-test hook call sites (42 useEffect, 49 useMemo, 19 useCallback, 1
// useLayoutEffect); the failure they invite is a new effect that copies a
// neighbour's `[physicsKey]` dep array, keeps a stale `launch` closure, and quietly
// simulates the PREVIOUS pad conditions while looking reviewed.
//
// WHY THE RULE SET IS SMALL. `npm run lint` is a deploy gate here — a push to main
// IS the production deploy — and a config that prints hundreds of errors on day one
// gets switched off. Everything below was run against this tree before being turned
// on, and every deviation from the recommended sets names the sites that forced it.
//
// Deliberately NOT enabled, with the measured reason:
//   - the type-aware typescript-eslint CONFIGS (recommendedTypeChecked and up):
//     six type-aware RULES are on, in their own block below, each at 0 hits;
//     recommendedTypeCheckedOnly would add 22 more, none of them measured here
//   - @typescript-eslint/no-non-null-assertion: 4,433 hits (631 outside tests) on
//     2026-09-23, up from 2,902 / 576 on 2026-09-08 as the suites grew; load-bearing
//     under the base tsconfig's noUncheckedIndexedAccess. The figure read "~284"
//     until 2026-09-08, which was 10x low — a reader sizing the cleanup off it would
//     have budgeted an afternoon for a week. It only grows; re-measure before acting
//     on it: npx eslint . --rule '{"@typescript-eslint/no-non-null-assertion":"error"}'
//   - the React-Compiler rules shipped in eslint-plugin-react-hooks v6/v7
//     (set-state-in-effect, purity, immutability, …): only rules-of-hooks and
//     exhaustive-deps are wired up, because those are the two the source already
//     writes suppression comments for
//   - react-refresh/only-export-components: 10 of 35 .tsx modules deliberately export
//     both a component and its helpers so the helpers can be unit-tested
//   - eslint-plugin-jsx-a11y: not installed. Size it with one warn-only run
//     before deciding (audit 2026-09-22)
//   - Prettier: it would rewrite every line and wreck `git blame` on a history this
//     project reads constantly (the CHANGELOG and the audits cite commits)
// (tsconfig.base.json records the one compiler flag declined the same way,
// exactOptionalPropertyTypes.)
//
// TEST FILE NAMES, going forward (audit 2026-09-22; also in README.md):
// `<module>.<aspect>.test.ts` beside the module, `.tsx` when the test renders JSX —
// FinPointsEditor.pointer.test.tsx tests FinPointsEditor.tsx's pointer handling.
// A name whose first segment names no module beside it makes finding a module's
// tests a grep: 33 of the 197 files in packages/app/src did on 2026-09-22. They
// keep their names; renaming buys churn in `git log` and nothing else. A test of
// something that is not a module is named for what it checks: shipped data
// (packages/app/scripts/preset-density.test.mjs), the dependency tree
// (scripts/dependencies.threeTypes.test.mjs reads package-lock.json), and this
// config, whose guard is scripts/eslint-config.guards.test.mjs — not
// eslint.config.*, because vitest's default exclude drops every `*.config.*` file.
//
// The file extension is .mjs because the root package.json has no "type": "module".

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { fileURLToPath } from 'node:url';

// `typeof <member> === 'number'` as the whole test of a conditional or an `if` —
// true of NaN. Used by the two no-restricted-syntax blocks below: the reader
// shape everywhere in src, and any such test at all in the file writers.
const TYPEOF_NUMBER_TEST = "[test.operator='==='][test.left.operator='typeof']"
  + "[test.left.argument.type='MemberExpression'][test.right.value='number']";
const NUMBER_READER_SHAPES = [
  ':function > ConditionalExpression.body',
  ':function > BlockStatement > ReturnStatement > ConditionalExpression.argument',
];

export default tseslint.config(
  {
    // A suppression that suppresses nothing reads to a reviewer as a decision
    // that was made, and 5 of the 13 in this tree had already rotted into that
    // by 2026-09-08 — the config exists BECAUSE ten disables sat honouring no
    // linter for months. Flat config defaults this to 'warn'; as an error the
    // count cannot climb again. The five stale ones were deleted in the same
    // commit that turned this on.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'packages/engine/vendor/**', // TeaVM-compiled kernel artifact — generated, never hand-edited
      'packages/app/src/data/userGuide.ts', // generated by scripts/build-user-guide.mjs from user-guide.md
      'engine-java/**', // Java kernel and its own build scripts; carved sources are never edited
      'validation/**', // published-data harness, run by hand, not part of any gate
      '**/*.d.ts',
      '**/*.d.mts', // else triple-slash/no-undef noise on src/vite-env.d.ts and scripts/manufacturers.d.mts
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Unused declarations, everywhere, one rule. The base rule is off because the
    // typescript-eslint one is the only one that understands `import type` — the live
    // example is tree/treeModel.ts's type-only import of ComponentType. `^_` opt-outs
    // match the convention already in the source (15 underscore-prefixed params).
    // ignoreRestSiblings is explicit rather than left to the default, which flipped to
    // false somewhere in typescript-eslint 8: `const { id, children, ...rest } = node`
    // is the omit idiom this codebase strips ids with (services/orkFile.test.ts's
    // stripIds; scripts/manufacturers.test.mjs's "did not silently collapse two
    // different parts" check), and naming a field in order to DROP it is a
    // use of that name, not dead code.
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
    },
  },

  {
    // ─── Four rules from the recommended sets, retuned against measured sites ───
    //
    // These fire ONLY on code that is deliberate here. Each is documented rather than
    // silently dropped so the next person can see what was checked.
    rules: {
      // 3 hits, all the same thing: a literal U+FEFF inside a regex that strips a BOM
      // from imported file text (the three readers: orkFile.ts importOrk,
      // rasaeroFile.ts importCdx1, rocksimFile.ts importRkt). skipRegExps keeps the
      // rule's real value — a stray non-breaking space in code — without outlawing the
      // character we exist to remove.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],

      // 2 hits (prefs/PrefsContext.tsx's `ok` in the preference writer,
      // services/saveFile.ts's `handle` in saveFile), both the same shape: a defensive
      // initialiser before a try/catch that assigns in both branches. Removing the
      // initialiser is what the rule asks for and is strictly worse — `let handle:
      // FsFileHandle | null = null` is the declaration that gives the variable its type.
      'no-useless-assignment': 'off',

      // 4 hits, each matching a control character on purpose: three in
      // scripts/build-user-guide.mjs's inline(), which uses \x00 and \x01 as
      // sentinels while splitting the user guide, and services/textFold.ts's BREAKS,
      // which folds the \x1c-\x1e separators Python's splitlines() reads as line ends.
      'no-control-regex': 'off',

      // Was a warning over 2 deliberate rethrows (shareLink's decodeShareFragment and
      // thrustcurve's download deadline): Chromium reports a corrupt deflate stream and
      // a stalled body read with messages that name the wrong condition, so the rethrow
      // replaces the MESSAGE. Both now keep the original as `cause` (2026-09-22, pinned
      // by their tests), so the rule costs nothing and refuses the next one.
      'preserve-caught-error': 'error',

      // 4 hits, and 3 are one member of a group of siblings declared together where the
      // others ARE reassigned: tree/solidMesh.ts extrudePolygon's `a` (beside b and c,
      // which the winding-order swap reassigns) and tree/finOutline.ts relativeCcw's
      // dx2/dy2 (beside dpx/dpy/ccw, in a line-for-line transcription of
      // java.awt.geom.Line2D.relativeCCW that is meant to diff against its Java
      // source). Splitting such a group by which member a later branch happens to touch
      // reads worse than the uniform `let`. The fourth is a test's `open`
      // (components/useDialog.test.tsx).
      'prefer-const': 'off',
    },
  },

  {
    // ─── Browser-shipped source ───
    // globals.browser only. That alone does NOT refuse a bare `process` or
    // `require` in .ts: typescript-eslint switches no-undef off there, leaving
    // undefined names to tsc — and packages/engine's tsconfig still sees
    // @types/node. no-restricted-globals below is what makes one a lint error
    // rather than a runtime crash for a user, in both packages.
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // WARN in an editor, but CI runs with --max-warnings 0 (2026-09-22), so a new
      // stale dep array fails the deploy exactly as an error would. The count had sat
      // AT its old ceiling of 8, where one push could clear an old warning, add a real
      // stale closure and stay green. The deliberate exceptions (27 on 2026-09-23:
      // `git grep -c "eslint-disable.*exhaustive-deps" -- packages`) each carry a
      // written reason after `--`, and reportUnusedDisableDirectives above fails any
      // that stops suppressing something.
      'react-hooks/exhaustive-deps': 'warn',
      // The free half of the 2026-09-08 audit's recommendation: all three were
      // MEASURED at zero violations against this tree before being turned on, so
      // each costs nothing today and refuses the next instance. no-explicit-any
      // locks in a genuinely any-free codebase (zero `as any`, zero `: any` and
      // zero tsc-suppression comments, counted the same day). eqeqeq needs the
      // null:'ignore' option
      // to be free — all 105 loose comparisons here are the deliberate `== null`
      // idiom, and plain eqeqeq reports every one of them.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Thousands of non-null assertions, load-bearing under noUncheckedIndexedAccess.
      // The header carries the measured count and the command that re-measures it.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // console.log in shipped code is a leak. warn/error survive because the app
      // reports engine failures through them, and debug because engine/kernelLogSink.ts
      // echoes the TeaVM kernel's stdout there behind an explicit opt-in flag.
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],

      // Node-only globals. typescript-eslint turns no-undef off for .ts, and tsc
      // accepted them while @types/node was visible to the program — as it still
      // is to packages/engine/src; packages/app's shipped source lost it in the
      // 2026-09-22 tsconfig split (packages/app/tsconfig.json). So
      // `Buffer.from(...)` passed typecheck, lint and the (Node-run) tests, then
      // threw ReferenceError in a user's browser — and `process.env.X` read
      // undefined there (Vite rewrites `process.env` to `{}`) while the tests read
      // the real value. isNaN/isFinite coerce (isFinite('') is true), where every
      // number reader here is Number.isFinite by design (tree/nodeNum.ts).
      // 0 hits in shipped source (2026-09-22, audit Step A); the tests block below
      // turns it off, because tests DO run under Node.
      'no-restricted-globals': ['error',
        ...['process', 'Buffer', 'require', '__dirname', '__filename', 'global', 'setImmediate']
          .map((name) => ({ name, message: `${name} is Node-only: it does not exist in the browser this source ships to.` })),
        { name: 'isNaN', message: 'Global isNaN coerces its argument. Use Number.isNaN, or num/numOrNull (tree/nodeNum.ts).' },
        { name: 'isFinite', message: "Global isFinite coerces its argument (isFinite('') is true). Use Number.isFinite." },
      ],
      // The rest of Step A, each measured at 0 hits in shipped source the same
      // day, so each is a pure ratchet. The one test-side hit is no-new-func in
      // src/tree/cluster.test.ts, which evaluates the carved Java source's own
      // constant expressions and carries a reasoned suppression. The rules: code
      // from a string (eval, new Function, a string handed to setTimeout);
      // parseInt without a radix; x !== x as a NaN test; a loop that can only
      // run once; a map/filter callback that forgets to return; throwing a
      // non-Error (no stack, no `cause`); for-in without an own-property guard
      // (the prototype-key class services/xmlUtil.ts lookupTable closes);
      // assignment hidden in a return or a comma expression; a = b = c; labels;
      // arguments.caller; extending a built-in prototype; new Number/String/Boolean.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      radix: 'error',
      'no-self-compare': 'error',
      'no-unreachable-loop': 'error',
      'array-callback-return': 'error',
      'no-throw-literal': 'error',
      'guard-for-in': 'error',
      'no-return-assign': 'error',
      'no-sequences': 'error',
      'no-multi-assign': 'error',
      'no-labels': 'error',
      'no-caller': 'error',
      'no-extend-native': 'error',
      'no-new-wrappers': 'error',

      // A private node-number reader: a function whose whole answer is
      // `typeof n[k] === 'number' ? n[k] : fb`. `typeof NaN` is 'number', so
      // that shape passes a NaN field on as a number — into a reference area, a
      // view, or (before the writer block below) a saved file. tree/nodeNum.ts
      // is the one reader (Number.isFinite); fourteen copies outlived its
      // 2026-09-08 consolidation and were folded into it on 2026-09-22, which
      // is when this went on, at 0. Here it matches the READER shape (an arrow
      // body, or a function's top-level return), not every inline test. Outside
      // the writers, 34 inline `typeof x[k] === 'number' ?` reads remain
      // (PropertyPanel 10, treeModel 10, recoverySizing 8, six files with one
      // each) and 3 `if (typeof x[k] === 'number')` (treeModel 2, importApply
      // 1), counted 2026-09-23. Converting those is a separate sitting — they
      // sit in the files every other change touches.
      'no-restricted-syntax': ['error', ...NUMBER_READER_SHAPES.map((reader) => ({
        selector: `${reader}${TYPEOF_NUMBER_TEST}`,
        message: 'A local typeof-number reader accepts NaN (typeof NaN is "number"). '
          + 'Import num / numOpt / numOrNull from tree/nodeNum.ts instead.',
      }))],
    },
  },

  {
    // The design-file writers and the cut-file exports refuse the INLINE test
    // as well, as the test of any conditional or `if` in the file:
    // `typeof node['cd'] === 'number' ? node['cd'] : 'auto'` wrote <cd>NaN</cd>
    // into a saved .ork for a NaN field, `if (typeof node['overrideMass'] ===
    // 'number')` wrote <overridemass>NaN</overridemass>, and finTemplate's
    // label printed "cut NaN" / "thickness NaN mm" on a sheet meant to be cut
    // from. Their 32 such reads (orkFile 18, rocksimFile 10, rasaeroFile 2,
    // finTemplate 2; dxfExport had none) went through nodeNum on 2026-09-23 —
    // every import, export, template and DXF byte-identical over the 21
    // committed fixtures and the 108 local tester uploads, since only a
    // non-finite field reads differently — so this is on at 0. A compound test
    // is not matched; of those in these files all but three refuse NaN in
    // their second half (a `>`/`>=` bound, or an `===`), and the three
    // (`|| typeof …`, `&& v !== 0`) are import-side and only decide whether to
    // keep a mark or fold a part. This block's no-restricted-syntax REPLACES
    // the reader block's options for these files rather than adding to them,
    // which is why its selector is the broad one: it covers the reader shape
    // as well.
    files: ['packages/app/src/services/{orkFile,rocksimFile,rasaeroFile,finTemplate,dxfExport}.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: `:matches(ConditionalExpression, IfStatement)${TYPEOF_NUMBER_TEST}`,
        message: 'typeof-number accepts NaN (typeof NaN is "number"), and this file writes what it reads '
          + 'into a design or cut file. Use num / numOpt / numOrNull from tree/nodeNum.ts.',
      }],
    },
  },

  {
    // ─── Type-aware rules (audit 2026-09-22, Step C) ───
    // The failures a syntax-only lint cannot see, because they turn on a TYPE:
    //   no-floating-promises   an async call nobody awaits or catches. A
    //                          rejection there is a button that silently does
    //                          nothing — the defect the 2026-09-22 audit found in
    //                          the STL/print-pack and image exports.
    //   no-misused-promises    an async function handed to something that ignores
    //                          its promise (an onClick). JSX attributes stay
    //                          CHECKED: `() => { void f(); }` is the marker that
    //                          says f reports its own failures, and the one
    //                          handler that is written inline carries a reasoned
    //                          disable (PropertyPanel's print export).
    //   await-thenable, only-throw-error, restrict-plus-operands   free (0 hits).
    //   switch-exhaustiveness-check   a switch over a union that neither lists
    //                          every member nor has a default. The two it found
    //                          were benign; orkFile's emitNode now LISTS 'stage'
    //                          rather than taking a default, so a component type
    //                          added later fails here instead of silently
    //                          dropping out of saved .ork files.
    // Measured 2026-09-22 at 3918947 + this package: 3 floating, 4 misused and
    // 2 non-exhaustive, all fixed first (the audit's a7756c5 counts were 6/4/2;
    // two App.tsx sites had been fixed since).
    //
    // COST: the parser now builds a TypeScript program per project. `npx eslint .`
    // went from 7.6 s to 20.1 s here (median of three, same machine and tree; a
    // cold first run took 34.6 s) — about 2.6x, the ratio the audit measured at
    // a7756c5 (4.9 s to 12.6 s). CI runs it after `npm run typecheck`, which
    // has built the engine's dist/index.d.ts that the app imports; run locally
    // WITHOUT that build, engine imports resolve to error types and these rules
    // see less. Each file's program is its own tsconfig project: tsconfig.app,
    // tsconfig.test or packages/engine's (packages/app/tsconfig.json says why).
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      // Not import.meta.dirname: that needs Node 20.11, and the README promises 20.
      parserOptions: { projectService: true, tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)) },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      // only-throw-error is no-throw-literal with the type information to see
      // through a variable; running both reports one throw twice.
      'no-throw-literal': 'off',
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    },
  },

  {
    // src/tree/ is the geometry layer — no file under it imports React (the one
    // "react" match, in tree/pieces.ts's header, is a comment about keeping
    // @react-three out of the entry bundle). The plugin reads ANY call to a function
    // named `use` as React's `use` hook, and tree/solidMesh.ts's isWatertight() calls
    // a local edge-counting helper called `use()` three times. Three false errors;
    // exhaustive-deps stays on, since it only fires on real hook calls.
    files: ['packages/app/src/tree/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },

  {
    // ─── Node-side build scripts and config ───
    // They legitimately read the disk and print progress.
    files: [
      'scripts/**/*.mjs',
      'packages/app/scripts/**/*.mjs',
      'eslint.config.mjs',
      '**/vite.config.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },

  {
    // packages/app/scripts/manufacturers.mjs is the ONE file in a directory of Node-only
    // build scripts that is ALSO imported by browser code (src/services/presets.ts and
    // src/services/recoverySizing.ts), so it ships inside the app bundle — `grep -c
    // semrocastronautics` finds it in the entry chunk. It is browser-safe today only
    // because it has zero imports, and 12 of its 14 sibling scripts import node:
    // builtins, so adding one here is the natural and wrong move. Nothing else would
    // catch it: vitest runs it under Node, tsc never reads the .mjs (it reads the
    // hand-written manufacturers.d.mts beside it), and vite would externalise node:fs
    // with a warning nobody reads in CI. The app would then throw on the first preset
    // match — the moment a user opens a .ork with a <PartMfg> in it.
    // manufacturers.browserSafe.test.mjs scans the source text for the same thing and
    // catches dynamic import() and require(), which this rule does not see.
    files: ['packages/app/scripts/manufacturers.mjs'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['node:*', 'fs', 'path', 'url', 'os', 'crypto', 'child_process'],
          message:
            'manufacturers.mjs is bundled into the browser app (imported by src/services/presets.ts '
            + 'and src/services/recoverySizing.ts). A node: import here deploys a module that throws '
            + 'on the first preset match. Put pipeline-only code in a sibling script instead.',
        }],
      }],
    },
  },

  {
    // Tests run under Node (vitest), some under happy-dom, and a few print measured
    // sweep numbers on purpose (services/lemivSweep.test.ts) — which is why
    // no-console is off here rather than suppressed line by line.
    // no-restricted-globals is off because the tests run under Node, and 11 sites
    // read `process` on purpose (unhandledRejection hooks, and process.cwd() to
    // find the repo's fixtures).
    files: ['**/*.test.{ts,tsx,mts,mjs,js}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },
);
