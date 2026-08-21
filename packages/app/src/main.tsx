import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
// Display face (identity pass 3): Rajdhani, self-hosted from @fontsource (OFL
// license) so the PWA stays CDN-free and works offline — the woff2 files are
// emitted into assets/ and precached (vite.config workbox globPatterns).
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { dismantlePwa, isRetiredHost } from './services/hostMigration.js';

// Offline-first on the canonical host. On the RETIRED pre-rename host the
// PWA dismantles itself instead: no SW, caches dropped, banner in App.
if (isRetiredHost(location.hostname)) {
  void dismantlePwa();
} else {
  registerSW({ immediate: true });
}

// Never a silently-blank page: uncaught errors paint into the root.
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
      <PrefsProvider>
        <App />
      </PrefsProvider>
    </StrictMode>,
  );
} catch (e) {
  showFatal(String((e as Error).stack ?? e));
}
