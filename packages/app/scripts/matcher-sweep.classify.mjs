import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const oracle = JSON.parse(readFileSync(new URL('./matcher-sweep.oracle.json', import.meta.url), 'utf8')).identities;
export const classes = ['unchanged', 'right→wrong', 'right→nothing', 'none→wrong', 'none→right', 'wrong→right', 'wrong→wrong', 'wrong→nothing', 'UNVERIFIABLE'];
export function classify(before, after, allowed) {
  if (before.id === after.id && before.loaded === after.loaded) return 'unchanged';
  if (!allowed) return 'UNVERIFIABLE';
  const from = !before.loaded ? 'none' : allowed.includes(before.id) ? 'right' : 'wrong';
  const to = !after.loaded ? 'nothing' : allowed.includes(after.id) ? 'right' : 'wrong';
  if (from === 'none' && to === 'nothing') return 'unchanged';
  if (from === 'right' && to === 'right') return 'unchanged';
  return `${from}→${to}`;
}
function truth(file, raw) {
  const name = raw.designation?.trim().toLowerCase();
  const maker = raw.manufacturer?.trim().toLowerCase();
  if (name === 'g80' && (!maker || ['unknown', 'custom'].includes(maker))) return oracle.makerlessG80;
  if (/^k700[- _]*bb$/.test(name) && file.key === oracle.katanaBlackBear.file) return oracle.katanaBlackBear;
  if (name === '26-e31-wh-15a' && file.key === oracle.vaporE31.file) return oracle.vaporE31;
  if (name === '217-h135-wh-12a') return oracle.ctiH135;
  if (/^i170[- _]+p$/.test(name) && maker?.includes('kosdon')) return oracle.pluggedI170;
  return null;
}
function selected(file, raw) {
  if (raw.excluded) return { id: null, loaded: false, exclusion: raw.excluded };
  if (!raw.resolved?.length) throw new Error(`Unreconciled raw reference ${file.key}:${raw.ordinal}`);
  const picks = raw.resolved.map(i => file.refs[i]);
  if (picks.some(p => !p)) throw new Error('Dangling raw-reference mapping');
  if (new Set(picks.map(p => `${p.id}|${p.loaded}`)).size !== 1) throw new Error('Ambiguous raw-reference mapping');
  return picks[0];
}
export function audit(meta, records) {
  const failures = [];
  if (meta.selectedFiles !== meta.expectedFiles) failures.push('Partial manifest');
  const pairs = new Map();
  for (const row of records) {
    const pair = pairs.get(row.key) ?? {};
    if (pair[row.side]) failures.push(`Duplicate file record: ${row.key}/${row.side}`);
    pair[row.side] = row; pairs.set(row.key, pair);
  }
  if (pairs.size !== meta.expectedFiles) failures.push('Missing file records');
  const table = Object.fromEntries(classes.map(c => [c, 0]));
  const changes = [], e31 = [], excluded = [], unmatchedImporterRefs = [], unsupportedFiles = [];
  let rawReferences = 0, baselineFoldedReferences = 0, currentFoldedReferences = 0, noteChanges = 0;
  for (const [key, { baseline: b, current: c }] of pairs) {
    if (['unsupported-binary', 'unsupported-legacy-rasaero'].includes(b?.status) && b.status === c?.status && b.sha256 === c.sha256 && b.error === c.error) {
      unsupportedFiles.push({ key, sha256: b.sha256, reason: b.error }); continue;
    }
    if (!b || !c || b.status !== 'ok' || c.status !== 'ok') { failures.push(`Missing/failed importer: ${key}`); continue; }
    if (b.sha256 !== c.sha256 || b.raw.length !== c.raw.length) { failures.push(`Input/raw inventory differs: ${key}`); continue; }
    rawReferences += b.raw.length; baselineFoldedReferences += b.refs.length; currentFoldedReferences += c.refs.length;
    for (const side of [b, c]) for (let i = 0; i < side.refs.length; i++) {
      if (!side.raw.some(r => r.resolved?.includes(i))) unmatchedImporterRefs.push({ key, side: side.side, ref: side.refs[i] });
    }
    for (let i = 0; i < b.raw.length; i++) {
      const br = b.raw[i], cr = c.raw[i];
      if (br.ordinal !== i || cr.ordinal !== i || br.designation !== cr.designation) { failures.push(`Raw ordinal/name mismatch: ${key}/${i}`); continue; }
      try {
        const before = selected(b, br), after = selected(c, cr);
        if (br.excluded || cr.excluded) excluded.push({ key, ordinal: i, before: br.excluded, after: cr.excluded });
        if (br.excluded !== cr.excluded) failures.push(`Changed exclusion: ${key}/${i}`);
        const identity = truth(c, cr);
        const category = classify(before, after, identity ? [identity.id] : null);
        table[category]++;
        if (before.note !== after.note) noteChanges++;
        if (category !== 'unchanged') changes.push({ key, ordinal: i, raw: cr, category, before, after, oracle: identity });
        if (/26[- _]*E31[- _]+WH/i.test(cr.designation)) e31.push({ key, ordinal: i, id: after.id, loaded: after.loaded, context: after.ref?.matchContext, note: after.note });
      } catch (error) { failures.push(`${key}/${i}: ${error}`); }
    }
  }
  if (unmatchedImporterRefs.length) failures.push(`${unmatchedImporterRefs.length} importer references absent from raw inventory`);
  for (const category of ['right→wrong', 'right→nothing', 'none→wrong', 'UNVERIFIABLE']) if (table[category]) failures.push(`${category}: ${table[category]}`);
  return { pass: failures.length === 0, failures, files: pairs.size, rawReferences, baselineFoldedReferences, currentFoldedReferences,
    table, noteChanges, changes, e31, excluded, unsupportedFiles, unmatchedImporterRefs };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: node packages/app/scripts/matcher-sweep.classify.mjs OUTPUT_DIRECTORY');
  const report = audit(JSON.parse(readFileSync(`${out}/meta.json`, 'utf8')), readFileSync(`${out}/results.jsonl`, 'utf8').trim().split('\n').map(JSON.parse));
  writeFileSync(`${out}/classification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, changes: report.changes.length, e31: report.e31.length, excluded: report.excluded.length, unsupportedFiles: report.unsupportedFiles.length, unmatchedImporterRefs: report.unmatchedImporterRefs.length }, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
