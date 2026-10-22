import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalNotice, main, selectSource } from './catalogue-source.mjs';
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
    const missing = fixture(); missing.artifacts[0].artifacts = [];
    expect(selectSource(missing)).toMatchObject({ failed: true, reason: 'source run has no catalogue-input artifact — it predates the catalogue pipeline; run a new refresh' });
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
  });
});
