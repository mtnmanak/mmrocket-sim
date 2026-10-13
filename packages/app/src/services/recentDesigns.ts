/** C-A2: file copies, never paths or reconstructed imports; shared across this site's tabs. */
export const MAX_RECENT_DESIGNS = 8;
export const MAX_RECENT_BYTES = 32 * 1024 * 1024;
export const MAX_RECENT_FILE_BYTES = 8 * 1024 * 1024;
const DB_NAME = 'online-openrocket.recent-designs.v1';
const STORE = 'files';

interface RecentDesignRecord { name: string; openedAt: number; bytes: ArrayBuffer }
export interface RecentDesign { name: string; openedAt: number; size: number }

function validRecord(value: unknown): value is RecentDesignRecord {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<RecentDesignRecord>;
  return typeof e.name === 'string' && e.name.length > 0 && e.name.length <= 1024
    && typeof e.openedAt === 'number'
    && Number.isSafeInteger(e.openedAt) && e.openedAt >= 0 && e.openedAt <= 8.64e15 && e.bytes instanceof ArrayBuffer
    && e.bytes.byteLength <= MAX_RECENT_FILE_BYTES;
}

/** Also validates old/corrupt records before display or writes. Version 1 has no older schema to migrate. */
export function boundedRecentDesigns(values: readonly unknown[]): RecentDesignRecord[] {
  const rows = values.filter(validRecord).sort((a, b) => b.openedAt - a.openedAt
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set<string>();
  let bytes = 0;
  return rows.filter(e => {
    if (seen.has(e.name) || seen.size >= MAX_RECENT_DESIGNS || bytes + e.bytes.byteLength > MAX_RECENT_BYTES) return false;
    seen.add(e.name);
    bytes += e.bytes.byteLength;
    return true;
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Browser storage is unavailable.')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'name' });
    };
    request.onerror = () => reject(request.error ?? new Error('Browser storage could not be opened.'));
    request.onblocked = () => { blocked = true; reject(new Error('Another tab is blocking browser storage. Close it and try again.')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
  });
}

async function transaction<T>(mode: IDBTransactionMode,
  work: (store: IDBObjectStore, done: (result: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    let result: T;
    let tx: IDBTransaction | undefined;
    try {
      tx = db.transaction(STORE, mode);
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(tx?.error ?? new Error('Browser storage could not be updated.')); };
      work(tx.objectStore(STORE), value => { result = value; });
    } catch (error) { tx?.abort(); db.close(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

export async function listRecentDesigns(): Promise<RecentDesign[]> {
  return transaction('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(boundedRecentDesigns(request.result).map(e => ({
      name: e.name, openedAt: e.openedAt, size: e.bytes.byteLength,
    })));
  });
}

/** Returns a separate file so the existing file door owns parsing, notes and unsaved-work handling. */
export async function recentDesignFile(name: string): Promise<File | null> {
  return transaction('readonly', (store, done) => {
    const request = store.get(name);
    request.onsuccess = () => done(validRecord(request.result)
      ? new File([request.result.bytes], request.result.name) : null);
  });
}

/** Errors here must never undo a successful file open/save or replace its import notes. */
export async function rememberRecentDesign(name: string, bytes: ArrayBuffer): Promise<string | null> {
  if (bytes.byteLength > MAX_RECENT_FILE_BYTES) return 'This file is over 8 MiB, so the app did not keep a copy in Recent.';
  if (!validRecord({ name, bytes, openedAt: 0 })) return 'The app could not keep this filename in Recent. Save a file to keep this design.';
  try {
    await transaction<void>('readwrite', (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const previous = boundedRecentDesigns(request.result);
          const entry = { name, bytes, openedAt: Math.max(Date.now(), (previous[0]?.openedAt ?? 0) + 1) };
          const next = boundedRecentDesigns([entry, ...previous.filter(e => e.name !== name)]);
          // C-A2: one read/write transaction serializes tabs, including Clear recent.
          store.clear();
          next.forEach(e => store.put(e));
          done(undefined);
        } catch { store.transaction.abort(); }
      };
    });
    return null;
  } catch {
    return 'The app could not keep a copy in Recent. Save a file to keep this design.';
  }
}

export async function clearRecentDesigns(): Promise<void> {
  await transaction<void>('readwrite', (store, done) => { store.clear(); done(undefined); });
}
