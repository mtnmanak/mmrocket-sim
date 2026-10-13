// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { importMotorFiles } from './importMotorFiles.js';
import { sessionDebugLog } from './sessionDebugLog.js';

afterEach(() => localStorage.clear());

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
