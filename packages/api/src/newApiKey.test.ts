import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TEST_KEY, TEST_KEYS } from './auth.testSupport.js';

const script = new URL('../scripts/new-api-key.mjs', import.meta.url).href;
/** Even a broken name/hash guard must never generate a random credential during a test. */
function runFixed(args: string[], options: { cwd?: string; input?: string } = {}) {
  const source = `import crypto from 'node:crypto';
    import {syncBuiltinESMExports} from 'node:module';
    crypto.randomBytes = n => Buffer.alloc(n, 42);
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'new-api-key.mjs', ...${JSON.stringify(args)}];
    await import(${JSON.stringify(script)});`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { ...options, encoding: 'utf8' });
}
it('generates only a fixed test key once, its matching secret line and setup steps without writing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmrsim-key-test-'));
  try {
    const result = runFixed(['test'], { cwd: dir });
    expect(result.status, result.stderr).toBe(0);
    const key = Buffer.alloc(32, 42).toString('base64url');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.stdout.split(key)).toHaveLength(2);
    expect(result.stdout).toContain('test:' + createHash('sha256').update(key).digest('hex'));
    expect(result.stdout).toContain('npx wrangler secret put API_KEYS');
    expect(result.stdout).toContain('one-time link');
    expect(readdirSync(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true }); }
});
it('hashes a fixed test key from stdin without echoing it', () => {
  const result = runFixed(['test', '--hash'], { input: TEST_KEY + '\n' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(TEST_KEYS + '\n');
  expect(result.stderr).toBe('');
});
it.each(['', 'UPPER', 'a'.repeat(33), 'bad:name'])('rejects invalid name %s without generating or echoing a key', name => {
  const result = runFixed([name]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
});

it.each(['', 'two keys', 'two\nlines'])('refuses unusable stdin %s without output', input => {
  const result = runFixed(['test', '--hash'], { input });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Supply one non-empty key on stdin.');
});

it('prints all existing keys and the new hash on one pasteable secret line', () => {
  const existing = 'older:' + 'a'.repeat(64);
  const other = TEST_KEYS.replace('test:', 'other:');
  const result = runFixed(['test', '--hash', existing, other], { input: TEST_KEY });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(existing + ',' + other + ',' + TEST_KEYS + '\n');
});
it('rejects malformed existing entries before generating a key', () => {
  const result = runFixed(['test', 'older:not-a-hash']);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
});

it('rotates a same-name key instead of retaining its old hash', () => {
  const old = 'test:' + 'a'.repeat(64);
  const other = 'other:' + 'b'.repeat(64);
  const result = runFixed(['test', '--hash', old, other], { input: TEST_KEY });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(other + ',' + TEST_KEYS + '\n');
  expect(result.stderr).toBe('Replaced the existing test entry.\n');
  expect(result.stdout).not.toContain(old);
});
it('accepts its comma-separated output as one existing-entries argument', () => {
  const entries = 'older:' + 'a'.repeat(64) + ',other:' + 'b'.repeat(64);
  const result = runFixed(['test', '--hash', entries], { input: TEST_KEY });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(entries + ',' + TEST_KEYS + '\n');
});

it('accepts newline-separated and whitespace-padded existing entries', () => {
  const old = 'older:' + 'a'.repeat(64);
  const other = 'other:' + 'b'.repeat(64);
  const result = runFixed(['test', '--hash', ' \t' + old + ' \r\n ' + other + '\t '], { input: TEST_KEY });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(old + ',' + other + ',' + TEST_KEYS + '\n');
});

it('skips blank entries as the Worker does (a terminal LF or CRLF, blank lines, stray commas)', () => {
  const old = 'older:' + 'a'.repeat(64);
  const other = 'other:' + 'b'.repeat(64);
  for (const [arg, kept] of [[old + '\n', [old]], [old + '\r\n', [old]], ['\n' + old + '\n\n' + other + '\n', [old, other]],
    [old + ',,' + other + ',', [old, other]]] as const) {
    const result = runFixed(['test', '--hash', arg], { input: TEST_KEY });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe([...kept, TEST_KEYS].join(',') + '\n');
  }
  // A malformed non-empty entry is still refused.
  expect(runFixed(['test', '--hash', old + '\nnot-an-entry'], { input: TEST_KEY }).status).toBe(1);
});
