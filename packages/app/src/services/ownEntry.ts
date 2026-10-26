/** User/restored identifiers may also name an Object.prototype property. */
export function ownEntry<T>(entries: Readonly<Record<string, T>> | undefined, id: string): T | undefined {
  return entries && Object.hasOwn(entries, id) ? entries[id] : undefined;
}
