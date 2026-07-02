import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

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
      <App />
    </StrictMode>,
  );
} catch (e) {
  showFatal(String((e as Error).stack ?? e));
}
