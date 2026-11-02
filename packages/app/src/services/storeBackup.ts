/**
 * A COPY OF A STORE THE APP CANNOT READ (cloud session 20). My parts, My
 * materials and the EX motor library read a stored value that does not parse,
 * or is not a list, as empty. Writing over it lost whatever it held, and
 * refusing to write left the user nothing in the app that could recover. So a
 * write first copies the value to this side key, verbatim, and then starts a
 * new list. Copies are kept for recovery by hand, never restored as live rows.
 */
export const unreadableBackupKey = (key: string): string => `${key}.unreadable-backup`;
const BACKUP_SLOTS = 3;
const backupKeys = (key: string) => Array.from({ length: BACKUP_SLOTS }, (_, i) => unreadableBackupKey(key) + (i ? `.${i + 1}` : ''));

function backupSlot(key: string, raw: string): { key: string; same: boolean } | undefined {
  let free: string | undefined;
  for (const side of backupKeys(key)) {
    const held = localStorage.getItem(side);
    if (held === raw) return { key: side, same: true };
    if (held === null) free ??= side;
  }
  return free === undefined ? undefined : { key: free, same: false };
}

export function canBackUpUnreadableStore(key: string, raw: string): boolean {
  try { return backupSlot(key, raw) !== undefined; }
  catch { return false; }
}

/** Three verbatim recovery copies per store; never overwrite an older copy. */
export function backUpUnreadableStore(key: string, raw: string): boolean {
  try {
    const slot = backupSlot(key, raw);
    if (!slot) return false;
    if (!slot.same) localStorage.setItem(slot.key, raw);
    return true;
  } catch { return false; }
}
