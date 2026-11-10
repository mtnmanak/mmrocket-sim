import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['build', 'patched', 'first', 'package', 'zip'].flatMap(kind =>
  ['write', 'rename', 'success'].map(phase => ({ kind, phase }))))(
  'publishes only complete $kind copies ($phase)', ({ kind, phase }) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'engine-copy-'));
    const put = (path, bytes) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, bytes); };
    try {
      // Execute the real entry points, relocated to an isolated fixture repository.
      for (const path of ['engine-java/scripts/build-engine.mjs', 'engine-java/scripts/carve.mjs',
        'scripts/openrocket-src.mjs', 'scripts/package-dist.mjs', 'packages/app/scripts/atomic-write.mjs']) {
        put(join(root, path), fs.readFileSync(new URL('../../../' + path, import.meta.url)));
      }
      const target = join(root, kind === 'zip' ? 'deploy/online-openrocket-vtest.zip' : kind === 'package' ? 'packages/app/dist/version.json'
        : kind === 'build' ? 'packages/engine/vendor/orkengine.mjs' : 'engine-java/src/carved/java/Test.java');
      const bytes = kind === 'package' ? Buffer.from('{"version":"test"}') : Buffer.from([0, 255, 1, 2, 3]);
      put(join(root, 'version.json'), '{"version":"test"}');
      put(join(root, 'packages/app/src/version.ts'), "export const APP_VERSION = 'test';");
      put(join(root, 'packages/app/dist/index.html'), 'fixture');
      put(join(root, 'engine-java/build/generated/teavm/js/online-openrocket-engine-java.js'), bytes);
      put(join(root, 'upstream/Test.java'), bytes);
      put(join(root, 'engine-java/carve-manifest.txt'), 'Test.java\n');
      if (kind === 'patched') put(join(root, 'engine-java/patches/Test.java'), bytes);
      if (kind !== 'first') put(target, 'old complete bytes');
      const preload = `import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const target = ${JSON.stringify(target)};
const write = fs.writeFileSync, copy = fs.copyFileSync, rename = fs.renameSync;
fs.writeFileSync = (path, bytes, ...args) => {
  if (${JSON.stringify(phase)} === 'write' && String(path).startsWith(target)) {
    write(path, 'partial'); throw new Error('interrupted write');
  }
  return write(path, bytes, ...args);
};
fs.copyFileSync = (src, dst) => {
  if (${JSON.stringify(phase)} !== 'success' && dst === target) {
    write(dst, 'partial'); throw new Error('interrupted copy');
  }
  return copy(src, dst);
};
fs.renameSync = (src, dst) => {
  if (${JSON.stringify(phase)} === 'rename' && dst === target) throw new Error('interrupted rename');
  return rename(src, dst);
};
cp.execFileSync = (command, args) => {
  // No Gradle or archiver process is ever started.
  if (!['package', 'zip'].includes(${JSON.stringify(kind)})) return;
  const path = command === 'zip' ? args[1] : args[args.indexOf('-f') + 1];
  write(path, ${JSON.stringify(kind)} === 'zip' && ${JSON.stringify(phase)} === 'write' ? 'partial' : Buffer.from([0, 255, 1, 2, 3]));
  if (${JSON.stringify(kind)} === 'zip' && ${JSON.stringify(phase)} === 'write') throw new Error('interrupted archive');
};
syncBuiltinESMExports();`;
      const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
        ['package', 'zip'].includes(kind) ? join(root, 'scripts/package-dist.mjs')
          : join(root, 'engine-java/scripts', kind === 'build' ? 'build-engine.mjs' : 'carve.mjs'),
        '--source', join(root, 'upstream')], { encoding: 'utf8', env: { ...process.env, JAVA_HOME: root } });
      expect(result.status, result.stderr).toBe(phase === 'success' ? 0 : 1);
      if (phase === 'success') expect(fs.readFileSync(target)).toEqual(bytes);
      else if (kind === 'first') expect(fs.existsSync(target)).toBe(false);
      else expect(fs.readFileSync(target, 'utf8')).toBe('old complete bytes');
      expect(fs.readdirSync(dirname(target)).filter(name => name.endsWith('.tmp') || name.startsWith(target.split(/[/\\]/).at(-1) + '.'))).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
