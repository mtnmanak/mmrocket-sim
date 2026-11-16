import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { referenceDir, referenceFile, referenceRoots } from '../../../scripts/reference-docs.mjs';
import { checkMachineProfile } from '../../../scripts/machine-profile.mjs';

let dir, options, profilePath, envRoot, profileRoot, docsRoot;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reference-docs-'));
  profilePath = join(dir, 'machine.json');
  envRoot = join(dir, 'env');
  profileRoot = join(dir, 'profile');
  docsRoot = join(dir, 'repo', 'docs');
  for (const root of [envRoot, profileRoot, docsRoot]) mkdirSync(join(root, 'User files'), { recursive: true });
  writeProfile({ repos: { online_open_rocket: { referenceDocs: profileRoot } } });
  options = { env: { MACHINE_PROFILE: profilePath, MMRSIM_REFERENCE_ROOT: envRoot }, repoRoot: join(dir, 'repo') };
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function writeProfile(data) {
  writeFileSync(profilePath, JSON.stringify({ hostname: hostname().toUpperCase(), ...data }));
}

it('prefers env over profile over checkout docs, then returns null', () => {
  expect(referenceRoots(options)).toEqual([envRoot, profileRoot, docsRoot,
    join(dir, '..', 'online_open_rocket', 'docs')]);
  expect(referenceDir('User files', options)).toBe(join(envRoot, 'User files'));
  rmSync(join(envRoot, 'User files'), { recursive: true });
  expect(referenceDir('User files', options)).toBe(join(profileRoot, 'User files'));
  rmSync(join(profileRoot, 'User files'), { recursive: true });
  expect(referenceDir('User files', options)).toBe(join(docsRoot, 'User files'));
  rmSync(join(docsRoot, 'User files'), { recursive: true });
  expect(referenceDir('User files', options)).toBeNull();
});

it('keeps the main-checkout fallback from a linked worktree', () => {
  const repoRoot = join(dir, 'oor-wt', 'lane');
  const main = join(dir, 'online_open_rocket', 'docs', 'User files');
  mkdirSync(main, { recursive: true });
  expect(referenceDir('User files', { env: { MACHINE_PROFILE: join(dir, 'absent.json') }, repoRoot })).toBe(main);
});

it('falls back to the module checkout when cwd has no repository marker', () => {
  const module = new URL('../../../scripts/reference-docs.mjs', import.meta.url);
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const driver = `import { referenceRoots } from ${JSON.stringify(module.href)};
    console.log(JSON.stringify(referenceRoots({ env: { MACHINE_PROFILE: ${JSON.stringify(join(dir, 'absent.json'))} } })));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { cwd: dir, encoding: 'utf8' });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toContain(join(repo, 'docs'));
});

it.each(['absent', 'invalid', 'foreign', 'stale', 'not a path'])('falls back after a %s profile', kind => {
  options.env.MMRSIM_REFERENCE_ROOT = '';
  if (kind === 'absent') rmSync(profilePath);
  if (kind === 'invalid') writeFileSync(profilePath, '{');
  if (kind === 'foreign') writeProfile({ hostname: 'another-machine', repos: { online_open_rocket: { referenceDocs: profileRoot } } });
  if (kind === 'stale') writeProfile({ repos: { online_open_rocket: { referenceDocs: join(dir, 'missing') } } });
  if (kind === 'not a path') writeProfile({ repos: { online_open_rocket: { referenceDocs: 42 } } });
  expect(referenceDir('User files', options)).toBe(join(docsRoot, 'User files'));
});

it('rejects files and continues after an unreadable directory', () => {
  rmSync(join(envRoot, 'User files'), { recursive: true });
  writeFileSync(join(envRoot, 'User files'), 'not a directory');
  expect(referenceDir('User files', options)).toBe(join(profileRoot, 'User files'));
  expect(referenceDir('User files', { ...options, isDirectory: path => {
    if (path.startsWith(envRoot) || path.startsWith(profileRoot)) throw new Error('EACCES');
    return path === join(docsRoot, 'User files');
  } })).toBe(join(docsRoot, 'User files'));
});

it('supports nested static folders and nullable member paths', () => {
  mkdirSync(join(envRoot, 'research', 'Boat-tails'), { recursive: true });
  expect(referenceDir('research/Boat-tails', options)).toBe(join(envRoot, 'research', 'Boat-tails'));
  vi.stubEnv('MACHINE_PROFILE', profilePath);
  vi.stubEnv('MMRSIM_REFERENCE_ROOT', envRoot);
  expect(referenceFile('research/Boat-tails', 'figure.pdf')).toBe(join(envRoot, 'research', 'Boat-tails', 'figure.pdf'));
  expect(referenceFile('absent-reference-folder', 'missing.ork')).toBeNull();
});

it('shows the repository referenceDocs key and source in --check', () => {
  const lines = [];
  checkMachineProfile({ env: options.env, log: line => lines.push(line) });
  expect(lines).toContain(`repos.online_open_rocket.referenceDocs: ${envRoot} [source: env]`);
  delete options.env.MMRSIM_REFERENCE_ROOT;
  lines.length = 0;
  checkMachineProfile({ env: options.env, log: line => lines.push(line) });
  expect(lines).toContain(`repos.online_open_rocket.referenceDocs: ${profileRoot} [source: profile]`);
});
