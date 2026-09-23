// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';

/**
 * ONE AUTOSAVE SLOT, TWO TABS (audit 2026-09-22).
 *
 * Every tab writes the same localStorage key, and the last to write used to
 * win: tab B's hour of unsaved work was replaced by one Launch in tab A. Each
 * tab is its own copy of session.ts's module state over one shared storage,
 * so a "tab" here is a fresh import of the module (vi.resetModules) over the
 * one happy-dom localStorage.
 */

type SessionModule = typeof import('./session.js');
const KEY = 'online-openrocket.session.v1';

async function openTab(): Promise<SessionModule> {
  vi.resetModules();
  const tab = await import('./session.js');
  tab.loadSession(); // every App mount reads the slot first
  return tab;
}

const state = (name: string) => ({
  tree: { name, components: [] } as unknown as RocketTree,
  launch: { windAverage: 2 } as unknown as LaunchConditions,
});

function save(tab: SessionModule, name: string): void {
  tab.saveSessionDebounced(state(name));
  vi.runAllTimers();
}

const stored = () => (JSON.parse(localStorage.getItem(KEY)!) as { tree: { name: string } }).tree.name;

/** Every tab's `storage` listener, removed after each test (they share the one window). */
let unwatch: (() => void)[] = [];

/** A tab with its other-tab watcher installed, as the app root installs it. */
async function openWatchedTab(): Promise<SessionModule> {
  const tab = await openTab();
  unwatch.push(tab.watchOtherTabs());
  return tab;
}

/**
 * What a browser does after a write: tell the OTHER tabs. happy-dom does not
 * fire `storage` at all, so the test fires it — at every tab, the writer
 * included, which a browser never does; the writer must shrug it off.
 */
function tellOtherTabs(): void {
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: localStorage.getItem(KEY) }));
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const off of unwatch) off();
  unwatch = [];
  vi.useRealTimers();
  localStorage.clear();
});

describe('a single tab never trips the guard', () => {
  it('saves, reloads and saves again, a hundred times over', async () => {
    let tab = await openTab();
    const seen: boolean[] = [];
    tab.onSessionConflictChange((c) => seen.push(c));
    for (let i = 0; i < 100; i++) save(tab, `edit ${i}`);
    expect(stored()).toBe('edit 99');
    tab.flushSession();
    tab = await openTab(); // a reload
    save(tab, 'after reload');
    expect(stored()).toBe('after reload');
    expect(tab.sessionConflicted()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('a session written before stamps is overwritten without complaint', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...state('legacy'), savedAt: 1 }));
    const tab = await openTab();
    save(tab, 'upgraded');
    expect(stored()).toBe('upgraded');
    expect(tab.sessionConflicted()).toBe(false);
  });

  it('an emptied slot is simply written', async () => {
    const tab = await openTab();
    save(tab, 'one');
    localStorage.removeItem(KEY);
    save(tab, 'two');
    expect(stored()).toBe('two');
    expect(tab.sessionConflicted()).toBe(false);
  });
});

describe('two tabs', () => {
  it('the tab that is behind does not overwrite the other\'s work — it raises a conflict', async () => {
    const a = await openTab();
    const b = await openTab();
    save(b, 'B: an hour of work');
    // Tab A, which has not seen B's write, launches and re-writes its session.
    save(a, 'A: one launch');
    expect(stored()).toBe('B: an hour of work');
    expect(a.sessionConflicted()).toBe(true);
    // B carries on untroubled: the slot still holds its own last write.
    save(b, 'B: more work');
    expect(stored()).toBe('B: more work');
    expect(b.sessionConflicted()).toBe(false);
    // And A keeps holding back, however many times it tries.
    save(a, 'A: another edit');
    a.flushSession(); // the pagehide flush too
    expect(stored()).toBe('B: more work');
  });

  it('"Keep this tab\'s design" writes the held state, and the other tab is told in turn', async () => {
    const a = await openTab();
    const b = await openTab();
    save(b, 'B');
    save(a, 'A held');
    expect(a.sessionConflicted()).toBe(true);
    a.takeOverSession();
    expect(stored()).toBe('A held');
    expect(a.sessionConflicted()).toBe(false);
    save(b, 'B again');
    expect(stored()).toBe('A held');
    expect(b.sessionConflicted()).toBe(true);
  });

  it('a second tab re-writing the SAME design on mount is not a conflict', async () => {
    const a = await openTab();
    save(a, 'shared');
    const b = await openTab();
    save(b, 'shared'); // B's mount-time autosave: identical content, new timestamp
    save(a, 'A edits on');
    expect(stored()).toBe('A edits on');
    expect(a.sessionConflicted()).toBe(false);
  });

  it('an older build\'s tab writing an unstamped session is a conflict too', async () => {
    const a = await openTab();
    save(a, 'A');
    localStorage.setItem(KEY, JSON.stringify({ ...state('old build tab'), savedAt: 2 }));
    save(a, 'A again');
    expect(stored()).toBe('old build tab');
    expect(a.sessionConflicted()).toBe(true);
  });

  it('a reload adopts what is in the slot — the "Load the other tab\'s design" path', async () => {
    const a = await openTab();
    const b = await openTab();
    save(b, 'B');
    save(a, 'A');
    expect(a.sessionConflicted()).toBe(true);
    const reloaded = await openTab();
    expect(reloaded.loadSession()!.tree.name).toBe('B');
    save(reloaded, 'A, now on B\'s design');
    expect(stored()).toBe('A, now on B\'s design');
    expect(reloaded.sessionConflicted()).toBe(false);
  });
});

describe('an idle tab hears that "Keep this tab\'s design" replaced its work (from review)', () => {
  it('raises the conflict there, holding its own design, so its close is guarded too', async () => {
    const a = await openWatchedTab();
    const b = await openWatchedTab();
    save(b, 'B: an hour of work');
    tellOtherTabs();
    save(a, 'A behind');
    expect(a.sessionConflicted()).toBe(true);
    // B is idle from here on: nothing pending, and it will never write again.
    a.takeOverSession();
    tellOtherTabs();
    expect(stored()).toBe('A behind');
    expect(a.sessionConflicted()).toBe(false);
    expect(b.sessionConflicted()).toBe(true);
    expect(b.heldSession()?.tree.name).toBe('B: an hour of work');
    // Its pagehide flush holds back too — and the conflict stands, which is
    // what arms App's leave-page prompt.
    b.flushSession();
    expect(stored()).toBe('A behind');
    expect(b.sessionConflicted()).toBe(true);
    // And its own "Keep" puts its hour of work back, telling A in turn.
    b.takeOverSession();
    tellOtherTabs();
    expect(stored()).toBe('B: an hour of work');
    expect(a.sessionConflicted()).toBe(true);
    expect(a.heldSession()?.tree.name).toBe('A behind');
  });

  it('an ordinary write does not — the tab it replaces is only stale, and its close is not stopped', async () => {
    const b = await openWatchedTab();
    save(b, 'B');
    const c = await openWatchedTab(); // opens B's design…
    save(c, 'B, then edited in C'); // …and carries on from it
    tellOtherTabs();
    expect(b.sessionConflicted()).toBe(false);
    expect(c.sessionConflicted()).toBe(false);
  });

  it('a single tab never hears itself: a takeover leaves the writer clear', async () => {
    const a = await openWatchedTab();
    save(a, 'A');
    localStorage.setItem(KEY, JSON.stringify({ ...state('another build\'s tab'), savedAt: 3 }));
    save(a, 'A, held');
    a.takeOverSession();
    tellOtherTabs(); // reaches A too here, which no browser does
    expect(a.sessionConflicted()).toBe(false);
    expect(stored()).toBe('A, held');
  });

  it('`over` rides outside the stamp — the same design is the same stamp however it was written', async () => {
    const a = await openWatchedTab();
    const b = await openWatchedTab();
    save(b, 'B');
    save(a, 'shared design');
    a.takeOverSession();
    const taken = JSON.parse(localStorage.getItem(KEY)!) as { stamp: string; over?: string };
    expect(taken.over).toBeTruthy();
    const c = await openWatchedTab();
    save(c, 'shared design'); // the same design, an ordinary write
    const plain = JSON.parse(localStorage.getItem(KEY)!) as { stamp: string; over?: string };
    expect(plain.over).toBeUndefined();
    expect(plain.stamp).toBe(taken.stamp);
  });
});

describe('"Start fresh" leaves another tab\'s autosave alone (from review)', () => {
  it('during a conflict it drops this tab\'s held write and keeps the slot', async () => {
    const d = await openTab();
    const c = await openTab();
    save(d, 'D: work');
    save(c, 'C behind');
    expect(c.sessionConflicted()).toBe(true);
    expect(c.autosaveIsAnotherTabs()).toBe(true);
    c.discardSession();
    expect(stored()).toBe('D: work');
    expect(c.sessionConflicted()).toBe(false);
    expect(c.heldSession()).toBeNull();
  });

  it('and when another tab wrote since, even with no conflict raised yet', async () => {
    const c = await openTab();
    save(c, 'C');
    const d = await openTab();
    save(d, 'D, carried on from C');
    expect(c.sessionConflicted()).toBe(false);
    expect(c.autosaveIsAnotherTabs()).toBe(true);
    // The crash panel's download reads the slot — without making it C's own.
    expect(c.peekSession()?.tree.name).toBe('D, carried on from C');
    expect(c.autosaveIsAnotherTabs()).toBe(true);
    c.discardSession();
    expect(stored()).toBe('D, carried on from C');
  });

  it('its own autosave it still deletes, with the write still in the debounce', async () => {
    const c = await openTab();
    save(c, 'C');
    expect(c.autosaveIsAnotherTabs()).toBe(false);
    c.saveSessionDebounced(state('C, last keystroke'));
    c.discardSession();
    vi.runAllTimers();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
