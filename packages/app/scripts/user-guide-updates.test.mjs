import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('V211-1 explains held-tab download failures and the save-first reload limit', () => {
  const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
  const updates = guide.split('### Updates\n')[1].split('\n### ')[0];
  expect(updates).toContain('keeps running its older version');
  expect(updates).toContain('may then fail to download');
  expect(updates).toContain('button respects the same hold');
  expect(updates).toContain('save this tab\'s design as an .ork file first');
  expect(updates).toContain('lose this tab\'s work');
  expect(updates).toContain('replacement offer');
  expect(updates).toContain('autosave could not store');
  expect(updates.indexOf('When a new version ships')).toBeLessThan(updates.indexOf('Automatic reloads also wait'));
  expect(updates).toContain('Reload anyway');
  expect(updates).toContain('does not clear');
});
