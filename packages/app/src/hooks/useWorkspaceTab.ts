import { useCallback, useState } from 'react';

/**
 * THE WORKSPACE TAB (Fly / Design / Motors & Launch / Results), persisted so a
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
  const [tab, setTabRaw] = useState<WorkspaceTab>(() => {
    try {
      const t = localStorage.getItem(WORKSPACE_KEY);
      if (isTab(t)) return t;
    } catch { /* fall through */ }
    return homeTab();
  });
  const setTab = useCallback((t: WorkspaceTab) => {
    setTabRaw(t);
    try { localStorage.setItem(WORKSPACE_KEY, t); } catch { /* ignore */ }
  }, []);
  return [tab, setTab];
}
