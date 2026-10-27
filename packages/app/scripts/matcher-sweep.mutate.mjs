// Hand-run, sequential mutation guards. Every file is restored in finally;
// test process exit codes are captured directly, with a full log per mutant.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const mutations = [
  ['g80-equivalence', 'motorDb.ts', 'if (target && fits(target) && equivalentG80(whole.motor, target))', 'if (false)'],
  ['g80-maker', 'motorDb.ts', "(!manufacturer?.trim() || /^(unknown|custom)$/i.test(manufacturer.trim()))", 'true'],
  ['g80-overlay', 'motorMatchPolicy.ts', 'Math.abs(from[k] - to[k]) < 1e-9', 'true'],
  ['g80-sync-selection', 'motorDb.ts', 'return match?.curveEquivalent ?? match?.motor ?? null;', 'return match?.motor ?? null;'],
  ['j360-capacity', 'motorDb.ts', 'm.diameter > context!.mountBoreMm! + 1.5));', 'false));'],
  ['j360-adapter', 'motorDb.ts', 'm.diameter > context!.mountBoreMm! + 1.5));', 'Math.abs(m.diameter - context!.mountBoreMm!) > 1.5));'],
  ['j360-cross-tier', 'motorDb.ts', "if (/^j360[- _]*sk$/i.test(want) && best.m.manufacturerAbbrev === 'Cesaroni')", 'if (false)'],
  ['g69-history', 'motorDb.ts', "if (whole && want === 'g69'", "if (whole && want === 'never-g69'"],
  ['k700-selection', 'motorDb.ts', '? MOTOR_MATCH_POLICY.blackBearK700 : null;', '? null : null;'],
  ['physical-mass', 'motorMatchPolicy.ts', 'Math.abs(p.motorMassG - m.totalWeightG) <= 0.02 * m.totalWeightG', 'true'],
  ['physical-burn', 'motorMatchPolicy.ts', 'Math.abs(p.burnTimeS - m.burnTimeS) <= 0.05 * m.burnTimeS', 'true'],
  ['physical-source', 'motorMatchPolicy.ts', "context?.source === 'rocksim'", 'true'],
  ['explicit-p', 'motorDb.ts', "t === 'p' ? 'p' :", "t === 'never' ? 'p' :"],
  ['e31-selection', 'motorDb.ts', '? MOTOR_MATCH_POLICY.whiteThunderE31', '? null'],
  ['h135-identity', 'motorDb.ts', 'if (complete && exact.length === 1)', 'if (false)'],
  ['h135-complete', 'motorDb.ts', 'if (complete && exact.length === 1)', 'if (exact.length === 1)'],
  ['h135-unique', 'motorDb.ts', 'if (complete && exact.length === 1)', 'if (complete && exact.length >= 1)'],
  ['rkt-version', 'rocksimMotorEvidence.ts', "fileVersion !== 4", 'false'],
  ['rkt-stage', 'rocksimMotorEvidence.ts', "fileVersion !== 4 || stageCount !== 1", 'fileVersion !== 4 || false'],
  ['rkt-dry-provenance', 'rocksimMotorEvidence.ts', "useKnownMass !== 1", 'false'],
  ['rkt-multiple-sets', 'rocksimMotorEvidence.ts', "if (stageCount !== 1 || !sim\n    || engineSetCount(sim, index) !== 1", 'if (stageCount !== 1 || !sim\n    || false'],
  ['rkt-indexed-count', 'rocksimMotorEvidence.ts', 'index.simulationSets.get(sim)?.length ?? 0', 'index.simulationSets.get(sim)?.length ?? 1'],
  ['rkt-evidence-multiple-sets', 'rocksimMotorEvidence.ts', "useKnownMass !== 1 || !sim\n    || engineSetCount(sim, index) !== 1", 'useKnownMass !== 1 || !sim\n    || false'],
  ['rkt-cluster', 'rocksimMotorEvidence.ts', "|| value(engineSet, 'EngineCount') !== 1) return undefined;", ') return undefined;'],
  ['rkt-ignition', 'rocksimMotorEvidence.ts', "const burn = value(sim, 'TimeToBurnout') - ignition;", "const burn = value(sim, 'TimeToBurnout');"],
  ['rkt-context', 'rocksimFile.ts', 'const matchContext = rocksimMotorEvidence(engineSet, motorIndex);', 'const matchContext = undefined;'],
  ['config-evidence-folding', 'rocksimFile.ts', '? JSON.stringify(r.matchContext) :', "? '' :"],
  ['every-delay-context', 'rocksimFile.ts', 'findDbMotor(designation, undefined, catalogue, manufacturer, context)', 'findDbMotor(designation, undefined, catalogue, manufacturer)'],
  ['rasaero-context', 'rasaeroFile.ts', "eng.delay !== undefined\n          ?", "false\n          ?"],
  ['rasaero-subtraction', 'rasaeroFile.ts', 'findDbMotor(ref.designation, undefined, undefined, ref.manufacturer, ref.matchContext)', 'findDbMotor(ref.designation, undefined, undefined, ref.manufacturer)'],
  ['open-note', 'motorMatch.ts', 'const openNote = unconfirmedMatchNote(ref, dbMatch, how);', 'const openNote = undefined;'],
  ['j360-note-certainty', 'motorMatch.ts', 'plausible alternative for this incomplete identity', 'confirmed identical motor'],
  ['sweep-parse', '../scripts/matcher-sweep.classify.mjs', " || b.status !== 'ok' || c.status !== 'ok'", ''],
  ['sweep-missing-file', '../scripts/matcher-sweep.classify.mjs', "if (pairs.size !== meta.expectedFiles) failures.push('Missing file records');", ''],
  ['sweep-hidden-ref', '../scripts/matcher-sweep.classify.mjs', 'if (unmatchedImporterRefs.length)', 'if (false)'],
  ['sweep-oracle', '../scripts/matcher-sweep.classify.mjs', "'none→wrong', 'UNVERIFIABLE']", "'none→wrong']"],
  ['sweep-right-wrong', '../scripts/matcher-sweep.classify.mjs', "['right→wrong', 'right→nothing', 'none→wrong', 'UNVERIFIABLE']", "['right→nothing', 'none→wrong', 'UNVERIFIABLE']"],
  ['sweep-right-nothing', '../scripts/matcher-sweep.classify.mjs', "['right→wrong', 'right→nothing', 'none→wrong', 'UNVERIFIABLE']", "['right→wrong', 'none→wrong', 'UNVERIFIABLE']"],
  ['sweep-none-wrong', '../scripts/matcher-sweep.classify.mjs', "['right→wrong', 'right→nothing', 'none→wrong', 'UNVERIFIABLE']", "['right→wrong', 'right→nothing', 'UNVERIFIABLE']"],
];
export function replaceMutationAnchor(source, anchor, replacement, name) {
  const hits = source.split(anchor).length - 1;
  if (hits !== 1) throw new Error(`Mutation anchor ${name}: expected 1 hit, found ${hits}`);
  return source.replace(anchor, replacement);
}

const testOf = (file) => (file.startsWith('../scripts/') ? 'scripts/matcher-sweep.test.mjs' : 'src/services/motorMatch.policy.test.ts');

/**
 * Runs the selected mutants (all when `names` is empty) and returns the exit
 * code. Each target suite must pass unmutated first: a stale mutant left by an
 * interrupted run, or an already-red suite, would otherwise count as killed.
 */
export function runMutations(names = [], {
  root = process.cwd(), vitest = fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
  spawn = spawnSync, read = readFileSync, write = writeFileSync, mkdir = mkdirSync, log = console.log,
} = {}) {
  const out = `${root}/.matcher-sweep/mutations`;
  const selected = mutations.filter(([name]) => !names.length || names.includes(name));
  const vitestRun = (test) => spawn(process.execPath, [vitest, 'run', test, '--maxWorkers', '1'],
    { cwd: `${root}/packages/app`, encoding: 'utf8', timeout: 60000 });
  mkdir(out, { recursive: true });
  for (const test of new Set(selected.map(([, file]) => testOf(file)))) {
    const p = vitestRun(test);
    write(`${out}/baseline-${test.replace(/[/.]/g, '_')}.log`, (p.stdout ?? '') + (p.stderr ?? ''));
    if (p.status !== 0) {
      log(`baseline ${test}: exit ${p.status}; restore the sources and fix the suite before mutating`);
      return 1;
    }
  }
  const results = [];
  for (const [name, file, old, replacement] of selected) {
    const path = file.startsWith('../scripts/') ? `${root}/packages/app/scripts/${file.slice('../scripts/'.length)}` : `${root}/packages/app/src/services/${file}`;
    const source = read(path, 'utf8');
    const mutated = replaceMutationAnchor(source, old, replacement, name);
    try {
      write(path, mutated);
      const p = vitestRun(testOf(file));
      write(`${out}/${name}.log`, (p.stdout ?? '') + (p.stderr ?? ''));
      const killed = p.status === 1 && /AssertionError/.test((p.stdout ?? '') + (p.stderr ?? ''));
      results.push({ name, exit: p.status, killed });
      log(`${name}: exit ${p.status}, ${killed ? 'killed' : 'SURVIVED/INVALID'}`);
    } finally { write(path, source); }
  }
  write(`${out}/results.json`, JSON.stringify(results, null, 2));
  return results.every(r => r.killed) ? 0 : 1;
}

// Importing the anchor guards for tests must not launch mutations.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = runMutations(process.argv.slice(2));
