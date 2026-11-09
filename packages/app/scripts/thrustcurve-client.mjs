/**
 * The one way the maintainer scripts send requests to thrustcurve.org: paced,
 * named, and stopped outright by a Cloudflare challenge.
 *
 * WHY (29 October 2026). From the owner's home connection, Node fetch got
 * Cloudflare challenges twice, while node:https with only Host + User-Agent
 * got HTTP 200; adding undici's headers and ALPN reproduced the challenge.
 * John Coker approved using what works; this transport sends only the needed
 * headers, without ALPN, and keeps the existing conservative pace and stops.
 *
 * PACING. John Coker's current limit is 10 requests per 10 seconds (29 Oct),
 * up from 3 when this client was introduced. The weekly refresh's ~50 requests,
 * sent back to back by fetch-motor-db.mjs and 250 ms apart by
 * fetch-motor-curves.mjs, would trip even the higher limit. Every request
 * through this client starts at least `intervalMs` after the ANSWER to the one
 * before it came back (default 5 s),
 * so two requests reach Cloudflare more than 5 s apart however slow the
 * network was for either — at most two in any 10 s, under both limits. Timed
 * from the answer, not the start, because a request delayed on its way out
 * would otherwise arrive bunched with the next (Gemini review, 27 Oct); timed
 * on the monotonic clock, so a wall-clock step cannot shorten a gap. The first
 * request waits one interval too, so a script that starts straight after
 * another one cannot stack its first request on the other's last. About five
 * minutes a weekly run; the refresh job's timeout in motors-refresh.yml
 * allows for it. THRUSTCURVE_INTERVAL_MS overrides the pace
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
 * RETRYABLE_STATUSES are retried, honouring Retry-After (capped), up to `retries`
 * times; whatever comes back after that is returned for the caller to judge, as
 * fetch would — and the client then sends NOTHING more: every later call
 * throws ThrustcurveUnavailableError without a request. Without that, a caller
 * that records a failed batch and moves on (fetchCurves, check-upstream) would
 * spend ~3.5 minutes of retries on every remaining request: 24 batches of
 * 503s is ~86 minutes, past the refresh job's timeout, against a host that is
 * already failing (review of 27 Oct). The same stop applies once the run's
 * failed attempts plus retry waits add up to `retryBudgetMs` (default 10
 * minutes), bounding slow flapping outages too (closure check of 27 Oct).
 * Transport failures, including headers/body
 * deadlines, also latch the stop. A single other transport error is allowed
 * to recover; a repeat without a successful body read latches the stop.
 * An `advisory` request shares pacing but returns outages without retries or
 * charging/latching the required-check budget. Its Retry-After still delays
 * subsequent traffic. Challenges still stop the run.
 * Every other answer is returned as it is.
 *
 * Only Node builtin imports: fetch-motor-db.mjs and fetch-motor-curves.mjs run
 * before `npm ci` in motors-refresh.yml, and deploy-workflow.test.mjs (R8)
 * walks their relative imports and requires every one to be a Node builtin.
 */

import https from 'node:https';

/** Headers and an active body read each get at most two minutes. */
export const HEADERS_DEADLINE_MS = 120_000;
export const BODY_DEADLINE_MS = 120_000;
/** 64 MiB leaves room for a full search or a 50-motor download batch. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Only this client's HTTPS endpoint, with no fetch-added browser headers or
 * ALPN. Return headers immediately so a challenge or retry never waits for a
 * body. Read UTF-8 JSON/text lazily, buffering once. The socket boundary is
 * injectable for offline tests.
 */
export async function httpsFetch(url, init = {}, request = https.request) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.host !== 'www.thrustcurve.org' || target.username || target.password) {
    throw new Error('Thrustcurve transport only allows https://www.thrustcurve.org without credentials');
  }
  if (init.body !== undefined && typeof init.body !== 'string') {
    throw new TypeError('Thrustcurve transport requires a string body');
  }
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-length', String(Buffer.byteLength(init.body, 'utf8')));

  return new Promise((resolve, reject) => {
    let req;
    let response;
    let headersReceived = false;
    let finished = false;
    let bodyError;
    let bodyPromise;
    let resolveBody;
    let rejectBody;
    let bodyTimer;
    const chunks = [];
    let bytes = 0;
    const headersTimer = setTimeout(() => fail(new Error(
      'thrustcurve.org headers deadline exceeded (' + HEADERS_DEADLINE_MS + ' ms)',
    )), HEADERS_DEADLINE_MS);

    function release() {
      clearTimeout(headersTimer);
      clearTimeout(bodyTimer);
      chunks.length = 0;
      response?.destroy();
      req?.destroy();
    }

    function fail(error) {
      if (finished) return;
      finished = true;
      bodyError = error;
      if (!headersReceived) reject(error);
      rejectBody?.(error);
      release();
    }

    function bodyDeadline() {
      return setTimeout(() => fail(new Error(
        'thrustcurve.org body deadline exceeded (' + BODY_DEADLINE_MS + ' ms)',
      )), BODY_DEADLINE_MS);
    }

    function readBody(responseHeaders) {
      if (bodyPromise) return bodyPromise;
      if (bodyError) return Promise.reject(bodyError);
      bodyPromise = new Promise((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
      clearTimeout(bodyTimer);
      bodyTimer = bodyDeadline();
      response.socket?.ref();
      const encoding = responseHeaders.get('content-encoding')?.trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        fail(new Error('thrustcurve.org unsupported Content-Encoding: ' + encoding));
        return bodyPromise;
      }
      response.on('data', (chunk) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          fail(new Error('thrustcurve.org response exceeds ' + MAX_RESPONSE_BYTES + ' bytes'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (finished) return;
        finished = true;
        const text = Buffer.concat(chunks, bytes).toString('utf8');
        release();
        resolveBody(text);
      });
      response.resume();
      return bodyPromise;
    }

    try {
      req = request(target, {
        method: init.method ?? 'GET', headers: Object.fromEntries(headers), agent: false,
      }, (res) => {
        if (finished) { res.destroy(); return; }
        response = res;
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('thrustcurve.org response aborted')));
        res.on('close', () => fail(new Error('thrustcurve.org response closed before body ended')));
        const responseHeaders = new Headers(res.headers);
        headersReceived = true;
        clearTimeout(headersTimer);
        // A caller may only inspect status. Reap its unread stream eventually,
        // but neither that timer nor its socket may hold the process open.
        bodyTimer = bodyDeadline();
        bodyTimer.unref();
        res.socket?.unref();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: responseHeaders,
          json: async () => JSON.parse(await readBody(responseHeaders)),
          text: () => readBody(responseHeaders),
          body: { cancel: async () => { fail(new Error('thrustcurve.org response body cancelled')); } },
        });
      });
      req.on('error', fail);
      req.end(init.body);
    } catch (error) {
      fail(error);
    }
  });
}

/** The same string every script has always sent: one profile for the operator to recognise. */
export const USER_AGENT = 'mmrocket-sim-upstream-check';
export const DEFAULT_INTERVAL_MS = 5000;
export const MIN_INTERVAL_MS = 1000;
/** The longest single wait a retryable answer can ask for before this client gives up waiting on it. */
export const MAX_RETRY_WAIT_MS = 120_000;
/** Run-wide failed-attempt and retry-wait budget, checked before each retry. */
export const RETRY_BUDGET_MS = 600_000;
/** Slow or failing origins: callers must stop batch loops after the final answer. */
export const RETRYABLE_STATUSES = Object.freeze([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);

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

/** An outage exhausted retries or failed in transport; this run sends nothing more. */
export class ThrustcurveUnavailableError extends Error {
  constructor(url, status, requested = url, cause) {
    super(`${notSent(requested, url)}thrustcurve.org: ${status == null ? `transport failure for ${url}` : `HTTP ${status} for ${url} after its retries`}; nothing more is `
      + `sent this run${cause ? ` (${cause.message})` : ''}`, { cause });
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
 * unreadable. Capped at MAX_RETRY_WAIT_MS and never negative. Decimal seconds
 * are read as seconds, and only text with a month or day name goes to
 * Date.parse: V8 reads a bare "10.5" as a date in 2001, which would have
 * turned a 10.5 s wait into none (Gemini review, 27 Oct).
 */
export function retryAfterMs(value, now) {
  if (value == null) return null;
  const text = String(value).trim();
  let ms = null;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Math.ceil(Number(text) * 1000);
  else if (/[A-Za-z]/.test(text)) {
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
  fetchImpl = httpsFetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // The pace runs on the monotonic clock; only an HTTP-date Retry-After needs the wall clock.
  now = () => performance.now(),
  wallNow = () => Date.now(),
  intervalMs,
  retries = 3,
  retryBudgetMs = RETRY_BUDGET_MS,
  log = (s) => process.stderr.write(s),
} = {}) {
  let last = null;
  let retryNotBefore = 0;
  let retrySpent = 0;
  let challenged = null;
  let unavailable = null;
  let transportFailures = 0;
  function transportFailure(error, url, started, advisory) {
    if (advisory) return error;
    retrySpent += Math.max(0, now() - started);
    transportFailures++;
    if (transportFailures >= 2 || retrySpent >= retryBudgetMs || /deadline exceeded/i.test(error.message)) {
      unavailable = { url: String(url), status: null, cause: error };
      return new ThrustcurveUnavailableError(unavailable.url, null, url, error);
    }
    return error;
  }
  // One request at a time through this client, whoever calls it: the pace is a
  // property of the client, not of each caller's loop.
  let queue = Promise.resolve();

  async function paced(url, init, begin) {
    const interval = intervalMs ?? intervalFromEnv();
    const due = Math.max((last ?? now()) + interval, retryNotBefore);
    // Re-checked after each sleep: a timer can fire a millisecond early.
    for (let wait = due - now(); wait > 0; wait = due - now()) await sleep(Math.ceil(wait));
    begin();
    try {
      return await fetchImpl(url, init);
    } finally {
      last = now();
    }
  }

  async function send(url, init = {}) {
    if (challenged) throw new ThrustcurveChallengeError(challenged.url, challenged.status, url);
    if (unavailable) throw new ThrustcurveUnavailableError(unavailable.url, unavailable.status, url, unavailable.cause);
    // An optional population probe shares the pace, but cannot stop required checks.
    // A Cloudflare challenge still stops every request, including advisory ones.
    const { advisory = false, ...options } = init;
    const headers = new Headers(options.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
    const request = { ...options, headers };
    for (let attempt = 0; ; attempt++) {
      let started;
      let res;
      try { res = await paced(url, request, () => { started = now(); }); }
      catch (error) {
        throw transportFailure(error, url, started, advisory);
      }
      if (res.headers?.get?.('cf-mitigated') === 'challenge') {
        challenged = { url: String(url), status: res.status };
        await res.body?.cancel?.().catch?.(() => {});
        throw new ThrustcurveChallengeError(challenged.url, challenged.status);
      }
      if (!RETRYABLE_STATUSES.includes(res.status)) {
        // Body reads happen after send returns; a slow broken body must stop
        // later batches just as a headers deadline does. Preserve the response.
        for (const method of ['json', 'text']) {
          if (typeof res[method] !== 'function') continue;
          const read = res[method].bind(res);
          res[method] = async (...args) => {
            try {
              const value = await read(...args);
              transportFailures = 0;
              return value;
            }
            catch (error) {
              // Invalid JSON is a data failure, not evidence of an outage.
              if (!(error instanceof SyntaxError)) {
                throw transportFailure(error, url, started, advisory);
              }
              transportFailures = 0;
              throw error;
            }
          };
        }
        return res;
      }
      if (advisory) {
        // No retry here, but the next request still waits as long as a retry would (the first backoff when the
        // answer names no Retry-After): a host that just answered 429/5xx is not asked again after the 5 s pace.
        const ms = retryAfterMs(res.headers?.get?.('retry-after'), wallNow()) ?? 30_000;
        retryNotBefore = Math.max(retryNotBefore, now() + ms);
        return res;
      }
      retrySpent += Math.max(0, now() - started);
      const ms = retryAfterMs(res.headers?.get?.('retry-after'), wallNow())
        ?? Math.min(30_000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
      if (attempt >= retries || retrySpent + ms > retryBudgetMs) {
        unavailable = { url: String(url), status: res.status };
        return res;
      }
      const waiting = now();
      log(`  thrustcurve.org HTTP ${res.status}; waiting ${Math.round(ms / 1000)} s before retry ${attempt + 1} of ${retries}\n`);
      await res.body?.cancel?.().catch?.(() => {});
      await sleep(ms);
      retrySpent += Math.max(ms, now() - waiting);
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
