import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const GLOB = /[*?[\]{}!]/;

/**
 * The workspace directories the root package.json's `workspaces` names. A
 * `dir/*` entry expands to its subdirectories that hold a package.json, a
 * plain entry is taken literally, and any other glob throws: enumerating
 * nothing would pass the guard below vacuously.
 */
function workspaceDirs(root) {
  return readJson(join(root, 'package.json')).workspaces.flatMap(entry => {
    const base = entry.endsWith('/*') ? entry.slice(0, -2) : null;
    if (base !== null && !GLOB.test(base)) {
      return readdirSync(join(root, base), { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && existsSync(join(root, base, dirent.name, 'package.json')))
        .map(dirent => join(root, base, dirent.name));
    }
    if (GLOB.test(entry)) throw new Error(`unsupported workspaces glob: ${entry}`);
    return [join(root, entry)];
  });
}

const missingNodeTypes = root => workspaceDirs(root)
  .filter(dir => typeof readJson(join(dir, 'package.json')).devDependencies?.['@types/node'] !== 'string')
  .map(dir => basename(dir));

const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'repository-policy-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(workspaces, packages) {
  const root = temp();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces }));
  for (const [name, manifest] of Object.entries(packages)) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify(manifest));
  }
  return root;
}

describe('repository configuration policies', () => {
  it('declares the Worker engine dependency and keeps its lock entry in sync', () => {
    const manifest = JSON.parse(read('../../api/package.json'));
    const lock = JSON.parse(read('../../../package-lock.json'));
    expect(manifest.dependencies['@online-openrocket/engine']).toBe('*');
    expect(lock.packages['packages/api'].dependencies).toEqual(manifest.dependencies);
  });
  it('keeps module-only uppercase constants private', () => {
    const files = [];
    const walk = url => {
      for (const entry of readdirSync(url, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
        if (entry.isDirectory()) walk(child);
        else if (/\.(?:tsx?|mjs)$/.test(entry.name)) files.push(child);
      }
    };
    for (const path of ['../src/', './', '../../api/src/', '../../../scripts/']) walk(new URL(path, import.meta.url));
    const refs = new Map(), exports = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const word of new Set(source.match(/\b[A-Z][A-Z0-9_]+\b/g))) refs.set(word, (refs.get(word) ?? 0) + 1);
      if (file.href.includes('/app/src/') && !/\/(?:userGuide|changelog|version)\.ts$/.test(file.href)) {
        for (const [, name] of source.matchAll(/^export const ([A-Z][A-Z0-9_]+)\b/gm)) exports.push([file.pathname, name]);
      }
    }
    expect(exports.filter(([, name]) => refs.get(name) === 1)).toEqual([]);
  });
  it('declares Node types directly in every workspace', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    expect(workspaceDirs(root).map(dir => basename(dir))).toEqual(expect.arrayContaining(['app', 'engine', 'api']));
    expect(missingNodeTypes(root)).toEqual([]);
  });

  it('reports a fourth workspace that compiles only through the hoisted Node types', () => {
    const typed = { devDependencies: { '@types/node': '^22.0.0' } };
    const root = fixture(['packages/*'], { app: typed, engine: typed, api: typed, extra: { devDependencies: {} } });
    mkdirSync(join(root, 'packages', 'notes'));
    expect(missingNodeTypes(root)).toEqual(['extra']);
  });

  it('takes a plain workspaces entry literally', () => {
    const root = fixture(['packages/app', 'packages/extra'], { app: {}, extra: {}, other: {} });
    expect(workspaceDirs(root).map(dir => basename(dir))).toEqual(['app', 'extra']);
  });

  it('refuses a workspaces glob it cannot enumerate', () => {
    const root = fixture(['packages/**'], { app: {} });
    expect(() => workspaceDirs(root)).toThrow(/unsupported workspaces glob: packages\/\*\*/);
  });

  it('defaults to LF while preserving byte-sensitive exceptions', () => {
    const rules = read('../../../.gitattributes').split('\n').filter(line => line && !line.startsWith('#'));
    expect(rules[0]).toBe('* text=auto eol=lf');
    expect(rules.filter(rule => /\beol=/.test(rule))).toEqual(['* text=auto eol=lf']);
    const exceptions = ['engine-java/src/carved/**', 'engine-java/patches/**',
      'packages/app/src/services/__fixtures__/synthetic-ex-labs.rse',
      'packages/app/scripts/fixtures/motor-digest/**',
      'packages/app/src/services/__fixtures__/ambiguous-motor-mounts.rkt'];
    // Any extra rule can unset text/eol, even without an eol= assignment.
    expect(rules.slice(1)).toEqual(exceptions.map(path => `${path} -text`));
  });
});
