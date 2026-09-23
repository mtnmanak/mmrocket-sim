/**
 * The three.js TYPES must describe the three.js the app RUNS (audit 2026-09-22).
 *
 * three is 0.x, and its minor version is its major: 0.169 -> 0.185 renames and
 * removes API. The app ran three 0.169 while typechecking against
 * @types/three 0.185, so tsc would pass a call that exists only in 0.185 and
 * the 3D view or an STL/GLB export would throw in a user's browser. Worse, the
 * app's direct devDependency is not the only copy: drei's maath and stats-gl
 * depend on @types/three too, and a second version in the tree splits the
 * program in two — the first attempt at this pin produced 12 errors of the
 * form "Vector2 is not assignable to type Vector2". Root package.json's
 * `overrides` holds every copy to the one version.
 *
 * Read from package-lock.json, which is exactly what `npm ci` installs in CI,
 * and from three's own REVISION, which is what the bundle ships.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { REVISION } from 'three';

const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
const entries = Object.entries(lock.packages);

describe('@types/three matches the three the app ships', () => {
  it('has one copy of the types, at the minor version of the runtime', () => {
    const copies = entries.filter(([path]) => path.endsWith('node_modules/@types/three'));
    expect(copies.map(([path]) => path)).toEqual(['node_modules/@types/three']);
    const typesMinor = copies[0][1].version.split('.')[1];
    expect(typesMinor).toBe(REVISION);
    expect(lock.packages['node_modules/three'].version.split('.')[1]).toBe(REVISION);
  });
});
