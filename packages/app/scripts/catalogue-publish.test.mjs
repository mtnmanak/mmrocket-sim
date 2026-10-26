import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contentHash, freezeInputs, main, planPublication, publicationSummary, readPublication, stagePublication,
  uploadPublication, validateInputs, validatePreviousManifest, verifyPublication } from './catalogue-publish.mjs';
import { FULL_FIELDS } from './fetch-motor-db.mjs';

const dirs = [];
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'catalogue-publish-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bytes = (doc) => Buffer.from(JSON.stringify(doc));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const now = '2026-10-25T12:34:56.000Z';
const commit = 'a'.repeat(40);
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), AWS_ACCESS_KEY_ID: 'secret-id', AWS_SECRET_ACCESS_KEY: 'secret-key' };
function inputs({ fetchedAt = '2026-10-25T00:00:00.000Z', sourceRunId = '123', generated = '2026-10-22', motors = [{ motorId: 'a', designation: 'F1', manufacturer: 'Maker' }], force = 1 } = {}) {
  return { motorsBytes: bytes({ generated, source: 'thrustcurve.org API v1', count: motors.length, fields: FULL_FIELDS, motors }),
    curvesBytes: bytes({ generated, catalogueGenerated: generated, complete: true, motors: 1, files: 1,
      curves: { a: [{ simfileId: 'file-a', samples: [[0, 0], [1, force]] }] } }), commit, fetchedAt, sourceRunId };
}
const first = () => planPublication(inputs());
function manifest(plan = first(), publishedAt = '2026-10-22T12:00:00.000Z', history = []) {
  return { schema: 1, current: plan.snapshotId, publishedAt, commit, source: 'thrustcurve.org API v1, curated by MMRocket Sim (github.com/mtnmanak/mmrocket-sim)',
    snapshots: [{ ...plan.entry, fetchedAt: '2026-10-22T00:00:00.000Z', publishedAt }, ...history] };
}
function staged(plan = first()) { const dir = tmp(); stagePublication(plan, dir); return dir; }
const missing = (operation) => ({ status: 254, stderr: operation === 'get-object'
  ? 'An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist.'
  : 'An error occurred (404) when calling the HeadObject operation: Not Found' });
const ok = { status: 0, stdout: '{}', stderr: '' };
const response = (body, status = 200) => ({ ok: status === 200, status, arrayBuffer: async () => Buffer.from(body) });

// Real command arguments drive this offline bucket: GET writes the requested local
// file and conditional PUTs enforce ETags/absence. No aws process or network runs.
function bucket(initial = [], intercept = () => undefined) {
  const objects = new Map(initial), calls = [];
  const etag = (key) => `"${sha(objects.get(key))}"`;
  const runCommand = vi.fn(async (cmd, args, options) => {
    calls.push([cmd, args, options]);
    const key = args[args.indexOf('--key') + 1], operation = args[1];
    const overridden = intercept({ key, operation, args, objects });
    if (overridden) return overridden;
    if (operation === 'head-object') return objects.has(key) ? { ...ok, stdout: JSON.stringify({
      ContentType: 'application/json; charset=utf-8', CacheControl: 'public, max-age=31536000, immutable' }) } : missing(operation);
    if (operation === 'get-object') {
      if (!objects.has(key)) return missing(operation);
      writeFileSync(args.at(-1), objects.get(key));
      return { ...ok, stdout: JSON.stringify({ ETag: etag(key) }) };
    }
    if (operation === 'put-object') {
      const match = args.indexOf('--if-match');
      if ((args.includes('--if-none-match') && objects.has(key)) || (match >= 0 && (!objects.has(key) || args[match + 1] !== etag(key)))) {
        return { status: 254, stderr: 'An error occurred (PreconditionFailed) when calling the PutObject operation: At least one precondition failed.' };
      }
      objects.set(key, readFileSync(args[args.indexOf('--body') + 1]));
      return ok;
    }
    throw new Error(`Unexpected command ${operation}`);
  });
  return { objects, calls, runCommand };
}
const puts = (b) => b.calls.filter(([, args]) => args[1] === 'put-object').map(([, args]) => args[args.indexOf('--key') + 1]);
async function uploaded(plan = first(), b = bucket()) {
  const dir = staged(plan);
  await uploadPublication(dir, { env, now, runCommand: b.runCommand });
  return { dir, b, final: readFileSync(join(dir, 'uploaded-manifest.json')) };
}

describe('planPublication and contentHash', () => {
  it.each(['constructor', 'toString', '__proto__'])('diffs own curve keys safely: %s', id => {
    const args = inputs();
    const one = bytes({ curves: { [id]: [{ simfileId: 'f', samples: [[0, 0], [1, 1]] }] } });
    const empty = bytes({ curves: {} });
    for (const [previousCurvesBytes, curvesBytes] of [[empty, one], [one, empty]]) {
      expect(publicationSummary(first(), { ...args, curvesBytes, previousCurvesBytes })).toContain(id);
    }
  });
  it('R2: refuses older/equal fetch times at PLAN and UPLOAD, including legacy generated dates', async () => {
    const previousManifest = manifest();
    previousManifest.snapshots[0].fetchedAt = '2026-10-25T00:00:00.000Z';
    for (const fetchedAt of ['2026-10-24T23:59:59Z', '2026-10-25T00:00:00.000Z']) {
      expect(() => planPublication({ ...inputs({ force: 2, fetchedAt }), previousManifest })).toThrow(/not newer/);
      // A tampered/replayed plan with an accurate live base must also refuse.
      const plan = first(); plan.baseManifestSha256 = sha(bytes(previousManifest)); plan.entry.fetchedAt = fetchedAt;
      const b = bucket([['manifest.json', bytes(previousManifest)]]);
      await expect(uploadPublication(staged(plan), { env, runCommand: b.runCommand })).rejects.toThrow(/not newer/);
      expect(puts(b)).toEqual([]);
    }
    delete previousManifest.snapshots[0].fetchedAt;
    expect(() => planPublication({ ...inputs({ force: 2, fetchedAt: '2026-10-21T12:00:00Z' }), previousManifest })).toThrow(/not newer/);
    expect(() => planPublication({ ...inputs({ force: 2, fetchedAt: '2026-10-26T12:00:00Z' }), previousManifest })).toThrow(/not newer/);
    expect(planPublication({ ...inputs({ generated: '2026-10-23', force: 2, fetchedAt: '2026-10-23T12:00:00Z' }), previousManifest }).changed).toBe(true);
    const legacyPlan = first(); legacyPlan.baseManifestSha256 = sha(bytes(previousManifest));
    const legacyBucket = bucket([['manifest.json', bytes(previousManifest)]]);
    await expect(uploadPublication(staged(legacyPlan), { env, runCommand: legacyBucket.runCommand })).rejects.toThrow(/not newer/);
    expect(puts(legacyBucket)).toEqual([]);
    for (const patch of [{ sourceRunId: undefined }, { sourceRunId: '../2' }, { fetchedAt: 'invalid' }, { fetchedAt: undefined }]) {
      expect(() => planPublication({ ...inputs(), ...patch })).toThrow(/sourceRunId and fetchedAt/);
    }
  });

  it('K14: excludes ONLY root run dates, retaining every other root field and nested dates', () => {
    const doc = { generated: 'old', catalogueGenerated: 'old', source: 'src', fields: ['x'], count: 1,
      complete: true, files: 1, future: 'keep', motors: [{ generated: 'nested' }] };
    expect(contentHash(bytes(doc))).toBe(contentHash(bytes({ ...doc, generated: 'new', catalogueGenerated: 'new' })));
    for (const key of ['source', 'fields', 'count', 'complete', 'files', 'future']) {
      const changed = { ...doc }; delete changed[key];
      expect(contentHash(bytes(changed))).not.toBe(contentHash(bytes(doc)));
    }
    expect(contentHash(bytes({ ...doc, motors: [{ generated: 'changed' }] }))).not.toBe(contentHash(bytes(doc)));
    const previousManifest = manifest();
    for (const [kind, patch] of [['motors', { source: 'new' }], ['motors', { fields: [...FULL_FIELDS].reverse() }], ['curves', { source: 'new' }]]) {
      const input = inputs(), key = `${kind}Bytes`;
      input[key] = bytes({ ...JSON.parse(input[key]), ...patch });
      expect(planPublication({ ...input, previousManifest }).changed).toBe(true);
    }
  });
  it('stages only immutable exact bytes, one entry and the base, without a future manifest or publication time', () => {
    const input = inputs(), plan = planPublication(input);
    expect(plan).toMatchObject({ changed: true, snapshotId: '2026-10-22', baseManifestSha256: 'absent', entry: { commit } });
    expect(plan).not.toHaveProperty('manifest');
    expect(plan.entry).not.toHaveProperty('publishedAt');
    expect(plan.uploads.map((u) => u.key)).toEqual(['v1/2026-10-22/motors.json', 'v1/2026-10-22/motorCurves.json']);
    expect(plan.uploads.every((u) => u.contentType === 'application/json; charset=utf-8'
      && u.cacheControl === 'public, max-age=31536000, immutable')).toBe(true);
    expect(plan.uploads.map((u) => u.bytes)).toEqual([input.motorsBytes, input.curvesBytes]);
    expect(plan.entry.motors).toEqual({ path: plan.uploads[0].key, bytes: input.motorsBytes.length, sha256: sha(input.motorsBytes),
      contentSha256: contentHash(input.motorsBytes), count: 1, generated: '2026-10-22' });
    expect(plan.entry.curves).toEqual({ path: plan.uploads[1].key, bytes: input.curvesBytes.length, sha256: sha(input.curvesBytes),
      contentSha256: contentHash(input.curvesBytes), motors: 1, files: 1, generated: '2026-10-22', catalogueGenerated: '2026-10-22' });
  });

  it('F5: dates/formatting only do not request publication, while rows and existing samples do', () => {
    const previousManifest = manifest();
    for (const input of [inputs(), inputs({ generated: '2026-10-29' }), { ...inputs(), motorsBytes: Buffer.concat([inputs().motorsBytes, Buffer.from('\n')]) }]) {
      const plan = planPublication({ ...input, previousManifest });
      expect(plan.changed).toBe(false);
      expect(plan.uploads).toEqual([]);
    }
    expect(planPublication({ ...inputs({ force: 2 }), previousManifest }).changed).toBe(true);
    expect(planPublication({ ...inputs({ motors: [{ motorId: 'a', designation: 'F2' }] }), previousManifest }).changed).toBe(true);
    const withUpdate = inputs({ motors: [{ motorId: 'a', updatedOn: '2026-10-22' }] });
    expect(planPublication({ ...withUpdate, previousManifest }).changed).toBe(true);
    expect(contentHash(bytes({ generated: 'one', catalogueGenerated: 'two', data: { b: 2, a: 1 } })))
      .toBe(contentHash(bytes({ data: { a: 1, b: 2 }, generated: 'three', catalogueGenerated: 'four' })));
  });

  it('compares legacy manifests with verified prior bytes and records the EXACT base bytes', () => {
    const previousManifest = manifest();
    delete previousManifest.snapshots[0].motors.contentSha256;
    delete previousManifest.snapshots[0].curves.contentSha256;
    const previousManifestBytes = Buffer.from(`${JSON.stringify(previousManifest)}\n\n`);
    const plan = planPublication({ ...inputs({ generated: '2026-10-29' }), previousManifest, previousManifestBytes,
      previousMotorsBytes: inputs().motorsBytes, previousCurvesBytes: inputs().curvesBytes });
    expect(plan.changed).toBe(false);
    expect(plan.baseManifestSha256).toBe(sha(previousManifestBytes));
    expect(planPublication({ ...inputs({ generated: '2026-10-29' }), previousManifest }).changed).toBe(true);
    expect(() => planPublication({ ...inputs(), previousManifest, previousManifestBytes: bytes({}) })).toThrow(/bytes differ/);
    expect(() => planPublication({ ...inputs(), previousManifest, previousMotorsBytes: bytes({}) })).toThrow(/sha256/);
  });

  it('never reuses historical ids and never mutates the base', () => {
    let previousManifest = manifest();
    for (let n = 2; n <= 12; n++) {
      const original = structuredClone(previousManifest);
      const plan = planPublication({ ...inputs({ force: n }), previousManifest });
      expect(plan.snapshotId).toBe(`2026-10-22.${n}`);
      expect(previousManifest).toEqual(original);
      previousManifest = manifest(plan, now, previousManifest.snapshots);
    }
    expect(planPublication({ ...inputs({ generated: '2026-10-23', force: 20 }), previousManifest }).snapshotId).toBe('2026-10-23');
  });

  it('K25: refuses alien curve motor ids, motor/file counts, mismatched dates and incomplete pairs', () => {
    const input = inputs(), curves = JSON.parse(input.curvesBytes);
    for (const patch of [{ catalogueGenerated: '2026-10-21' }, { generated: 'invalid' }, { complete: false },
      { motors: 2 }, { files: 2 }, { curves: { a: {} } }, { curves: { alien: curves.curves.a } }]) {
      expect(() => planPublication({ ...input, curvesBytes: bytes({ ...curves, ...patch }) })).toThrow();
    }
    expect(() => planPublication(inputs({ generated: '2026-02-30' }))).toThrow(/Invalid/);
    const motors = JSON.parse(input.motorsBytes);
    expect(() => planPublication({ ...input, motorsBytes: bytes({ ...motors, count: 5 }) })).toThrow(/Invalid/);
    expect(() => planPublication({ ...input, commit: '' })).toThrow(/commit/);
    expect(() => planPublication({ ...input, sourceAttempt: '../1' })).toThrow(/Invalid source attempt/);
  });
});

describe('Round 3 replay, summary and PUT recovery', () => {
  it('T6/T7: whole-workflow replay is green and says already published; no-change input provenance remains visible', () => {
    const input = { ...inputs(), sourceAttempt: '1' }, old = planPublication(input);
    const previousManifest = { schema: 1, current: old.snapshotId, snapshots: [{ ...old.entry, publishedAt: now }] };
    const plan = planPublication({ ...input, previousManifest });
    expect(plan).toMatchObject({ changed: false, alreadyPublished: true });
    const summary = publicationSummary(plan, { ...input, hasPrevious: true });
    expect(summary).toContain('already published as 2026-10-22');
    expect(summary).not.toContain('NEW snapshot');
    expect(summary).toContain('https://github.com/mtnmanak/mmrocket-sim/actions/runs/123');
    expect(summary).toContain('artifact attempt 1');
    expect(summary).toContain('https://github.com/mtnmanak/mmrocket-sim/commit/' + commit);
    expect(summary).toContain('Artifact created_at: 2026-10-25T00:00:00.000Z');
    const noChange = planPublication({ ...input, sourceRunId: '999', sourceAttempt: '2', fetchedAt: '2026-10-26T00:00:00Z', previousManifest });
    const text = publicationSummary(noChange, { ...input, hasPrevious: true });
    expect(text).toContain('actions/runs/999'); expect(text).toContain('artifact attempt 2');
    expect(text).not.toContain('NEW snapshot');
    const firstSummary = publicationSummary(old, input);
    expect(firstSummary).toContain('Catalogue rows: 1 added');
    expect(firstSummary).toContain('final snapshot id may gain a suffix');
    expect(firstSummary).toContain(`Input sha256: motors ${sha(input.motorsBytes)}; curves ${sha(input.curvesBytes)}`);
  });

  it('T6: snapshot PUT lost replies (exit failure or throw) re-check bytes AND headers before continuing', async () => {
    for (const thrown of [false, true]) for (const index of [0, 1]) {
      const plan = first(), target = plan.uploads[index];
      const b = bucket([], ({ operation, key, args, objects }) => {
        if (operation === 'put-object' && key === target.key) {
          objects.set(key, readFileSync(args[args.indexOf('--body') + 1]));
          if (thrown) throw new Error('lost PUT reply');
          return { status: 254, stderr: '(412) PreconditionFailed' };
        }
      });
      await uploaded(plan, b);
      expect(puts(b).at(-1)).toBe('manifest.json');
      const at = b.calls.findIndex(([, args]) => args[1] === 'put-object' && args.includes(target.key));
      expect(b.calls.slice(at + 1, at + 3).map(([, args]) => args[1])).toEqual(['head-object', 'get-object']);
    }
    for (const mismatch of ['bytes', 'headers', 'get-failure']) {
      const plan = first(), key = plan.uploads[0].key; let failed = false;
      const b = bucket([], ({ operation, key: target, args, objects }) => {
        if (target !== key) return;
        if (operation === 'put-object') {
          failed = true; objects.set(key, mismatch === 'bytes' ? bytes({ wrong: true }) : readFileSync(args[args.indexOf('--body') + 1]));
          return { status: 1, stderr: 'original PUT failed' };
        }
        if (failed && operation === 'head-object' && mismatch === 'headers') return { ...ok, stdout: '{"ContentType":"text/plain"}' };
        if (failed && operation === 'get-object' && mismatch === 'get-failure') throw new Error('GET failed');
      });
      await expect(uploadPublication(staged(plan), { env, runCommand: b.runCommand })).rejects.toThrow('original PUT failed');
      expect(b.objects.has('manifest.json')).toBe(false);
    }
  });

  it('T6: preserves the manifest PUT diagnostic if its confirmation GET also fails', async () => {
    let failed = false;
    const b = bucket([], ({ operation, key }) => {
      if (key !== 'manifest.json') return;
      if (operation === 'put-object') { failed = true; return { status: 1, stderr: 'original manifest PUT diagnostic' }; }
      if (failed && operation === 'get-object') throw new Error('confirmation GET failed');
    });
    await expect(uploadPublication(staged(), { env, runCommand: b.runCommand })).rejects.toThrow('original manifest PUT diagnostic');
  });
});

describe('validatePreviousManifest', () => {
  it('K17: only undefined means absent; null, primitives, unknown schemas and malformed history refuse', () => {
    expect(validatePreviousManifest(undefined)).toBeUndefined();
    expect(validatePreviousManifest(manifest())).toBeUndefined();
    for (const value of [null, 0, 1, false, 'text', []]) expect(() => validatePreviousManifest(value)).toThrow(/object/);
    for (const schema of [0, 2, undefined]) expect(() => validatePreviousManifest({ schema })).toThrow(/Unknown previous manifest schema/);
    const badCurrent = manifest(); badCurrent.current = '2026-10-23';
    expect(() => validatePreviousManifest(badCurrent)).toThrow(/missing/);
    const badPath = manifest(); badPath.snapshots[0].motors.path = '../secret';
    expect(() => validatePreviousManifest(badPath)).toThrow(/metadata/);
    const duplicate = manifest(); duplicate.snapshots.push(duplicate.snapshots[0]);
    expect(() => validatePreviousManifest(duplicate)).toThrow(/duplicate/);
  });
});

describe('freezeInputs, publicationSummary, stagePublication and readPublication', () => {
  it('R7: pins curves-only samples, metadata-only changes and unavailable row/curve verdicts', () => {
    const old = inputs(), prior = manifest();
    const summary = (input, evidence = { previousMotorsBytes: old.motorsBytes, previousCurvesBytes: old.curvesBytes }) =>
      publicationSummary(planPublication({ ...input, previousManifest: prior, previousSnapshotUnavailable: true }),
        { ...input, ...evidence, hasPrevious: true });
    const changed = inputs({ force: 2 });
    expect(summary(changed)).toContain('Catalogue rows: 0 changed · Curves: 1 motors changed · Dates only: no');
    const metadata = JSON.parse(old.curvesBytes); metadata.curves.a[0].digests = ['changed'];
    const text = summary({ ...old, curvesBytes: bytes(metadata) });
    expect(text).toContain('Curves: 1 motors changed · Dates only: no');
    expect(text).toContain('Motors with other file metadata changed: 1; first 20 ids: a.');
    // Legacy evidence really is unknown without either bytes or content hashes.
    const plan = first();
    expect(publicationSummary(plan, { ...changed, hasPrevious: true })).toContain(
      'Catalogue rows: UNAVAILABLE changed · Curves: UNAVAILABLE motors changed · Dates only: unknown');
    expect(publicationSummary(plan, { ...changed, previousMotorsBytes: old.motorsBytes, hasPrevious: true })).toContain(
      'Catalogue rows: 0 changed · Curves: UNAVAILABLE motors changed · Dates only: unknown');
    expect(summary(old, {})).toContain('Content vs recorded hash: motors unchanged, curves unchanged (identical content)');
    expect(summary(old, {})).toContain('Dates only: n/a (identical bytes)');
    const lines = summary(changed).trim().split('\n').filter(Boolean);
    expect(lines).toContain('- LIVE snapshot: 2026-10-22; fetched: 2026-10-22T00:00:00.000Z.');
    expect(lines).toContain('- NEW snapshot: 2026-10-22.2; fetched: 2026-10-25T00:00:00.000Z.');
    expect(lines.every((line) => line.startsWith('- ') || line.startsWith('#'))).toBe(true);
  });

  it('R7: names root metadata and array order changes beyond row/file identity', () => {
    const old = inputs(), oldCurves = JSON.parse(old.curvesBytes);
    oldCurves.curves.a.push({ simfileId: 'second', samples: [[0, 0]] }); oldCurves.files++;
    for (const [kind, inputDoc, patch, expected] of [
      ['motors', JSON.parse(old.motorsBytes), (doc) => { doc.fields.reverse(); }, 'motors root fields: fields'],
      ['curves', oldCurves, (doc) => { doc.source = 'changed'; }, 'curves root fields: source'],
      ['curves', oldCurves, (doc) => { doc.curves.a.reverse(); }, 'curves row/file identity or array order'],
    ]) {
      const next = structuredClone(inputDoc); patch(next);
      const input = { ...old, curvesBytes: bytes(oldCurves), [`${kind}Bytes`]: bytes(next) };
      const text = publicationSummary(planPublication(input), { ...input, hasPrevious: true,
        previousMotorsBytes: old.motorsBytes, previousCurvesBytes: bytes(oldCurves) });
      expect(text).toContain(`Other content changes: ${expected}`);
      expect(text).toContain('Dates only: no');
    }
  });
  it('freezes exactly two files with sha256 and detects input artifact corruption', () => {
    const dir = tmp(), input = inputs();
    freezeInputs(input, dir);
    expect(readFileSync(join(dir, 'motors-full.json'))).toEqual(input.motorsBytes);
    expect(readFileSync(join(dir, 'motorCurves.json'))).toEqual(input.curvesBytes);
    expect(JSON.parse(readFileSync(join(dir, 'inputs.json')))).toEqual({ schema: 1, motors: sha(input.motorsBytes), curves: sha(input.curvesBytes) });
    expect(validateInputs(join(dir, 'inputs.json'), input)).toBeUndefined();
    writeFileSync(join(dir, 'inputs.json'), bytes({ motors: sha(input.motorsBytes), curves: sha(input.curvesBytes) }));
    expect(() => validateInputs(join(dir, 'inputs.json'), input)).toThrow(/sha256 mismatch/);
    expect(() => validateInputs(join(dir, 'inputs.json'), { ...input, curvesBytes: bytes({}) })).toThrow(/input artifact sha256/);
  });

  it('F7: shows full-row changes, added/removed simfiles and existing sample changes with bounded ids', () => {
    const previous = inputs({ motors: [{ motorId: 'a', manufacturer: 'Old' }, { motorId: 'removed' }] });
    const input = inputs({ motors: [{ motorId: 'a', manufacturer: 'New' }, { motorId: 'added' }], force: 2 });
    const curves = JSON.parse(input.curvesBytes);
    curves.curves.a.push({ simfileId: 'new', samples: [[0, 0]] }); curves.files++;
    const priorCurves = JSON.parse(previous.curvesBytes);
    priorCurves.curves.a.push({ simfileId: 'old', samples: [[0, 0]] });
    const summary = publicationSummary(planPublication(input), { ...input, previousMotorsBytes: previous.motorsBytes,
      previousCurvesBytes: bytes(priorCurves), curvesBytes: bytes(curves), hasPrevious: true });
    expect(summary).toMatch(/Catalogue rows: 3 changed · Curves: 1 motors changed · Dates only: no/);
    expect(summary).toContain('1 added, 1 removed, 1 changed');
    expect(summary).toContain('Motors with simfile ids added/removed: 1; first 20 ids: a');
    expect(summary).toContain('Simfile ids added (motor/file): 1; first 20 ids: a/new');
    expect(summary).toContain('Simfile ids removed (motor/file): 1; first 20 ids: a/old');
    expect(summary).toContain('Motors with existing simfile samples changed: 1; first 20 ids: a');
    const many = inputs({ motors: Array.from({ length: 25 }, (_, i) => ({ motorId: i ? `motor-${i}` : 'a' })) });
    const line = publicationSummary(planPublication(many), many).split('\n').find((s) => s.startsWith('- Rows added:'));
    expect(line).toContain('25;'); expect(line).toContain('motor-19'); expect(line).not.toContain('motor-20');
    const dated = inputs({ generated: '2026-10-29' });
    expect(publicationSummary(planPublication(dated), { ...dated, previousMotorsBytes: inputs().motorsBytes,
      previousCurvesBytes: inputs().curvesBytes, hasPrevious: true })).toContain('Dates only: yes');
    expect(publicationSummary(first(), inputs())).toContain('First publication');
    expect(publicationSummary(first(), { ...inputs(), unavailable: ['previous rows HTTP 503'], hasPrevious: true }))
      .toContain('**UNAVAILABLE: previous rows HTTP 503**');
  });

  it('round-trips only entry/base/files and refuses damaged bytes, metadata, order and headers', () => {
    const plan = first(), dir = staged(plan), read = readPublication(dir);
    expect(read.entry).toEqual(plan.entry);
    expect(read.uploads.map((u) => u.bytes)).toEqual(plan.uploads.map((u) => u.bytes));
    expect(readFileSync(join(dir, 'plan.json'), 'utf8')).not.toContain(dir);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false);
    writeFileSync(join(dir, 'v1/2026-10-22/motors.json'), 'broken');
    expect(() => readPublication(dir)).toThrow(/Staged bytes/);
    for (const mutate of [
      (p) => { p.uploads[0].contentType = 'text/html'; }, (p) => { p.uploads.reverse(); }, (p) => { p.uploads[0].cacheControl = 'public'; },
      (p) => { p.entry.motors.sha256 = '0'.repeat(64); }, (p) => { p.baseManifestSha256 = 'invalid'; },
      (p) => { p.entry.curves.contentSha256 = '0'.repeat(64); },
    ]) {
      const dir = staged(), file = join(dir, 'plan.json'), p = JSON.parse(readFileSync(file));
      mutate(p); writeFileSync(file, bytes(p)); expect(() => readPublication(dir)).toThrow();
    }
    const noop = staged(planPublication({ ...inputs(), previousManifest: manifest() }));
    expect(readPublication(noop).uploads).toEqual([]);
  });
});

describe('uploadPublication', () => {
  it('R3: retries its own publication and a lost PUT response; rejects an entry that differs beyond publishedAt', async () => {
    const plan = first(), b = bucket(), { final } = await uploaded(plan, b);
    b.calls.length = 0;
    const dir = staged(plan);
    expect(await uploadPublication(dir, { env, now: '2026-10-30', runCommand: b.runCommand })).toBe('already live');
    expect(puts(b)).toEqual([]); expect(readFileSync(join(dir, 'uploaded-manifest.json'))).toEqual(final);
    const changed = JSON.parse(final); changed.snapshots[0].commit = 'external'; b.objects.set('manifest.json', bytes(changed));
    await expect(uploadPublication(staged(plan), { env, runCommand: b.runCommand })).rejects.toThrow(/moved on to 2026-10-22/);
    for (const throws of [false, true]) {
      const lost = bucket([], ({ operation, key, args, objects }) => {
        if (operation !== 'put-object' || key !== 'manifest.json') return;
        objects.set(key, readFileSync(args[args.indexOf('--body') + 1]));
        if (throws) throw new Error('response lost secret-key');
        return { status: 254, stderr: 'An error occurred (PreconditionFailed) when calling the PutObject operation: response lost' };
      });
      const retryDir = staged(plan);
      expect(await uploadPublication(retryDir, { env, runCommand: lost.runCommand })).toBe('already live');
      expect(readFileSync(join(retryDir, 'uploaded-manifest.json'))).toEqual(lost.objects.get('manifest.json'));
    }
  });

  it('R4/K26: fails closed on operation-specific unknown errors, malformed account and thrown secret-bearing commands', async () => {
    for (const operation of ['get-object', 'head-object']) {
      for (const stderr of ['(NoSuchBucket)', '(AccessDenied)', '403',
        operation === 'get-object' ? missing('head-object').stderr : missing('get-object').stderr]) {
        const b = bucket([], ({ operation: op }) => op === operation ? { status: 254, stderr } : undefined);
        await expect(uploadPublication(staged(), { env, runCommand: b.runCommand })).rejects.toThrow(/GET failed|HEAD failed/);
        expect(puts(b)).toEqual([]);
      }
    }
    const runCommand = vi.fn();
    await expect(uploadPublication(staged(), { env: { ...env, CLOUDFLARE_ACCOUNT_ID: 'bad-id' }, runCommand })).rejects.toThrow(/invalid/);
    expect(runCommand).not.toHaveBeenCalled();
    runCommand.mockRejectedValue(new Error('secret-id secret-key transport'));
    await expect(uploadPublication(staged(), { env, runCommand })).rejects.toThrow('AWS get-object manifest.json: [REDACTED] [REDACTED] transport');
  });

  it('T6: skips incorrect resume headers and stops after 20 occupied candidates without writes', async () => {
    const plan = first();
    for (const [field, value] of [['ContentType', 'text/plain'], ['CacheControl', 'public']]) {
      const b = bucket(plan.uploads.map((u) => [u.key, u.bytes]), ({ operation, key }) => operation === 'head-object' && plan.uploads.some((u) => u.key === key)
        ? { ...ok, stdout: JSON.stringify({ ContentType: 'application/json; charset=utf-8', CacheControl: 'public, max-age=31536000, immutable', [field]: value }) } : undefined);
      const dir = staged(plan);
      await uploadPublication(dir, { env, runCommand: b.runCommand });
      expect(JSON.parse(readFileSync(join(dir, 'uploaded.json'))).snapshotId).toBe('2026-10-22.2');
      expect(puts(b)).toEqual(['v1/2026-10-22.2/motors.json', 'v1/2026-10-22.2/motorCurves.json', 'manifest.json']);
    }
    const b = bucket(Array.from({ length: 20 }, (_, i) => [`v1/2026-10-22${i ? `.${i + 1}` : ''}/motors.json`, bytes({ wrong: true })]));
    await expect(uploadPublication(staged(plan), { env, runCommand: b.runCommand })).rejects.toThrow(/after 20 tries/);
    expect(b.calls.filter(([, args]) => args[1] === 'head-object')).toHaveLength(20);
    expect(puts(b)).toEqual([]);
  });

  it('R6: preserves unknown manifest root fields and complete history verbatim', async () => {
    const prior = { ...manifest(), notice: { withdrawn: ['motor-a'], future: true } };
    const plan = planPublication({ ...inputs({ force: 2 }), previousManifest: prior });
    const { final } = await uploaded(plan, bucket([['manifest.json', Buffer.from(`${JSON.stringify(prior, null, 2)}\n`)]]));
    expect(JSON.parse(final).notice).toEqual(prior.notice);
    expect(JSON.parse(final).snapshots.slice(1)).toEqual(prior.snapshots);
  });
  it('F1: exact happy-path AWS sequence, conditional pointer LAST, live history preserved, upload-time timestamps', async () => {
    const prior = manifest(), priorBytes = Buffer.from(`${JSON.stringify(prior)}\n\n`);
    const plan = planPublication({ ...inputs({ force: 2 }), previousManifest: prior, previousManifestBytes: priorBytes });
    const b = bucket([['manifest.json', priorBytes]]), { dir, final } = await uploaded(plan, b);
    const common = ['--bucket', 'mmr-motor-catalogue', '--region', 'auto', '--endpoint-url', `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`];
    const liveFile = b.calls[0][1].at(-1), finalFile = b.calls.at(-1)[1][b.calls.at(-1)[1].indexOf('--body') + 1];
    expect(b.calls.map((c) => c.slice(0, 2))).toEqual([
      ['aws', ['s3api', 'get-object', ...common, '--key', 'manifest.json', liveFile]],
      ...plan.uploads.map((u) => ['aws', ['s3api', 'head-object', ...common, '--key', u.key]]),
      ...plan.uploads.map((u) => ['aws', ['s3api', 'put-object', ...common, '--key', u.key, '--body', resolve(dir, u.key),
        '--content-type', u.contentType, '--cache-control', u.cacheControl, '--if-none-match', '*']]),
      ['aws', ['s3api', 'put-object', ...common, '--key', 'manifest.json', '--body', finalFile,
        '--content-type', 'application/json; charset=utf-8', '--cache-control', 'public, max-age=300', '--if-match', `"${sha(priorBytes)}"`]],
    ]);
    for (const call of b.calls) expect(call[2].env).toEqual({ ...env, AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' });
    const published = JSON.parse(final);
    expect(published.publishedAt).toBe(now);
    expect(published.snapshots[0].publishedAt).toBe(now);
    expect(published.snapshots.slice(1)).toEqual(prior.snapshots);
    expect(b.objects.get('manifest.json')).toEqual(final);
    expect(JSON.parse(readFileSync(join(dir, 'uploaded.json')))).toEqual({ snapshotId: plan.snapshotId, sha256: sha(final) });
    expect(existsSync(liveFile)).toBe(false);
  });

  it('F1: stale base, absent-now-existing, or deleted live base refuse BEFORE any writes', async () => {
    const prior = manifest(), priorBytes = bytes(prior);
    const plan = planPublication({ ...inputs({ force: 2 }), previousManifest: prior, previousManifestBytes: priorBytes });
    const newer = bytes(manifest(planPublication({ ...inputs({ generated: '2026-10-23', force: 3 }), previousManifest: prior }), now, prior.snapshots));
    for (const [p, initial] of [[plan, [['manifest.json', newer]]], [first(), [['manifest.json', bytes({ ...prior, notice: 'external' })]]], [plan, []]]) {
      const b = bucket(initial);
      await expect(uploadPublication(staged(p), { env, runCommand: b.runCommand })).rejects.toThrow(/live catalogue moved on to.*re-run the refresh/);
      expect(puts(b)).toEqual([]);
      expect(b.calls).toHaveLength(1);
      expect([...b.objects]).toEqual(initial);
    }
  });

  it('F1: first publication conditionally creates the pointer and a 412 race refuses', async () => {
    const { b } = await uploaded();
    expect(b.calls.at(-1)[1].slice(-2)).toEqual(['--if-none-match', '*']);
    const prior = manifest(), priorBytes = bytes(prior);
    const next = planPublication({ ...inputs({ force: 2 }), previousManifest: prior, previousManifestBytes: priorBytes });
    for (const [plan, initial] of [[first(), []], [next, [['manifest.json', priorBytes]]]]) {
      const racing = bucket(initial, ({ operation, key, objects }) => {
        if (operation === 'put-object' && key === 'manifest.json') objects.set(key, bytes(manifest(planPublication(inputs({ force: 9 })))) );
      });
      const dir = staged(plan);
      await expect(uploadPublication(dir, { env, runCommand: racing.runCommand })).rejects.toThrow(/live catalogue moved on to.*re-run the refresh/);
      expect(JSON.parse(racing.objects.get('manifest.json')).snapshots[0].curves.sha256).toBe(sha(inputs({ force: 9 }).curvesBytes));
      expect(existsSync(join(dir, 'uploaded.json'))).toBe(false);
    }
  });

  it('R5/K21: resumes identical bytes or skips different orphan bytes for EACH file before writing', async () => {
    const plan = first();
    const matching = bucket(plan.uploads.map((u) => [u.key, u.bytes]));
    await uploaded(plan, matching);
    expect(matching.calls.map(([, a]) => a[1])).toEqual(['get-object', 'head-object', 'get-object', 'head-object', 'get-object', 'put-object']);
    expect(puts(matching)).toEqual(['manifest.json']);
    for (const index of [0, 1]) {
      const initial = plan.uploads.slice(0, index + 1).map((u, i) => [u.key, i === index ? bytes({ wrong: true }) : u.bytes]);
      const different = bucket(initial), { dir, final } = await uploaded(plan, different);
      const entry = JSON.parse(final).snapshots[0];
      expect(entry.id).toBe('2026-10-22.2');
      expect(puts(different)).toEqual(['v1/2026-10-22.2/motors.json', 'v1/2026-10-22.2/motorCurves.json', 'manifest.json']);
      for (const [key, value] of initial) expect(different.objects.get(key)).toEqual(value);
      await verifyPublication(dir, { base: 'https://example.invalid', fetchImpl: async (url) => response(different.objects.get(new URL(url).pathname.slice(1))) });
      // Re-staging loses the local receipt; the live final suffix still identifies this plan.
      expect(await uploadPublication(staged(plan), { env, runCommand: different.runCommand })).toBe('already live');
    }
  });

  it('F6: retries the same staged plan after the second snapshot PUT fails', async () => {
    let fail = true;
    const plan = first(), dir = staged(plan), b = bucket([], ({ operation, key }) => {
      if (fail && operation === 'put-object' && key.endsWith('motorCurves.json')) return { status: 1, stderr: 'transient' };
    });
    await expect(uploadPublication(dir, { env, runCommand: b.runCommand })).rejects.toThrow(/Upload failed/);
    expect(b.objects.has('manifest.json')).toBe(false);
    fail = false; b.calls.length = 0;
    await uploadPublication(dir, { env, now, runCommand: b.runCommand });
    expect(puts(b)).toEqual([plan.uploads[1].key, 'manifest.json']);
  });

  it('F6: retries after a failed manifest PUT with both snapshots already present', async () => {
    let fail = true;
    const dir = staged(), b = bucket([], ({ operation, key }) => fail && operation === 'put-object' && key === 'manifest.json'
      ? { status: 1, stderr: '(503) ServiceUnavailable' } : undefined);
    await expect(uploadPublication(dir, { env, runCommand: b.runCommand })).rejects.toThrow(/503.*ServiceUnavailable/);
    expect(b.objects.size).toBe(2);
    expect(b.objects.has('manifest.json')).toBe(false);
    fail = false; b.calls.length = 0;
    await uploadPublication(dir, { env, now, runCommand: b.runCommand });
    expect(puts(b)).toEqual(['manifest.json']);
    expect(JSON.parse(b.objects.get('manifest.json')).publishedAt).toBe(now);
  });

  it('fails closed on auth, transport, missing CLI/ETag and existing-object GET failures; stderr is scrubbed', async () => {
    for (const error of [{ status: 254, stderr: '(403) Forbidden secret-id secret-key' }, { status: 1, stderr: 'network' },
      { status: null, error: new Error('missing aws'), stderr: '(404)' }]) {
      const runCommand = vi.fn().mockResolvedValue(error);
      await expect(uploadPublication(staged(), { env, runCommand })).rejects.toThrow(/Live manifest GET failed/);
      expect(runCommand).toHaveBeenCalledTimes(1);
    }
    const plan = first();
    for (const operation of ['head-object', 'get-object']) {
      const b = bucket([[plan.uploads[0].key, plan.uploads[0].bytes]], ({ operation: op, key }) => op === operation && key !== 'manifest.json'
        ? { status: 254, stderr: '(403) AccessDenied secret-id secret-key' } : undefined);
      await expect(uploadPublication(staged(), { env, runCommand: b.runCommand })).rejects.toThrow(/AccessDenied \[REDACTED\] \[REDACTED\]/);
      expect(puts(b)).toEqual([]);
    }
    const prior = manifest(), data = bytes(prior), next = planPublication({ ...inputs({ force: 2 }), previousManifest: prior, previousManifestBytes: data });
    const b = bucket([['manifest.json', data]], ({ operation, key, args }) => {
      if (operation === 'get-object' && key === 'manifest.json') { writeFileSync(args.at(-1), data); return ok; }
    });
    await expect(uploadPublication(staged(next), { env, runCommand: b.runCommand })).rejects.toThrow(/no ETag/);
    expect(puts(b)).toEqual([]);
  });

  it('does no AWS work for no change or invalid account configuration', async () => {
    const runCommand = vi.fn(), noOp = planPublication({ ...inputs(), previousManifest: manifest() });
    await uploadPublication(staged(noOp), { runCommand, env: {} });
    await expect(uploadPublication(staged(), { runCommand, env: {} })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('verifyPublication', () => {
  const base = 'https://catalogue.example.invalid';
  it('R3/K26: retries HTTP, transport and hash failures for EACH snapshot and validates the receipt hash', async () => {
    const { dir, final } = await uploaded();
    const sleep = vi.fn(), fetchImpl = vi.fn().mockResolvedValueOnce(response(final));
    for (const data of [inputs().motorsBytes, inputs().curvesBytes]) {
      fetchImpl.mockResolvedValueOnce(response('', 502)).mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(response('wrong hash')).mockResolvedValueOnce(response(data));
    }
    await verifyPublication(dir, { base, fetchImpl, sleep, attempts: 4, delayMs: 0 });
    expect(sleep.mock.calls).toEqual(Array.from({ length: 6 }, () => [0]));
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([`${base}/manifest.json`,
      ...Array(4).fill(`${base}/v1/2026-10-22/motors.json`), ...Array(4).fill(`${base}/v1/2026-10-22/motorCurves.json`)]);
    writeFileSync(join(dir, 'uploaded-manifest.json'), bytes({ ...JSON.parse(final), publishedAt: 'tampered' }));
    fetchImpl.mockClear();
    await expect(verifyPublication(dir, { base, fetchImpl, sleep: vi.fn(), attempts: 1 })).rejects.toThrow(/Invalid uploaded manifest receipt/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('F1: verifies upload-time manifest bytes, retries cache failures, then checks both immutable files', async () => {
    const { dir, final } = await uploaded(), sleep = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response('{}', 503)).mockResolvedValueOnce(response('{"current":"old"}'));
    for (const data of [final, inputs().motorsBytes, inputs().curvesBytes]) fetchImpl.mockResolvedValueOnce(response(data));
    await verifyPublication(dir, { base, fetchImpl, sleep, delayMs: 0 });
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([`${base}/manifest.json`, `${base}/manifest.json`, `${base}/manifest.json`,
      `${base}/v1/2026-10-22/motors.json`, `${base}/v1/2026-10-22/motorCurves.json`]);
    expect(sleep.mock.calls).toEqual([[0], [0]]);
    for (const [, options] of fetchImpl.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses wrong manifest bytes even with matching current, missing receipts, and corrupt/missing snapshots', async () => {
    const { dir, final } = await uploaded();
    for (const body of ['{}', '{"current":"2026-10-22"}', bytes({ ...JSON.parse(final), publishedAt: 'changed' })]) {
      const fetchImpl = vi.fn().mockResolvedValue(response(body));
      await expect(verifyPublication(dir, { base, fetchImpl, sleep: vi.fn(), attempts: 3, delayMs: 0 })).rejects.toThrow(/did not converge/);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    }
    for (const bad of [response('corrupt'), response('', 404)]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(final)).mockResolvedValueOnce(bad);
      await expect(verifyPublication(dir, { base, fetchImpl, attempts: 2, sleep: vi.fn(), delayMs: 0 })).rejects.toThrow(/snapshot/);
    }
    const fetchImpl = vi.fn();
    await expect(verifyPublication(staged(), { base, fetchImpl })).rejects.toThrow(/uploaded.json/);
    await verifyPublication(staged(planPublication({ ...inputs(), previousManifest: manifest() })), { base, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CLI main (all external dependencies faked)', () => {
  function files(input = inputs()) {
    const dir = tmp(), motors = join(dir, 'motors.json'), curves = join(dir, 'curves.json');
    writeFileSync(motors, input.motorsBytes); writeFileSync(curves, input.curvesBytes);
    return { dir, motors, curves };
  }
  it('freezes, plans, emits scalars/summary, uploads and verifies through fake AWS and public fetches', async () => {
    const { dir, motors, curves } = files(), out = join(dir, 'staged'), summary = join(dir, 'summary.md'), frozen = join(dir, 'frozen');
    const stdout = vi.fn(), stderr = vi.fn(), options = { env: { GITHUB_SHA: commit }, stdout, stderr };
    expect(await main(['freeze', '--motors', motors, '--curves', curves, '--out', frozen], options)).toBe(0);
    const args = ['plan', '--source-run-id', '123', '--fetched-at', '2026-10-25T00:00:00.000Z', '--motors', motors, '--curves', curves, '--previous', 'none', '--out', out, '--summary', summary,
      '--inputs', join(frozen, 'inputs.json')];
    expect(await main(args, options)).toBe(0);
    expect(stdout).toHaveBeenCalledWith('changed=true\nsnapshot=2026-10-22\n');
    expect(readFileSync(summary, 'utf8')).toContain('Motors: 1');
    const b = bucket();
    expect(await main(['upload', '--plan', out], { env, now, runCommand: b.runCommand, stdout, stderr })).toBe(0);
    const fetchImpl = vi.fn(async (url) => response(b.objects.get(new URL(url).pathname.slice(1))));
    expect(await main(['verify', '--base', 'https://example.invalid', '--plan', out], { fetchImpl, stdout, stderr })).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    writeFileSync(curves, bytes({ changed: true }));
    expect(await main(args, options)).toBe(1);
    expect(stderr.mock.calls.at(-1)[0]).toContain('input artifact sha256');
  });

  it('reads prior rows AND curves, checks exact hashes, and reports unavailable diffs without blocking repair', async () => {
    const { dir, motors, curves } = files(inputs({ force: 2 })), prior = join(dir, 'previous.json'), summary = join(dir, 'summary.md');
    const old = inputs(); writeFileSync(prior, bytes(manifest()));
    const stdout = vi.fn(), stderr = vi.fn(), out = join(dir, 'staged');
    const options = { stdout, stderr, env: { GITHUB_SHA: commit }, sleep: vi.fn(), delayMs: 0 };
    const args = ['plan', '--source-run-id', '123', '--fetched-at', '2026-10-25T00:00:00.000Z', '--motors', motors, '--curves', curves, '--previous', prior, '--out', out, '--summary', summary];
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(old.motorsBytes)).mockResolvedValueOnce(response(old.curvesBytes));
    expect(await main(args, { ...options, fetchImpl })).toBe(0);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['https://catalogue.mountainmanrockets.com/v1/2026-10-22/motors.json',
      'https://catalogue.mountainmanrockets.com/v1/2026-10-22/motorCurves.json']);
    expect(readFileSync(summary, 'utf8')).toContain('Curves: 1 motors changed');
    for (const bad of [response('', 503), response('wrong hash')]) {
      expect(await main(args, { ...options, fetchImpl: vi.fn().mockResolvedValue(bad) })).toBe(0);
      const text = readFileSync(summary, 'utf8');
      expect(text).toContain('**UNAVAILABLE: previous motors diff');
      expect(text).toContain('**UNAVAILABLE: previous curves diff');
      expect(readPublication(out).changed).toBe(true);
    }
    // Same content must still repair an unreadable current snapshot; its recorded
    // content hashes alone must not suppress the approval for replacement files.
    writeFileSync(curves, old.curvesBytes);
    expect(await main(args, { ...options, fetchImpl: vi.fn().mockResolvedValue(response('', 404)) })).toBe(0);
    expect(readPublication(out)).toMatchObject({ changed: true, snapshotId: '2026-10-22.2' });
    expect(readFileSync(summary, 'utf8')).toContain('**UNAVAILABLE:');
    const oldMotors = join(dir, 'old-motors.json'), oldCurves = join(dir, 'old-curves.json');
    writeFileSync(oldMotors, old.motorsBytes); writeFileSync(oldCurves, old.curvesBytes);
    expect(await main([...args, '--previous-motors', oldMotors, '--previous-curves', oldCurves], { ...options, fetchImpl: () => { throw new Error('unexpected network'); } })).toBe(0);
    expect(readFileSync(summary, 'utf8')).not.toContain('UNAVAILABLE');
  });

  it('K17/K18: refuses JSON null/unknown schemas/options; prints AWS diagnostics while redacting both secret values', async () => {
    const { dir, motors, curves } = files(), prior = join(dir, 'previous.json'), stderr = vi.fn();
    const args = ['plan', '--source-run-id', '123', '--fetched-at', '2026-10-25T00:00:00.000Z', '--motors', motors, '--curves', curves, '--previous', prior, '--out', join(dir, 'staged')];
    for (const body of ['null', '[]', '42', 'true', '"text"', '{"schema":2}']) {
      writeFileSync(prior, body); expect(await main(args, { stderr })).toBe(1);
      expect(existsSync(join(dir, 'staged'))).toBe(false);
    }
    for (const args of [[], ['oops'], ['upload'], ['verify', '--unknown', 'a']]) expect(await main(args, { stderr })).toBe(1);
    const runCommand = vi.fn().mockResolvedValue({ status: 1, stderr: '(403) AccessDenied secret-key secret-id' });
    expect(await main(['upload', '--plan', staged()], { env, runCommand, stderr })).toBe(1);
    expect(stderr.mock.calls.at(-1)[0]).toContain('(403) AccessDenied [REDACTED] [REDACTED]');
    expect(stderr.mock.calls.flat().join('\n')).not.toMatch(/secret-key|secret-id/);
  });

  it('T1: --commit overrides a different runner GITHUB_SHA and validates exact lower-case SHA', async () => {
    const { dir, motors, curves } = files(), stderr = vi.fn(), runCommand = vi.fn();
    const args = ['plan', '--source-run-id', '123', '--source-attempt', '2', '--fetched-at', '2026-10-25T00:00:00Z',
      '--motors', motors, '--curves', curves, '--previous', 'none', '--out', join(dir, 'out'), '--commit', commit];
    expect(await main(args, { env: { GITHUB_SHA: 'b'.repeat(40) }, runCommand, stdout: vi.fn(), stderr })).toBe(0);
    expect(runCommand).not.toHaveBeenCalled();
    expect(readPublication(join(dir, 'out')).entry).toMatchObject({ commit, sourceAttempt: '2' });
    for (const bad of ['abc123', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), '../main', '']) {
      expect(await main([...args.slice(0, -1), bad], { env: { GITHUB_SHA: commit }, stderr })).toBe(1);
    }
  });

  it('T6: retries previous snapshot transport/HTTP/hash failures with bounded fetch signals before UNAVAILABLE', async () => {
    const old = inputs(), { dir, motors, curves } = files(old), prior = join(dir, 'prior.json'), summary = join(dir, 'summary.md');
    writeFileSync(prior, bytes(manifest()));
    const args = ['plan', '--source-run-id', '124', '--source-attempt', '1', '--fetched-at', '2026-10-26T00:00:00Z',
      '--motors', motors, '--curves', curves, '--previous', prior, '--out', join(dir, 'out'), '--summary', summary, '--commit', commit];
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(response('', 503))
      .mockResolvedValueOnce(response(old.motorsBytes)).mockResolvedValueOnce(response(old.curvesBytes));
    const sleep = vi.fn(), stderr = vi.fn(), stdout = vi.fn();
    expect(await main(args, { env: {}, fetchImpl, sleep, delayMs: 0, attempts: 3, stderr, stdout })).toBe(0);
    expect(sleep.mock.calls).toEqual([[0], [0]]);
    expect(readPublication(join(dir, 'out')).changed).toBe(false);
    expect(readFileSync(summary, 'utf8')).not.toContain('UNAVAILABLE');
    for (const [, options] of fetchImpl.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal);
    const fail = vi.fn().mockResolvedValue(response('', 503)); sleep.mockClear();
    expect(await main(args, { env: {}, fetchImpl: fail, sleep, delayMs: 0, attempts: 3, stderr, stdout })).toBe(0);
    expect(fail).toHaveBeenCalledTimes(6); expect(sleep).toHaveBeenCalledTimes(4);
    expect(readFileSync(summary, 'utf8')).toContain('UNAVAILABLE');
  });

  it('T6/T7: CLI replay says already published and upload summary records the final suffix', async () => {
    const input = { ...inputs(), sourceAttempt: '1' }, plan = planPublication(input);
    const { dir, motors, curves } = files(input), prior = join(dir, 'prior.json'), summary = join(dir, 'summary.md');
    writeFileSync(prior, bytes({ schema: 1, current: plan.snapshotId, snapshots: [plan.entry] }));
    const args = ['plan', '--source-run-id', input.sourceRunId, '--source-attempt', '1', '--fetched-at', input.fetchedAt,
      '--commit', commit, '--motors', motors, '--curves', curves, '--previous', prior, '--out', join(dir, 'replay'),
      '--previous-motors', motors, '--previous-curves', curves];
    const stdout = vi.fn(), stderr = vi.fn();
    expect(await main(args, { env: {}, stdout, stderr })).toBe(0);
    expect(stderr).toHaveBeenCalledWith('already published as 2026-10-22');
    expect(stdout).toHaveBeenCalledWith('changed=false\nsnapshot=2026-10-22\n');
    const b = bucket([[plan.uploads[0].key, bytes({ orphan: true })]]);
    expect(await main(['upload', '--plan', staged(plan)], { env: { ...env, GITHUB_STEP_SUMMARY: summary },
      stdout, stderr, runCommand: b.runCommand })).toBe(0);
    expect(readFileSync(summary, 'utf8')).toBe('Catalogue publication: published as 2026-10-22.2\n');
  });

  it('can determine commit via injected read-only git, and returns failure when it cannot', async () => {
    const { dir, motors, curves } = files(), stderr = vi.fn();
    const args = ['plan', '--source-run-id', '123', '--fetched-at', '2026-10-25T00:00:00.000Z', '--motors', motors, '--curves', curves, '--previous', 'none', '--out', join(dir, 'plan')];
    const runCommand = vi.fn().mockResolvedValue({ status: 0, stdout: `${commit}\n` });
    expect(await main(args, { env: {}, runCommand, stdout: vi.fn(), stderr })).toBe(0);
    expect(runCommand).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], { env: {} });
    expect(readPublication(join(dir, 'plan')).entry.commit).toBe(commit);
    expect(await main(args, { env: {}, runCommand: vi.fn().mockResolvedValue({ status: 1 }), stderr })).toBe(1);
    expect(stderr.mock.calls.at(-1)[0]).toContain('Cannot determine commit');
  });
});
