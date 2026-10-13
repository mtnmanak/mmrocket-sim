// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { importMotorFiles } from './importMotorFiles.js';
import { sessionDebugLog } from './sessionDebugLog.js';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it.each(['QuotaExceededError', 'SecurityError'])('C-H3 records %s motor storage refusal separately from session import', async name => {
  vi.resetModules();
  const { importMotorFiles: read } = await import('./importMotorFiles.js');
  const { sessionDebugLog: log } = await import('./sessionDebugLog.js');
  const storage = localStorage;
  vi.stubGlobal('localStorage', {
    get length() { return storage.length; },
    key: (index: number) => storage.key(index),
    getItem: (key: string) => storage.getItem(key),
    removeItem: (key: string) => storage.removeItem(key),
    clear: () => storage.clear(),
    setItem: () => { throw new DOMException('Private storage 61.234 Fairbanks', name); },
  });
  const out = await read([new File(['Private 18 70 P 0.01 0.02 PrivateMaker\n0 0\n0.5 20\n1 0'], 'Private-session.eng')]);
  expect(out.parsed).toHaveLength(1);
  expect(out.write?.stored).toBe(false);
  expect(out.error).toContain('NOT saved');
  const text = log.text();
  expect(text).toContain('import-complete');
  expect(text).toContain('import-storage-failed: Motor storage is full or blocked; imported motors are available only for this session.');
  expect(text).not.toContain('import-failed:');
  for (const secret of ['Private', '61.234', 'Fairbanks']) expect(text).not.toContain(secret);
});

it('C-H3 does not record a storage failure when the motor-library write succeeds', async () => {
  vi.resetModules();
  const { importMotorFiles: read } = await import('./importMotorFiles.js');
  const { sessionDebugLog: log } = await import('./sessionDebugLog.js');
  const out = await read([new File(['Private 18 70 P 0.01 0.02 PrivateMaker\n0 0\n0.5 20\n1 0'], 'Private-session.eng')]);
  expect(out.write?.stored).toBe(true);
  expect(log.text()).toContain('import-complete');
  expect(log.text()).not.toContain('import-storage-failed');
  expect(log.text()).not.toContain('Private');
});

it('C-H3 captures a failed motor import without the file name or its content', async () => {
  const before = sessionDebugLog.text();
  const out = await importMotorFiles([new File(['not a motor: Secret weather place 61.234'], 'Secret-session.eng')]);
  expect(out.error).toContain('Secret-session.eng');
  const after = sessionDebugLog.text();
  expect(after).not.toBe(before);
  expect(after).toContain('import-failed');
  expect(after).not.toContain('Secret');
  expect(after).not.toContain('61.234');
});
