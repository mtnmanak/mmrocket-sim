/**
 * .github/workflows/deploy.yml checks every pull request into main and deploys
 * only main (audit 2026-09-30). A Dependabot PR used to get no run at all, so
 * its gate was whatever someone ran by hand before merging — and in this repo
 * the merge IS the deploy. A pull-request run is only safe if three things
 * hold, and each is pinned here because each fails silently:
 *
 *   - the deploy job refuses it. On a pull_request run github.ref is
 *     refs/pull/<n>/merge, but on pull_request_target it is the BASE branch,
 *     main, and that event's runs hold the repository's secrets;
 *   - it never shares the deploy's concurrency group, where it would hold up
 *     the deploy queued behind it or replace one waiting (GitHub keeps one
 *     pending run per group and cancels the older);
 *   - and, as in every checkout here, the token is not left in .git/config
 *     while `npm ci` runs every dependency's install script.
 *
 * GitHub starts no workflow for a push or a PR made with a run's own
 * GITHUB_TOKEN, which is how motors-refresh.yml opens its weekly PR, so
 * deploy.yml's run does not start for that PR: its refresh job runs the deploy
 * gate itself, and the last test holds the two lists of commands together.
 *
 * Read as text, the way scripts/upstream-advisories.mjs reads the wrangler pin:
 * no YAML parser is installed, and these files keep one key per line.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { FREEZE_STEP, INPUT_ARTIFACT, REFRESH_JOB, SEAL_STEP, UPLOAD_STEP, SOURCE_REPO, SOURCE_WORKFLOW_FILE, SOURCE_WORKFLOW_NAME } from './catalogue-source.mjs';

const workflow = (name) => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, ''));
const DEPLOY = workflow('deploy.yml');
const REFRESH = workflow('motors-refresh.yml');
const CATALOGUE = workflow('catalogue-publish.yml');

const indentOf = (l) => l.length - l.trimStart().length;
const isContent = (l) => l.trim() !== '' && !l.trim().startsWith('#');

/** The lines nested under `key`, found at the shallowest indent of `lines`; null when absent. */
function child(lines, key) {
  const top = Math.min(...lines.filter(isContent).map(indentOf));
  const at = lines.findIndex((l) => isContent(l) && indentOf(l) === top && l.trim().startsWith(`${key}:`));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && (!isContent(lines[end]) || indentOf(lines[end]) > top)) end++;
  return lines.slice(at + 1, end);
}

/** The scalar on `key`'s own line, at the shallowest indent of `lines`; undefined when absent. */
function value(lines, key) {
  if (!lines) return undefined;
  const top = Math.min(...lines.filter(isContent).map(indentOf));
  const line = lines.find((l) => isContent(l) && indentOf(l) === top && l.trim().startsWith(`${key}:`));
  return line === undefined ? undefined : line.trim().slice(key.length + 1).trim();
}

const path = (lines, ...keys) => keys.reduce((ls, k) => (ls ? child(ls, k) : null), lines);

/** A job's steps, each as mapping lines (its `- ` turned into indentation). */
function steps(lines, job) {
  const body = path(lines, 'jobs', job, 'steps');
  const top = Math.min(...body.filter(isContent).map(indentOf));
  const out = [];
  for (const l of body) {
    if (isContent(l) && indentOf(l) === top && l.trim().startsWith('- ')) out.push([l.replace('- ', '  ')]);
    else if (out.length) out[out.length - 1].push(l);
  }
  return out;
}

/** The one-line `run:` commands of a job, in order. */
const runs = (lines, job) => steps(lines, job).map((s) => value(s, 'run')).filter((r) => r && r !== '|');

/**
 * A GitHub Actions expression over github.event_name and github.ref: string
 * literals, == != && || ! and parentheses — what these workflows use. Anything
 * else throws, so a test cannot pass by misreading an expression.
 */
function evaluate(expr, { event, ref }) {
  const tokens = expr.match(/'[^']*'|github\.event_name|github\.ref|==|!=|&&|\|\||!|\(|\)|\s+/g) ?? [];
  if (tokens.join('') !== expr) throw new Error(`expression this test cannot read: ${expr}`);
  const js = tokens.map((t) => ({
    'github.event_name': JSON.stringify(event), 'github.ref': JSON.stringify(ref), '==': '===', '!=': '!==',
  })[t] ?? t).join('');
  return Function(`"use strict"; return (${js});`)();
}

/** A workflow value with `${{ }}` in it, as Actions interpolates it. */
const interpolate = (text, ctx) => text.replace(/\$\{\{(.*?)\}\}/g, (_, e) => String(evaluate(e.trim(), ctx)));

const PUSH_MAIN = { event: 'push', ref: 'refs/heads/main' };
const RUN_MAIN = { event: 'workflow_dispatch', ref: 'refs/heads/main' };
const PR = (n) => ({ event: 'pull_request', ref: `refs/pull/${n}/merge` });

describe('deploy.yml — pull requests get the gate, only main deploys', () => {
  it('runs on a pull request into main, as on a push to it', () => {
    expect(value(path(DEPLOY, 'on', 'pull_request'), 'branches')).toBe('[main]');
    expect(value(path(DEPLOY, 'on', 'push'), 'branches')).toBe('[main]');
  });

  it('deploys a push to main or a Run workflow from main, and never a pull request', () => {
    const when = value(path(DEPLOY, 'jobs', 'deploy'), 'if');
    expect(evaluate(when, PUSH_MAIN)).toBe(true);
    expect(evaluate(when, RUN_MAIN)).toBe(true);
    expect(evaluate(when, PR(7))).toBe(false);
    // pull_request_target's github.ref is the base branch, and its runs hold
    // the secrets: refused by the event, not by the ref.
    expect(evaluate(when, { event: 'pull_request_target', ref: 'refs/heads/main' })).toBe(false);
    expect(evaluate(when, { event: 'workflow_dispatch', ref: 'refs/heads/feature' })).toBe(false);
    // The build job has no `if`: a pull request runs the whole gate.
    expect(value(path(DEPLOY, 'jobs', 'build'), 'if')).toBeUndefined();
  });

  it('keeps a pull request out of the deploy concurrency group', () => {
    const group = (ctx) => interpolate(value(path(DEPLOY, 'concurrency'), 'group'), ctx);
    const cancel = (ctx) => interpolate(value(path(DEPLOY, 'concurrency'), 'cancel-in-progress'), ctx);
    expect(group(PUSH_MAIN)).toBe('deploy-online-open-rocket');
    expect(group(RUN_MAIN)).toBe('deploy-online-open-rocket');
    expect(group(PR(7))).not.toBe('deploy-online-open-rocket');
    expect(group(PR(7))).not.toBe(group(PR(8)));
    // A deploy is never cancelled; a newer push to the same PR replaces its run.
    expect(cancel(PUSH_MAIN)).toBe('false');
    expect(cancel(PR(7))).toBe('true');
  });

  it('leaves no git credential in any checkout of either workflow', () => {
    const checkouts = [[DEPLOY, 'build'], [DEPLOY, 'deploy'], [REFRESH, 'refresh'], [REFRESH, 'publish'], [CATALOGUE, 'plan'], [CATALOGUE, 'catalogue']]
      .flatMap(([lines, job]) => steps(lines, job).filter((s) => value(s, 'uses')?.startsWith('actions/checkout@'))
        .map((s) => [job, value(child(s, 'with') ?? [''], 'persist-credentials')]));
    expect(checkouts).toEqual([['build', 'false'], ['deploy', 'false'], ['refresh', 'false'], ['publish', 'false'], ['plan', 'false'], ['catalogue', 'false']]);
  });

  it('runs every gate command of the deploy build on a motor refresh, in the same order', () => {
    // npm ci installs; everything after it that is `npm run …` or `npm test` is the gate.
    const gate = runs(DEPLOY, 'build').filter((r) => /^npm (run |test\b)/.test(r));
    expect(gate).toEqual(['npm run typecheck', 'npm run lint -- --max-warnings 0', 'npm test', 'npm run build']);
    const refresh = runs(REFRESH, 'refresh');
    expect(refresh.filter((r) => gate.includes(r))).toEqual(gate);
    // ...on the refreshed data: after the refresh step, not before it.
    const refreshSteps = steps(REFRESH, 'refresh');
    const fetching = refreshSteps.findIndex((s) => s.some((l) => l.includes('node packages/app/scripts/fetch-motor-db.mjs --full-out')));
    expect(fetching).toBeGreaterThanOrEqual(0);
    expect(refreshSteps.findIndex((s) => value(s, 'run') === gate[0])).toBeGreaterThan(fetching);
    const body = refreshSteps[fetching].join('\n');
    expect(body.indexOf('fetch-motor-curves.mjs')).toBeGreaterThan(body.indexOf('fetch-motor-db.mjs'));
    expect(body.indexOf('scripts/build-user-guide.mjs')).toBeGreaterThan(body.indexOf('fetch-motor-curves.mjs'));
    // The optional superset must be the ONLY divergence from the hand-run command.
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    const commands = child(refreshSteps[fetching], 'run').filter(isContent).map((l) => l.trim()
      .replace(/ --full-out "[^"]+"/, ''));
    expect(commands).toEqual(pkg.scripts['motors:refresh'].split('&&').map((s) => s.trim()));
  });
});

describe('both workflows — one pinned runner image', () => {
  // ubuntu-latest moves on GitHub's date, not on a commit here. The image moves
  // only by a commit that changes all jobs, including the catalogue publisher.
  it('runs all six jobs on the same explicit image, never a -latest label', () => {
    const images = [[DEPLOY, 'build'], [DEPLOY, 'deploy'], [REFRESH, 'refresh'], [REFRESH, 'publish'], [CATALOGUE, 'plan'], [CATALOGUE, 'catalogue']]
      .map(([lines, job]) => value(path(lines, 'jobs', job), 'runs-on'));
    expect(images).toHaveLength(6);
    for (const image of images) expect(image).toMatch(/^ubuntu-\d\d\.\d\d$/);
    expect(new Set(images).size).toBe(1);
  });
});

// Include both '- uses:' and named steps with a separate indented 'uses:'.
function assertPinnedActions(text, expectedCount) {
  const uses = text.split(/\r?\n/).filter((l) => /^\s*(?:- )?uses:/.test(l));
  expect(uses).toHaveLength(expectedCount);
  for (const use of uses) expect(use).toMatch(/uses: actions\/[a-z-]+@[a-f0-9]{40} # v\d/);
}

// Dynamic imports and CommonJS entry points must not bypass the pre-install
// dependency boundary. Ban computed imports and createRequire outright here.
function importsOf(source) {
  expect(source).not.toMatch(/\bcreateRequire\b/);
  const staticImports = [...source.matchAll(/\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const calls = [...source.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)].map((m) => {
    expect(m[1].trim()).toMatch(/^['"][^'"]+['"]$/);
    return m[1].trim().slice(1, -1);
  });
  const imports = [...staticImports, ...calls];
  for (const spec of imports) expect(spec.startsWith('node:') || spec.startsWith('.')).toBe(true);
  return imports;
}


const normalize = (lines) => lines.filter(isContent).map((l) => l.trim().replace(/(uses: actions\/[a-z-]+)@[a-f0-9]{40}/, '$1@<pin>'));
function stepStructure(step) {
  return { name: value(step, 'name') ?? null, run: value(step, 'run') === '|' ? normalize(child(step, 'run')) : value(step, 'run') ?? null,
    if: value(step, 'if') ?? null, envKeys: (child(step, 'env') ?? []).filter(isContent).map((l) => l.trim().split(':')[0]),
    configuration: normalize(step) };
}
function jobStructure(lines, job) {
  const body = path(lines, 'jobs', job);
  return { header: normalize(body.slice(0, body.findIndex((l) => l.trim() === 'steps:'))),
    permissions: normalize(path(lines, 'jobs', job, 'permissions')), steps: steps(lines, job).map(stepStructure) };
}

const ORIGINAL_REFRESH = JSON.parse(readFileSync(new URL('./fixtures/motors-refresh-original.json', import.meta.url), 'utf8'));

describe('catalogue workflow isolation and approval boundary', () => {
  it('R1: restores original workflow structure across Dependabot SHA and comment edits', () => {
    const assertRestored = (lines) => {
      expect(jobStructure(lines, 'publish')).toEqual(ORIGINAL_REFRESH.publish);
      const after = steps(lines, 'refresh').filter((step) => !['freeze', 'inputs'].includes(value(step, 'id'))
        && value(step, 'name') !== 'Seal frozen artifact time window');
      const fetch = after.find((step) => value(step, 'name') === 'Refresh the catalogue, the curve bundle and the user guide');
      after.splice(after.indexOf(fetch), 1, ['        name: Refresh the catalogue, the curve bundle and the user guide', '        run: npm run motors:refresh']);
      const install = after.find((step) => value(step, 'run') === 'npm ci');
      expect(install, 'the original npm ci command must remain').toBeDefined();
      after.splice(after.indexOf(install), 1);
      after.splice(after.findIndex((step) => value(step, 'name') === 'Refresh the catalogue, the curve bundle and the user guide'), 0, install);
      expect(after.map(stepStructure)).toEqual(ORIGINAL_REFRESH.refresh.steps);
      const header = jobStructure(lines, 'refresh'); delete header.steps;
      const original = { ...ORIGINAL_REFRESH.refresh }; delete original.steps;
      expect(header).toEqual(original);
    };
    assertRestored(REFRESH);
    assertRestored(REFRESH.map((l) => l.replace(/@[a-f0-9]{40}/g, '@' + 'f'.repeat(40))).concat('  # routine comment'));
    expect(() => assertRestored(REFRESH.map((l) => l.replace('run: npm ci', 'run: npm ci --ignore-scripts')))).toThrow();
    expect(path(REFRESH, 'concurrency').filter(isContent)).toEqual(['  group: motors-refresh', '  cancel-in-progress: false']);
    expect(path(CATALOGUE, 'concurrency')).toBeNull();
    expect(path(CATALOGUE, 'jobs', 'catalogue', 'concurrency').filter(isContent).map((l) => l.trim())).toEqual(['group: catalogue-publish', 'cancel-in-progress: false']);
    expect(path(REFRESH, 'jobs').filter((l) => indentOf(l) === 2 && isContent(l)).map((l) => l.trim())).toEqual(['refresh:', 'publish:']);
    expect(path(REFRESH, 'jobs', 'refresh', 'concurrency')).toBeNull();
    expect(path(REFRESH, 'jobs', 'refresh').join('\n')).not.toMatch(/curl|catalogue-publish\.mjs plan/);
  });

  it('R1: pins both triggers, repository/main/event guards and the refresh attempt gate', () => {
    expect(value(path(CATALOGUE, 'on', 'workflow_run'), 'workflows')).toBe('[Weekly motor catalogue refresh]');
    expect(value(path(CATALOGUE, 'on', 'workflow_run'), 'types')).toBe('[completed]');
    expect(value(path(CATALOGUE, 'on', 'workflow_dispatch', 'inputs', 'run_id'), 'required')).toBe('true');
    expect(value(path(CATALOGUE, 'on', 'workflow_dispatch', 'inputs', 'run_id'), 'type')).toBe('string');
    const condition = child(path(CATALOGUE, 'jobs', 'plan'), 'if').filter(isContent).map((l) => l.trim()).join(' ');
    expect(condition).toBe("!cancelled() && github.repository == 'mtnmanak/mmrocket-sim' && github.ref == 'refs/heads/main'");
    const input = steps(CATALOGUE, 'plan').find((s) => value(s, 'id') === 'input').join('\n');
    for (const line of ['gh api "$api/runs/$RUN_ID"', 'gh api --paginate --slurp "$api/runs/$RUN_ID/attempts/$attempt/jobs?per_page=100"',
      'node packages/app/scripts/catalogue-source.mjs attempts --run "$RUNNER_TEMP/source-run.json" --summary "$GITHUB_STEP_SUMMARY" > "$RUNNER_TEMP/attempts.txt"',
      'catalogue-source.mjs select', '--run "$RUNNER_TEMP/source-run.json" --jobs "$jobs" --artifacts "$RUNNER_TEMP/artifacts.json"',
      '--out "$RUNNER_TEMP/source-output" --summary "$GITHUB_STEP_SUMMARY"']) expect(input).toContain(line);
    expect(path(CATALOGUE, 'jobs', 'plan', 'permissions').filter(isContent).map((l) => l.trim())).toEqual(['contents: read', 'actions: read']);
    expect(path(CATALOGUE, 'jobs', 'plan').join('\n')).not.toMatch(/\bsecrets\b|^\s*(?:run: )?npm ci|cache: npm|environment:/im);
    expect(CATALOGUE.join('\n')).not.toContain('always()');
  });

  it('R1/R4: pins immutable artifact ID/digest, pre-install provenance and fail-loud missing/expired input', () => {
    const refresh = steps(REFRESH, 'refresh'), freeze = refresh.find((s) => value(s, 'id') === 'freeze');
    const upload = refresh.find((s) => value(s, 'id') === 'inputs');
    const install = refresh.findIndex((s) => value(s, 'run') === 'npm ci');
    expect(refresh.indexOf(freeze)).toBeLessThan(refresh.indexOf(upload)); expect(refresh.indexOf(upload)).toBeLessThan(install);
    expect(value(freeze, 'continue-on-error')).toBe('true'); expect(value(upload, 'continue-on-error')).toBe('true');
    expect(value(upload, 'if')).toBe("steps.freeze.outcome == 'success'");
    expect(child(freeze, 'run').filter(isContent).map((l) => l.trim())).toEqual([
      'node packages/app/scripts/catalogue-publish.mjs freeze \\', '--motors "$RUNNER_TEMP/catalogue-input/motors-full.json" \\',
      '--curves "$DATA/motorCurves.json" --out "$RUNNER_TEMP/catalogue-input"']);
    expect(value(child(upload, 'with'), 'retention-days')).toBe('35');
    expect(runs(REFRESH, 'refresh')).toContain('sleep 2');
    const input = steps(CATALOGUE, 'plan').find((s) => value(s, 'id') === 'input').join('\n');
    for (const line of ['gh api "$api/artifacts/$artifact_id/zip"', 'sha256sum --check --status', 'Catalogue artifact ZIP digest mismatch']) expect(input).toContain(line);
    const planning = steps(CATALOGUE, 'plan').find((s) => value(s, 'id') === 'catalogue');
    expect(value(planning, 'if')).toBe("steps.input.outputs.eligible == 'true'");
    const block = child(planning, 'run').filter(isContent).map((l) => l.trim());
    expect(block.slice(block.indexOf('case "$status" in'), block.indexOf('esac') + 1)).toEqual([
      'case "$status" in', '200) previous_args=(--previous "$previous") ;;', '404) ;;',
      // An ERR trap does not fire on an explicit exit: this line writes the summary itself.
      '*) echo "Catalogue manifest GET failed: HTTP $status" | tee -a "$GITHUB_STEP_SUMMARY" >&2; exit 1 ;;', 'esac']);
    for (const text of ['--source-run-id "$SOURCE_RUN_ID" --fetched-at "$FETCHED_AT"',
      '--inputs "$RUNNER_TEMP/catalogue-input/inputs.json"', '>> "$GITHUB_STEP_SUMMARY"', '--commit "$SOURCE_COMMIT" --source-attempt "$SOURCE_ATTEMPT"']) {
      expect(CATALOGUE.join('\n')).toContain(text);
    }
  });

  it('R4 #3: ties catalogue-source.mjs names to the refresh workflow it reads through the API', () => {
    const assertTied = (refresh, catalogue) => {
      // No `name:` key: the API reports the job key as the job name.
      const job = path(refresh, 'jobs', REFRESH_JOB);
      expect(job, `job ${REFRESH_JOB}`).not.toBeNull();
      expect([undefined, REFRESH_JOB]).toContain(value(job, 'name'));
      const list = steps(refresh, REFRESH_JOB);
      const seal = list.filter((s) => value(s, 'name') === SEAL_STEP);
      expect(seal).toHaveLength(1);
      const uploads = list.filter((s) => value(s, 'uses')?.startsWith('actions/upload-artifact@') && value(child(s, 'with') ?? [''], 'name') === INPUT_ARTIFACT);
      expect(uploads).toHaveLength(1);
      // The red "no upload" reason names these two steps to the reader.
      expect(value(uploads[0], 'name')).toBe(UPLOAD_STEP);
      expect(list.filter((s) => value(s, 'name') === FREEZE_STEP)).toHaveLength(1);
      // The window: the upload lands before the seal, and both before npm ci.
      expect(list.indexOf(uploads[0])).toBeLessThan(list.indexOf(seal[0]));
      expect(list.indexOf(seal[0])).toBeLessThan(list.findIndex((s) => value(s, 'run') === 'npm ci'));
      expect(value(refresh, 'name')).toBe(SOURCE_WORKFLOW_NAME);
      expect(value(path(catalogue, 'on', 'workflow_run'), 'workflows')).toBe(`[${SOURCE_WORKFLOW_NAME}]`);
      expect(value(job, 'if')).toBe(`github.repository == '${SOURCE_REPO}'`);
      expect(child(path(catalogue, 'jobs', 'plan'), 'if').join(' ')).toContain(`github.repository == '${SOURCE_REPO}'`);
    };
    expect(existsSync(new URL(`../../../.github/workflows/${SOURCE_WORKFLOW_FILE}`, import.meta.url))).toBe(true);
    assertTied(REFRESH, CATALOGUE);
    for (const [from, to] of [[`name: ${SEAL_STEP}`, 'name: Seal the window'], [`name: ${INPUT_ARTIFACT}`, 'name: catalogue-inputs'],
      [`name: ${FREEZE_STEP}`, 'name: Freeze inputs'], [`name: ${UPLOAD_STEP}`, 'name: Upload inputs'],
      ['  refresh:', '  fetch:'], [`name: ${SOURCE_WORKFLOW_NAME}`, 'name: Weekly refresh']]) {
      expect(REFRESH.some((l) => l.includes(from)), from).toBe(true);
      expect(() => assertTied(REFRESH.map((l) => l.replace(from, to)), CATALOGUE), from).toThrow();
    }
    const named = [...REFRESH]; named.splice(REFRESH.indexOf('  refresh:') + 1, 0, '    name: Refresh');
    expect(() => assertTied(named, CATALOGUE)).toThrow();
    expect(() => assertTied(REFRESH, CATALOGUE.map((l) => l.replace(SOURCE_WORKFLOW_NAME, 'Weekly refresh')))).toThrow();
  });

  it('ci-1: replaces a same-name catalogue-input artifact on a re-run', () => {
    const upload = steps(REFRESH, 'refresh').find((s) => value(s, 'id') === 'inputs');
    expect(value(child(upload, 'with'), 'name')).toBe(INPUT_ARTIFACT);
    expect(value(child(upload, 'with'), 'overwrite')).toBe('true');
  });

  it('R4 #4/#5: classifies a 404 environment and records manifest/plan failures in the step summary', () => {
    const approval = child(steps(CATALOGUE, 'plan').find((s) => value(s, 'name') === 'Check approval protection (informational)'), 'run')
      .filter(isContent).map((l) => l.trim());
    expect(approval).toEqual([
      'if gh api "repos/$GITHUB_REPOSITORY/environments/catalogue-publish" > "$RUNNER_TEMP/approval.json" 2> "$RUNNER_TEMP/approval-error.txt"; then',
      'node packages/app/scripts/catalogue-source.mjs approval --run "$RUNNER_TEMP/approval.json" >> "$GITHUB_STEP_SUMMARY" ||',
      'echo \'could not confirm the approval rule\' >> "$GITHUB_STEP_SUMMARY"',
      'else',
      'cat "$RUNNER_TEMP/approval-error.txt" >&2 || true',
      'node packages/app/scripts/catalogue-source.mjs approval-error --error "$RUNNER_TEMP/approval-error.txt" >> "$GITHUB_STEP_SUMMARY" ||',
      'echo \'could not confirm the approval rule\' >> "$GITHUB_STEP_SUMMARY"',
      'fi']);
    const block = child(steps(CATALOGUE, 'plan').find((s) => value(s, 'id') === 'catalogue'), 'run').filter(isContent).map((l) => l.trim());
    expect(block[0]).toBe('trap \'echo "Catalogue manifest/plan step failed; see the step diagnostic" >> "$GITHUB_STEP_SUMMARY"\' ERR');
  });

  it('T1/T8: forbids reserved step env overrides and checks approval protection without failing on denied reads', () => {
    for (const [lines, jobs] of [[REFRESH, ['refresh', 'publish']], [CATALOGUE, ['plan', 'catalogue']]]) {
      for (const job of jobs) for (const step of steps(lines, job)) {
        const keys = (child(step, 'env') ?? []).filter(isContent).map((l) => l.trim().split(':')[0]);
        expect(keys.filter((key) => /^(GITHUB_|RUNNER_)/.test(key))).toEqual([]);
      }
    }
    const approval = steps(CATALOGUE, 'plan').find((s) => value(s, 'name') === 'Check approval protection (informational)').join('\n');
    expect(approval).toContain('if gh api "repos/$GITHUB_REPOSITORY/environments/catalogue-publish"');
    expect(approval).toContain('could not confirm the approval rule');
    expect(approval).toContain('catalogue-source.mjs approval');
  });

  it('R8: catches static/dynamic/require dependencies and createRequire before npm ci', () => {
    const seen = new Set();
    function builtinOnly(url) {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      for (const spec of importsOf(readFileSync(url, 'utf8'))) if (spec.startsWith('.')) builtinOnly(new URL(spec, url));
    }
    for (const file of ['fetch-motor-db.mjs', 'fetch-motor-curves.mjs', 'catalogue-publish.mjs', 'catalogue-source.mjs', '../../../scripts/build-user-guide.mjs']) builtinOnly(new URL(file, import.meta.url));
    expect(seen.size).toBeGreaterThanOrEqual(6);
    for (const bad of ["await import('marked')", "import ( 'marked' )", "require('marked')", 'createRequire(import.meta.url)', 'import(variable)']) {
      expect(() => importsOf(bad)).toThrow();
    }
    expect(importsOf("await import('node:fs'); require('./local.mjs')")).toEqual(['node:fs', './local.mjs']);
  });

  it('R8: confines ALL secret references and the environment to upload; pins commands and every action', () => {
    expect(value(path(CATALOGUE, 'jobs', 'catalogue'), 'needs')).toBe('plan');
    expect(value(path(CATALOGUE, 'jobs', 'catalogue'), 'if')).toBe("${{ !cancelled() && github.repository == 'mtnmanak/mmrocket-sim' && github.ref == 'refs/heads/main' && needs.plan.outputs.changed == 'true' }}");
    expect(value(path(CATALOGUE, 'jobs', 'catalogue'), 'environment')).toBe('catalogue-publish');
    expect(value(path(CATALOGUE, 'jobs', 'plan', 'outputs'), 'changed')).toBe('${{ steps.catalogue.outputs.changed }}');
    const list = steps(CATALOGUE, 'catalogue'), upload = list.find((s) => value(s, 'name') === 'Upload snapshots, then manifest');
    const expected = ['AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}', 'AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}',
      'CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}'];
    const secretLines = (lines) => lines.filter((l) => isContent(l) && /\bsecrets\b/i.test(l)).map((l) => l.trim());
    expect(secretLines(CATALOGUE)).toEqual(expected); expect(secretLines(upload)).toEqual(expected);
    expect(CATALOGUE.filter((l) => /^\s*environment:/.test(l)).map((l) => l.trim())).toEqual(['environment: catalogue-publish']);
    expect(path(CATALOGUE, 'jobs', 'catalogue', 'env')).toBeNull();
    expect(path(CATALOGUE, 'jobs', 'catalogue', 'permissions').filter(isContent).map((l) => l.trim())).toEqual(['contents: read']);
    for (const step of list) expect(value(step, 'continue-on-error')).toBeUndefined();
    expect(value(upload, 'run')).toBe('node packages/app/scripts/catalogue-publish.mjs upload --plan "$RUNNER_TEMP/catalogue-plan"');
    const verify = list.find((s) => value(s, 'name') === 'Verify the public catalogue');
    expect(value(verify, 'run')).toBe('node packages/app/scripts/catalogue-publish.mjs verify --base https://catalogue.mountainmanrockets.com --plan "$RUNNER_TEMP/catalogue-plan"');
    expect(list.indexOf(verify)).toBe(list.indexOf(upload) + 1); expect(value(verify, 'env')).toBeUndefined();
    for (const [name, lines, jobs] of [['motors-refresh.yml', REFRESH, ['refresh', 'publish']], ['catalogue-publish.yml', CATALOGUE, ['plan', 'catalogue']]]) {
      const original = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8');
      assertPinnedActions(original, jobs.flatMap((job) => steps(lines, job)).filter((s) => value(s, 'uses')).length);
    }
    expect(() => assertPinnedActions('  - name: Bad\n    uses: actions/checkout@main', 1)).toThrow();
  });
});
