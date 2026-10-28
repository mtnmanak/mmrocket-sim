/**
 * A COPY OF A STORE THE APP CANNOT READ (cloud session 20). My parts, My
 * materials and the EX motor library read a stored value that does not parse,
 * or is not a list, as empty. Writing over it lost whatever it held, and
 * refusing to write left the user nothing in the app that could recover. So a
 * write first copies the value to this side key, verbatim, and then starts a
 * new list. The app never reads the copy back; it is kept for recovery by hand.
 */
export const unreadableBackupKey = (key: string): string => `${key}.unreadable-backup`;

/** Whether the side key is free or already holds this copy; never writes. */
export function canBackUpUnreadableStore(key: string, raw: string): boolean {
  try {
    const held = localStorage.getItem(unreadableBackupKey(key));
    return held === null || held === raw;
  } catch {
    return false;
  }
}

/**
 * Copy `raw`, the unreadable value stored under `key`, to its side key. True
 * when the side key then holds exactly these bytes, so a write may replace
 * the store. One copy per store, never overwritten: a different copy already
 * there is the earlier unreadable value, the one more likely to hold the
 * user's data, so this returns false and the caller refuses the write as
 * before. False too when storage refuses the copy.
 */
export function backUpUnreadableStore(key: string, raw: string): boolean {
  const side = unreadableBackupKey(key);
  try {
    const held = localStorage.getItem(side);
    if (held === raw) return true;
    if (held !== null) return false;
    localStorage.setItem(side, raw);
    return true;
  } catch {
    return false;
  }
}
