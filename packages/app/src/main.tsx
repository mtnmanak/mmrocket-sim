import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
// Display face (identity pass 3): Rajdhani, self-hosted from @fontsource (OFL
// license) so the PWA stays CDN-free and works offline — the woff2 files are
// emitted into assets/ and precached (vite.config workbox globPatterns).
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import { App } from './App.js';
import { AppBoundary } from './components/AppBoundary.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { dismantlePwa, isRetiredHost } from './services/hostMigration.js';
import { setSwRegistration } from './services/versionCheck.js';

// Offline-first on the canonical host. On the RETIRED pre-rename host the
// PWA dismantles itself instead: no SW, caches dropped, banner in App.
if (isRetiredHost(location.hostname)) {
  void dismantlePwa();
} else {
  // autoUpdate: a new build takes over and reloads the page by itself. What it
  // does NOT do is go looking — the browser checks for a new worker when this
  // registration runs, i.e. on a page load. Publishing the registration lets
  // the header's version check ask for that on demand, which is the whole of
  // the "am I on the current version?" support conversation.
  registerSW({ immediate: true, onRegisteredSW: (_url, reg) => setSwRegistration(reg) });
}

// Never a silently-blank page: uncaught errors paint into the root. A throw
// while RENDERING is caught by AppBoundary below, which keeps the root filled
// and offers the autosaved design and a fresh start (audit 2026-09-22); this
// paints only into an EMPTY root, so it is the last resort for what no
// boundary sees (the root failing to mount at all).
function showFatal(message: string) {
  const root = document.getElementById('root');
  if (root && !root.childElementCount) {
    root.innerHTML = `<div style="font-family:system-ui;padding:24px;color:#b00">
      <h2>Something went wrong</h2>
      <pre style="white-space:pre-wrap">${message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</pre>
    </div>`;
  }
}
window.addEventListener('error', (e) => showFatal(String(e.error?.stack ?? e.message)));
window.addEventListener('unhandledrejection', (e) => showFatal(String(e.reason)));

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppBoundary>
        <PrefsProvider>
          <App />
        </PrefsProvider>
      </AppBoundary>
    </StrictMode>,
  );
} catch (e) {
  showFatal(String((e as Error).stack ?? e));
}
