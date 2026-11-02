// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { backUpUnreadableStore, canBackUpUnreadableStore, unreadableBackupKey } from './storeBackup.js';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('keeps raw Unicode recovery copies without requiring a decoder', () => {
  const raw = '{broken\u0000\ud800\u00e9\ud83d\ude80' + 'x'.repeat(10000);
  expect(backUpUnreadableStore('k', raw)).toBe(true);
  expect(localStorage.getItem(unreadableBackupKey('k'))).toBe(raw);
  expect(backUpUnreadableStore('k', raw)).toBe(true);
  expect(localStorage.length).toBe(1);
});

it('copies the unreadable value to the side key, verbatim, once', () => {
  expect(unreadableBackupKey('k')).toBe('k.unreadable-backup');
  expect(backUpUnreadableStore('k', '{broken')).toBe(true);
  expect(localStorage.getItem('k.unreadable-backup')).toBe('{broken');
  expect(backUpUnreadableStore('k', '{broken')).toBe(true);
});

it('keeps three distinct corruptions, including the legacy slot, without overwriting any', () => {
  localStorage.setItem('k.unreadable-backup', 'older');
  expect(canBackUpUnreadableStore('k', '{broken')).toBe(true);
  expect(backUpUnreadableStore('k', '{broken')).toBe(true);
  expect(backUpUnreadableStore('k', 'third')).toBe(true);
  expect(backUpUnreadableStore('k', 'fourth')).toBe(false);
  expect(canBackUpUnreadableStore('k', 'fourth')).toBe(false);
  expect(backUpUnreadableStore('k', '{broken')).toBe(true);
  expect(localStorage.getItem('k.unreadable-backup')).toBe('older');
  expect(localStorage.getItem('k.unreadable-backup.2')).toBe('{broken');
  expect(localStorage.getItem('k.unreadable-backup.3')).toBe('third');
  expect(localStorage.length).toBe(3);
});

it('says false when storage refuses the copy', () => {
  const own = localStorage.setItem;
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: () => { throw new DOMException('Quota', 'QuotaExceededError'); } });
  try {
    expect(backUpUnreadableStore('k', '{broken')).toBe(false);
  } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: own }); }
});
