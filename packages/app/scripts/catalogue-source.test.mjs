import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INPUT_ARTIFACT, REFRESH_JOB, SEAL_STEP, approvalErrorNotice, approvalNotice, main, selectSource } from './catalogue-source.mjs';
import { planPublication } from './catalogue-publish.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/catalogue-source.json', import.meta.url), 'utf8'));
const job = (data) => data.attempts[0].pages[0].jobs[0];
const artifact = (data) => data.artifacts[0].artifacts[0];
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('GitHub REST source eligibility', () => {
  it('T2: retains artifact creation and producing attempt when only the old run PR job is re-run', () => {
    const data = fixture();
    const source = selectSource(data);
    expect(source).toMatchObject({ eligible: true, fetched_at: '2026-10-19T09:20:00Z', source_attempt: '1', commit: data.run.head_sha });
    data.run.run_started_at = '2026-11-01T12:00:00Z';
    expect(selectSource(data)).toEqual(source);
    // The old data cannot cross a newer live entry's monotonic guard even
    // though the run API now reports a later run_started_at.
    const motors = { generated: '2026-10-19', count: 1, motors: [{ motorId: 'a' }] };
    const curves = { generated: motors.generated, catalogueGenerated: motors.generated, complete: true,
      motors: 1, files: 1, curves: { a: [{ samples: [[0, 0]] }] } };
    const input = { motorsBytes: Buffer.from(JSON.stringify(motors)), curvesBytes: Buffer.from(JSON.stringify(curves)),
      commit: source.commit, sourceRunId: source.source_run_id, fetchedAt: source.fetched_at };
    const live = planPublication({ ...input, fetchedAt: '2026-10-20T09:20:00Z' });
    const previousManifest = { schema: 1, current: live.snapshotId, snapshots: [live.entry] };
    curves.curves.a[0].samples = [[0, 1]];
    expect(() => planPublication({ ...input, curvesBytes: Buffer.from(JSON.stringify(curves)), previousManifest })).toThrow(/not newer/);
    job(data).conclusion = 'failure';
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: false, reason: expect.stringContaining('artifact attempt 1') });
  });

  it('T3 timestamps: accepts documented offset, .000Z and Z and excludes an equal seal instant', () => {
    for (const end of ['2026-10-19T01:20:03.000-08:00', '2026-10-19T09:20:03.000Z', '2026-10-19T09:20:03Z']) {
      const data = fixture(); job(data).steps[1].completed_at = end;
      expect(selectSource(data).eligible).toBe(true);
    }
    for (const created of ['2026-10-19T09:17:00Z', '2026-10-19T09:20:02.999Z']) {
      const data = fixture(); artifact(data).created_at = created;
      expect(selectSource(data).eligible).toBe(true);
    }
    for (const created of ['2026-10-19T09:20:03Z', '2026-10-19T01:20:03.000-08:00', '2026-10-19T09:16:59Z']) {
      const data = fixture(); artifact(data).created_at = created;
      expect(selectSource(data)).toMatchObject({ eligible: false, failed: true, reason: expect.stringContaining('outside') });
    }
  });

  it('T3 path: accepts ref-suffixed REST paths or the workflow name, and rejects another workflow', () => {
    for (const path of ['.github/workflows/motors-refresh.yml', '.github/workflows/motors-refresh.yml@main', 'other/motors-refresh.yml@refs/heads/main']) {
      const data = fixture(); data.run.path = path; data.run.name = 'different';
      expect(selectSource(data).eligible).toBe(true);
    }
    const data = fixture(); data.run.path = 'unexpected';
    expect(selectSource(data).eligible).toBe(true);
    data.run.name = 'Other';
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: false, reason: expect.stringContaining('workflow') });
  });

  it('T3: explains neutral branch/event/repository/unfinished/gate outcomes and red missing/expired/ambiguous inputs', () => {
    for (const [key, value, reason] of [['head_branch', 'feature', 'main'], ['event', 'push', 'event'], ['status', 'in_progress', 'completed'],
      ['repository', { full_name: 'fork/repo' }, 'repository'], ['head_repository', null, 'repository']]) {
      const data = fixture(); data.run[key] = value;
      expect(selectSource(data)).toMatchObject({ eligible: false, failed: false, reason: expect.stringContaining(reason) });
    }
    // The fixture's refresh job has the seal step: it ran the pipeline, so its
    // missing artifact is a Freeze/Upload failure, not an old run.
    const missing = fixture(); missing.artifacts[0].artifacts = [];
    expect(selectSource(missing)).toMatchObject({ failed: true, reason: 'source refresh attempt 1 ran the catalogue pipeline but uploaded no '
      + 'catalogue-input artifact; see its "Freeze the catalogue input bytes and sha256" and "Upload frozen catalogue inputs" steps' });
    const old = fixture(); old.artifacts[0].artifacts = []; job(old).steps = job(old).steps.filter((s) => s.name !== SEAL_STEP);
    expect(selectSource(old)).toMatchObject({ failed: true, reason: 'source run has no catalogue-input artifact — it predates the catalogue pipeline; run a new refresh' });
    job(missing).conclusion = 'failure';
    expect(selectSource(missing)).toMatchObject({ failed: false, reason: expect.stringContaining('gate') });
    for (const [change, reason] of [
      [(d) => { artifact(d).expired = true; }, 'expired'],
      [(d) => { d.artifacts[0].artifacts.push({ ...artifact(d), id: 322 }); }, 'ambiguous'],
      [(d) => { artifact(d).digest = null; }, 'id/digest'],
      [(d) => { artifact(d).created_at = 'invalid'; }, 'timestamp'],
      [(d) => { d.attempts.pop(); }, 'attempt'],
      [(d) => { d.run.head_sha = 'short'; }, 'head_sha'],
      [(d) => { d.artifacts = [{}]; }, 'paginated'],
    ]) {
      const data = fixture(); change(data);
      expect(selectSource(data)).toMatchObject({ eligible: false, failed: true, reason: expect.stringContaining(reason) });
    }
  });

  it('uses the latest artifact producing attempt and does not substitute another attempt gate', () => {
    const data = fixture(), next = structuredClone(job(data));
    next.id = 987; next.run_attempt = 2; next.conclusion = 'failure';
    next.started_at = '2026-10-21T12:00:00Z'; next.steps[1].completed_at = '2026-10-21T12:05:00Z';
    data.attempts[1].pages.push({ total_count: 2, jobs: [next, job(data)] });
    data.artifacts.push({ total_count: 2, artifacts: [{ ...artifact(data), id: 333, created_at: '2026-10-21T12:04:00Z' }] });
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: false, reason: expect.stringContaining('attempt 2') });
    next.conclusion = 'success';
    expect(selectSource(data)).toMatchObject({ eligible: true, source_attempt: '2', artifact_id: '333', fetched_at: '2026-10-21T12:04:00Z' });
  });

  it('R4 #1/#6: names the latest sealed successful attempt when no catalogue-input artifact exists', () => {
    const data = fixture(), next = structuredClone(job(data));
    data.artifacts[0].artifacts = [];
    next.id = 987; next.run_attempt = 2; next.started_at = '2026-10-21T12:00:00Z';
    data.attempts[1].pages[0].jobs.push(next);
    expect(selectSource(data)).toMatchObject({ failed: true, reason: expect.stringContaining('source refresh attempt 2 ran the catalogue pipeline') });
    next.steps = next.steps.filter((s) => s.name !== SEAL_STEP);
    expect(selectSource(data)).toMatchObject({ failed: true, reason: expect.stringContaining('source refresh attempt 1 ran the catalogue pipeline') });
    job(data).conclusion = 'failure';
    expect(selectSource(data)).toMatchObject({ failed: true, reason: expect.stringContaining('predates') });
    next.conclusion = 'failure';
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: false, reason: 'source refresh gate did not conclude success' });
  });

  it('R4 #2: is red when a catalogue-input artifact exists but no refresh job was found in any attempt', () => {
    const data = fixture();
    // Its own run_attempt is 1, so attempt 2's page cannot vouch for it.
    data.attempts[1].pages[0].jobs.push(data.attempts[0].pages[0].jobs.pop());
    expect(selectSource(data)).toEqual({ eligible: false, failed: true, reason: 'catalogue-input artifact present but no refresh job found in any attempt' });
    const renamed = fixture(); job(renamed).name = 'build';
    expect(selectSource(renamed)).toMatchObject({ failed: true, reason: expect.stringContaining('no refresh job found') });
    renamed.artifacts[0].artifacts = [];
    expect(selectSource(renamed)).toMatchObject({ eligible: false, failed: false, reason: 'source refresh gate did not conclude success' });
  });

  it('a: is red when no recognised refresh job could have produced the catalogue-input artifact', () => {
    const data = fixture(), next = structuredClone(job(data));
    // Attempt 1's job is carried into attempt 2's page, so the filter drops it;
    // the one recognised job failed and its complete window starts after the artifact.
    data.attempts[1].pages[0].jobs.push(data.attempts[0].pages[0].jobs.pop());
    next.id = 987; next.run_attempt = 2; next.conclusion = 'failure';
    next.started_at = '2026-10-21T12:00:00Z'; next.completed_at = '2026-10-21T12:10:00Z';
    next.steps[1].completed_at = '2026-10-21T12:05:00Z';
    data.attempts[1].pages[0].jobs.push(next);
    expect(selectSource(data)).toEqual({ eligible: false, failed: true,
      reason: 'catalogue-input artifact matches no recognised refresh job in any attempt' });
    // A windowless failed job whose run time misses the artifact cannot have made it either.
    next.steps[1].conclusion = 'cancelled';
    expect(selectSource(data)).toMatchObject({ failed: true, reason: expect.stringContaining('matches no recognised refresh job') });
    next.started_at = '2026-10-19T09:00:00Z'; next.completed_at = '2026-10-19T09:19:59Z';
    expect(selectSource(data)).toMatchObject({ failed: true, reason: expect.stringContaining('matches no recognised refresh job') });
  });

  it('a: stays neutral when a failed job without a complete seal window could have produced the artifact', () => {
    for (const change of [
      (j) => { j.steps[1].conclusion = 'cancelled'; },
      (j) => { j.steps = j.steps.filter((s) => s.name !== SEAL_STEP); },
      (j) => { j.steps[1].conclusion = 'cancelled'; delete j.completed_at; },
      (j) => { j.steps[1].conclusion = 'cancelled'; j.completed_at = '2026-10-19T09:20:00Z'; j.started_at = '2026-10-19T09:20:00Z'; },
      // Unreadable timestamps on a windowless job: a possible producer, not a new red.
      (j) => { j.steps[1].conclusion = 'cancelled'; j.started_at = 'invalid'; },
      (j) => { j.steps[1].conclusion = 'cancelled'; j.completed_at = 'invalid'; },
    ]) {
      const data = fixture(); job(data).conclusion = 'cancelled'; change(job(data));
      expect(selectSource(data)).toEqual({ eligible: false, failed: false, reason: 'source refresh gate did not conclude success' });
    }
  });

  it('113-13a: is red when a stray catalogue-input artifact sits beside the one that matches', () => {
    const data = fixture();
    // Created after every refresh window, and attempt 2 ran no refresh job.
    data.artifacts.push({ total_count: 1, artifacts: [{ ...artifact(data), id: 333, created_at: '2026-10-22T08:00:00Z' }] });
    expect(selectSource(data)).toEqual({ eligible: false, failed: true,
      reason: 'catalogue-input artifact matches no recognised refresh job in any attempt' });
    // Positive control: without the stray the same run is eligible.
    data.artifacts.pop();
    expect(selectSource(data)).toMatchObject({ eligible: true, artifact_id: '321' });
  });

  it('113-13a: stays eligible when the extra artifact may come from a cancelled, windowless earlier attempt', () => {
    const data = fixture(), next = structuredClone(job(data));
    job(data).conclusion = 'cancelled'; job(data).steps[1].conclusion = 'cancelled';
    next.id = 987; next.run_attempt = 2;
    next.started_at = '2026-10-21T12:00:00Z'; next.completed_at = '2026-10-21T12:10:00Z';
    next.steps[1].completed_at = '2026-10-21T12:05:00Z';
    data.attempts[1].pages[0].jobs.push(next);
    data.artifacts.push({ total_count: 1, artifacts: [{ ...artifact(data), id: 333, created_at: '2026-10-21T12:04:00Z' }] });
    expect(selectSource(data)).toMatchObject({ eligible: true, source_attempt: '2', artifact_id: '333' });
    // Outside the cancelled job's run time it could not have made it: red.
    job(data).completed_at = '2026-10-19T09:19:00Z';
    expect(selectSource(data)).toMatchObject({ failed: true, reason: expect.stringContaining('matches no recognised refresh job') });
  });

  it('113-13e: with no match, every artifact needs a possible producer, not just one', () => {
    const data = fixture();
    job(data).conclusion = 'cancelled'; job(data).steps[1].conclusion = 'cancelled';
    // The windowless job ran 09:17-09:30 and may have made the first; nothing could have made the second.
    data.artifacts.push({ total_count: 1, artifacts: [{ ...artifact(data), id: 333, created_at: '2026-10-22T08:00:00Z' }] });
    expect(selectSource(data)).toEqual({ eligible: false, failed: true,
      reason: 'catalogue-input artifact matches no recognised refresh job in any attempt' });
    data.artifacts.pop();
    expect(selectSource(data)).toEqual({ eligible: false, failed: false, reason: 'source refresh gate did not conclude success' });
  });

  it('ci-1: is red when a later attempt passed the gate but only an earlier failed attempt left an artifact', () => {
    const data = fixture(), next = structuredClone(job(data));
    job(data).conclusion = 'failure';
    next.id = 987; next.run_attempt = 2; next.conclusion = 'success';
    next.started_at = '2026-10-21T12:00:00Z'; next.steps[1].completed_at = '2026-10-21T12:05:00Z';
    data.attempts[1].pages[0].jobs.push(next);
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: true,
      reason: expect.stringContaining('source refresh attempt 2 ran the catalogue pipeline but uploaded no catalogue-input artifact') });
    next.conclusion = 'failure';
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: false, reason: expect.stringContaining('artifact attempt 1') });
  });

  it('ci-1: is red when a later passing attempt left no artifact beside an earlier passing one', () => {
    // A re-run whose Freeze/Upload step failed (continue-on-error) keeps attempt 1's
    // artifact; publishing it would silently drop the re-run's newer input.
    const data = fixture(), next = structuredClone(job(data));
    next.id = 987; next.run_attempt = 2; next.conclusion = 'success';
    next.started_at = '2026-10-21T12:00:00Z'; next.steps[1].completed_at = '2026-10-21T12:05:00Z';
    data.attempts[1].pages[0].jobs.push(next);
    expect(selectSource(data)).toMatchObject({ eligible: false, failed: true,
      reason: expect.stringContaining('source refresh attempt 2 ran the catalogue pipeline but uploaded no catalogue-input artifact') });
  });

  it('R4 #3: exports the cross-file names it matches', () => {
    expect([REFRESH_JOB, SEAL_STEP, INPUT_ARTIFACT]).toEqual(['refresh', 'Seal frozen artifact time window', 'catalogue-input']);
    const data = fixture();
    expect(job(data).name).toBe(REFRESH_JOB);
    expect(job(data).steps.map((s) => s.name)).toContain(SEAL_STEP);
    expect(artifact(data).name).toBe(INPUT_ARTIFACT);
  });

  it('R4 #7: writes CLI errors to stderr, never into the stdout the workflow captures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalogue-source-')); dirs.push(dir);
    const { run_attempt: _attempt, ...run } = fixture().run;
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run));
    const stdout = vi.fn(), stderr = vi.fn();
    expect(main(['attempts', '--run', join(dir, 'run.json')], { stdout, stderr })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('')).toContain('Invalid source run_attempt');
    expect(main(['approval', '--run', join(dir, 'missing.json')], { stdout, stderr })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('b: copies a CLI failure in select into the --summary file, scrubbed of the GitHub token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalogue-source-')); dirs.push(dir);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(fixture().run));
    const select = (jobs, summary) => ['select', '--run', join(dir, 'run.json'), '--jobs', jobs,
      '--artifacts', join(dir, 'artifacts.json'), '--out', join(dir, 'out'), '--summary', summary];
    // (i) A missing --jobs directory fails inside main, before selectSource returns.
    let stdout = vi.fn(), stderr = vi.fn();
    expect(main(select(join(dir, 'missing-jobs'), join(dir, 'summary')), { stdout, stderr, env: {} })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const line = stderr.mock.calls.flat().join('');
    expect(line).toMatch(/^Catalogue source check failed: .*missing-jobs.*\n$/);
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toBe(line);
    // (ii) A secret-shaped value in the failing path is redacted in both outputs.
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
      const secret = `ghs_${key}0123456789abcdef`;
      stdout = vi.fn(); stderr = vi.fn();
      expect(main(select(join(dir, secret), join(dir, `summary-${key}`)), { stdout, stderr, env: { [key]: secret } })).toBe(1);
      const text = stderr.mock.calls.flat().join('');
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain(secret);
      expect(readFileSync(join(dir, `summary-${key}`), 'utf8')).toBe(text);
    }
    // (iii) A summary path that cannot be appended to keeps exit 1 and the stderr line.
    mkdirSync(join(dir, 'summary-dir'));
    stdout = vi.fn(); stderr = vi.fn();
    expect(main(select(join(dir, 'missing-jobs'), join(dir, 'summary-dir')), { stdout, stderr, env: {} })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('')).toMatch(/^Catalogue source check failed: .*missing-jobs/);
    // A failure before parseArgs returns writes to stderr only.
    stderr = vi.fn();
    expect(main(['select', '--summary', join(dir, 'summary-parse'), '--unknown'], { stdout, stderr, env: {} })).toBe(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(join(dir, 'summary-parse'))).toThrow(/ENOENT/);
  });

  it('113-13b: attempts copies a bad run_attempt into --summary and exits 1; a good run writes only the attempt numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalogue-source-')); dirs.push(dir);
    const secret = 'ghs_attempts0123456789abcdef';
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...fixture().run, run_attempt: 0, note: secret }));
    writeFileSync(join(dir, 'good.json'), JSON.stringify(fixture().run));
    let stdout = vi.fn(), stderr = vi.fn();
    expect(main(['attempts', '--run', join(dir, `${secret}.json`), '--summary', join(dir, 'summary')],
      { stdout, stderr, env: { GH_TOKEN: secret } })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toBe(stderr.mock.calls.flat().join(''));
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('[REDACTED]');
    expect(readFileSync(join(dir, 'summary'), 'utf8')).not.toContain(secret);
    stdout = vi.fn(); stderr = vi.fn();
    expect(main(['attempts', '--run', join(dir, 'bad.json'), '--summary', join(dir, 'summary-bad')], { stdout, stderr, env: {} })).toBe(1);
    expect(readFileSync(join(dir, 'summary-bad'), 'utf8')).toBe('Catalogue source check failed: Invalid source run_attempt\n');
    expect(stdout).not.toHaveBeenCalled();
    stdout = vi.fn(); stderr = vi.fn();
    expect(main(['attempts', '--run', join(dir, 'good.json'), '--summary', join(dir, 'summary-good')], { stdout, stderr, env: {} })).toBe(0);
    expect(stdout.mock.calls).toEqual([['1\n2\n']]);
    expect(stderr).not.toHaveBeenCalled();
    expect(() => readFileSync(join(dir, 'summary-good'))).toThrow(/ENOENT/);
  });

  it('R4 #4: classifies a failed environment read: 404 is a missing environment, anything else is unconfirmed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalogue-source-')); dirs.push(dir);
    const missing = approvalErrorNotice('gh: Not Found (HTTP 404)\n');
    expect(missing).toMatch(/^\*\*WARNING: environment catalogue-publish does not exist/);
    expect(missing).toContain('no approval rule');
    for (const text of ['gh: Resource not accessible by integration (HTTP 403)\n', 'gh: Server Error (HTTP 500)\n', 'HTTP 4040', '']) {
      expect(approvalErrorNotice(text)).toBe('could not confirm the approval rule\n');
    }
    const stdout = vi.fn(), stderr = vi.fn();
    writeFileSync(join(dir, 'error.txt'), 'gh: Not Found (HTTP 404)\n');
    expect(main(['approval-error', '--error', join(dir, 'error.txt')], { stdout, stderr })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(missing);
    writeFileSync(join(dir, 'error.txt'), 'gh: Forbidden (HTTP 403)\n');
    expect(main(['approval-error', '--error', join(dir, 'error.txt')], { stdout, stderr })).toBe(0);
    expect(stdout).toHaveBeenLastCalledWith('could not confirm the approval rule\n');
    // 200 with no rules is approvalNotice's warning.
    expect(approvalNotice({ protection_rules: [] })).toMatch(/^\*\*WARNING:/);
  });

  it('runs builtin CLI with paginated fixture files and writes neutral/error summaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalogue-source-')); dirs.push(dir);
    mkdirSync(join(dir, 'jobs'));
    const data = fixture(), stdout = vi.fn(), write = () => {
      writeFileSync(join(dir, 'run.json'), JSON.stringify(data.run));
      writeFileSync(join(dir, 'artifacts.json'), JSON.stringify(data.artifacts));
      for (const a of data.attempts) writeFileSync(join(dir, 'jobs', `${a.attempt}.json`), JSON.stringify(a.pages));
    };
    write();
    expect(main(['attempts', '--run', join(dir, 'run.json')], { stdout })).toBe(0);
    expect(stdout).toHaveBeenCalledWith('1\n2\n');
    const args = ['select', '--run', join(dir, 'run.json'), '--jobs', join(dir, 'jobs'), '--artifacts', join(dir, 'artifacts.json'),
      '--out', join(dir, 'out'), '--summary', join(dir, 'summary')];
    expect(main(args, { stdout })).toBe(0);
    expect(readFileSync(join(dir, 'out'), 'utf8')).toContain('fetched_at=2026-10-19T09:20:00Z\n');
    data.run.head_branch = 'branch'; write(); expect(main(args, { stdout })).toBe(0);
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('ineligible: source run is not on main');
    data.run.head_branch = 'main'; artifact(data).expired = true; write(); expect(main(args, { stdout })).toBe(1);
    expect(readFileSync(join(dir, 'summary'), 'utf8')).toContain('failed: source catalogue-input artifact has expired');
  });

  it('warns about missing required reviewers and reports a configured rule', () => {
    expect(approvalNotice({ protection_rules: [] })).toMatch(/^\*\*WARNING:/);
    expect(approvalNotice({ protection_rules: [{ type: 'required_reviewers', reviewers: [] }] })).toMatch(/^\*\*WARNING:/);
    expect(approvalNotice({ protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'mtnmanak' } }] }] })).not.toContain('WARNING');
    const selfReview = approvalNotice({ protection_rules: [{ type: 'required_reviewers', prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { login: 'mtnmanak' } }] }] });
    expect(selfReview).toMatch(/^\*\*WARNING:/);
    expect(selfReview).toContain('self-review');
    expect(approvalNotice({ protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { login: 'mtnmanak' } }] }] })).not.toContain('WARNING');
  });
});
