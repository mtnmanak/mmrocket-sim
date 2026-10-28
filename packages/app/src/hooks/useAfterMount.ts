import { useEffect, useState } from 'react';

/**
 * False on a component's first render, true from the commit after it mounts.
 *
 * For a live region whose message can already be due on that first render:
 * gated on this, the region mounts EMPTY and the message is inserted in a
 * later commit, so a screen reader hears it as a change rather than meeting a
 * region that arrived with its text already in place, which is announced
 * unreliably (audit 2026-09-22; owner ruling, row 113 (b)). Gate the display
 * only, never the state behind it.
 */
export function useAfterMount(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted;
}
