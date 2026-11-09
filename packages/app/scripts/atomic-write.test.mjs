import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.mjs';

it('copies existing permission bits onto the temporary before replacing', () => {
  const calls = [];
  const io = {
    statSync: () => ({ mode: 0o100640 }),
    writeFileSync: () => calls.push('write'),
    chmodSync: (path, mode) => calls.push(['chmod', mode]),
    renameSync: () => calls.push('rename'),
    rmSync: () => {},
  };
  atomicWriteFileSync('artifact.json', '{}', 'utf8', io);
  expect(calls).toEqual(['write', ['chmod', 0o640], 'rename']);
});

it.skipIf(process.platform === 'win32')('uses the umask for new artifacts and retains existing modes', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'atomic-modes-'));
  const path = join(dir, 'artifact.json');
  try {
    atomicWriteFileSync(path, '{}');
    expect(fs.statSync(path).mode & 0o777).toBe(0o666 & ~process.umask());
    fs.chmodSync(path, 0o640);
    atomicWriteFileSync(path, '{"new":true}');
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.each(['write', 'rename'])('preserves the previous artifact after a failed %s', phase => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'atomic-artifact-'));
  const path = join(dir, 'artifact.json');
  fs.writeFileSync(path, '{"old":true}\n');
  try {
    const io = { ...fs,
      writeFileSync: (target, bytes, options) => {
        fs.writeFileSync(target, phase === 'write' ? '{' : bytes, options);
        if (phase === 'write') throw new Error('disk full');
      },
      renameSync: (...args) => {
        if (phase === 'rename') throw new Error('replacement refused');
        fs.renameSync(...args);
      },
    };
    expect(() => atomicWriteFileSync(path, '{"new":true}\n', 'utf8', io)).toThrow();
    expect(fs.readFileSync(path, 'utf8')).toBe('{"old":true}\n');
    expect(fs.readdirSync(dir)).toEqual(['artifact.json']);
    atomicWriteFileSync(path, '{"new":true}\n');
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual({ new: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
