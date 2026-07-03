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
import { pathToFileURL } from 'node:url';

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
  const mod = await import(pathToFileURL(jsPath).href);
  mod.main();
} finally {
  console.log = origLog;
  process.stdout.write = origWrite;
}
const jsLines = [jsCaptured];

// --- compare ---
const norm = (s) => s.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
const jvm = norm(jvmRaw);
const js = jsLines.flatMap((l) => norm(l));

// Comparison: bit-identical required, EXCEPT numeric fields may differ by a
// small relative tolerance — JS Math transcendentals (pow/log/exp) are not
// bit-specified and differ from Java's by 1-2 ULPs. Everything structural
// (tags, counts, rational arithmetic) still compares exactly.
//
// flight.* lines get a looser budget: per-step ULP noise compounds over
// thousands of RK4 integration steps (observed ~1e-11 relative after 100 s
// of simulated flight; near-zero descent accelerations are worst in relative
// terms, so an absolute floor applies too).
const REL_TOL_DEFAULT = 1e-13;
const REL_TOL_FLIGHT = 1e-9;
const ABS_TOL_FLIGHT = 1e-12;
// Turbulent-wind scenarios are chaotic: per-step ULP noise feeds back through
// the wind lookup and amplifies exponentially (observed ~3e-8 after a full
// gusty flight). Deterministic-seed identity is still verified by the
// series-length lines comparing exactly.
const REL_TOL_TURBULENT = 1e-6;

function linesMatch(a, b) {
  if (a === b) return 'exact';
  if (a === undefined || b === undefined) return false;
  const fa = a.split('|');
  const fb = b.split('|');
  if (fa.length !== fb.length || fa[0] !== fb[0]) return false;
  const isFlight = fa[0].startsWith('flight.');
  const isTurbulent = fa[0].startsWith('flight.conditions');
  const relTol = isTurbulent ? REL_TOL_TURBULENT : isFlight ? REL_TOL_FLIGHT : REL_TOL_DEFAULT;
  const absTol = isFlight ? ABS_TOL_FLIGHT : 0;
  let ulp = false;
  for (let i = 1; i < fa.length; i++) {
    if (fa[i] === fb[i]) continue;
    const na = Number(fa[i]);
    const nb = Number(fb[i]);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    const absDiff = Math.abs(na - nb);
    const denom = Math.max(Math.abs(na), Math.abs(nb));
    if (absDiff > absTol && absDiff / denom > relTol) return false;
    ulp = true;
  }
  return ulp ? 'ulp' : false;
}

let failures = 0;
let ulpLines = 0;
let exactLines = 0;
const n = Math.max(jvm.length, js.length);
for (let i = 0; i < n; i++) {
  const m = linesMatch(jvm[i], js[i]);
  if (m === 'exact') {
    exactLines++;
  } else if (m === 'ulp') {
    ulpLines++;
  } else {
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
console.log(`differential ok: ${n} lines (${exactLines} bit-identical, ${ulpLines} within tolerance — JS Math ULP noise; flight.* lines 1e-9 rel/1e-12 abs, others 1e-13 rel)`);
