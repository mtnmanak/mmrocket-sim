import { useCallback, useEffect, useState } from 'react';

/**
 * THE WORKSPACE TAB (Fly / Design / Motors & Configuration / Results), persisted so a
 * reload lands the user back where they were working — and, with nothing
 * persisted, the device's home screen.
 *
 * Extracted from App.tsx in the 2026-09-22 audit (row 501 — the UI hooks of
 * extraction #8, 8 September), where statsDrawerDefault.test.ts held the phone
 * breakpoint as a regex over App's text; useWorkspaceTab.test.tsx renders it.
 */

export type WorkspaceTab = 'fly' | 'design' | 'motors' | 'results';

/** Where the tab remembers itself (AppBoundary clears it with the autosave). */
export const WORKSPACE_KEY = 'online-openrocket.workspace.v1';

/**
 * The PHONE rule: tab default and drawer chrome. Deliberately NOT the hero
 * canvas's 981px (hooks/useHeroDrawer.ts) — the two must stay distinct, or a
 * phone inherits the desktop drawer.
 */
export const PHONE_QUERY = '(max-width: 767px)';

/**
 * The device's home screen. Fly (S4, batch 08-21c) is the phone home:
 * launch-centered, first and default below the phone breakpoint; its tab
 * button is CSS-hidden on desktop, where Design is home.
 */
export function homeTab(): WorkspaceTab {
  return typeof matchMedia !== 'undefined' && matchMedia(PHONE_QUERY).matches ? 'fly' : 'design';
}

const isTab = (t: unknown): t is WorkspaceTab =>
  t === 'fly' || t === 'motors' || t === 'results' || t === 'design';

export function useWorkspaceTab(): [WorkspaceTab, (t: WorkspaceTab) => void] {
  const [view, setView] = useState<{ tab: WorkspaceTab; automatic: boolean }>(() => {
    const home = homeTab();
    let chosen = home;
    try {
      const t = localStorage.getItem(WORKSPACE_KEY);
      if (isTab(t)) chosen = t;
    } catch { /* fall through */ }
    const automatic = chosen === 'fly' && home !== 'fly';
    return { tab: automatic ? 'design' : chosen, automatic };
  });
  const setTab = useCallback((t: WorkspaceTab) => {
    setView({ tab: t, automatic: false });
    try { localStorage.setItem(WORKSPACE_KEY, t); } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const media = matchMedia(PHONE_QUERY);
    const change = () => {
      const phone = media.matches;
      setView(current => {
        if (!phone && current.tab === 'fly') return { tab: 'design', automatic: true };
        if (phone && current.automatic) return { tab: 'fly', automatic: false };
        return current;
      });
    };
    media.addEventListener?.('change', change);
    return () => media.removeEventListener?.('change', change);
  }, []);
  return [view.tab, setTab];
}
