import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { workspaceLinkProblems } from '../../../scripts/check-workspace-links.mjs';
import { gitInfoExclude } from '../../../scripts/git-info-exclude.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'workspace-links-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('checks workspace links before every root command that consumes workspace packages', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  for (const name of ['dev', 'build', 'typecheck', 'lint', 'test']) {
    expect(scripts[name]).toMatch(/^node scripts\/check-workspace-links\.mjs && /);
  }
});

it.for(['app', 'api'])('diagnoses copied engine folders before direct %s Vitest loading', (workspace, { task }) => {
  const childTimeout = 15_000;
  expect(task.timeout).toBeGreaterThan(childTimeout);
  const prelude = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const stat = fs.lstatSync; fs.lstatSync = function(path, ...args) {
      if (String(path).replaceAll('\\\\', '/').endsWith('/node_modules/@online-openrocket/engine')) return { isSymbolicLink: () => false };
      return stat.call(this, path, ...args);
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(prelude),
    fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)), 'list', 'workspace-preflight-probe-no-tests', '--configLoader', 'runner'], {
    cwd: fileURLToPath(new URL(`../../${workspace}/`, import.meta.url)), encoding: 'utf8', timeout: childTimeout,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/Workspace installation is broken:[\s\S]*engine: not a link/);
}, 25_000);

it.each(['app', 'api'])('guards direct %s typecheck and npm test scripts too', workspace => {
  const { scripts } = JSON.parse(readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), 'utf8'));
  for (const name of ['typecheck', 'test', workspace === 'app' ? 'build' : 'dev']) {
    expect(scripts[name]).toMatch(/^node ..\/..\/scripts\/check-workspace-links\.mjs && /);
  }
});

function checkout() {
  const root = temp();
  const names = ['app', 'engine', 'api'];
  mkdirSync(join(root, 'node_modules/@online-openrocket'), { recursive: true });
  for (const name of names) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@online-openrocket/${name}` }));
  }
  const link = name => join(root, 'node_modules/@online-openrocket', name);
  return { root, link };
}

it('finds absent and copied workspace links', () => {
  const { root, link } = checkout();
  expect(workspaceLinkProblems(root)).toHaveLength(3);
  mkdirSync(link('app'));
  expect(workspaceLinkProblems(root).join('\n')).toMatch(/app.*not a link/);
});

it('skips packages directories without a package.json', () => {
  const { root } = checkout();
  const before = workspaceLinkProblems(root);
  mkdirSync(join(root, 'packages', 'half-deleted'));
  expect(workspaceLinkProblems(root)).toEqual(before);
});

it('finds misdirected workspace links and accepts correct junctions', ctx => {
  const { root, link } = checkout();
  mkdirSync(link('app'));
  try { symlinkSync(join(root, 'packages/app'), link('engine'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') { ctx.skip('Sandbox forbids creating junctions'); return; } throw error; }
  symlinkSync(join(root, 'packages/api'), link('api'), 'junction');
  expect(workspaceLinkProblems(root).join('\n')).toMatch(/app.*not a link/);
  expect(workspaceLinkProblems(root).join('\n')).toMatch(/engine.*wrong target/);
  rmSync(link('app'), { recursive: true });
  rmSync(link('engine'));
  for (const name of ['app', 'engine']) symlinkSync(join(root, 'packages', name), link(name), 'junction');
  expect(workspaceLinkProblems(root)).toEqual([]);
});

it('resolves relative gitdir and commondir paths for linked worktree excludes', () => {
  const root = temp();
  mkdirSync(join(root, 'common/worktrees/lane'), { recursive: true });
  mkdirSync(join(root, 'common/info'), { recursive: true });
  writeFileSync(join(root, '.git'), 'gitdir: common/worktrees/lane\n');
  writeFileSync(join(root, 'common/worktrees/lane/commondir'), '../..\n');
  const exclude = join(root, 'common/info/exclude');
  writeFileSync(exclude, '/.lane/\n');
  expect(gitInfoExclude(root)).toBe(exclude);
  rmSync(join(root, '.git'));
  expect(gitInfoExclude(root)).toBeNull();
});
