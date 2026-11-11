#!/usr/bin/env node
/**
 * Builds the TeaVM JS engine artifact and copies it into
 * packages/engine/vendor/orkengine.mjs (committed — consumers of the npm
 * workspace don't need a JDK; regenerate with `npm run engine:js`).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../../packages/app/scripts/atomic-write.mjs';
import { findJavaHome } from '../../scripts/machine-profile.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..');
const repoRoot = resolve(engineRoot, '..');

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
execFileSync(join(engineRoot, gradlew), ['generateJavaScript', '--console=plain'], {
  cwd: engineRoot,
  env: { ...process.env, JAVA_HOME: findJavaHome() },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const src = join(engineRoot, 'build', 'generated', 'teavm', 'js', 'online-openrocket-engine-java.js');
const dstDir = join(repoRoot, 'packages', 'engine', 'vendor');
mkdirSync(dstDir, { recursive: true });
atomicWriteFileSync(join(dstDir, 'orkengine.mjs'), readFileSync(src));
console.log('engine artifact -> packages/engine/vendor/orkengine.mjs');
