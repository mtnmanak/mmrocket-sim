export interface FatalErrorBarOptions {
  /** W3-DIAG / C-H3 seam: register the tools lane's local download action here. */
  downloadSessionDebugLog?: () => void | Promise<void>;
}

/** W3-DIAG: shared dialogs suspend their backdrop and focus trap while this bar is present. */
export const FATAL_ERROR_BAR_CHANGE = 'mmrocket-fatal-error-bar-change';

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
  let returnFocus: HTMLElement | null = null;
  // W3-DIAG: replacing or dismissing the bar must not start a second download.
  let downloadPending = false;
  const notifyDialogs = () => document.dispatchEvent(new Event(FATAL_ERROR_BAR_CHANGE));
  const removeBar = () => {
    if (!bar) return;
    const current = bar;
    const active = document.activeElement;
    bar = null;
    current.remove();
    notifyDialogs();
    if ((!active || active === document.body || current.contains(active))
      && document.activeElement === document.body && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  };
  const report = (reason: unknown) => {
    const message = shortMessage(reason);
    // Safari and Chromium's two benign observer-loop messages (W3-DIAG).
    if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications\.?)$/.test(message)) return;
    if (!bar) returnFocus = document.activeElement as HTMLElement | null;
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
    download.disabled = downloadPending || !options.downloadSessionDebugLog;
    const detail = document.createElement('p');
    detail.setAttribute('role', 'status');
    if (!options.downloadSessionDebugLog) {
      detail.textContent = 'Session debug-log download is not available in this build. Keep the error message with your bug report.';
    }
    download.addEventListener('click', () => {
      if (downloadPending || !options.downloadSessionDebugLog) return;
      downloadPending = true;
      download.disabled = true;
      detail.textContent = '';
      // Catch the download's own failure here, without an unhandled-rejection loop.
      void Promise.resolve().then(() => options.downloadSessionDebugLog?.()).catch((error: unknown) => {
        const currentDetail = bar?.querySelector<HTMLElement>('[role="status"]');
        if (currentDetail) currentDetail.textContent = `Debug-log download failed: ${shortMessage(error)}`;
      }).finally(() => {
        downloadPending = false;
        const currentDownload = bar?.querySelector<HTMLButtonElement>('[data-debug-log]');
        if (currentDownload) currentDownload.disabled = !options.downloadSessionDebugLog;
      });
    });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss error');
    dismiss.addEventListener('click', () => { if (bar === current) removeBar(); });
    actions.append(download, dismiss);
    current.append(text, actions, detail);
    // Normal flow BEFORE the app root: never a fixed layer over tabs or Launch.
    const root = document.getElementById('root');
    if (root?.parentElement) root.before(current); else document.body.prepend(current);
    bar = current;
    notifyDialogs();
    dismiss.focus({ preventScroll: true });
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
    removeBar();
  }, { report });
}
