/** Test bundle only. Imported before the real entry, including its dependency initialization. */
let attempts = 0;
globalThis.fetch = (() => {
  attempts++;
  throw new Error('Outbound fetch is forbidden in this workerd test.');
}) as typeof fetch;

export const fetchAttempts = () => attempts;

let timers = 0;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  timers++;
  return originalSetTimeout(...args);
}) as typeof setTimeout;
export const timerCalls = () => timers;
