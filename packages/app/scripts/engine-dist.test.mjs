/**
 * The engine package's build output, packages/engine/dist — what its package.json
 * `exports` hands the app — holds the package and no test code (audit 2026-09-30,
 * Step 8). The engine build compiled the whole of src/ in one `tsc -p`, so every
 * src/*.test.ts landed in dist/ beside the entry (18 test files, each as .js, .d.ts
 * and two maps); and since tsc never deletes an output whose source is gone, a
 * deleted test lived on there too: a dist/__zzA3Verify.test.js that no commit ever
 * held. Vitest 4 and later collect a test file under dist/ unless told not to,
 * which is why packages/engine/vitest.config.ts excludes it.
 *
 * Now the build empties dist/ first, compiles src/ through tsconfig.build.json,
 * which leaves the tests out, and typechecks them through tsconfig.test.json,
 * which emits nothing — so CI still refuses a type error in an engine test, as it
 * did when the build compiled them. `npm test` (CI's included) builds the engine
 * just before this suite runs, so the first test reads the dist/ that build made.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const ENGINE = new URL('../../engine/', import.meta.url);
const DIST = new URL('dist/', ENGINE);

describe('packages/engine/dist — the engine build ships the package and no test code', () => {
  it('holds the package entry and no *.test.* file', () => {
    expect(existsSync(DIST), 'no packages/engine/dist: run `npm run build -w @online-openrocket/engine`').toBe(true);
    const files = readdirSync(DIST, { recursive: true, encoding: 'utf8' });
    // The entry first, so an empty or half-written dist/ cannot pass the second check.
    expect(files).toEqual(expect.arrayContaining(['index.js', 'index.d.ts']));
    expect(files.filter((f) => /\.test\./.test(f)), 'test code in packages/engine/dist').toEqual([]);
  });

  it('empties dist/ before it compiles, and typechecks the tests without emitting them', () => {
    // The order is the mechanism: the clean runs before anything writes into
    // dist/, and the tests' typecheck is a step of its own now that the src/
    // build no longer sees them — drop it and nothing reports a type error in
    // an engine test (vitest transpiles without checking).
    const { scripts } = JSON.parse(readFileSync(new URL('package.json', ENGINE), 'utf8'));
    expect(scripts.build.split('&&').map((s) => s.trim())).toEqual([
      `node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"`,
      'tsc -p tsconfig.build.json',
      'tsc -p tsconfig.test.json',
      'tsc -p tsconfig.node.json',
    ]);
  });
});
