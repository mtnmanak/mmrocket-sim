/** One back-off window for all thrustcurve.org requests in this tab. */
let retryAt = 0;
let refusing = false;
const DEFAULT_BACKOFF_MS = 10 * 60_000;

/** Test isolation only; production resets on a successful response or reconnect. */
export function resetThrustcurveBackoffForTests(): void { retryAt = 0; }

if (typeof window !== 'undefined') window.addEventListener('online', () => { retryAt = 0; });

export class ThrustcurveBackoffError extends Error {
  constructor() {
    const minutes = Math.max(1, Math.ceil((retryAt - Date.now()) / 60_000));
    super(`thrustcurve.org is ${refusing ? 'refusing requests' : 'not answering'} right now; the app will not ask it again for about `
      + `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`);
    this.name = 'ThrustcurveBackoffError';
  }
}

export function thrustcurveBackoffMessage(): string {
  clampBackoff();
  return Date.now() < retryAt ? new ThrustcurveBackoffError().message : '';
}

export function assertThrustcurveAvailable(): void {
  clampBackoff();
  if (Date.now() < retryAt) throw new ThrustcurveBackoffError();
  retryAt = 0;
}

function clampBackoff(): void {
  retryAt = Math.min(retryAt, Date.now() + 3_600_000);
}

/** Keep service errors and the pause advice as separate sentences. */
export function withThrustcurveBackoff(message: string): string {
  const backoff = thrustcurveBackoffMessage();
  return backoff ? `${message.replace(/[.!?]?$/, (end) => end || '.')} ${backoff}` : message;
}

function backOff(retryAfter?: string | null, status?: number): void {
  const now = Date.now();
  let ms = DEFAULT_BACKOFF_MS;
  if (retryAfter?.trim()) {
    const value = retryAfter.trim();
    const parsed = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    if (Number.isFinite(parsed)) ms = Math.max(60_000, Math.min(60 * 60_000, parsed));
  }
  retryAt = Math.max(retryAt, now + ms);
  refusing = status === 429;
}

/** A caller's Stop never opens the breaker; a deadline or lost connection does. */
export function recordThrustcurveFailure(timedOut: boolean, cancelled: boolean, network: boolean): void {
  if (!cancelled && (timedOut || network && (typeof navigator === 'undefined' || navigator.onLine !== false))) backOff();
}

/** Wrap only thrustcurve.org fetches; the other network services are independent. */
export function thrustcurveFetch(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    assertThrustcurveAvailable();
    try {
      const res = await fetchImpl(input, init);
      if (res.status === 429 || res.status >= 500 && res.status <= 599 && res.status !== 511) {
        // Cross-origin Retry-After is unreadable unless the server exposes it
        // with Access-Control-Expose-Headers. When unavailable, use the default.
        backOff(res.headers?.get('retry-after'), res.status);
      } else if (res.ok) {
        retryAt = 0;
      }
      return res;
    } catch (err) {
      recordThrustcurveFailure(false, init?.signal?.aborted === true, err instanceof TypeError);
      throw err;
    }
  };
}
