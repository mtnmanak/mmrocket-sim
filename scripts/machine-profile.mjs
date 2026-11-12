/** Machine-local settings. Profile contents are read lazily. */
import { isMain } from './is-main.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read lazily: an explicit flag or environment setting need not load the profile. */
export function loadMachineProfile({ env = process.env, home = homedir() } = {}) {
  const path = env.MACHINE_PROFILE || join(home, '.machine', 'machine.json');
  let loaded = false;
  let data;
  function read() {
    if (!loaded) {
      try { data = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Cannot read machine profile ${path}: ${error.message}`, { cause: error });
      }
      loaded = true;
    }
    return data;
  }
  return { path, read };
}

const present = value => value !== undefined && value !== null && value !== '';
const evaluate = value => typeof value === 'function' ? value() : value;

export function legacyOpenrocketSource(repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const pointer = join(repo, '.openrocket-src');
  if (!existsSync(pointer)) return undefined;
  const line = readFileSync(pointer, 'utf8').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (line) console.error('Deprecated: .openrocket-src is in use; set openrocketSource in the machine profile instead.');
  return line;
}

function portableJavaHome(home) {
  const root = join(home, '.online-openrocket');
  if (!existsSync(root)) return undefined;
  const jdks = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.name.startsWith('jdk-17') && statSync(join(root, entry.name), { throwIfNoEntry: false })?.isDirectory())
    .map(entry => entry.name).sort();
  return jdks.length ? join(root, jdks.at(-1)) : undefined;
}

/** Higher-priority overrides bypass profile validation; null means unknown. */
export function resolveSetting({
  key, flag, envVar, env = process.env, profile = loadMachineProfile({ env }),
  legacy, fallback, isPath = false, required = false,
}) {
  if (present(flag)) return { value: flag, source: 'flag' };
  if (present(envVar && env[envVar])) return { value: env[envVar], source: 'env' };
  const data = profile.read();
  const value = key.split('.').reduce((parent, part) => parent?.[part], data);
  if (present(value)) {
    if (typeof data.hostname !== 'string' || data.hostname.toLowerCase() !== hostname().toLowerCase()) {
      throw new Error(`Machine profile ${profile.path}: hostname ${JSON.stringify(data.hostname)} does not match ${hostname()} (key ${key})`);
    }
    if (isPath && (typeof value !== 'string' || !existsSync(value))) {
      throw new Error(`Machine profile ${profile.path}: ${key} path does not exist: ${String(value)}`);
    }
    return { value, source: 'profile' };
  }
  const old = evaluate(legacy);
  if (present(old)) return { value: old, source: 'legacy file' };
  const defaultValue = evaluate(fallback);
  if (present(defaultValue)) return { value: defaultValue, source: 'default' };
  if (required) throw new Error(`Missing ${key}; configure machine profile ${profile.path} or an explicit override`);
  return { value: undefined, source: 'missing' };
}

/** JAVA_HOME > profile jdk17 > newest portable jdk-17* directory. */
export function findJavaHome({ env = process.env, home = homedir(), profile = loadMachineProfile({ env, home }) } = {}) {
  return resolveSetting({ key: 'jdk17', flag: existingJavaHome(env), env, profile, isPath: true, required: true,
    fallback: () => portableJavaHome(home),
  }).value;
}

const existingJavaHome = env => env.JAVA_HOME && existsSync(env.JAVA_HOME) ? env.JAVA_HOME : undefined;

/** Read-only diagnostic; continue after invalid keys so every setting is visible. */
export function checkMachineProfile({ env = process.env, log = console.log } = {}) {
  const profile = loadMachineProfile({ env });
  log(`Profile: ${profile.path}`);
  let status = 0;
  try {
    const data = profile.read();
    const matches = typeof data?.hostname === 'string' && data.hostname.toLowerCase() === hostname().toLowerCase();
    log(`Hostname: ${!data ? 'profile absent' : matches ? 'match' : 'MISMATCH'} (profile=${data?.hostname ?? 'missing'}, current=${hostname()})`);
    if (data && !matches) status = 2;
  } catch (error) { log(error.message); status = 2; }
  for (const [key, envVar, fallback] of [
    ['openrocketSource', 'OPENROCKET_SRC'], ['jdk17', 'JAVA_HOME', () => portableJavaHome(homedir())], ['dropbox'],
    ['tools.python', 'PYTHON', 'python'], ['tools.agy'],
  ]) {
    try {
      if (key === 'jdk17' && env.JAVA_HOME && !existingJavaHome(env)) log(`JAVA_HOME: ${env.JAVA_HOME} ignored (path does not exist)`);
      const javaEnv = key === 'jdk17' ? { ...env, JAVA_HOME: existingJavaHome(env) } : env;
      const result = resolveSetting({ key, envVar, fallback, env: javaEnv, profile, isPath: true,
        legacy: key === 'openrocketSource' ? () => legacyOpenrocketSource() : undefined });
      log(`${key}: ${result.value ?? '(unknown)'} [source: ${result.source}]`);
    } catch (error) { log(`${key}: ERROR [source: profile] ${error.message}`); status = 2; }
  }
  return status;
}

if (isMain(import.meta.url)) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--check') process.exitCode = checkMachineProfile();
  else { console.error('Usage: node scripts/machine-profile.mjs --check'); process.exitCode = 2; }
}
