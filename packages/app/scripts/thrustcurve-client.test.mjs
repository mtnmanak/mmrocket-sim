import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVAL_MS, MAX_RETRY_WAIT_MS, ThrustcurveChallengeError, USER_AGENT,
  createThrustcurveFetch, intervalFromEnv, retryAfterMs,
} from './thrustcurve-client.mjs';

/**
 * thrustcurve-client.mjs against a fake clock and a fake thrustcurve.org —
 * never the network, never a real wait. `sleep` advances the clock, so each
 * request's start time is exactly when the client let it go.
 */
function harness(answers, options = {}) {
  let clock = 1_000_000;
  const sent = [];
  const slept = [];
  const queue = [...answers];
  const client = createThrustcurveFetch({
    now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    fetchImpl: async (url, init) => {
      sent.push({ url, at: clock, ua: init.headers.get('user-agent') });
      const next = queue.length ? queue.shift() : { status: 200 };
      return new Response(next.body ?? '{}', { status: next.status, headers: next.headers ?? {} });
    },
    log: () => {},
    intervalMs: 5000,
    ...options,
  });
  return { client, sent, slept, advance: (ms) => { clock += ms; } };
}

const challenge = { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<title>Just a moment...</title>' };

describe('thrustcurve-client pacing', () => {
  it('starts every request at least one interval after the one before, the first included', async () => {
    const { client, sent } = harness([]);
    for (let i = 0; i < 4; i++) await client(`https://www.thrustcurve.org/api/v1/search.json?i=${i}`);
    const starts = sent.map((s) => s.at);
    expect(starts[0]).toBe(1_000_000 + 5000);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(5000);
  });

  it('paces callers that do not wait for each other', async () => {
    const { client, sent } = harness([]);
    await Promise.all([1, 2, 3].map((i) => client(`https://www.thrustcurve.org/api/v1/x?${i}`)));
    const starts = sent.map((s) => s.at);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(5000);
  });

  it('does not wait again when the caller already spent the interval', async () => {
    const { client, slept, advance } = harness([]);
    await client('https://www.thrustcurve.org/a');
    advance(9000);
    await client('https://www.thrustcurve.org/b');
    expect(slept).toEqual([5000]);
  });

  it('keeps at most two requests in any 10 s at the default pace', async () => {
    expect(DEFAULT_INTERVAL_MS).toBeGreaterThan(10_000 / 3);
  });

  it('names itself unless the caller already did', async () => {
    const { client, sent } = harness([]);
    await client('https://www.thrustcurve.org/a');
    await client('https://www.thrustcurve.org/b', { headers: { 'User-Agent': 'caller-named' } });
    expect(sent.map((s) => s.ua)).toEqual([USER_AGENT, 'caller-named']);
  });
});

describe('thrustcurve-client challenge', () => {
  it('throws on a Cloudflare challenge and never sends another request', async () => {
    const { client, sent } = harness([challenge]);
    await expect(client('https://www.thrustcurve.org/a')).rejects.toBeInstanceOf(ThrustcurveChallengeError);
    const again = client('https://www.thrustcurve.org/b');
    await expect(again).rejects.toThrow(/Cloudflare challenge.*HTTP 403/);
    await expect(again).rejects.toMatchObject({ status: 403 });
    expect(sent).toHaveLength(1);
  });

  it('returns a plain 403 (no challenge header) for the caller to judge', async () => {
    const { client } = harness([{ status: 403 }]);
    expect((await client('https://www.thrustcurve.org/a')).status).toBe(403);
  });
});

describe('thrustcurve-client retries', () => {
  it('retries 429 and 503, honouring Retry-After, then returns the answer', async () => {
    const { client, sent, slept } = harness([
      { status: 429, headers: { 'retry-after': '12' } },
      { status: 503 },
      { status: 200, body: '{"ok":true}' },
    ]);
    const res = await client('https://www.thrustcurve.org/a');
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(3);
    expect(slept).toContain(12_000);
    expect(slept).toContain(60_000);
  });

  it('gives back the last 429 once the retries are spent', async () => {
    const { client, sent } = harness(Array(5).fill({ status: 429 }), { retries: 2 });
    expect((await client('https://www.thrustcurve.org/a')).status).toBe(429);
    expect(sent).toHaveLength(3);
  });

  it('does not retry other failures', async () => {
    const { client, sent } = harness([{ status: 500 }]);
    expect((await client('https://www.thrustcurve.org/a')).status).toBe(500);
    expect(sent).toHaveLength(1);
  });
});

describe('thrustcurve-client settings', () => {
  it('reads THRUSTCURVE_INTERVAL_MS and refuses a pace under one second or not a whole number', () => {
    expect(intervalFromEnv({})).toBe(DEFAULT_INTERVAL_MS);
    expect(intervalFromEnv({ THRUSTCURVE_INTERVAL_MS: '2500' })).toBe(2500);
    for (const bad of ['999', '0', '-5000', '2.5e3', '1500.5', 'fast', ' ']) {
      expect(() => intervalFromEnv({ THRUSTCURVE_INTERVAL_MS: bad })).toThrow(/THRUSTCURVE_INTERVAL_MS/);
    }
  });

  it('reads Retry-After as seconds or a date, capped and never negative', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    expect(retryAfterMs('7', now)).toBe(7000);
    expect(retryAfterMs('100000', now)).toBe(MAX_RETRY_WAIT_MS);
    expect(retryAfterMs('Tue, 27 Oct 2026 12:00:20 GMT', now)).toBe(20_000);
    expect(retryAfterMs('Tue, 27 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});
