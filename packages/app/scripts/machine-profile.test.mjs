import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { findJavaHome, loadMachineProfile, resolveSetting } from '../../../scripts/machine-profile.mjs';
import { openrocketSrcRoot } from '../../../scripts/openrocket-src.mjs';
import { main as census } from './digest-census.mjs';

let dir, env, profilePath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-profile-'));
  profilePath = join(dir, 'machine.json');
  env = { MACHINE_PROFILE: profilePath };
  vi.stubEnv('MACHINE_PROFILE', profilePath);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const write = data => writeFileSync(profilePath, JSON.stringify({ hostname: hostname().toUpperCase(), ...data }));
const setting = options => resolveSetting({ key: 'openrocketSource', envVar: 'OPENROCKET_SRC', env, ...options });
const run = (script, args = [], extraEnv = {}) => spawnSync(process.execPath,
  [fileURLToPath(new URL(`../../../${script}`, import.meta.url)), ...args], {
    encoding: 'utf8', env: { ...process.env, OPENROCKET_SRC: '', JAVA_HOME: '', PYTHON: '', ...env, ...extraEnv },
  });

it('resolves flag > env > profile > legacy > default > missing without reading lower sources', () => {
  write({ openrocketSource: dir });
  env.OPENROCKET_SRC = 'env-value';
  const legacy = vi.fn(() => 'legacy-value');
  expect(setting({ flag: 'flag-value', legacy })).toEqual({ value: 'flag-value', source: 'flag' });
  expect(setting({ legacy })).toEqual({ value: 'env-value', source: 'env' });
  delete env.OPENROCKET_SRC;
  expect(setting({ legacy, isPath: true })).toEqual({ value: dir, source: 'profile' });
  expect(legacy).not.toHaveBeenCalled();
  write({ openrocketSource: null });
  expect(setting({ legacy })).toEqual({ value: 'legacy-value', source: 'legacy file' });
  expect(setting({ fallback: 'default-value' })).toEqual({ value: 'default-value', source: 'default' });
  expect(setting({})).toEqual({ value: undefined, source: 'missing' });
  expect(() => setting({ required: true })).toThrow(`Missing openrocketSource; configure machine profile ${profilePath}`);
});

it('treats missing profile files and null nested keys as absent', () => {
  expect(setting({ legacy: () => dir })).toEqual({ value: dir, source: 'legacy file' });
  write({ tools: { python: null } });
  expect(resolveSetting({ key: 'tools.python', env, fallback: 'python' }).source).toBe('default');
  expect(loadMachineProfile({ env: {}, home: dir }).path).toBe(join(dir, '.machine', 'machine.json'));
});

it('validates only the selected profile path and names its key, value and file', () => {
  const stale = join(dir, 'stale');
  write({ tools: { python: stale }, dropbox: dir });
  expect(resolveSetting({ key: 'dropbox', env, isPath: true }).value).toBe(dir);
  const readPython = () => resolveSetting({ key: 'tools.python', env, isPath: true, fallback: 'python' });
  expect(readPython).toThrow('tools.python');
  expect(readPython).toThrow(stale);
  expect(readPython).toThrow(profilePath);
});

it('rejects foreign host values but permits overrides and absent-key fallbacks', () => {
  write({ hostname: 'foreign-host', openrocketSource: dir });
  const read = () => setting({});
  for (const detail of ['foreign-host', hostname(), profilePath]) expect(read).toThrow(detail);
  expect(setting({ flag: dir }).source).toBe('flag');
  env.OPENROCKET_SRC = dir;
  expect(setting({}).source).toBe('env');
  expect(resolveSetting({ key: 'unknown', env, fallback: 'ok' }).value).toBe('ok');
});

it('does not parse a malformed profile when an override is available', () => {
  writeFileSync(profilePath, '{broken');
  expect(setting({ flag: dir }).value).toBe(dir);
  env.OPENROCKET_SRC = dir;
  expect(setting({}).value).toBe(dir);
  delete env.OPENROCKET_SRC;
  expect(() => setting({})).toThrow(profilePath);
});

it('puts legacy .openrocket-src below the profile and warns only when used', () => {
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  writeFileSync(join(dir, '.openrocket-src'), '# comment\n\nlegacy-path\n');
  write({ openrocketSource: dir });
  expect(openrocketSrcRoot(undefined, { env, repo: dir })).toBe(dir);
  expect(warn).not.toHaveBeenCalled();
  write({ openrocketSource: null });
  expect(openrocketSrcRoot(undefined, { env, repo: dir })).toBe('legacy-path');
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Deprecated.*openrocketSource/));
  rmSync(join(dir, '.openrocket-src'));
  expect(openrocketSrcRoot(undefined, { env, repo: dir })).toBeNull();
});

it('uses JAVA_HOME > profile jdk17 > newest portable directory > named error', () => {
  write({ jdk17: dir });
  const options = { env, home: dir };
  const override = join(dir, 'override');
  mkdirSync(override);
  expect(findJavaHome({ ...options, env: { ...env, JAVA_HOME: override } })).toBe(override);
  expect(findJavaHome(options)).toBe(dir);
  write({ jdk17: null });
  const portable = join(dir, '.online-openrocket');
  mkdirSync(join(portable, 'jdk-17.1'), { recursive: true });
  mkdirSync(join(portable, 'jdk-17.9'));
  writeFileSync(join(portable, 'jdk-17.zzz'), 'not a directory');
  expect(findJavaHome(options)).toBe(join(portable, 'jdk-17.9'));
  rmSync(portable, { recursive: true });
  expect(() => findJavaHome(options)).toThrow('Missing jdk17');
});

it('ignores a nonexistent JAVA_HOME for both profile and portable fallback', () => {
  env.JAVA_HOME = join(dir, 'missing-java');
  write({ jdk17: dir });
  expect(findJavaHome({ env, home: dir })).toBe(dir);
  const result = run('scripts/machine-profile.mjs', ['--check'], { JAVA_HOME: env.JAVA_HOME });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`JAVA_HOME: ${env.JAVA_HOME} ignored`);
  expect(result.stdout).toContain(`jdk17: ${dir} [source: profile]`);
  write({ jdk17: null });
  const portable = join(dir, '.online-openrocket', 'jdk-17.9');
  mkdirSync(portable, { recursive: true });
  expect(findJavaHome({ env, home: dir })).toBe(portable);
});

it('discovers a portable JDK directory junction or symlink', () => {
  const root = join(dir, '.online-openrocket');
  mkdirSync(root);
  const target = join(dir, 'target');
  mkdirSync(target);
  const link = join(root, 'jdk-17.9');
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  expect(findJavaHome({ env, home: dir })).toBe(link);
});

it.each(['openrocketSource', 'jdk17'])('consumer rejects nonexistent profile %s', key => {
  const stale = join(dir, 'missing-path');
  write({ [key]: stale });
  const consume = () => key === 'jdk17' ? findJavaHome({ env, home: dir }) : openrocketSrcRoot(undefined, { env, repo: dir });
  for (const detail of [key, stale, profilePath]) expect(consume).toThrow(detail);
});

it('nozzle consumer rejects nonexistent profile Python before running extraction', async () => {
  const stale = join(dir, 'missing-python');
  write({ tools: { python: stale } });
  vi.stubEnv('PYTHON', '');
  const { main } = await import('./build-nozzle-db.mjs');
  const consume = () => main({ argv: [], source: dir });
  for (const detail of ['tools.python', stale, profilePath]) expect(consume).toThrow(detail);
});

it('census walk rejects nonexistent profile Dropbox before creating output', async () => {
  const stale = join(dir, 'missing-dropbox');
  write({ dropbox: stale });
  for (const detail of ['dropbox', stale, profilePath]) {
    await expect(census(['--out', join(dir, 'output')])).rejects.toThrow(detail);
  }
  expect(readdirSync(dir)).toEqual(['machine.json']);
});

it('CLI with no profile exits zero and reports profile absent', () => {
  const result = run('scripts/machine-profile.mjs', ['--check']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('profile absent');
});

// Exercise real census path resolution/walk and manifest writing. Replace only
// the motor bundle and downstream simulation subprocess; no network or engine.
it.each(['profile-list', 'absent-list', 'foreign-list', 'stale-list', 'profile-walk'])('census successfully resolves inputs for %s', mode => {
  const dropbox = join(dir, 'dropbox');
  mkdirSync(dropbox);
  const design = join(dropbox, 'synthetic.ork');
  writeFileSync(design, 'synthetic input for manifest only');
  const list = join(dir, 'list.txt');
  const valid = mode.startsWith('profile-');
  writeFileSync(list, valid ? 'synthetic.ork\n' : `${relative(process.cwd(), design)}\n`);
  if (mode !== 'absent-list') write({ hostname: mode === 'foreign-list' ? 'foreign-host' : hostname(),
    dropbox: mode === 'stale-list' ? join(dir, 'absent') : dropbox });
  const out = join(dir, 'output');
  mkdirSync(out);
  const bundle = { generated: 'synthetic', curves: {} };
  const hash = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
  writeFileSync(join(out, `raw-synthetic-${hash}.json`), '{}');
  const argv = ['--out', out, ...(mode === 'profile-walk' ? [] : ['--list', list])];
  const code = `import fs from 'node:fs'; import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => String(path).endsWith('motorCurves.json') ? ${JSON.stringify(JSON.stringify(bundle))} : read(path, ...args);
    cp.spawnSync = () => ({ status: 0 });
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(new URL('./digest-census.mjs', import.meta.url).href)});
    process.exitCode = await main(${JSON.stringify(argv)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  expect(manifest.files.filter(file => file.corpus === 'dropbox')).toEqual([
    { path: design, corpus: 'dropbox', sha256: createHash('sha256').update(readFileSync(design)).digest('hex') },
  ]);
});

it.each(['flag', 'env', 'profile', 'default'])('nozzle extraction selects Python from %s', source => {
  write({ tools: { python: source === 'profile' ? process.execPath : null } });
  const script = fileURLToPath(new URL('./build-nozzle-db.mjs', import.meta.url));
  const code = `import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    cp.execFileSync = command => { throw new Error('SELECTED:' + command); };
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(new URL('./build-nozzle-db.mjs', import.meta.url).href)});
    try { main({ argv: [], source: ${JSON.stringify(dir)},
      ${source === 'flag' ? "python: 'injected-python'," : ''} }); }
    catch (error) { console.log(error.message); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    encoding: 'utf8', env: { ...process.env, ...env, PYTHON: source === 'env' || source === 'flag' ? 'env-python' : '' },
  });
  expect(result.status, `${script}: ${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe(`SELECTED:${source === 'flag' ? 'injected-python' : source === 'env' ? 'env-python' : source === 'profile' ? process.execPath : 'python'}`);
});

it('CLI prints every key, source, profile path and hostname verdict without writing', () => {
  write({ openrocketSource: dir, jdk17: dir, dropbox: null });
  const before = readFileSync(profilePath, 'utf8');
  const files = readdirSync(dir);
  const result = run('scripts/machine-profile.mjs', ['--check'], { PYTHON: 'env-python' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(profilePath);
  expect(result.stdout).toContain('Hostname: match');
  for (const [key, source] of [['openrocketSource', 'profile'], ['jdk17', 'profile'],
    ['dropbox', 'missing'], ['tools.python', 'env'], ['tools.agy', 'missing']]) {
    expect(result.stdout).toMatch(new RegExp(`${key}: .*\\[source: ${source}\\]`));
  }
  expect(run('scripts/machine-profile.mjs', ['--check']).stdout).toContain('tools.python: python [source: default]');
  expect(readFileSync(profilePath, 'utf8')).toBe(before);
  expect(readdirSync(dir)).toEqual(files);
});

it.each(['hostname', 'path'])('CLI exits 2 for an invalid %s and still lists all keys', kind => {
  write({ hostname: kind === 'hostname' ? 'foreign-host' : hostname(), tools: { agy: join(dir, 'absent') } });
  const result = run('scripts/machine-profile.mjs', ['--check']);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain(kind === 'hostname' ? 'MISMATCH' : 'path does not exist');
  for (const key of ['openrocketSource', 'jdk17', 'dropbox', 'tools.python', 'tools.agy']) expect(result.stdout).toContain(`${key}:`);
});

it('CLI diagnoses a hostname mismatch even when every stored key is unknown', () => {
  write({ hostname: 'foreign-host' });
  const result = run('scripts/machine-profile.mjs', ['--check']);
  expect(result.status).toBe(2);
  expect(result.stdout).toContain('MISMATCH');
});

it('census without Dropbox overrides or a profile errors before creating output', async () => {
  const out = join(dir, 'output');
  await expect(census(['--out', out])).rejects.toThrow('Missing dropbox');
  expect(readdirSync(dir)).toEqual([]);
});

it.each([['--no-dropbox'], ['--list', 'missing-list'], ['--dropbox', '.'],
  ['--list', 'missing-list', '--dropbox', '.']])('census override %j bypasses a foreign profile', async (...args) => {
  write({ hostname: 'foreign-host', dropbox: dir });
  // Stop before walking inputs, downloading, or writing any census output.
  const out = join(dir, 'output');
  writeFileSync(out, 'block output creation');
  await expect(census(['--out', out, ...args])).rejects.toThrow(/EEXIST/);
});
