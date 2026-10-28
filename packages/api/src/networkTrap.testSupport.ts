/** Test bundle only. Imported before the real entry, including its dependency initialization. */
let attempts = 0;
globalThis.fetch = (() => {
  attempts++;
  throw new Error('Outbound fetch is forbidden in this workerd test.');
}) as typeof fetch;

export const fetchAttempts = () => attempts;

// Every macrotask source workerd offers: a timer, an interval, scheduler.wait
// and a MessagePort message. Counted together; a source the runtime lacks is
// left out of `timerSources`.
let timers = 0;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  timers++;
  return originalSetTimeout(...args);
}) as typeof setTimeout;
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  timers++;
  return originalSetInterval(...args);
}) as typeof setInterval;
const sources = ['setTimeout', 'setInterval'];
const scheduler = (globalThis as { scheduler?: { wait?: (...args: unknown[]) => Promise<void> } }).scheduler;
if (scheduler && typeof scheduler.wait === 'function') {
  const wait = scheduler.wait.bind(scheduler);
  scheduler.wait = (...args: unknown[]) => { timers++; return wait(...args); };
  if (scheduler.wait !== wait) sources.push('scheduler.wait');
}
if (typeof MessagePort !== 'undefined') {
  const postMessage = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (this: MessagePort, ...args: Parameters<MessagePort['postMessage']>) {
    timers++;
    return postMessage.apply(this, args);
  } as MessagePort['postMessage'];
  sources.push('MessagePort.postMessage');
}
export const timerCalls = () => timers;
export const timerSources = () => [...sources];
