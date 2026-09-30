// Hand-run, sequential mutation guards. Every file is restored in finally;
// test process exit codes are captured directly, with a full log per mutant.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const out = `${root}/.matcher-sweep/mutations`;
mkdirSync(out, { recursive: true });
const mutations = [
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
  ['rkt-version', 'rocksimMotorEvidence.ts', "value(doc.documentElement, 'FileVersion') !== 4", 'false'],
  ['rkt-stage', 'rocksimMotorEvidence.ts', "value(design, 'StageCount') !== 1", 'false'],
  ['rkt-dry-provenance', 'rocksimMotorEvidence.ts', "value(design, 'UseKnownMass') !== 1", 'false'],
  ['rkt-multiple-sets', 'rocksimMotorEvidence.ts', "sim.querySelectorAll('EngineSet').length !== 1", 'false'],
  ['rkt-cluster', 'rocksimMotorEvidence.ts', "value(engineSet, 'EngineCount') !== 1", 'false'],
  ['rkt-ignition', 'rocksimMotorEvidence.ts', "value(sim, 'TimeToBurnout') - ignition", "value(sim, 'TimeToBurnout')"],
  ['rkt-context', 'rocksimFile.ts', 'const matchContext = rocksimMotorEvidence(doc, engineSet);', 'const matchContext = undefined;'],
  ['config-evidence-folding', 'rocksimFile.ts', '? JSON.stringify(r.matchContext) :', "? '' :"],
  ['every-delay-context', 'rocksimFile.ts', 'findDbMotor(designation, undefined, undefined, manufacturer, context)', 'findDbMotor(designation, undefined, undefined, manufacturer)'],
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
const results = [];
for (const [name, file, old, replacement] of mutations) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  const path = file.startsWith('../scripts/') ? `${root}/packages/app/scripts/${file.slice('../scripts/'.length)}` : `${root}/packages/app/src/services/${file}`;
  const source = readFileSync(path, 'utf8');
  if (!source.includes(old)) throw new Error(`Missing mutation anchor: ${name}`);
  try {
    writeFileSync(path, source.replace(old, replacement));
    const test = file.startsWith('../scripts/') ? 'scripts/matcher-sweep.test.mjs' : 'src/services/motorMatch.policy.test.ts';
    const p = spawnSync(process.execPath, [`${root}/packages/app/node_modules/vitest/vitest.mjs`, 'run', test, '--maxWorkers', '1'],
      { cwd: `${root}/packages/app`, encoding: 'utf8', timeout: 60000 });
    writeFileSync(`${out}/${name}.log`, (p.stdout ?? '') + (p.stderr ?? ''));
    const killed = p.status === 1 && /AssertionError/.test((p.stdout ?? '') + (p.stderr ?? ''));
    results.push({ name, exit: p.status, killed });
    console.log(`${name}: exit ${p.status}, ${killed ? 'killed' : 'SURVIVED/INVALID'}`);
  } finally { writeFileSync(path, source); }
}
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
process.exitCode = results.every(r => r.killed) ? 0 : 1;
