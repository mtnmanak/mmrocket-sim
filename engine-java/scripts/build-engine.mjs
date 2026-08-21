#!/usr/bin/env node
/**
 * Builds the TeaVM JS engine artifact and copies it into
 * packages/engine/vendor/orkengine.mjs (committed — consumers of the npm
 * workspace don't need a JDK; regenerate with `npm run engine:js`).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..');
const repoRoot = resolve(engineRoot, '..');

function findJavaHome() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  // Don't hardcode a JDK dir name — each machine's portable install carries its
  // own patch version. Take the newest jdk-17* under ~/.online-openrocket.
  const portableRoot = join(homedir(), '.online-openrocket');
  if (existsSync(portableRoot)) {
    const jdks = readdirSync(portableRoot).filter((d) => d.startsWith('jdk-17')).sort();
    if (jdks.length) return join(portableRoot, jdks[jdks.length - 1]);
  }
  console.error('No JDK found. Set JAVA_HOME (portable JDK expected at ~/.online-openrocket; re-fetch Temurin 17 via the Adoptium API).');
  process.exit(1);
}

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
copyFileSync(src, join(dstDir, 'orkengine.mjs'));
console.log('engine artifact -> packages/engine/vendor/orkengine.mjs');
