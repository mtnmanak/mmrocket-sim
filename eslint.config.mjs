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

// `typeof <member> === 'number'` (or `!==`, `==`, `!=`; `x?.[k]` too): true of
// NaN and of ±Infinity. The no-restricted-syntax rule in the browser-source
// block below refuses it in two shapes; its comment says why and what it
// leaves alone.
const typeofNumber = (operator) => `BinaryExpression[operator=${operator}][left.operator='typeof']`
  + "[left.argument.type=/^(MemberExpression|ChainExpression)$/][right.value='number']";
const TYPEOF_NUMBER = typeofNumber('/^[!=]==?$/');
// Shape 1: standing on its own — the whole test of a conditional or an `if`,
// a value, a return, an arrow body — rather than one operand of `&&` / `||`.
const LONE_TYPEOF_NUMBER = `${TYPEOF_NUMBER}:not(LogicalExpression > BinaryExpression)`;
// Shape 2: one operand of an `&&` / `||` chain that has nothing else in it to
// refuse NaN. What refuses it depends on which way the test points. An ACCEPT
// test (`=== 'number'`) goes on to use the value, so its partner must be FALSE
// for NaN: a bare bound (`<`, `<=`, `>`, `>=`, all false for NaN) or a bare
// Number.isFinite / Number.isInteger. A REJECT test (`!== 'number'`) picks the
// fallback, so its partner must be TRUE for NaN: the same two, negated. A bound
// in a reject chain (`!== 'number' || x <= 0`) or a negated one in an accept
// chain (`=== 'number' && !(x <= 0)`) lets NaN through, and both were exempt
// until re-verification of row 522 found it. esquery's `:has` takes
// ONE `>` step reliably (`:has(> A > B)` matched the wrong nodes in esquery
// 1.7, probed 2026-09-23), so each level of the chain is a :has of its own:
// CHAIN_DEPTH levels are searched, down from each of the test's CHAIN_DEPTH + 1
// nearest && / || ancestors. A deeper chain can only be over-reported, never
// let through; 6 and 12 report the same lines on this tree (2026-09-23).
const NAN_REFUSER = ':matches(BinaryExpression[operator=/^[<>]=?$/], '
  + "CallExpression[callee.object.name='Number'][callee.property.name=/^is(Finite|Integer)$/])";
const CHAIN_DEPTH = 6;
const refuserWithin = (here, depth) => (depth === 0 ? `:matches(${here})`
  : `:matches(${here}, :has(> LogicalExpression${refuserWithin(here, depth - 1)}))`);
const unrefused = (test, here) => `LogicalExpression > ${test}:not(${Array.from({ length: CHAIN_DEPTH + 1 },
  (_, up) => `LogicalExpression${refuserWithin(here, CHAIN_DEPTH)}${' > LogicalExpression'.repeat(up)} > ${test}`)
  .join(', ')})`;
const UNREFUSED_TYPEOF_NUMBER = [
  unrefused(typeofNumber('/^===?$/'), `:has(> ${NAN_REFUSER})`),
  unrefused(typeofNumber('/^!==?$/'), `:has(> UnaryExpression[operator='!']:has(> ${NAN_REFUSER}))`),
].join(', ');
// Both shapes as no-restricted-syntax options. Named because a later block
// that adds entries of its own for one file REPLACES the rule's options there,
// so it has to carry these along (App.tsx's markSaved block).
const NUMBER_READ_RESTRICTIONS = [{
  selector: LONE_TYPEOF_NUMBER,
  message: 'typeof-number accepts NaN and Infinity (typeof NaN is "number"), which the kernel reads '
    + 'as absent. Read the field with num / numOpt / numOrNull from tree/nodeNum.ts.',
}, {
  selector: UNREFUSED_TYPEOF_NUMBER,
  message: 'typeof-number accepts NaN and Infinity (typeof NaN is "number"), and nothing else in this '
    + '&& / || refuses them (a bound or Number.isFinite beside an === test, or one negated beside a !== '
    + 'test). Read the field with num / numOpt / numOrNull '
    + 'from tree/nodeNum.ts; if it is not a design number, say why in an eslint-disable-next-line comment.',
}];

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

      // A number read off a node, a catalogue row or a file through
      // `typeof x[k] === 'number'` (LONE_TYPEOF_NUMBER and
      // UNREFUSED_TYPEOF_NUMBER, top of file). `typeof NaN` is 'number', so
      // the test passes a NaN or an infinite field on as a number — into a
      // saved .ork/.rkt, a cut file, the kernel document engineTree builds, a
      // recommendation, a view — where the kernel itself reads it as ABSENT
      // (JSON.stringify sends null, and ComponentFactory falls back).
      // tree/nodeNum.ts is the one reader (Number.isFinite).
      //
      // How it got to 0. 2026-09-22: fourteen private reader FUNCTIONS folded
      // into nodeNum, and this went on for the reader shape. 2026-09-23 (C3a):
      // the 32 inline reads in the five design-file writers and cut-file
      // exports, under a block of their own. 2026-09-23 (audit row 522): every
      // other one in src, and this replaced both — 54 lone tests, counted with
      // this selector: 46 in shipped source (PropertyPanel 12, treeModel 12,
      // recoverySizing 8, App 4, statedLaunchWeight 2, and componentTable,
      // finAlign, importApply, scaleRocket, simStore, solidContext, solidMesh
      // and useNozzleFollow one each), 4 the writer block's condition-only
      // selector had missed (rocksimFile: two override flags that still wrote
      // <KnownMass>NaN</KnownMass>, a `!==` test, a `parent?.[k]` read), and 4
      // in tests. Each now reads through nodeNum with the fallback it had for
      // an absent value, or — where nodeNum cannot take the object (an
      // interface: importApply's configuration, simStore's run) — through a
      // Number.isFinite test (and rasaeroFile.test asserts on every radius
      // present, so a NaN fails it). Every corpus design opens, lowers to the
      // kernel, sizes, tabulates, exports and renders its property panels
      // byte-identically, since only a non-finite field reads differently.
      //
      // The compound shape, from the review of row 522. The lone rule let
      // every && / || operand through, and 15 of main's compound lines in
      // shipped source were exactly this defect, converted by hand in row 522
      // (PropertyPanel 5, buildAllowance 2, treeModel 2, and componentTable,
      // presets, recoverySizing, ScaleDialog, solidContext and solidMesh) —
      // a revert of any of them passed lint. UNREFUSED_TYPEOF_NUMBER reports
      // all 15 on main's source; on row 522's own tree it found 31 more
      // typeof tests on 24 lines. Converted, as design numbers (12 lines):
      // rocksimFile's base-extension fold, where a NaN override still split
      // the extension out of <BaseExtensionLen> on export, orkFile's
      // keep-the-mark, and nine lines in tests. Kept, each with a disable
      // comment giving its reason at the site (12 lines): the pad-mass
      // records (configSync, padMassReconcile — hardwareMass refuses a
      // non-finite weighing before any arithmetic), the load clamp
      // (sanitize), the scaler's pass-through (scaleRocket), a test's leaf
      // enumerator (scaleRocket.test), the null tests in orkFile's launch
      // reader and the weather chip, the stat chip's position and a set-key
      // count.
      //
      // Tests are included (they read nodes too), and so is packages/engine/src
      // (0 hits; there, test Number.isFinite). NOT matched, on purpose:
      //  - a compound test with a bound (`<`, `<=`, `>`, `>=`) or a
      //    Number.isFinite / Number.isInteger ANYWHERE in its && / || chain,
      //    bare beside an accept test, negated beside a reject test (top of
      //    file). The selector does not check whether the chain is && or ||.
      //    A selector cannot tell whether that partner tests the same value:
      //    scaleRocket's point scaler passes on `p.length >= 2`, a bound on
      //    another number (harmless there — NaN · k is NaN on either branch).
      //    A bound lets +Infinity through, which no source is known to write;
      //  - `typeof v === 'number'` on a plain variable, which is as often a
      //    union discriminator (`number | undefined`, `RktTrigger | number`)
      //    as a field read. The field reads among them went through nodeNum
      //    too (canopyVent's diameter, rocksimFile's shape parameter, the
      //    panel's field value); what is left is a discriminator, the load
      //    clamp's walk (sanitize), or a value validated where it was set.
      'no-restricted-syntax': ['error', ...NUMBER_READ_RESTRICTIONS],
    },
  },

  {
    // App.tsx's `markSaved` (hooks/useDesignDirty.ts) clears the unsaved-work
    // guard, so every place that names it is a place the Open prompt and ✕ New's
    // question can be silenced. Three may: a .ork save, an import and ✕ New —
    // each carries a disable with its reason, and reportUnusedDisableDirectives
    // fails any that stops suppressing a site. Any other reference (a call, a
    // hand-off to a child or a hook, a rename) is an error here. WHY LINT: a new
    // mark is an absence no behavioural test can see unless it drives that
    // action. App.save.test.tsx presses every Save As / Export entry and the
    // flight actions; a mark on Launch passed every test before those
    // were added, and one on the weather dialog's Apply, which no App test
    // presses, still does (AUDIT row 477, review of its fix — the count over
    // App.tsx's text in savedMarkSites.test.ts had been removed). The
    // shorthand destructuring from useDesignDirty is where App takes it, so it
    // is not a site. This block's no-restricted-syntax REPLACES the typeof-number
    // block's options for App.tsx, so it carries them along.
    files: ['packages/app/src/App.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...NUMBER_READ_RESTRICTIONS, {
        selector: "Identifier[name='markSaved']:not(ObjectPattern > Property[shorthand=true] > Identifier)",
        message: 'markSaved clears the unsaved-work guard, so the next Open or ✕ New discards without asking. '
          + 'Only a full-fidelity save (.ork), an import and ✕ New may mark; a new site needs '
          + '`// eslint-disable-next-line no-restricted-syntax -- <why this action may mark>`.',
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
