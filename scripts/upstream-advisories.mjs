import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, join } from 'node:path';

// open-items.md: “Nothing raises an advisory whose fix is a major version”
// (Tier 0 row 43, approved 2026-09-30): report exposure, never gate a deploy.
export function runtimeNodes(lock) {
  const packages = lock.packages;
  if (!packages?.['packages/app'] || !packages['packages/engine']) {
    throw new Error('lockfile has no app/engine workspace entries');
  }
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const pkg = packages[path];
    if (pkg.link) { visit(pkg.resolved); return; }
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      let dir = path;
      for (;;) {
        const candidate = posix.join(dir, 'node_modules', name);
        if (packages[candidate]) { visit(candidate); break; }
        if (!dir) break;
        const parent = posix.dirname(dir);
        dir = parent === '.' ? '' : parent;
      }
    }
  };
  visit('packages/app');
  visit('packages/engine');
  return seen;
}

export function auditFix(fix) {
  if (fix === true) return 'in range: npm audit fix';
  if (fix === false) return 'no fix available';
  if (fix && typeof fix.name === 'string' && typeof fix.version === 'string') {
    return `${fix.isSemVerMajor ? 'MAJOR' : 'outside declared range (non-major)'}: ${fix.name}@${fix.version}`;
  }
  return 'fix unknown';
}

export function npmAdvisories(report, lock) {
  if (report?.error) throw new Error(report.error.summary || report.message || 'npm audit registry error');
  if (!report?.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    throw new Error('npm audit returned no vulnerabilities object');
  }
  const runtime = runtimeNodes(lock);
  const lines = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    const nodes = vuln.nodes;
    const scope = nodes?.some((node) => runtime.has(node)) ? 'RUNTIME'
      : nodes?.length && nodes.every((node) => lock.packages[node]) ? 'dev/build-only' : 'scope unknown';
    const route = auditFix(vuln.fixAvailable);
    const own = new Map(vuln.via.filter((a) => typeof a === 'object').map((a) => [a.url, a]));
    for (const a of own.values()) {
      lines.push(`${name} ${a.severity} (${scope}) ${a.url} — ${route} — ${a.title}`);
    }
    if (!own.size) lines.push(`${name} ${vuln.severity} (${scope}) only through ${vuln.via.join(', ')} — ${route}`);
  }
  return lines;
}

export function wranglerPins(workflow) {
  const active = workflow.split(/\r?\n/).map((line) => line.replace(/#.*/, '')).join('\n');
  const pins = [...active.matchAll(/\bwrangler@(\d+\.\d+\.\d+)(?=[\s"']|$)/g),
    ...active.matchAll(/\bwranglerVersion:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/gm)]
    .map((match) => match[1]);
  if (!pins.length) throw new Error('no exact wrangler pin in deploy.yml');
  return [...new Set(pins)];
}

export function wranglerAdvisories(pages, pin) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('GitHub returned no advisory pages');
  return pages.flat().map((a) => {
    const patches = a.vulnerabilities.filter((v) => v.package.ecosystem === 'npm' && v.package.name === 'wrangler')
      .map((v) => v.first_patched_version).filter(Boolean);
    // Wrangler is EXACTLY pinned: even a patch needs an explicit workflow edit.
    const route = !patches.length ? 'no fix published' : [...new Set(patches)].map((version) =>
      `${Number(version.split('.')[0]) > Number(pin.split('.')[0]) ? 'MAJOR' : 'outside exact pin'}: wrangler@${version}`).join('; ');
    return `wrangler@${pin} ${a.severity} (dev/build-only; deploy, outside lockfile) ${a.ghsa_id} — ${route} — ${a.summary}`;
  });
}

function commandJSON(result, audit = false) {
  if (result.error) throw result.error;
  // npm uses exit 1 for findings; gh does not. An outage must not look clean.
  if (result.status !== 0 && !(audit && result.status === 1)) {
    throw new Error(result.stderr?.trim() || `command exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

export function checkAdvisories(root, say = console.log, run = spawnSync, read = readFileSync) {
  say('');
  say('7. Security advisories (REPORT ONLY — no change to exit status)');
  const options = { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 };
  try {
    // A fixed command string avoids npm.cmd's Windows spawn limitation and DEP0190.
    // Include wins over inherited omit/production settings: tooling needs coverage too.
    const report = commandJSON(run('npm audit --package-lock-only --json --include=dev --include=optional --include=peer', { ...options, shell: true }), true);
    const lines = npmAdvisories(report, JSON.parse(read(join(root, 'package-lock.json'), 'utf8')));
    if (!lines.length) say('  ok   npm audit: no advisories');
    for (const line of lines) say(`  note ${line}`);
  } catch (err) {
    say(`  warn could not check npm advisories (${err.message}) — not a clean audit`);
  }
  try {
    const pins = wranglerPins(read(join(root, '.github/workflows/deploy.yml'), 'utf8'));
    if (pins.length > 1) say('  warn deploy.yml has different wrangler pins; checking each');
    for (const pin of pins) {
      try {
        const pages = commandJSON(run('gh', ['api', '--paginate', '--slurp',
          `/advisories?ecosystem=npm&affects=wrangler@${pin}&per_page=100`], options));
        const lines = wranglerAdvisories(pages, pin);
        if (!lines.length) say(`  ok   wrangler@${pin} (deploy, outside lockfile): no advisories`);
        for (const line of lines) say(`  note ${line}`);
      } catch (err) {
        say(`  warn could not check wrangler@${pin} advisories (${err.message}) — gh may be missing or offline`);
      }
    }
  } catch (err) {
    say(`  warn could not check wrangler advisories (${err.message})`);
  }
}
