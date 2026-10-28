/**
 * The one way the maintainer scripts send requests to thrustcurve.org: paced,
 * named, and stopped outright by a Cloudflare challenge.
 *
 * WHY (27 October 2026). thrustcurve.org now sits behind Cloudflare. Its
 * operator, John Coker, runs a GLOBAL rate limit of 3 requests per 10 seconds
 * (going to 5), so the weekly refresh's ~50 requests, sent back to back by
 * fetch-motor-db.mjs and 250 ms apart by fetch-motor-curves.mjs, would trip it
 * a few requests in. Every request through this client starts at least
 * `intervalMs` after the one before it (default 5 s: at most two in any 10 s,
 * under either limit), and the first waits one interval too, so a script that
 * starts straight after another one cannot stack its first request on the
 * other's last. About four minutes a weekly run; the refresh job's timeout in
 * motors-refresh.yml allows for it. THRUSTCURVE_INTERVAL_MS overrides the pace
 * (whole milliseconds, 1000 or more) once a different rate is agreed with him.
 *
 * A CHALLENGE IS NOT A RATE LIMIT. Measured 27 Oct, 6 s apart: Node's fetch got
 * HTTP 403 with `cf-mitigated: challenge` (the "Just a moment..." page) on its
 * very first request. No pace passes that, and nothing here tries to: the
 * client throws ThrustcurveChallengeError, and every later request through the
 * same client throws it again WITHOUT going to the network, so a run that loops
 * over 24 download batches does not knock 24 more times. Getting through is the
 * operator's decision, not a script's.
 *
 * 429 and 503 are retried, honouring Retry-After (capped), up to `retries`
 * times; whatever comes back after that is returned for the caller to judge, as
 * fetch would — and the client then sends NOTHING more: every later call
 * throws ThrustcurveUnavailableError without a request. Without that, a caller
 * that records a failed batch and moves on (fetchCurves, check-upstream) would
 * spend ~3.5 minutes of retries on every remaining request: 24 batches of
 * 503s is ~86 minutes, past the refresh job's timeout, against a host that is
 * already failing (review of 27 Oct). The same stop applies once the run's
 * retry waits add up to `retryBudgetMs` (default 10 minutes), so a host that
 * fails every request but the last retry cannot run the job out of time
 * either (closure check of 27 Oct). Every other answer is returned as it is.
 *
 * No imports, on purpose: fetch-motor-db.mjs and fetch-motor-curves.mjs run
 * before `npm ci` in motors-refresh.yml, and deploy-workflow.test.mjs (R8)
 * walks their relative imports and requires every one to be a Node builtin.
 */

/** The same string every script has always sent: one profile for the operator to recognise. */
export const USER_AGENT = 'mmrocket-sim-upstream-check';
export const DEFAULT_INTERVAL_MS = 5000;
export const MIN_INTERVAL_MS = 1000;
/** The longest single wait a 429/503 can ask for before this client gives up waiting on it. */
export const MAX_RETRY_WAIT_MS = 120_000;
/** The most a whole run spends waiting to retry before the client stops sending. */
export const RETRY_BUDGET_MS = 600_000;

/** Names the URL a latched error was asked for, when it is not the one that tripped the latch. */
const notSent = (requested, first) => (String(requested) === first ? '' : `Not sent: ${requested}. `);

export class ThrustcurveChallengeError extends Error {
  constructor(url, status, requested = url) {
    super(`${notSent(requested, url)}thrustcurve.org answered ${url} with a Cloudflare challenge (HTTP ${status}, `
      + 'cf-mitigated: challenge). A script cannot pass one and must not try; letting this client through is the '
      + 'operator\'s decision.');
    this.name = 'ThrustcurveChallengeError';
    this.status = status;
    this.url = url;
  }
}

/** A request already used up its retries on a 429/503; this run sends nothing more. */
export class ThrustcurveUnavailableError extends Error {
  constructor(url, status, requested = url) {
    super(`${notSent(requested, url)}thrustcurve.org: HTTP ${status} for ${url} after its retries; nothing more is `
      + 'sent this run');
    this.name = 'ThrustcurveUnavailableError';
    this.status = status;
    this.url = url;
  }
}

/** THRUSTCURVE_INTERVAL_MS, or the default; a value that is not a whole number of ms ≥ 1000 throws. */
export function intervalFromEnv(env = process.env) {
  const raw = env.THRUSTCURVE_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
  const ms = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(ms) || ms < MIN_INTERVAL_MS) {
    throw new Error(`THRUSTCURVE_INTERVAL_MS must be a whole number of milliseconds, ${MIN_INTERVAL_MS} or more `
      + `(got ${JSON.stringify(raw)})`);
  }
  return ms;
}

/**
 * Retry-After in ms — delta-seconds or an HTTP date — or null when absent or
 * unreadable. Capped at MAX_RETRY_WAIT_MS and never negative.
 */
export function retryAfterMs(value, now) {
  if (value == null) return null;
  const text = String(value).trim();
  let ms = null;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_WAIT_MS);
}

/**
 * A fetch-shaped function for thrustcurve.org. Everything that touches time or
 * the network is injectable so the tests never wait and never connect.
 */
export function createThrustcurveFetch({
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  intervalMs,
  retries = 3,
  retryBudgetMs = RETRY_BUDGET_MS,
  log = (s) => process.stderr.write(s),
} = {}) {
  let last = null;
  let retryWaited = 0;
  let challenged = null;
  let unavailable = null;
  // One request at a time through this client, whoever calls it: the pace is a
  // property of the client, not of each caller's loop.
  let queue = Promise.resolve();

  async function paced(url, init) {
    const interval = intervalMs ?? intervalFromEnv();
    const wait = last === null ? interval : last + interval - now();
    if (wait > 0) await sleep(wait);
    last = now();
    return fetchImpl(url, init);
  }

  async function send(url, init = {}) {
    if (challenged) throw new ThrustcurveChallengeError(challenged.url, challenged.status, url);
    if (unavailable) throw new ThrustcurveUnavailableError(unavailable.url, unavailable.status, url);
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
    const request = { ...init, headers };
    for (let attempt = 0; ; attempt++) {
      const res = await paced(url, request);
      if (res.headers?.get?.('cf-mitigated') === 'challenge') {
        challenged = { url: String(url), status: res.status };
        throw new ThrustcurveChallengeError(challenged.url, challenged.status);
      }
      if (res.status !== 429 && res.status !== 503) return res;
      const ms = retryAfterMs(res.headers?.get?.('retry-after'), now())
        ?? Math.min(30_000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
      if (attempt >= retries || retryWaited + ms > retryBudgetMs) {
        unavailable = { url: String(url), status: res.status };
        return res;
      }
      retryWaited += ms;
      log(`  thrustcurve.org HTTP ${res.status}; waiting ${Math.round(ms / 1000)} s before retry ${attempt + 1} of ${retries}\n`);
      await res.body?.cancel?.().catch?.(() => {});
      await sleep(ms);
    }
  }

  return (url, init) => {
    const result = queue.then(() => send(url, init));
    queue = result.catch(() => {});
    return result;
  };
}

/** The shared client: one pace for every request a process sends to thrustcurve.org. */
export const thrustcurveFetch = createThrustcurveFetch();
