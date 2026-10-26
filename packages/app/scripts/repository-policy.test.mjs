import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('repository configuration policies', () => {
  it('declares Node types directly in the app', () => {
    expect(JSON.parse(read('../package.json')).devDependencies['@types/node']).toEqual(expect.any(String));
  });

  it('defaults to LF while preserving byte-sensitive exceptions', () => {
    const rules = read('../../../.gitattributes').split('\n').filter(line => line && !line.startsWith('#'));
    expect(rules[0]).toBe('* text=auto eol=lf');
    for (const path of ['engine-java/src/carved/**', 'engine-java/patches/**',
      'packages/app/src/services/__fixtures__/synthetic-ex-labs.rse',
      'packages/app/scripts/fixtures/motor-digest/**',
      'packages/app/src/services/__fixtures__/ambiguous-motor-mounts.rkt']) {
      expect(rules).toContain(`${path} -text`);
    }
  });
});
