export interface FatalErrorBarOptions {
  /** W3-DIAG / C-H3 seam: register the tools lane's local download action here. */
  downloadSessionDebugLog?: () => void | Promise<void>;
}

function shortMessage(reason: unknown): string {
  try {
    const message = typeof reason === 'object' && reason !== null && 'message' in reason
      ? String(reason.message) : String(reason ?? 'Unknown error');
    return message.split(/[\r\n]/, 1)[0]!.trim().slice(0, 240) || 'Unknown error';
  } catch { return 'Unknown error'; }
}

/** Independent of React so an error in rendering or startup cannot remove the bar. */
export function installFatalErrorBar(options: FatalErrorBarOptions = {}): (() => void) & { report: (reason: unknown) => void } {
  let bar: HTMLElement | null = null;
  const report = (reason: unknown) => {
    const message = shortMessage(reason);
    // Safari and Chromium's two benign observer-loop messages (W3-DIAG).
    if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\.?)$/.test(message)) return;
    bar?.remove();
    const current = document.createElement('section');
    current.className = 'fatal-error-bar message-tier message-danger';
    current.setAttribute('aria-label', 'Unexpected error');
    const text = document.createElement('p');
    text.setAttribute('role', 'alert');
    const label = document.createElement('strong');
    label.textContent = 'Danger: Something went wrong. ';
    text.append(label, message);
    const actions = document.createElement('div');
    actions.className = 'fatal-error-actions';
    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download session debug log';
    download.setAttribute('data-debug-log', '');
    download.disabled = !options.downloadSessionDebugLog;
    const detail = document.createElement('p');
    detail.setAttribute('role', 'status');
    if (!options.downloadSessionDebugLog) {
      detail.textContent = 'Session debug-log download is not available in this build. Keep the error message with your bug report.';
    }
    download.addEventListener('click', () => {
      download.disabled = true;
      // Catch the download's own failure here, without an unhandled-rejection loop.
      void Promise.resolve().then(() => options.downloadSessionDebugLog?.()).catch((error: unknown) => {
        detail.textContent = `Debug-log download failed: ${shortMessage(error)}`;
      }).finally(() => { download.disabled = !options.downloadSessionDebugLog; });
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss error');
    dismiss.addEventListener('click', () => { current.remove(); if (bar === current) bar = null; });
    actions.append(download, dismiss);
    current.append(text, actions, detail);
    // Normal flow BEFORE the app root: never a fixed layer over tabs or Launch.
    const root = document.getElementById('root');
    if (root?.parentElement) root.before(current); else document.body.prepend(current);
    bar = current;
    // W3-DIAG: a normal-flow bar above a scrolled page must still be seen.
    const bounds = current.getBoundingClientRect();
    if (bounds.top < 0 || bounds.bottom > window.innerHeight) {
      current.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  };
  const onError = (event: ErrorEvent) => report(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return Object.assign(() => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    bar?.remove();
    bar = null;
  }, { report });
}
