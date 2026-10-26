import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

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
  it.each(['app', 'engine', 'api'])('declares Node types directly in %s', workspace => {
    expect(JSON.parse(read(`../../${workspace}/package.json`)).devDependencies['@types/node']).toEqual(expect.any(String));
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
