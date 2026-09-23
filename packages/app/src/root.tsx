import { useEffect } from 'react';
import { App } from './App.js';
import { AppBoundary } from './components/AppBoundary.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { watchOtherTabs } from './services/session.js';

/**
 * The tree main.tsx mounts, as a component of its own so it can be rendered —
 * and tested — without main.tsx's side effects (the service worker, the page's
 * root element). A test of main.tsx's source text could only say the words
 * were there (audit 2026-09-22, from review).
 *
 * AppBoundary sits OUTSIDE PrefsProvider, so a throw in the preferences layer
 * is caught too (components/AppBoundary.tsx). The other-tab watcher is here,
 * above the boundary, for the page's lifetime: a tab whose App has crashed
 * must still hear that another tab took the autosave over, so its recovery
 * download stays its own design (services/session.ts, `watchOtherTabs`).
 */
export function AppRoot() {
  useEffect(() => watchOtherTabs(), []);
  return (
    <AppBoundary>
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </AppBoundary>
  );
}
