import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
// Display face (identity pass 3): Rajdhani, self-hosted from @fontsource (OFL
// license) so the PWA stays CDN-free and works offline — the woff2 files are
// emitted into assets/ and precached (vite.config workbox globPatterns).
import '@fontsource/rajdhani/latin-600.css';
import '@fontsource/rajdhani/latin-700.css';
import { AppRoot } from './root.js';
import { guardPrecache } from './services/precacheGuard.js';
import { setSwRegistration } from './services/versionCheck.js';
import { offlineStatus } from './services/offlineStatus.js';
import { installFatalErrorBar } from './services/fatalErrorBar.js';
import { sessionDebugLog, startSessionDebugCapture } from './services/sessionDebugLog.js';
import { saveFile } from './services/saveFile.js';

const stopDebugCapture = startSessionDebugCapture();
const stopWorkerDebug = (() => {
  try {
    return navigator.serviceWorker ? sessionDebugLog.watchWorker(navigator.serviceWorker) : () => {};
  } catch (error) {
    sessionDebugLog.record('worker-error', error);
    return () => {};
  }
})();
const stopOfflineDebug = offlineStatus.subscribe(() => {
  const status = offlineStatus.getSnapshot();
  if (status.kind === 'unavailable' && status.reason === 'registration failed') {
    sessionDebugLog.record('worker-error', new Error(status.detail));
  }
});
// The running app uses the page lifetime; development reloads remove old listeners.
if (import.meta.hot) import.meta.hot.dispose(() => { stopDebugCapture(); stopWorkerDebug(); stopOfflineDebug(); });

// C-H3 is now integrated: keep the global error action independent of React.
const fatalErrors = installFatalErrorBar({ downloadSessionDebugLog: async () => {
  sessionDebugLog.record('debug-log-download');
  await saveFile(sessionDebugLog.text(), {
    suggestedName: 'mmrocket-sim-session-debug.txt', mime: 'text/plain;charset=utf-8',
    extensions: ['.txt'], description: 'Session debug log',
  });
} });
import.meta.hot?.dispose(fatalErrors);

// Offline-first. autoUpdate: a new build takes over and reloads the page by
// itself. What it does NOT do is go looking — the browser checks for a new
// worker when this registration runs, i.e. on a page load. Publishing the
// registration lets the header's version check ask for that on demand, which
// is the whole of the "am I on the current version?" support conversation.
// Every registration also goes past the empty-precache safeguard
// (services/precacheGuard.ts), which does nothing unless the worker's offline
// copy is empty. (Until v0.172 a branch here dismantled the PWA on the
// pre-rename openrocket.* host; that host has 301-redirected here since
// 2026-08-21, so the branch could no longer run and was removed.)
offlineStatus.start(registerSW, (_url, reg) => {
  setSwRegistration(reg);
  void guardPrecache(reg).catch(() => { /* Offline diagnostics must not prevent startup. */ });
});

// AppBoundary still offers design recovery for render failures. index.html's
// startup painter covers failures before this module can install the handlers.
try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  );
} catch (e) {
  sessionDebugLog.record('app-error', e);
  fatalErrors.report(e);
}
