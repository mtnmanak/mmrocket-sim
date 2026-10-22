/**
 * Offline planning, approval-gated S3 upload, and public verification of the
 * curated catalogue. No fetch or child command runs when this module is imported.
 * plan --motors <file> --curves <file> --previous <manifest|none> --out <dir>
 *      --source-run-id <id> --fetched-at <artifact created_at> --source-attempt <n> --commit <sha>
 *      [--previous-motors <file>] [--previous-curves <file>] [--inputs <inputs.json>] [--summary <file>]
 * freeze --motors <file> --curves <file> --out <dir> (before dependency installation)
 * upload --plan <dir> | verify --base <public URL> --plan <dir>
 * For the exact id diff, plan reads --previous-motors/--previous-curves if supplied,
 * otherwise downloads and hash-checks the previous files from the public URL.
 * Commit provenance prefers --commit, then GITHUB_SHA, then local git rev-parse HEAD.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const SOURCE = 'thrustcurve.org API v1, curated by MMRocket Sim (github.com/mtnmanak/mmrocket-sim)';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE = 'public, max-age=300';
const BUCKET = 'mmr-motor-catalogue';
const REQUEST_TIMEOUT_MS = 30_000;
const PUBLIC_BASE = 'https://catalogue.mountainmanrockets.com/';
const run = (command, args, options) => spawnSync(command, args, { ...options, encoding: 'utf8' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const snapshotId = (id) => typeof id === 'string' && /^\d{4}-\d{2}-\d{2}(?:\.[2-9]|\.[1-9]\d+)?$/.test(id)
  && date(id.slice(0, 10));
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const timestamp = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s)
  && date(s.slice(0, 10)) && Number.isFinite(Date.parse(s));
const runId = (s) => typeof s === 'string' && /^[1-9]\d*$/.test(s);
const currentEntry = (manifest) => manifest?.snapshots.find((s) => s.id === manifest.current);
const withoutPublishedAt = ({ publishedAt: _publishedAt, ...entry }) => entry;
const withId = (entry, id) => ({ ...entry, id,
  motors: { ...entry.motors, path: `v1/${id}/motors.json` },
  curves: { ...entry.curves, path: `v1/${id}/motorCurves.json` } });
function assertNewer(entry, live) {
  const current = currentEntry(live);
  // Legacy dates cannot establish which same-day fetch was newer. Compare both
  // generated dates conservatively until a precise fetchedAt is published.
  const stale = current && (current.fetchedAt
    ? Date.parse(entry.fetchedAt) <= Date.parse(current.fetchedAt)
    : entry.motors.generated <= current.motors.generated);
  if (stale) {
    throw new Error(`Input fetchedAt ${entry.fetchedAt} is not newer than live ${current.id} (${current.fetchedAt ?? current.motors.generated}); re-run the refresh`);
  }
}
const digest = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

// Only these root fields are run-specific in catalogueDocument/curvesDocument.
// In particular a motor's updatedOn is upstream data, not our generation clock.
export function contentHash(bytes) {
  const { generated: _generated, catalogueGenerated: _catalogueGenerated, ...content } = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const canonical = (v) => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  return hash(JSON.stringify(canonical(content)));
}

/** Freeze the two builtin-only fetchers' output before npm can execute dependencies. */
export function freezeInputs({ motorsBytes, curvesBytes }, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'motors-full.json'), motorsBytes);
  writeFileSync(join(dir, 'motorCurves.json'), curvesBytes);
  writeFileSync(join(dir, 'inputs.json'), jsonBytes({ schema: 1,
    motors: hash(motorsBytes), curves: hash(curvesBytes) }));
}

export function validateInputs(file, { motorsBytes, curvesBytes }) {
  const inputs = JSON.parse(readFileSync(file, 'utf8'));
  if (inputs.schema !== 1 || inputs.motors !== hash(motorsBytes) || inputs.curves !== hash(curvesBytes)) {
    throw new Error('Catalogue input artifact sha256 mismatch');
  }
}

/** Fail closed on future schemas and malformed history; never silently discard it. */
export function validatePreviousManifest(manifest) {
  if (manifest === undefined) return;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid previous manifest object');
  if (manifest.schema !== 1) throw new Error(`Unknown previous manifest schema: ${manifest.schema}`);
  if (!Array.isArray(manifest.snapshots) || !manifest.snapshots.length
    || !snapshotId(manifest.current)) throw new Error('Invalid previous manifest history/current');
  const ids = new Set();
  for (const entry of manifest.snapshots) {
    if (!snapshotId(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate previous snapshot id');
    ids.add(entry.id);
    if ((entry.fetchedAt !== undefined && !timestamp(entry.fetchedAt))
      || (entry.sourceAttempt !== undefined && !runId(entry.sourceAttempt))
      || (entry.sourceRunId !== undefined && !runId(entry.sourceRunId))) throw new Error('Invalid snapshot fetch provenance');
    for (const [kind, file] of [['motors', 'motors.json'], ['curves', 'motorCurves.json']]) {
      const meta = entry[kind];
      if (!meta || meta.path !== `v1/${entry.id}/${file}` || !integer(meta.bytes)
        || !digest(meta.sha256) || (meta.contentSha256 !== undefined && !digest(meta.contentSha256)) || !date(meta.generated)) {
        throw new Error(`Invalid previous snapshot ${kind} metadata: ${entry.id}`);
      }
    }
    if (!integer(entry.motors.count) || !integer(entry.curves.motors) || !integer(entry.curves.files)
      || entry.curves.catalogueGenerated !== entry.motors.generated) {
      throw new Error(`Invalid previous snapshot counts/dates: ${entry.id}`);
    }
  }
  if (!ids.has(manifest.current)) throw new Error('Previous current snapshot is missing from history');
}

/** Plan immutable files and ONE entry, never an authoritative future manifest. */
export function planPublication({ motorsBytes, curvesBytes, previousManifest, previousManifestBytes,
  previousMotorsBytes, previousCurvesBytes, previousSnapshotUnavailable = false, commit, sourceRunId, fetchedAt, sourceAttempt }) {
  validatePreviousManifest(previousManifest);
  if (!runId(sourceRunId) || !timestamp(fetchedAt)) throw new Error('Valid sourceRunId and fetchedAt are required');
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('A valid 40-hex commit is required');
  if (sourceAttempt !== undefined && !runId(String(sourceAttempt))) throw new Error('Invalid source attempt');
  const motors = JSON.parse(Buffer.from(motorsBytes).toString('utf8'));
  const curves = JSON.parse(Buffer.from(curvesBytes).toString('utf8'));
  if (curves.catalogueGenerated !== motors.generated) {
    throw new Error('Pair mismatch: curves.catalogueGenerated must equal motors.generated');
  }
  if (!date(motors.generated) || !date(curves.generated) || !Array.isArray(motors.motors)
    || !motors.motors.length || motors.count !== motors.motors.length
    || !curves.curves || Array.isArray(curves.curves) || typeof curves.curves !== 'object'
    || curves.complete !== true || !integer(curves.motors) || !integer(curves.files)
    || Object.keys(curves.curves).length !== curves.motors
    || !Object.values(curves.curves).every(Array.isArray)
    || Object.values(curves.curves).reduce((n, files) => n + files.length, 0) !== curves.files) {
    throw new Error('Invalid catalogue/curve dates, counts, or incomplete curve bundle');
  }
  const ids = new Set(motors.motors.map((m) => m.motorId));
  if (Object.keys(curves.curves).some((id) => !ids.has(id))) throw new Error('Pair mismatch: curve motor id absent from catalogue rows');
  const motorsHash = hash(motorsBytes), curvesHash = hash(curvesBytes);
  const current = previousManifest?.snapshots.find((s) => s.id === previousManifest.current);
  const baseManifestSha256 = previousManifest === undefined ? 'absent' : hash(previousManifestBytes ?? jsonBytes(previousManifest));
  if (previousManifestBytes && !isDeepStrictEqual(JSON.parse(Buffer.from(previousManifestBytes).toString('utf8')), previousManifest)) {
    throw new Error('Previous manifest bytes differ from parsed manifest');
  }
  const contentMatches = (kind, next, previous) => {
    if (!current) return false;
    const meta = current[kind];
    if (previous && hash(previous) !== meta.sha256) throw new Error(`Previous ${kind} sha256 mismatch`);
    return meta.sha256 === hash(next) || (meta.contentSha256 ?? (previous && contentHash(previous))) === contentHash(next);
  };
  // A missing/corrupt current object needs an approved repair even if its recorded
  // content hash matches. Otherwise every later refresh would skip that repair.
  if (!previousSnapshotUnavailable && contentMatches('motors', motorsBytes, previousMotorsBytes) && contentMatches('curves', curvesBytes, previousCurvesBytes)) {
    return { liveEntry: current, changed: false, snapshotId: current.id, baseManifestSha256, entry: current, uploads: [],
      input: { commit, sourceRunId, fetchedAt, sourceAttempt },
      alreadyPublished: current.sourceRunId === sourceRunId && current.motors.sha256 === motorsHash && current.curves.sha256 === curvesHash };
  }
  assertNewer({ fetchedAt, motors }, previousManifest);
  const used = new Set(previousManifest?.snapshots.map((s) => s.id));
  let id = motors.generated;
  for (let suffix = 2; used.has(id); suffix++) id = `${motors.generated}.${suffix}`;
  const entry = {
    id, commit, sourceRunId, fetchedAt, ...(sourceAttempt === undefined ? {} : { sourceAttempt: String(sourceAttempt) }),
    motors: { path: `v1/${id}/motors.json`, bytes: Buffer.byteLength(motorsBytes), sha256: motorsHash,
      contentSha256: contentHash(motorsBytes), count: motors.count, generated: motors.generated },
    curves: { path: `v1/${id}/motorCurves.json`, bytes: Buffer.byteLength(curvesBytes), sha256: curvesHash,
      contentSha256: contentHash(curvesBytes),
      motors: curves.motors, files: curves.files, generated: curves.generated, catalogueGenerated: curves.catalogueGenerated },
  };
  return { liveEntry: current, changed: true, snapshotId: id, baseManifestSha256, entry, uploads: [
    { key: entry.motors.path, bytes: Buffer.from(motorsBytes), contentType: CONTENT_TYPE, cacheControl: IMMUTABLE },
    { key: entry.curves.path, bytes: Buffer.from(curvesBytes), contentType: CONTENT_TYPE, cacheControl: IMMUTABLE },
  ] };
}

/** Exact full-row and simulator-file diffs for the approval, with missing evidence explicit. */
export function publicationSummary(plan, { motorsBytes, curvesBytes, previousMotorsBytes, previousCurvesBytes,
  unavailable = [], hasPrevious = false } = {}) {
  const entry = plan.entry;
  const before = previousMotorsBytes ? JSON.parse(Buffer.from(previousMotorsBytes).toString('utf8')).motors : [];
  const after = JSON.parse(Buffer.from(motorsBytes).toString('utf8')).motors;
  const priorRows = new Map(before.map((m) => [m.motorId, m]));
  const rows = new Map(after.map((m) => [m.motorId, m]));
  const added = [...rows.keys()].filter((id) => !priorRows.has(id));
  const removed = [...priorRows.keys()].filter((id) => !rows.has(id));
  const changed = [...rows.keys()].filter((id) => priorRows.has(id) && !isDeepStrictEqual(priorRows.get(id), rows.get(id)));
  const priorCurves = previousCurvesBytes ? JSON.parse(Buffer.from(previousCurvesBytes).toString('utf8')).curves : {};
  const curves = JSON.parse(Buffer.from(curvesBytes).toString('utf8')).curves;
  const curveChanges = [], fileSets = [], samples = [], other = [], fileAdded = [], fileRemoved = [];
  for (const id of new Set([...Object.keys(priorCurves), ...Object.keys(curves)])) {
    const oldFiles = new Map((priorCurves[id] ?? []).map((f) => [f.simfileId, f]));
    const newFiles = new Map((curves[id] ?? []).map((f) => [f.simfileId, f]));
    const addedFiles = [...newFiles.keys()].filter((key) => !oldFiles.has(key));
    const removedFiles = [...oldFiles.keys()].filter((key) => !newFiles.has(key));
    const sampleChange = [...newFiles.keys()].some((key) => oldFiles.has(key)
      && !isDeepStrictEqual(oldFiles.get(key).samples, newFiles.get(key).samples));
    const anyChange = addedFiles.length || removedFiles.length || [...newFiles.keys()].some((key) => !isDeepStrictEqual(oldFiles.get(key), newFiles.get(key)));
    if (anyChange) curveChanges.push(id);
    if (addedFiles.length || removedFiles.length) fileSets.push(id);
    if (sampleChange) samples.push(id);
    if (anyChange && !sampleChange && !addedFiles.length && !removedFiles.length) other.push(id);
    fileAdded.push(...addedFiles.map((key) => `${id}/${key}`));
    fileRemoved.push(...removedFiles.map((key) => `${id}/${key}`));
  }
  const rowCount = hasPrevious && !previousMotorsBytes ? 'UNAVAILABLE' : added.length + removed.length + changed.length;
  const curveCount = hasPrevious && !previousCurvesBytes ? 'UNAVAILABLE' : curveChanges.length;
  const priorEntry = plan.liveEntry;
  const contentState = (kind, next, previous) => {
    const oldHash = previous ? contentHash(previous) : priorEntry?.[kind].contentSha256;
    return !hasPrevious ? 'new' : !oldHash ? 'unknown' : oldHash === contentHash(next) ? 'unchanged' : 'changed';
  };
  const motorContent = contentState('motors', motorsBytes, previousMotorsBytes);
  const curveContent = contentState('curves', curvesBytes, previousCurvesBytes);
  const identicalBytes = (previousMotorsBytes ? hash(previousMotorsBytes) : priorEntry?.motors.sha256) === hash(motorsBytes)
    && (previousCurvesBytes ? hash(previousCurvesBytes) : priorEntry?.curves.sha256) === hash(curvesBytes);
  const datesOnly = !hasPrevious ? 'no' : [motorContent, curveContent].includes('unknown') ? 'unknown'
    : motorContent === 'unchanged' && curveContent === 'unchanged' ? identicalBytes ? 'n/a (identical bytes)' : 'yes' : 'no';
  const otherContent = [];
  for (const [kind, next, previous, payload] of [['motors', motorsBytes, previousMotorsBytes, 'motors'],
    ['curves', curvesBytes, previousCurvesBytes, 'curves']]) {
    if (!previous) continue;
    const beforeDoc = JSON.parse(Buffer.from(previous)), afterDoc = JSON.parse(Buffer.from(next));
    const keys = new Set([...Object.keys(beforeDoc), ...Object.keys(afterDoc)]);
    const roots = [...keys].filter((key) => !['generated', 'catalogueGenerated', payload].includes(key)
      && !isDeepStrictEqual(beforeDoc[key], afterDoc[key]));
    if (roots.length) otherContent.push(`${kind} root fields: ${roots.join(', ')}`);
    const order = (doc) => kind === 'motors' ? doc.motors.map((row) => row.motorId)
      : Object.fromEntries(Object.entries(doc.curves).map(([id, files]) => [id, files.map((file) => file.simfileId)]));
    if (!isDeepStrictEqual(order(beforeDoc), order(afterDoc))) otherContent.push(`${kind} row/file identity or array order`);
  }
  const source = plan.input ?? entry;
  const repo = 'mtnmanak/mmrocket-sim';
  const lines = [
    `Source: [refresh run ${source.sourceRunId}](https://github.com/${repo}/actions/runs/${source.sourceRunId}) (artifact attempt ${source.sourceAttempt ?? 'unknown (legacy)'}).`,
    `Commit: [${source.commit.slice(0, 7)}](https://github.com/${repo}/commit/${source.commit}).`,
    `Artifact created_at: ${source.fetchedAt}.`,
    `LIVE snapshot: ${priorEntry?.id ?? 'none'}; fetched: ${priorEntry?.fetchedAt ?? priorEntry?.motors.generated ?? 'n/a (legacy/first)'}.`,
    ...(plan.changed ? [`NEW snapshot: ${plan.snapshotId}; fetched: ${entry.fetchedAt}.`,
      'The final snapshot id may gain a suffix at upload time if an orphan occupies this id.']
      : [plan.alreadyPublished ? `already published as ${plan.snapshotId}` : `No content change; keeping live snapshot ${plan.snapshotId}.`]),
    ...unavailable.map((reason) => `**UNAVAILABLE: ${reason}**`),
    `Catalogue rows: ${rowCount} ${hasPrevious ? 'changed' : 'added'} · Curves: ${curveCount} motors changed · Dates only: ${datesOnly}`,
    `Content vs recorded hash: motors ${motorContent}, curves ${curveContent}${hasPrevious && motorContent === 'unchanged' && curveContent === 'unchanged' ? ' (identical content)' : ''}.`,
    `Other content changes: ${otherContent.join('; ') || 'none identified'}.`,
    '', '### Curated motor catalogue publication', '',
    `Snapshot: ${plan.snapshotId}; changed=${plan.changed}.`,
    `Motors: ${entry.motors.count} (${entry.motors.bytes} bytes).`,
    `Curves: ${entry.curves.motors} motors, ${entry.curves.files} files (${entry.curves.bytes} bytes).`,
    `Input sha256: motors ${hash(motorsBytes)}; curves ${hash(curvesBytes)}.`];
  if (!hasPrevious) lines.push('First publication: all rows and curve files are new.');
  const list = (label, ids) => `${label}: ${ids.length}; first 20 ids: ${ids.slice(0, 20).join(', ') || 'none'}.`;
  if (!hasPrevious || previousMotorsBytes) {
    lines.push(`Motor ids: ${added.length} added, ${removed.length} removed, ${changed.length} changed.`);
    lines.push(list('Rows added', added), list('Rows removed', removed), list('Rows changed', changed));
  }
  lines.push('', '#### Curves');
  if (!hasPrevious || previousCurvesBytes) {
    lines.push(list('Motors with curve changes', curveChanges), list('Motors with simfile ids added/removed', fileSets),
      list('Simfile ids added (motor/file)', fileAdded), list('Simfile ids removed (motor/file)', fileRemoved),
      list('Motors with existing simfile samples changed', samples), list('Motors with other file metadata changed', other));
  }
  return `${lines.map((line) => line && !line.startsWith('#') ? `- ${line}` : line).join('\n')}\n`;
}

/** Staged data contains no credentials; plan.json is portable between runner jobs. */
export function stagePublication(plan, outDir) {
  mkdirSync(outDir, { recursive: true });
  const uploads = plan.uploads.map(({ bytes, ...meta }) => {
    const file = join(outDir, meta.key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return { ...meta, size: bytes.length, sha256: hash(bytes) };
  });
  writeFileSync(join(outDir, 'plan.json'), jsonBytes({ ...plan, uploads, schema: 1 }));
}

/** Check staged bytes and order again before a credential-bearing job uses them. */
export function readPublication(dir) {
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  if (plan.schema !== 1 || typeof plan.changed !== 'boolean') throw new Error('Invalid staged plan schema/verdict');
  if (plan.baseManifestSha256 !== 'absent' && !digest(plan.baseManifestSha256)) throw new Error('Invalid staged base manifest hash');
  validatePreviousManifest({ schema: 1, current: plan.snapshotId, snapshots: [plan.entry] });
  if (plan.snapshotId !== plan.entry.id) throw new Error('Invalid staged current snapshot');
  const keys = plan.changed ? [`v1/${plan.snapshotId}/motors.json`, `v1/${plan.snapshotId}/motorCurves.json`] : [];
  if (!isDeepStrictEqual(plan.uploads?.map((u) => u.key), keys)) throw new Error('Invalid staged upload order/keys');
  for (const upload of plan.uploads) {
    const bytes = readFileSync(join(dir, upload.key));
    if (bytes.length !== upload.size || hash(bytes) !== upload.sha256
      || upload.contentType !== CONTENT_TYPE
      || upload.cacheControl !== IMMUTABLE) {
      throw new Error(`Staged bytes or headers changed: ${upload.key}`);
    }
    upload.bytes = bytes;
  }
  if (plan.changed) {
    const entry = plan.entry;
    for (const [i, meta] of [[0, entry.motors], [1, entry.curves]]) {
      if (hash(plan.uploads[i].bytes) !== meta.sha256 || plan.uploads[i].size !== meta.bytes) {
        throw new Error('Staged snapshot differs from manifest');
      }
    }
    const checked = planPublication({ motorsBytes: plan.uploads[0].bytes, curvesBytes: plan.uploads[1].bytes, commit: entry.commit, sourceRunId: entry.sourceRunId, fetchedAt: entry.fetchedAt, sourceAttempt: entry.sourceAttempt });
    for (const kind of ['motors', 'curves']) {
      if (!isDeepStrictEqual({ ...checked.entry[kind], path: entry[kind].path }, entry[kind])) {
        throw new Error(`Staged ${kind} metadata differs from entry`);
      }
    }
  }
  return plan;
}

const scrub = (message, env) => [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY]
  .filter(Boolean).reduce((s, secret) => s.split(secret).join('[REDACTED]'), String(message));

/** Authoritative base check before ANY writes, resumable immutable files, conditional pointer LAST. */
export async function uploadPublication(dir, {
  runCommand = run,
  env = process.env,
  now = new Date(),
} = {}) {
  const plan = readPublication(dir);
  if (!plan.changed) return;
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) throw new Error('Missing/invalid CLOUDFLARE_ACCOUNT_ID');
  const childEnv = { ...env, AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' };
  const common = ['--bucket', BUCKET, '--region', 'auto', '--endpoint-url',
    `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`];
  const temp = mkdtempSync(join(tmpdir(), 'catalogue-upload-'));
  const aws = async (operation, key, extra = []) => {
    try { return await runCommand('aws', ['s3api', operation, ...common, '--key', key, ...extra], { env: childEnv }); }
    catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Raw command errors may contain credentials; propagate only scrubbed text.
      throw new Error(scrub(`AWS ${operation} ${key}: ${error.message}`, env));
    }
  };
  const success = (r) => !r.error && r.status === 0;
  const absent = (r, operation) => !r.error && r.status != null && r.status !== 0
    && (operation === 'get-object'
      ? /\(NoSuchKey\) when calling the GetObject operation:/.test(String(r.stderr))
      : /\(404\) when calling the HeadObject operation:/.test(String(r.stderr)));
  const failure = (context, r) => new Error(scrub(`${context}: ${r.stderr ?? ''} ${r.error?.message ?? ''}`.trim(), env));
  const stale = (live) => new Error(`the live catalogue moved on to ${live?.current ?? 'none'} — re-run the refresh`);
  const receipt = (bytes, id) => {
    writeFileSync(join(dir, 'uploaded-manifest.json'), bytes);
    writeFileSync(join(dir, 'uploaded.json'), jsonBytes({ snapshotId: id, sha256: hash(bytes) }));
  };
  const own = (live) => {
    const entry = currentEntry(live);
    return entry && entry.id.slice(0, 10) === plan.entry.motors.generated
      && isDeepStrictEqual(withoutPublishedAt(entry), withId(plan.entry, entry.id));
  };
  const matchingObject = async (upload, head) => {
    head ??= await aws('head-object', upload.key);
    if (!success(head)) return false;
    const file = join(temp, 'existing.json'), got = await aws('get-object', upload.key, [file]);
    if (!success(got)) throw failure(`Existing snapshot GET failed: ${upload.key}`, got);
    const headers = JSON.parse(head.stdout);
    return hash(readFileSync(file)) === upload.sha256
      && headers.ContentType === upload.contentType && headers.CacheControl === upload.cacheControl;
  };
  const getLive = async () => {
    const file = join(temp, 'manifest.json'), result = await aws('get-object', 'manifest.json', [file]);
    if (success(result)) {
      const bytes = readFileSync(file), manifest = JSON.parse(bytes.toString('utf8'));
      validatePreviousManifest(manifest);
      return { bytes, manifest, etag: JSON.parse(result.stdout).ETag };
    }
    if (absent(result, 'get-object')) return {};
    throw failure('Live manifest GET failed', result);
  };
  try {
    const initial = await getLive(), live = initial.manifest;
    if ((initial.bytes ? hash(initial.bytes) : 'absent') !== plan.baseManifestSha256) {
      if (own(live)) { receipt(initial.bytes, live.current); return 'already live'; }
      throw stale(live);
    }
    assertNewer(plan.entry, live);
    if (live && (typeof initial.etag !== 'string' || !initial.etag.length)) {
      throw new Error('Live manifest GET returned no ETag; refusing an unconditional PUT');
    }
    const used = new Set(live?.snapshots.map((entry) => entry.id));
    let entry = plan.entry, pending, uploads;
    // A different orphan is never overwritten. Choose the next available ID,
    // preflighting BOTH files before writing anything for the chosen candidate.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt) {
        const suffix = Number(entry.id.split('.')[1] ?? 1) + 1;
        entry = withId(entry, `${entry.motors.generated}.${suffix}`);
      }
      if (used.has(entry.id)) continue;
      uploads = plan.uploads.map((upload, i) => ({ ...upload, key: entry[i === 0 ? 'motors' : 'curves'].path, originalKey: upload.key }));
      pending = [];
      let collision = false;
      for (const upload of uploads) {
        const head = await aws('head-object', upload.key);
        if (success(head)) {
          if (!await matchingObject(upload, head)) { collision = true; break; }
        } else if (absent(head, 'head-object')) pending.push(upload);
        else throw failure(`Snapshot HEAD failed: ${upload.key}`, head);
      }
      if (!collision) break;
      pending = undefined;
    }
    if (!pending) throw new Error('No free snapshot ID after 20 tries; different bytes or headers in orphan objects');
    for (const upload of pending) {
      let failed;
      try {
        const put = await aws('put-object', upload.key, ['--body', resolve(dir, upload.originalKey), '--content-type', upload.contentType,
          '--cache-control', upload.cacheControl, '--if-none-match', '*']);
        if (!success(put)) failed = failure(`Upload failed: ${upload.key}; publication stopped`, put);
      } catch (error) { failed = error; }
      if (failed) {
        let matches = false;
        try { matches = await matchingObject(upload); } catch { /* Keep the original PUT diagnostic. */ }
        if (!matches) throw failed;
      }
    }
    const publishedAt = new Date(now).toISOString();
    entry = { ...entry, publishedAt };
    // Preserve schema-1 extensions; only the pointer/publication fields change.
    const manifest = { ...live, schema: 1, current: entry.id, publishedAt, commit: entry.commit, source: SOURCE,
      snapshots: [entry, ...(live?.snapshots ?? [])] };
    validatePreviousManifest(manifest);
    const manifestBytes = jsonBytes(manifest), finalFile = join(temp, 'final-manifest.json');
    writeFileSync(finalFile, manifestBytes);
    let failed;
    try {
      const put = await aws('put-object', 'manifest.json', ['--body', finalFile, '--content-type', CONTENT_TYPE,
        '--cache-control', MANIFEST_CACHE, ...(live ? ['--if-match', initial.etag] : ['--if-none-match', '*'])]);
      if (!success(put)) failed = failure('Manifest conditional PUT failed; publication stopped', put);
    } catch (error) { failed = error; }
    if (failed) {
      // A lost response (including a CLI retry's PreconditionFailed) can mean
      // this very publication is live. Confirm it authoritatively before failing.
      let latest;
      try { latest = await getLive(); } catch { throw failed; }
      if (own(latest.manifest)) { receipt(latest.bytes, latest.manifest.current); return 'already live'; }
      if ((latest.bytes ? hash(latest.bytes) : 'absent') !== plan.baseManifestSha256) throw stale(latest.manifest);
      throw failed;
    }
    receipt(manifestBytes, entry.id);
    return 'published';
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Six one-minute retry delays, plus bounded requests, cover the five-minute manifest cache. */
export async function verifyPublication(dir, { base, fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 7, delayMs = 60_000,
} = {}) {
  const plan = readPublication(dir);
  if (!plan.changed) return;
  const receipt = JSON.parse(readFileSync(join(dir, 'uploaded.json'), 'utf8'));
  const finalBytes = readFileSync(join(dir, 'uploaded-manifest.json'));
  if (!snapshotId(receipt.snapshotId) || receipt.sha256 !== hash(finalBytes)) throw new Error('Invalid uploaded manifest receipt');
  const finalManifest = JSON.parse(finalBytes);
  validatePreviousManifest(finalManifest);
  if (finalManifest.current !== receipt.snapshotId || !isDeepStrictEqual(
    withoutPublishedAt(currentEntry(finalManifest)), withId(plan.entry, receipt.snapshotId))) throw new Error('Invalid uploaded manifest entry');
  const root = new URL(base);
  if (root.protocol !== 'https:') throw new Error('Verification base must use HTTPS');
  root.pathname = `${root.pathname.replace(/\/$/, '')}/`;
  root.search = ''; root.hash = '';
  let verified = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchImpl(new URL('manifest.json', root).href, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.current === receipt.snapshotId && hash(bytes) === receipt.sha256) {
        verified = true; break;
      }
    } catch { /* Transient GETs are retried too; the final verdict still fails closed. */ }
    if (i + 1 < attempts) await sleep(delayMs);
  }
  if (!verified) throw new Error('Public manifest did not converge to the planned current snapshot/hash');
  for (const [i, upload] of plan.uploads.entries()) {
    const key = currentEntry(finalManifest)[i === 0 ? 'motors' : 'curves'].path;
    let verified = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetchImpl(new URL(key, root).href, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (hash(bytes) === hash(upload.bytes)) { verified = true; break; }
      } catch { /* Retry transient snapshot failures, with the same cache budget. */ }
      if (attempt + 1 < attempts) await sleep(delayMs);
    }
    if (!verified) throw new Error(`Public snapshot did not converge to sha256: ${key}`);
  }
}

/** CLI errors return non-zero without echoing command environments or credentials. */
export async function main(argv = process.argv.slice(2), { env = process.env, stdout = (s) => process.stdout.write(s),
  stderr = (s) => console.error(s), runCommand = run, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now, attempts = 7, delayMs = 60_000,
} = {}) {
  try {
    const [command, ...args] = argv;
    const allowed = { plan: ['motors', 'curves', 'previous', 'out', 'summary', 'previous-motors', 'previous-curves', 'inputs', 'source-run-id', 'fetched-at', 'source-attempt', 'commit'],
      freeze: ['motors', 'curves', 'out'], upload: ['plan'], verify: ['base', 'plan'] };
    if (!allowed[command]) throw new Error('Expected freeze, plan, upload, or verify subcommand');
    const { values } = parseArgs({ args, options: Object.fromEntries(allowed[command].map((k) => [k, { type: 'string' }])) });
    const required = command === 'plan' ? ['motors', 'curves', 'previous', 'out', 'source-run-id', 'fetched-at'] : command === 'freeze' ? ['motors', 'curves', 'out']
      : command === 'verify' ? ['base', 'plan'] : ['plan'];
    for (const key of required) if (!values[key]) throw new Error(`Missing --${key}`);
    if (command === 'upload') {
      const result = await uploadPublication(values.plan, { env, runCommand, now }) ?? 'unchanged';
      const receiptFile = join(values.plan, 'uploaded.json');
      const id = result === 'unchanged' ? '' : JSON.parse(readFileSync(receiptFile, 'utf8')).snapshotId;
      const message = result === 'unchanged' ? result : `${result} as ${id}`;
      stdout(`${message}\n`);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Catalogue publication: ${message}\n`);
    }
    else if (command === 'verify') await verifyPublication(values.plan, { base: values.base, fetchImpl, sleep });
    else if (command === 'freeze') freezeInputs({ motorsBytes: readFileSync(values.motors), curvesBytes: readFileSync(values.curves) }, values.out);
    else {
      const previousManifestBytes = values.previous === 'none' ? undefined : readFileSync(values.previous);
      const previousManifest = previousManifestBytes === undefined ? undefined : JSON.parse(previousManifestBytes.toString('utf8'));
      validatePreviousManifest(previousManifest);
      const motorsBytes = readFileSync(values.motors), curvesBytes = readFileSync(values.curves);
      if (values.inputs) validateInputs(values.inputs, { motorsBytes, curvesBytes });
      let commit = values.commit ?? env.GITHUB_SHA;
      if (commit === undefined) {
        const result = await runCommand('git', ['rev-parse', 'HEAD'], { env });
        if (result.error || result.status !== 0) throw new Error('Cannot determine commit: set GITHUB_SHA or run inside a git checkout');
        commit = String(result.stdout).trim();
      }
      const previousBytes = {}, unavailable = [];
      if (previousManifest) {
        const current = previousManifest.snapshots.find((s) => s.id === previousManifest.current);
        for (const kind of ['motors', 'curves']) {
          let lastError;
          for (let attempt = 0; attempt < (values[`previous-${kind}`] ? 1 : attempts); attempt++) {
            try {
              let data;
              if (values[`previous-${kind}`]) data = readFileSync(values[`previous-${kind}`]);
              else {
                const response = await fetchImpl(new URL(current[kind].path, PUBLIC_BASE).href,
                  { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                data = Buffer.from(await response.arrayBuffer());
              }
              if (hash(data) !== current[kind].sha256) throw new Error('sha256 mismatch');
              const doc = JSON.parse(data.toString('utf8'));
              if (kind === 'motors' ? !Array.isArray(doc.motors) : !doc.curves || typeof doc.curves !== 'object' || !Object.values(doc.curves).every(Array.isArray)) {
                throw new Error('invalid snapshot document');
              }
              previousBytes[kind] = data;
              lastError = undefined;
              break;
            } catch (error) { lastError = error; }
            if (attempt + 1 < attempts && !values[`previous-${kind}`]) await sleep(delayMs);
          }
          if (lastError) unavailable.push(`previous ${kind} diff (${current.id}): ${lastError.message}`);
        }
      }
      const previousMotorsBytes = previousBytes.motors, previousCurvesBytes = previousBytes.curves;
      const plan = planPublication({ motorsBytes, curvesBytes, previousManifest, previousManifestBytes, previousMotorsBytes, previousCurvesBytes,
        previousSnapshotUnavailable: unavailable.length > 0, commit, sourceRunId: values['source-run-id'], fetchedAt: values['fetched-at'], sourceAttempt: values['source-attempt'] });
      const summary = publicationSummary(plan, { motorsBytes, curvesBytes, previousMotorsBytes, previousCurvesBytes, unavailable, hasPrevious: !!previousManifest });
      stagePublication(plan, values.out);
      if (values.summary) writeFileSync(values.summary, summary);
      else stderr(summary);
      if (plan.alreadyPublished) stderr(`already published as ${plan.snapshotId}`);
      stdout(`changed=${plan.changed}\nsnapshot=${plan.snapshotId}\n`);
    }
    return 0;
  } catch (error) {
    stderr(scrub(`Catalogue publication: ${error.message}`, env));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
