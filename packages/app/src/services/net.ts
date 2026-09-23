/**
 * THE APP'S NETWORK HELPERS, IN ONE PLACE (weather build, 2026-09-22).
 *
 * A request's deadline, merged with the caller's own cancellation — shared by
 * the thrust-curve download and, from the weather build on, every request a
 * new feature makes.
 */

/** A request's deadline, merged with the caller's own cancellation. */
export interface Deadline {
  /** undefined only where AbortController does not exist at all. */
  signal: AbortSignal | undefined;
  /** True when OUR timer fired, as opposed to the caller cancelling. */
  timedOut: () => boolean;
  /** Always call: clears the timer and unsubscribes from the caller's signal. */
  done: () => void;
}

/**
 * Combines the caller's cancellation with our own deadline.
 *
 * Hand-rolled rather than AbortSignal.any(), which is Chrome 116 / Safari 17.4
 * (2023-24) and would break an older iPad, and rather than a bare
 * AbortSignal.timeout(), whose abort is indistinguishable from the caller's
 * once the two are merged. Telling them apart is the point: a timeout has to
 * read as "the network stalled", a caller abort as "you pressed Stop".
 *
 * Moved here unchanged from thrustcurve.ts (weather build), which imports it,
 * so the thrust-curve download and the weather requests share one definition.
 */
export function deadline(caller: AbortSignal | undefined, ms: number): Deadline {
  if (typeof AbortController !== 'function') {
    return { signal: caller, timedOut: () => false, done: () => { /* nothing to undo */ } };
  }
  const ctrl = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; ctrl.abort(); }, ms);
  const relay = (): void => ctrl.abort(caller?.reason);
  if (caller?.aborted) ctrl.abort(caller.reason);
  else caller?.addEventListener('abort', relay, { once: true });
  return {
    signal: ctrl.signal,
    timedOut: () => expired,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', relay);
    },
  };
}
