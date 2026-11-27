/** Checked before any application module evaluates. */
export function supportsBrowserRuntime(): boolean {
  return typeof Object.hasOwn === 'function' && typeof Array.prototype.at === 'function'
    && typeof globalThis.structuredClone === 'function'
    && typeof globalThis.crypto?.randomUUID === 'function';
}

export const BROWSER_REQUIREMENTS = 'The app needs Safari 15.4, Firefox 95, Chrome 98 or Edge 98 or later. Update your browser to open the app.';
