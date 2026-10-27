/**
 * Builtin-only GitHub REST eligibility check. Non-main/wrong-event/workflow,
 * unfinished runs and failed refresh gates are green-neutral. Missing, expired,
 * ambiguous or malformed input for an otherwise eligible source is red.
 * Fetch every attempt's paginated jobs: an artifact belongs to the attempt whose
 * pre-install window contains its service-created timestamp, never the latest
 * run_started_at. This detects naive post-install tampering; approval review is
 * still the guard against a dependency that compromises the runner itself.
 */
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Names this file shares with the workflows; deploy-workflow.test.mjs ties each
// one to motors-refresh.yml / catalogue-publish.yml.
export const SOURCE_REPO = 'mtnmanak/mmrocket-sim';
export const SOURCE_WORKFLOW_NAME = 'Weekly motor catalogue refresh';
export const SOURCE_WORKFLOW_FILE = 'motors-refresh.yml';
export const REFRESH_JOB = 'refresh';
export const SEAL_STEP = 'Seal frozen artifact time window';
export const INPUT_ARTIFACT = 'catalogue-input';
export const FREEZE_STEP = 'Freeze the catalogue input bytes and sha256';
export const UPLOAD_STEP = 'Upload frozen catalogue inputs';
const pages = (value, key) => {
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((page) => Array.isArray(page?.[key]))) throw new Error(`Invalid paginated ${key} response`);
  return list.flatMap((page) => page[key]);
};
const epoch = (value) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new Error(`Invalid API timestamp: ${value}`);
  return parsed;
};
const countAttempts = (run) => {
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Invalid source run_attempt');
  return run.run_attempt;
};
const noUpload = (job) => new Error(`source refresh attempt ${job.run_attempt} ran the catalogue pipeline but uploaded no `
  + `${INPUT_ARTIFACT} artifact; see its "${FREEZE_STEP}" and "${UPLOAD_STEP}" steps`);
const latest = (jobs) => jobs.reduce((a, b) => (b.run_attempt > a.run_attempt ? b : a));

export function selectSource({ run, attempts, artifacts }) {
  const neutral = (reason) => ({ eligible: false, failed: false, reason });
  try {
    const workflowPath = String(run.path ?? '').split('@')[0];
    if (!workflowPath.endsWith(`/${SOURCE_WORKFLOW_FILE}`) && run.name !== SOURCE_WORKFLOW_NAME) {
      return neutral('source run is not the motor refresh workflow');
    }
    if (run.repository?.full_name !== SOURCE_REPO || run.head_repository?.full_name !== SOURCE_REPO) return neutral('source run is from another repository');
    if (run.head_branch !== 'main') return neutral('source run is not on main');
    if (!['schedule', 'workflow_dispatch'].includes(run.event)) return neutral('source run event is not schedule or workflow_dispatch');
    if (run.status !== 'completed') return neutral('source run has not completed');
    if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? '')) throw new Error('Invalid source head_sha');
    if (!Number.isSafeInteger(run.id) || run.id < 1) throw new Error('Invalid source run id');
    const count = countAttempts(run);
    if (attempts.length !== count || new Set(attempts.map((a) => a.attempt)).size !== count
      || attempts.some((a) => !Number.isInteger(a.attempt) || a.attempt < 1 || a.attempt > count)) {
      throw new Error('Missing or duplicate source attempt jobs response');
    }
    const jobs = attempts.flatMap(({ attempt, pages: response }) => pages(response, 'jobs')
      // Re-run-failed-jobs may carry an earlier job forward. Only its own attempt
      // may vouch for it; that attempt was fetched explicitly as well.
      .filter((job) => job.name === REFRESH_JOB && job.run_attempt === attempt));
    const frozen = pages(artifacts, 'artifacts').filter((a) => a.name === INPUT_ARTIFACT);
    if (!frozen.length) {
      const passed = jobs.filter((job) => job.conclusion === 'success');
      if (!passed.length) return neutral('source refresh gate did not conclude success');
      // A sealed attempt ran the pipeline: its own Freeze/Upload step failed.
      const sealed = passed.filter((job) => job.steps?.some((s) => s.name === SEAL_STEP));
      if (sealed.length) throw noUpload(latest(sealed));
      throw new Error(`source run has no ${INPUT_ARTIFACT} artifact — it predates the catalogue pipeline; run a new refresh`);
    }
    // Only a refresh job that reached its upload step can have made one.
    if (!jobs.length) throw new Error(`${INPUT_ARTIFACT} artifact present but no refresh job found in any attempt`);
    const windows = jobs.map((job) => {
      const seals = job.steps?.filter((s) => s.name === SEAL_STEP) ?? [];
      if (seals.length !== 1 || seals[0].conclusion !== 'success') return { job };
      return { job, start: epoch(job.started_at), end: epoch(seals[0].completed_at) };
    });
    const matches = frozen.map((artifact) => {
      const created = epoch(artifact.created_at);
      const owners = windows.filter((w) => created >= w.start && created < w.end);
      if (owners.length > 1) throw new Error('ambiguous catalogue-input artifact producing attempt');
      return { artifact, created, owner: owners[0] };
    }).filter((m) => m.owner).sort((a, b) => b.created - a.created);
    if (!matches.length) {
      if (!jobs.some((job) => job.conclusion === 'success')) return neutral('source refresh gate did not conclude success');
      throw new Error('catalogue-input artifact is outside every pre-install attempt window');
    }
    const { artifact, owner } = matches[0];
    if (matches.filter((m) => m.owner.job.run_attempt === owner.job.run_attempt).length !== 1) {
      throw new Error('ambiguous catalogue-input artifacts in producing attempt');
    }
    if (owner.job.conclusion !== 'success') {
      // A later attempt that passed the gate must have uploaded its own input.
      const later = jobs.filter((job) => job.run_attempt > owner.job.run_attempt && job.conclusion === 'success');
      if (later.length) throw noUpload(latest(later));
      return neutral(`source refresh gate for artifact attempt ${owner.job.run_attempt} did not conclude success`);
    }
    if (artifact.expired !== false) throw new Error('source catalogue-input artifact has expired; run a new refresh');
    if (!Number.isSafeInteger(artifact.id) || artifact.id < 1 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')) {
      throw new Error('Invalid catalogue-input artifact id/digest');
    }
    return { eligible: true, failed: false, reason: `eligible: refresh run ${run.id}, artifact attempt ${owner.job.run_attempt}`,
      artifact_id: String(artifact.id), digest: artifact.digest.slice(7), source_run_id: String(run.id),
      source_attempt: String(owner.job.run_attempt), fetched_at: artifact.created_at, commit: run.head_sha };
  } catch (error) { return { eligible: false, failed: true, reason: error.message }; }
}

export function approvalNotice(environment) {
  const rules = environment.protection_rules?.filter((rule) => rule.type === 'required_reviewers' && rule.reviewers?.length) ?? [];
  if (!rules.length) return '**WARNING: catalogue-publish has no required_reviewers approval protection.**\n';
  // The sole reviewer also triggers the run, so prevented self-review waits until the job times out.
  if (rules.some((rule) => rule.prevent_self_review === true)) {
    return '**WARNING: catalogue-publish prevents self-review; the reviewer who triggered the run cannot approve it.**\n';
  }
  return 'Approval rule: required reviewers configured.\n';
}

/** A failed `gh api` environment read, from its stderr: only a 404 says the environment is missing. */
export function approvalErrorNotice(stderrText) {
  return /\bHTTP 404\b/.test(stderrText)
    ? '**WARNING: environment catalogue-publish does not exist; GitHub will create it with no approval rule.**\n'
    : 'could not confirm the approval rule\n';
}

export function main(argv = process.argv.slice(2), { stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  try {
    const [command, ...args] = argv;
    const { values } = parseArgs({ args, options: Object.fromEntries(['run', 'jobs', 'artifacts', 'out', 'summary', 'error'].map((key) => [key, { type: 'string' }])) });
    if (command === 'approval-error') { stdout(approvalErrorNotice(readFileSync(values.error, 'utf8'))); return 0; }
    const run = JSON.parse(readFileSync(values.run, 'utf8'));
    if (command === 'approval') { stdout(approvalNotice(run)); return 0; }
    if (command === 'attempts') {
      stdout(`${Array.from({ length: countAttempts(run) }, (_, i) => i + 1).join('\n')}\n`);
      return 0;
    }
    if (command !== 'select') throw new Error('Expected approval, approval-error, attempts or select');
    const attempts = readdirSync(values.jobs).map((file) => ({ attempt: Number(file.replace(/\.json$/, '')),
      pages: JSON.parse(readFileSync(join(values.jobs, file), 'utf8')) }));
    const result = selectSource({ run, attempts, artifacts: JSON.parse(readFileSync(values.artifacts, 'utf8')) });
    stdout(`${result.reason}\n`);
    if (!result.eligible && values.summary) appendFileSync(values.summary, `Catalogue publication ${result.failed ? 'failed' : 'ineligible'}: ${result.reason}\n`);
    if (values.out) appendFileSync(values.out, `${Object.entries(result).filter(([key]) => !['failed', 'reason'].includes(key))
      .map(([key, val]) => `${key}=${val}`).join('\n')}\n`);
    return result.failed ? 1 : 0;
  } catch (error) {
    // stdout is captured into files and the summary; the reason belongs in the log.
    stderr(`Catalogue source check failed: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
