import { exec } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { checkAdvisories } from '../../../scripts/upstream-advisories.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// The real lock currently has no peer-only package. Add one in the temporary
// project so dropping --include=peer cannot silently leave this guard untested.
manifest.peerDependencies = { ...manifest.peerDependencies, 'audit-coverage-peer': '1.0.0' };
lock.packages[''].peerDependencies = manifest.peerDependencies;
lock.packages['node_modules/audit-coverage-peer'] = { version: '1.0.0', peer: true };
const expected = {};
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || pkg.link || !pkg.version) continue;
  const name = pkg.name || path.split('node_modules/').at(-1);
  expected[name] = [...new Set([...(expected[name] || []), pkg.version])].sort();
}

it.each([
  { NODE_ENV: 'production' },
  { npm_config_omit: 'dev' },
  { NODE_ENV: 'production', npm_config_omit: 'dev' },
  { npm_config_omit: 'optional' },
  { npm_config_omit: 'peer' },
])('audits the complete lockfile with inherited %j (offline npm CLI)', async (inherited) => {
  // Exercise the installed npm's real config and audit payload construction.
  // Only the registry response is synthetic; all traffic stays on loopback.
  const payloads = [];
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      payloads.push(JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString()));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const temp = mkdtempSync(join(tmpdir(), 'upstream-audit-coverage-'));
  try {
    const project = join(temp, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(project, 'package-lock.json'), JSON.stringify(lock));
    for (const workspace of ['packages/app', 'packages/engine']) {
      mkdirSync(join(project, workspace), { recursive: true });
      writeFileSync(join(project, workspace, 'package.json'), readFileSync(join(root, workspace, 'package.json')));
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const registry = `http://127.0.0.1:${server.address().port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^npm_config_|^NODE_ENV$|^NODE_OPTIONS$/i.test(key)));
    for (const config of ['userconfig', 'globalconfig']) {
      env[`npm_config_${config}`] = join(temp, config);
      writeFileSync(env[`npm_config_${config}`], '');
    }
    Object.assign(env, {
      npm_config_registry: registry, npm_config_audit_registry: registry,
      npm_config_cache: join(temp, 'cache'), npm_config_fetch_retries: '0',
      npm_config_update_notifier: 'false', ...inherited,
    });

    let auditCommand;
    let auditOptions;
    checkAdvisories(project, () => {}, (command, options) => {
      if (command !== 'gh') { auditCommand = command; auditOptions = options; }
      return { status: 0, stdout: command === 'gh' ? '[[]]' : '{"vulnerabilities":{}}' };
    }, (path) => path.endsWith('package-lock.json') ? JSON.stringify(lock) : 'wranglerVersion: 4.136.3');
    const { shell, ...options } = auditOptions;
    expect(shell).toBe(true);
    const { stdout } = await promisify(exec)(auditCommand, { ...options, env, timeout: 15_000 });
    expect(JSON.parse(stdout).vulnerabilities).toEqual({});
    expect(requests).toEqual(['POST /-/npm/v1/security/advisories/bulk']);
    expect(payloads).toHaveLength(1);
    const payload = Object.fromEntries(Object.entries(payloads[0]).map(([name, versions]) => [name, versions.sort()]));
    expect(payload.vite).toEqual(expected.vite);
    expect(payload.vitest).toEqual(expected.vitest);
    // Every lockfile package and version must be audited - that is what an inherited
    // omit would break. Not exact equality: npm on CI's Linux runner sends two
    // packages this lockfile-derived set does not list (557 vs 555, v0.143's
    // second push), and an EXTRA package audited is harmless.
    const missing = Object.entries(expected).flatMap(([name, versions]) =>
      versions.filter((v) => !(payload[name] ?? []).includes(v)).map((v) => `${name}@${v}`));
    expect(missing).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);
