// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { backUpUnreadableStore, unreadableBackupKey } from './storeBackup.js';

afterEach(() => { localStorage.clear(); });

it('copies the unreadable value to the side key, verbatim, once', () => {
  expect(unreadableBackupKey('k')).toBe('k.unreadable-backup');
  expect(backUpUnreadableStore('k', '{broken')).toBe(true);
  expect(localStorage.getItem('k.unreadable-backup')).toBe('{broken');
  expect(backUpUnreadableStore('k', '{broken')).toBe(true);
});

it('never overwrites an earlier, different copy', () => {
  localStorage.setItem('k.unreadable-backup', 'older');
  expect(backUpUnreadableStore('k', '{broken')).toBe(false);
  expect(localStorage.getItem('k.unreadable-backup')).toBe('older');
});

it('says false when storage refuses the copy', () => {
  const own = localStorage.setItem;
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new DOMException('Quota', 'QuotaExceededError'); } });
  try {
    expect(backUpUnreadableStore('k', '{broken')).toBe(false);
  } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: own }); }
});
