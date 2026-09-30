// Catalogue self-matches and generated spellings, both catalogue orders.
// This is supplementary differential evidence, not an oracle for ambiguous names.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.cwd().replaceAll('\\', '/');
if (!process.env.MATCHER_BASELINE) {
  const baseline = execFileSync('git', ['rev-parse', '01d6bee'], { encoding: 'utf8' }).trim();
  const p = spawnSync(process.execPath, ['--max-old-space-size=1536', '--no-warnings', '--experimental-loader', './packages/app/scripts/matcher-sweep.loader.mjs', './packages/app/scripts/matcher-sweep.variants.mjs'],
    { env: { ...process.env, MATCHER_BASELINE: baseline, MATCHER_CACHE: `${root}/.matcher-sweep/variant-cache` }, stdio: 'inherit' });
  process.exitCode = p.status ?? 1;
} else {
  const old = await import(pathToFileURL(`${root}/.matcher-sweep/baseline/packages/app/src/services/motorDb.ts`).href);
  const now = await import(pathToFileURL(`${root}/packages/app/src/services/motorDb.ts`).href);
  const cases = new Map();
  for (const m of now.MOTOR_DB) {
    const names = new Set([m.designation, m.designation.toLowerCase(), m.commonName]);
    for (const d of (m.delays ?? '').split(',').filter(Boolean)) {
      if (/^(\d+|P)$/i.test(d)) { names.add(`${m.commonName}-${d}`); names.add(`${m.commonName}_${d.toLowerCase()}`); }
    }
    if (m.propInfo) names.add(`${m.commonName}-${m.propInfo.replaceAll(' ', '')}`);
    for (const name of names) for (const maker of [m.manufacturerAbbrev, undefined]) {
      const c = { name, maker, diameter: m.diameter };
      cases.set(JSON.stringify(c), c);
    }
  }
  const changes = [], selfFailures = [];
  for (const reverse of [false, true]) {
    const before = reverse ? [...old.MOTOR_DB].reverse() : old.MOTOR_DB;
    const after = reverse ? [...now.MOTOR_DB].reverse() : now.MOTOR_DB;
    for (const c of cases.values()) {
      const b = old.findDbMotor(c.name, c.diameter, before, c.maker);
      const a = now.findDbMotor(c.name, c.diameter, after, c.maker);
      if (b?.motorId !== a?.motorId) changes.push({ ...c, reverse, before: b?.motorId ?? null, after: a?.motorId ?? null });
    }
    for (const m of after) {
      const b = old.findDbMotor(m.designation, m.diameter, before, m.manufacturerAbbrev);
      const a = now.findDbMotor(m.designation, m.diameter, after, m.manufacturerAbbrev);
      if (b?.motorId === m.motorId && a?.motorId !== m.motorId) selfFailures.push({ row: m.motorId, reverse, after: a?.motorId });
    }
  }
  mkdirSync(`${root}/.matcher-sweep`, { recursive: true });
  const report = { baseline: process.env.MATCHER_BASELINE, node: process.version, catalogueRows: now.MOTOR_DB.length,
    selfComparisons: now.MOTOR_DB.length * 2, generatedComparisons: cases.size * 2, changes, selfFailures };
  writeFileSync(`${root}/.matcher-sweep/variants.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, changes: changes.length }, null, 2));
  process.exitCode = selfFailures.length ? 1 : 0;
}
