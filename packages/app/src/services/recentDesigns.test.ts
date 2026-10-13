// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDesignFile } from './designFile.js';
import { boundedRecentDesigns, clearRecentDesigns, listRecentDesigns, rememberRecentDesign,
  recentDesignFile, MAX_RECENT_DESIGNS, MAX_RECENT_BYTES, MAX_RECENT_FILE_BYTES } from './recentDesigns.js';

const entry = (name: string, openedAt: number, size = 1) => ({ name, openedAt, bytes: new ArrayBuffer(size) });
afterEach(() => vi.unstubAllGlobals());

/** A transactional IDB test double: queued transactions, structured clones and rollback on abort.
 * Native browser rendering/storage checks are a separate integration gate. */
function storageDouble() {
  const rows = new Map<string, unknown>();
  let queue = Promise.resolve();
  let failPut = false;
  let closed = 0;
  let storeExists = false;
  const createStore = vi.fn(() => { storeExists = true; });
  const factory = { open: () => {
    const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void;
      onupgradeneeded?: () => void } = {};
    const db = {
      objectStoreNames: { contains: () => storeExists },
      createObjectStore: createStore,
      close: () => { closed++; },
      transaction: (_name: string, mode: string) => {
        let pending = 0;
        let started = false;
        let aborted = false;
        let finished = false;
        let local = new Map<string, unknown>();
        let release: () => void = () => {};
        const ready = queue;
        queue = new Promise<void>(resolve => { release = resolve; });
        const tx: { oncomplete?: () => void; onabort?: () => void; error?: Error;
          abort: () => void; objectStore: () => unknown } = {
          abort: () => {
            if (aborted) return;
            aborted = true; queueMicrotask(() => { tx.onabort?.(); release(); });
          },
          objectStore: () => store,
        };
        const complete = () => {
          if (!started || pending || aborted || finished) return;
          finished = true;
          if (mode === 'readwrite') { rows.clear(); for (const [key, value] of local) rows.set(key, value); }
          tx.oncomplete?.(); release();
        };
        const operation = <T>(get: () => T) => {
          pending++;
          const op: { result?: T; onsuccess?: () => void } = {};
          void ready.then(() => {
            if (aborted) return;
            if (!started) { started = true; local = new Map(rows); }
            try { op.result = get(); op.onsuccess?.(); }
            catch (e) { tx.error = e instanceof Error ? e : new Error(String(e)); tx.abort(); }
            pending--; queueMicrotask(complete);
          });
          return op;
        };
        const store = {
          transaction: tx,
          getAll: () => operation(() => structuredClone([...local.values()])),
          get: (key: string) => operation(() => structuredClone(local.get(key))),
          clear: () => operation(() => { local.clear(); }),
          put: (value: { name: string }) => operation(() => {
            if (failPut) { failPut = false; throw new Error('QuotaExceededError'); }
            local.set(value.name, structuredClone(value));
          }),
        };
        return tx;
      },
    };
    queueMicrotask(() => {
      request.result = db;
      if (!storeExists) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } };
  vi.stubGlobal('indexedDB', factory);
  return { rows, createStore, failNextPut: () => { failPut = true; }, closed: () => closed };
}

describe('C-A2 recent storage transactions', () => {
  it.each(['reference.zip', 'reference'])('retains and reopens a successfully imported %s with its original bytes and name', async name => {
    storageDouble();
    const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'reference.ork'));
    const bytes = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength) as ArrayBuffer;
    const opened = await openDesignFile(bytes, name, { presets: [] });
    expect(opened.sourceFormat).toBe('ork');
    expect(opened.tree.components).toHaveLength(1);

    expect(await rememberRecentDesign(name, bytes)).toBeNull();
    expect(await listRecentDesigns()).toEqual([{ name, openedAt: expect.any(Number), size: bytes.byteLength }]);
    const file = await recentDesignFile(name);
    expect(file?.name).toBe(name);
    const retained = await file!.arrayBuffer();
    expect(new Uint8Array(retained)).toEqual(new Uint8Array(bytes));
    const reopened = await openDesignFile(retained, file!.name, { presets: [] });
    expect(reopened.sourceFormat).toBe('ork');
    expect(reopened.name).toBe(opened.name);
    expect(reopened.notes).toEqual(opened.notes);
    // Re-importing mints component ids, including ignition-default keys; retain their values.
    const treeValues = (tree: typeof opened.tree) => JSON.parse(JSON.stringify(tree,
      (key, value: unknown) => key === 'ignitionDefaults' ? Object.values(value as object)
        : key === 'id' ? undefined : value));
    expect(treeValues(reopened.tree)).toEqual(treeValues(opened.tree));
  });
  it('stores exact bytes across reload-like reads and closes every connection', async () => {
    const storage = storageDouble();
    const bytes = new TextEncoder().encode('original café <&>\nbytes').buffer;
    expect(await rememberRecentDesign('same.ork', bytes)).toBeNull();
    expect(await listRecentDesigns()).toEqual([{ name: 'same.ork', openedAt: expect.any(Number), size: bytes.byteLength }]);
    const file = await recentDesignFile('same.ork');
    expect(file?.name).toBe('same.ork');
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect(storage.closed()).toBe(3);
    expect(storage.createStore).toHaveBeenCalledExactlyOnceWith('files', { keyPath: 'name' });
  });
  it('serializes simultaneous writers, same-name replacement and Clear from different connections', async () => {
    storageDouble();
    await Promise.all(Array.from({ length: 12 }, (_, i) => rememberRecentDesign(`${i}.ork`, new ArrayBuffer(i + 1))));
    expect((await listRecentDesigns()).map(e => e.name)).toEqual(['11.ork', '10.ork', '9.ork', '8.ork', '7.ork', '6.ork', '5.ork', '4.ork']);
    await rememberRecentDesign('11.ork', new ArrayBuffer(2));
    expect((await listRecentDesigns())[0]!.size).toBe(2);
    await Promise.all([clearRecentDesigns(), rememberRecentDesign('after.ork', new ArrayBuffer(1))]);
    expect((await listRecentDesigns()).map(e => e.name)).toEqual(['after.ork']);
    await clearRecentDesigns();
    expect(await recentDesignFile('after.ork')).toBeNull();
  });
  it('rolls back quota-failed writes, leaving earlier copies available', async () => {
    const storage = storageDouble();
    await rememberRecentDesign('old.ork', new ArrayBuffer(1));
    storage.failNextPut();
    expect(await rememberRecentDesign('new.ork', new ArrayBuffer(1))).toContain('could not keep');
    expect((await listRecentDesigns()).map(e => e.name)).toEqual(['old.ork']);
  });
  it('skips corrupt stored values and repairs the store on the next successful write', async () => {
    const storage = storageDouble();
    storage.rows.set('invalid.ork', { name: 'invalid.ork', bytes: 'bad', openedAt: 1 });
    expect(await listRecentDesigns()).toEqual([]);
    expect(await recentDesignFile('invalid.ork')).toBeNull();
    await rememberRecentDesign('good.ork', new ArrayBuffer(1));
    expect(storage.rows.has('invalid.ork')).toBe(false);
  });

  it('reports a blocked upgrade and closes a connection that eventually opens after the rejection', async () => {
    const close = vi.fn();
    const request: { result: unknown; onblocked?: () => void; onsuccess?: () => void } = { result: { close } };
    vi.stubGlobal('indexedDB', { open: () => {
      queueMicrotask(() => { request.onblocked?.(); request.onsuccess?.(); });
      return request;
    } });
    await expect(listRecentDesigns()).rejects.toThrow('Another tab');
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('C-A2 recent file retention', () => {
  it('keeps the newest eight, replaces the same filename, and orders equal-time entries deterministically', () => {
    const rows = Array.from({ length: 12 }, (_, i) => entry(`${i}.ork`, i));
    const kept = boundedRecentDesigns(rows);
    expect(kept).toHaveLength(MAX_RECENT_DESIGNS);
    expect(kept.map(e => e.name)).toEqual(['11.ork', '10.ork', '9.ork', '8.ork', '7.ork', '6.ork', '5.ork', '4.ork']);
    expect(boundedRecentDesigns([entry('same.ork', 1), entry('same.ork', 2)])[0]!.openedAt).toBe(2);
    expect(boundedRecentDesigns([entry('b.ork', 1), entry('a.ork', 1)]).map(e => e.name)).toEqual(['a.ork', 'b.ork']);
  });
  it('caps bytes as well as entries and never retains a file above its individual limit', () => {
    const rows = Array.from({ length: 8 }, (_, i) => entry(`${i}.ork`, i, MAX_RECENT_FILE_BYTES));
    const kept = boundedRecentDesigns(rows);
    expect(kept.reduce((n, e) => n + e.bytes.byteLength, 0)).toBeLessThanOrEqual(MAX_RECENT_BYTES);
    expect(kept.length).toBe(MAX_RECENT_BYTES / MAX_RECENT_FILE_BYTES);
    expect(boundedRecentDesigns([entry('big.ork', 1, MAX_RECENT_FILE_BYTES + 1)])).toEqual([]);
  });
  it('validates stored records without coercion and ignores malformed records', () => {
    expect(boundedRecentDesigns([null, {}, entry('ok.CDX1', 3), entry('ok.rkt', 2),
      { ...entry('bad.ork', 2), openedAt: '2' }, entry('', 2), entry('a'.repeat(1025), 2),
      { ...entry('bad.ork', 2), name: 1 }, entry('bad.ork', -1), entry('bad.ork', 8.64e15 + 1),
      entry('bad.ork', 1.5),
      { ...entry('bad.ork', 2), bytes: [1, 2] },
      { ...entry('fake.ork', 2), bytes: { byteLength: 1 } }, entry('bad.ork', NaN)]).map(e => e.name))
      .toEqual(['ok.CDX1', 'ok.rkt']);
  });
  it('retains structurally valid snapshots regardless of filename extension', () => {
    expect(boundedRecentDesigns([entry('reference.zip', 3), entry('reference', 2), entry('reference.txt', 1)])
      .map(e => e.name)).toEqual(['reference.zip', 'reference', 'reference.txt']);
  });
  it.each([['empty', ''], ['overlong', 'a'.repeat(1025)]])('refuses an %s filename before opening storage', async (_label, name) => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await rememberRecentDesign(name, new ArrayBuffer(1))).toContain('filename');
  });
  it('reports unavailable storage without rejecting an otherwise successful open or save', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const result = await rememberRecentDesign('ok.ork', new ArrayBuffer(1));
    expect(result).toMatch(/could not keep.*Recent/i);
    await expect(listRecentDesigns()).rejects.toThrow();
    await expect(clearRecentDesigns()).rejects.toThrow();
    await expect(recentDesignFile('missing.ork')).rejects.toThrow();
  });
  it('skips an oversized copy with an explicit reason before opening storage', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await rememberRecentDesign('big.ork', new ArrayBuffer(MAX_RECENT_FILE_BYTES + 1)))
      .toMatch(/8 MiB/);
  });
});
