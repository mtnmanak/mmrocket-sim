import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const python = process.env.PYTHON ?? 'python';
const available = spawnSync(python, ['-c', 'pass']).status === 0;
it.skipIf(!available)('preserves Python artifact modes and uses the umask for new files', () => {
  const script = `import os, stat, sys, tempfile
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from atomic_write import atomic_write
with tempfile.TemporaryDirectory() as root:
    path = os.path.join(root, 'reference.json')
    # Check call order and mode propagation even on Windows.
    replace = os.replace
    chmod = os.chmod
    original_stat = os.stat
    calls = []
    def record_chmod(target, mode):
        calls.append(mode)
        chmod(target, mode)
    def record_replace(source, target):
        assert calls == [0o640], calls
        replace(source, target)
    def target_stat(target, *args, **kwargs):
        if target == path: return type('Info', (), {'st_mode': 0o100640})()
        return original_stat(target, *args, **kwargs)
    atomic_write(path, 'old')
    with patch('atomic_write.os.stat', side_effect=target_stat), patch('atomic_write.os.chmod', side_effect=record_chmod), patch('atomic_write.os.replace', side_effect=record_replace):
        atomic_write(path, 'new')
    if os.name != 'nt':
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o640
        os.unlink(path)
        previous = os.umask(0o027)
        try:
            atomic_write(path, 'new')
            assert stat.S_IMODE(os.stat(path).st_mode) == 0o640
            assert os.umask(0o027) == 0o027
        finally: os.umask(previous)
`;
  const result = spawnSync(python, ['-c', script, fileURLToPath(new URL('.', import.meta.url))], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

it.skipIf(!available)('preserves Python reference output after replacement failure', () => {
  const script = `import os, sys, tempfile
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from atomic_write import atomic_write
with tempfile.TemporaryDirectory() as root:
    path = os.path.join(root, 'reference.json')
    atomic_write(path, 'old')
    with patch('atomic_write.os.replace', side_effect=OSError('replacement refused')):
        try: atomic_write(path, 'new')
        except OSError: pass
        else: raise AssertionError('expected failure')
    assert open(path).read() == 'old'
    assert os.listdir(root) == ['reference.json']
    atomic_write(path, 'new')
    assert open(path).read() == 'new'
`;
  const result = spawnSync(python, ['-c', script, fileURLToPath(new URL('.', import.meta.url))], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});
