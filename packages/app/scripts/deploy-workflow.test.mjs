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
import { readFileSync } from 'node:fs';

const workflow = (name) => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')
  .split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, ''));
const DEPLOY = workflow('deploy.yml');
const REFRESH = workflow('motors-refresh.yml');

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
    const checkouts = [[DEPLOY, 'build'], [DEPLOY, 'deploy'], [REFRESH, 'refresh'], [REFRESH, 'publish']]
      .flatMap(([lines, job]) => steps(lines, job).filter((s) => value(s, 'uses')?.startsWith('actions/checkout@'))
        .map((s) => [job, value(child(s, 'with') ?? [''], 'persist-credentials')]));
    expect(checkouts).toEqual([['build', 'false'], ['deploy', 'false'], ['refresh', 'false'], ['publish', 'false']]);
  });

  it('runs every gate command of the deploy build on a motor refresh, in the same order', () => {
    // npm ci installs; everything after it that is `npm run …` or `npm test` is the gate.
    const gate = runs(DEPLOY, 'build').filter((r) => /^npm (run |test\b)/.test(r));
    expect(gate).toEqual(['npm run typecheck', 'npm run lint -- --max-warnings 0', 'npm test', 'npm run build']);
    const refresh = runs(REFRESH, 'refresh');
    expect(refresh.filter((r) => gate.includes(r))).toEqual(gate);
    // ...on the refreshed data: after the refresh step, not before it.
    expect(refresh.indexOf(gate[0])).toBeGreaterThan(refresh.indexOf('npm run motors:refresh'));
  });
});
