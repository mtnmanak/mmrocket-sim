#!/usr/bin/env node
/**
 * Differential test: run harness.GoldenMain on the JVM and under TeaVM-JS in
 * Node, and require BIT-IDENTICAL output. Any diff is a fidelity break
 * (miscompile, semantics divergence, or an unported dependency).
 *
 * Prereqs: `gradlew generateJavaScript` already run; JAVA_HOME or the
 * .online-openrocket portable JDK available.
 *
 * Usage: node scripts/difftest.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..');

// --- locate a JDK ---
function findJavaHome() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const portable = join(homedir(), '.online-openrocket', 'jdk-17.0.19+10');
  if (existsSync(portable)) return portable;
  console.error('No JDK found. Set JAVA_HOME or run scripts/setup-jdk.ps1');
  process.exit(1);
}
const javaHome = findJavaHome();
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

// --- JVM reference output (quiet gradle, harness output only) ---
const jvmRaw = execFileSync(join(engineRoot, gradlew), ['goldenJvm', '--quiet', '--console=plain'], {
  cwd: engineRoot,
  env: { ...process.env, JAVA_HOME: javaHome },
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

// --- TeaVM-JS output, capturing stdout ---
const jsPath = join(engineRoot, 'build', 'generated', 'teavm', 'js', 'online-openrocket-engine-java.js');
if (!existsSync(jsPath)) {
  console.error(`TeaVM output missing: ${jsPath} — run gradlew generateJavaScript first.`);
  process.exit(1);
}
// TeaVM's Node runtime writes to process.stdout directly (not console.log) —
// hook both to be safe.
let jsCaptured = '';
const origLog = console.log;
const origWrite = process.stdout.write.bind(process.stdout);
console.log = (msg) => { jsCaptured += String(msg) + '\n'; };
process.stdout.write = (chunk) => { jsCaptured += String(chunk); return true; };
try {
  createRequire(import.meta.url)(jsPath).main();
} finally {
  console.log = origLog;
  process.stdout.write = origWrite;
}
const jsLines = [jsCaptured];

// --- compare ---
const norm = (s) => s.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
const jvm = norm(jvmRaw);
const js = jsLines.flatMap((l) => norm(l));

let failures = 0;
const n = Math.max(jvm.length, js.length);
for (let i = 0; i < n; i++) {
  if (jvm[i] !== js[i]) {
    if (failures < 10) {
      console.error(`DIFF line ${i + 1}:\n  jvm: ${jvm[i] ?? '<missing>'}\n  js : ${js[i] ?? '<missing>'}`);
    }
    failures++;
  }
}

if (failures) {
  console.error(`\nDIFFERENTIAL FAILURE: ${failures} mismatched line(s) of ${n}.`);
  process.exit(1);
}
console.log(`differential ok: ${jvm.length} lines bit-identical (JVM vs TeaVM-JS)`);
