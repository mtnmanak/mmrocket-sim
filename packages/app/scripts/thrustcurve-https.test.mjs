import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  httpsFetch, createThrustcurveFetch, MAX_RESPONSE_BYTES, HEADERS_DEADLINE_MS, BODY_DEADLINE_MS,
  ThrustcurveChallengeError, ThrustcurveUnavailableError,
} from './thrustcurve-client.mjs';

// Fail closed: even a broken default transport cannot connect from this file.
vi.mock('node:https', () => ({ default: { request: vi.fn(() => { throw new Error('unmocked HTTPS request'); }) } }));
vi.stubGlobal('fetch', () => { throw new Error('global fetch must not be used'); });
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const URL = 'https://www.thrustcurve.org/api/v1/metadata.json';

/** Only the socket boundary is fake; the adapter and paced client run unchanged. */
function transport(answers = [{}]) {
  const sent = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    req.destroy = vi.fn();
    res.socket = { ref: vi.fn(), unref: vi.fn(), destroy: vi.fn() };
    res.destroy = vi.fn(() => res.socket.destroy());
    req.end = (body) => {
      sent.push({ url: String(url), options, body, req, res });
      const answer = answers[sent.length - 1] ?? {};
      queueMicrotask(() => {
        if (answer.requestError) { req.emit('error', new Error(answer.requestError)); return; }
        if (answer.noHeaders) return;
        res.statusCode = answer.status ?? 200;
        res.headers = answer.headers ?? {};
        let reading = false;
        res.resume = () => {
          if (reading) return;
          reading = true;
          queueMicrotask(() => {
            if (answer.stall || res.destroy.mock.calls.length) return;
            if (answer.responseError) { res.emit('error', new Error(answer.responseError)); return; }
            if (answer.aborted) { res.emit('aborted'); return; }
            if (answer.closed) { res.emit('close'); return; }
            for (const chunk of answer.chunks ?? [Buffer.from(answer.body ?? '{}')]) res.emit('data', chunk);
            res.emit('end');
          });
        };
        // IncomingMessage flows when a data listener is added or resume() is called.
        res.on('newListener', (name) => { if (name === 'data') res.resume(); });
        callback(res);
      });
    };
    return req;
  };
  return { request, sent };
}

/** Flush continuations without waiting for a stalled body's deadline. */
async function atHeaders(pending) {
  let response;
  const observed = pending.then((value) => { response = value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(response, 'response must resolve at headers, before any body bytes').toBeDefined();
  await observed;
  return response;
}

describe('thrustcurve HTTPS transport', () => {
  it('sends only the GET headers supplied, without ALPN or a keep-alive agent', async () => {
    const { request, sent } = transport();
    const res = await httpsFetch(URL, { headers: new Headers({ 'user-agent': 'test-client' }) }, request);
    expect(sent[0].url).toBe(URL);
    expect(sent[0].options).toEqual({ method: 'GET', headers: { 'user-agent': 'test-client' }, agent: false });
    expect(sent[0].body).toBeUndefined();
    await res.body.cancel();
  });

  it('sends a JSON POST with exactly its headers and the UTF-8 byte length', async () => {
    const { request, sent } = transport();
    const body = '{"name":"café 🚀"}';
    const res = await httpsFetch(URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'test-client', 'Content-Length': '1' }, body,
    }, request);
    expect(sent[0].options).toEqual({ method: 'POST', agent: false, headers: {
      'content-type': 'application/json', 'user-agent': 'test-client', 'content-length': '21',
    } });
    expect(sent[0].body).toBe(body);
    await res.body.cancel();
  });

  it('includes Content-Length for an empty string body too', async () => {
    const { request, sent } = transport();
    const res = await httpsFetch(URL, { method: 'POST', body: '' }, request);
    expect(sent[0].options.headers).toEqual({ 'content-length': '0' });
    expect(sent[0].body).toBe('');
    await res.body.cancel();
  });

  it.each([
    'http://www.thrustcurve.org/api/v1/search.json', 'https://example.test/',
    'https://www.thrustcurve.org.example.test/', 'https://thrustcurve.org/',
    'https://www.thrustcurve.org:444/', 'https://user@www.thrustcurve.org/',
    'https://:password@www.thrustcurve.org/',
  ])('refuses %s before sending anything', async (url) => {
    const { request, sent } = transport();
    await expect(httpsFetch(url, {}, request)).rejects.toThrow(/only.*https:\/\/www\.thrustcurve\.org/i);
    expect(sent).toHaveLength(0);
  });

  it('refuses a non-string body before sending anything', async () => {
    const { request, sent } = transport();
    await expect(httpsFetch(URL, { body: {} }, request)).rejects.toThrow(/string body/i);
    expect(sent).toHaveLength(0);
  });

  it('buffers once and supplies status, case-insensitive headers, UTF-8 json/text and cancellation', async () => {
    const bytes = Buffer.from('{"name":"café 🚀"}');
    const { request, sent } = transport([{ status: 201, headers: { 'content-type': 'application/json' },
      chunks: [bytes.subarray(0, 13), bytes.subarray(13)] }]);
    const res = await httpsFetch(URL, {}, request);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('missing')).toBeNull();
    expect(await res.json()).toEqual({ name: 'café 🚀' });
    expect(await res.text()).toBe('{"name":"café 🚀"}');
    await expect(res.body.cancel()).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it.each([199, 300, 302, 403, 503])('returns HTTP %i as !ok without following redirects', async (status) => {
    const { request, sent } = transport([{ status, headers: { location: 'https://other.test/' } }]);
    const res = await httpsFetch(URL, {}, request);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(status);
    expect(sent).toHaveLength(1);
    await res.body.cancel();
  });

  it('starts only one read for concurrent text/json calls and caches the result', async () => {
    vi.useFakeTimers();
    const { request, sent } = transport([{ stall: true }]);
    const res = await atHeaders(httpsFetch(URL, {}, request));
    const first = res.text();
    const second = res.text();
    expect(second).toBe(first);
    const json = res.json();
    sent[0].res.emit('data', Buffer.from('{"once":true}'));
    sent[0].res.emit('end');
    expect(await first).toBe('{"once":true}');
    expect(await json).toEqual({ once: true });
    expect(await res.text()).toBe('{"once":true}');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'aborted', 'close', 'requestError'])('saves an early %s for the body reader without rejecting the response', async (event) => {
    vi.useFakeTimers();
    const { request, sent } = transport([{ stall: true }]);
    const res = await atHeaders(httpsFetch(URL, {}, request));
    if (event === 'requestError') sent[0].req.emit('error', new Error('late request error'));
    else sent[0].res.emit(event, new Error('early response error'));
    let error;
    const pending = res.json().catch((caught) => { error = caught; });
    await vi.advanceTimersByTimeAsync(0);
    expect(error?.message).toMatch(/error|aborted|closed/i);
    await pending;
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports malformed JSON from json(), preserving text()', async () => {
    const { request } = transport([{ body: '<html>not JSON</html>' }]);
    const res = await httpsFetch(URL, {}, request);
    await expect(res.json()).rejects.toThrow(SyntaxError);
    expect(await res.text()).toBe('<html>not JSON</html>');
  });

  it.each(['gzip', 'br', 'deflate'])('rejects unsolicited %s encoding and destroys the connection', async (encoding) => {
    const { request, sent } = transport([{ headers: { 'content-encoding': encoding } }]);
    const res = await httpsFetch(URL, {}, request);
    await expect(res.text()).rejects.toThrow(/unsupported.*content-encoding/i);
    await expect(res.json()).rejects.toThrow(/unsupported.*content-encoding/i);
    expect(sent[0].req.destroy).toHaveBeenCalled();
    expect(sent[0].res.destroy).toHaveBeenCalled();
  });

  it('accepts an explicitly identity-encoded response', async () => {
    const { request } = transport([{ headers: { 'content-encoding': 'identity' } }]);
    expect(await (await httpsFetch(URL, {}, request)).json()).toEqual({});
  });

  it('enforces the headers deadline before a response arrives', async () => {
    vi.useFakeTimers();
    const { request, sent } = transport([{ noHeaders: true }]);
    let error;
    const pending = httpsFetch(URL, {}, request).catch((caught) => { error = caught; });
    await vi.advanceTimersByTimeAsync(HEADERS_DEADLINE_MS - 1);
    expect(sent[0].req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/headers deadline.*120000 ms/i);
    await pending;
    expect(sent[0].req.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns stalled headers immediately and starts a fresh deadline when the body is read', async () => {
    vi.useFakeTimers();
    const { request, sent } = transport([{ stall: true }]);
    const res = await atHeaders(httpsFetch(URL, {}, request));
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(sent[0].res.listenerCount('data')).toBe(0);
    await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS - 1);
    let error;
    const pending = res.text().catch((caught) => { error = caught; });
    await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS - 1);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(error?.message).toMatch(/body deadline.*120000 ms/i);
    await pending;
    await expect(res.json()).rejects.toThrow(/body deadline/i);
    expect(sent[0].req.destroy).toHaveBeenCalled();
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unrefs unread bodies and reaps their socket without keeping the process alive', async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const { request, sent } = transport([{ stall: true }]);
    const res = await atHeaders(httpsFetch(URL, {}, request));
    expect(sent[0].res.socket.unref).toHaveBeenCalled();
    expect(timer.mock.results.at(-1).value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS);
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    await expect(res.text()).rejects.toThrow(/body deadline/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('cancel releases the socket and all deadlines (reading=%s)', async (reading) => {
    vi.useFakeTimers();
    const { request, sent } = transport([{ stall: true }]);
    const res = await atHeaders(httpsFetch(URL, {}, request));
    const pending = reading ? res.json().catch((error) => error) : null;
    if (reading) expect(sent[0].res.socket.ref).toHaveBeenCalled();
    await res.body.cancel();
    expect(sent[0].req.destroy).toHaveBeenCalled();
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    if (pending) expect((await pending).message).toMatch(/cancelled/i);
    await expect(res.text()).rejects.toThrow(/cancelled/i);
    await vi.advanceTimersByTimeAsync(BODY_DEADLINE_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts streamed bytes, permits the cap and destroys a response one byte over it', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 'a');
    const chunks = Array(MAX_RESPONSE_BYTES / chunk.length).fill(chunk);
    const { request, sent } = transport([{ chunks }, { chunks: [...chunks, Buffer.from('b')] }]);
    expect((await (await httpsFetch(URL, {}, request)).text()).length).toBe(MAX_RESPONSE_BYTES);
    const res = await httpsFetch(URL, {}, request);
    await expect(res.json()).rejects.toThrow(/response exceeds.*bytes/i);
    await expect(res.text()).rejects.toThrow(/response exceeds.*bytes/i);
    expect(sent[1].req.destroy).toHaveBeenCalled();
    expect(sent[1].res.destroy).toHaveBeenCalled();
  });

  it.each([
    [{ responseError: 'read failed' }, /read failed/],
    [{ aborted: true }, /response aborted/i],
    [{ closed: true }, /response closed/i],
  ])('rejects body failure %j from the reader and clears its deadline', async (answer, message) => {
    vi.useFakeTimers();
    const { request } = transport([answer]);
    const res = await httpsFetch(URL, {}, request);
    let error;
    const pending = res.text().catch((caught) => { error = caught; });
    await vi.advanceTimersByTimeAsync(0);
    expect(error?.message).toMatch(message);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadlines on network errors or a fully read response', async () => {
    vi.useFakeTimers();
    await expect(httpsFetch(URL, {}, () => { throw new Error('request failed'); })).rejects.toThrow('request failed');
    expect(vi.getTimerCount()).toBe(0);
    const failed = transport([{ requestError: 'connection failed' }]);
    await expect(httpsFetch(URL, {}, failed.request)).rejects.toThrow('connection failed');
    expect(vi.getTimerCount()).toBe(0);
    const { request, sent } = transport();
    const res = await httpsFetch(URL, {}, request);
    expect(await res.text()).toBe('{}');
    expect(await res.json()).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEADERS_DEADLINE_MS + BODY_DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the real default transport under the paced client', () => {
  function defaultClient(answers) {
    let clock = 0;
    const slept = [];
    const wire = transport(answers);
    https.request.mockImplementation(wire.request);
    const client = createThrustcurveFetch({
      intervalMs: 5000, now: () => clock,
      sleep: async (ms) => { slept.push(ms); clock += ms; }, log: () => {},
    });
    return { client, slept, sent: wire.sent };
  }

  it.each([{}, { 'content-encoding': 'gzip' }])('cancels a stalled challenge at headers and latches without another request: %j', async (extraHeaders) => {
    vi.useFakeTimers();
    const { client, sent } = defaultClient([{ status: 403, stall: true,
      headers: { 'cf-mitigated': 'challenge', ...extraHeaders } }]);
    let error;
    const pending = client(URL).catch((caught) => { error = caught; });
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toBeInstanceOf(ThrustcurveChallengeError);
    await pending;
    await expect(client(URL + '?again')).rejects.toBeInstanceOf(ThrustcurveChallengeError);
    expect(sent).toHaveLength(1);
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{}, { 'content-encoding': 'br' }])('backs off and cancels a stalled 503 before reading its body: %j', async (extraHeaders) => {
    vi.useFakeTimers();
    const { client, sent, slept } = defaultClient([
      { status: 503, stall: true, headers: { 'retry-after': '12', ...extraHeaders } },
      { body: '{"recovered":true}' },
    ]);
    const res = await atHeaders(client(URL));
    expect(sent).toHaveLength(2);
    expect(slept).toEqual([5000, 12000]);
    expect(sent[0].res.socket.destroy).toHaveBeenCalled();
    expect(await res.json()).toEqual({ recovered: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('latches unavailable at stalled headers after exhausting retries', async () => {
    vi.useFakeTimers();
    const { client, sent } = defaultClient(Array(4).fill({ status: 503, stall: true }));
    const res = await atHeaders(client(URL));
    expect(res.status).toBe(503);
    await expect(client(URL + '?again')).rejects.toBeInstanceOf(ThrustcurveUnavailableError);
    expect(sent).toHaveLength(4);
    for (const { res: earlier } of sent.slice(0, -1)) expect(earlier.socket.destroy).toHaveBeenCalled();
    await res.body.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ECONNRESET', 'connect ETIMEDOUT'])('does not retry a thrown network error: %s', async (message) => {
    const { client, sent } = defaultClient([{ requestError: message }]);
    await expect(client(URL)).rejects.toThrow(message);
    expect(sent).toHaveLength(1);
  });

  it('uses HTTPS by default, supplies the user agent and latches a Cloudflare challenge', async () => {
    const { client, sent } = defaultClient([{ status: 403, headers: { 'cf-mitigated': 'challenge' } }]);
    await expect(client(URL)).rejects.toBeInstanceOf(ThrustcurveChallengeError);
    await expect(client(URL + '?again')).rejects.toBeInstanceOf(ThrustcurveChallengeError);
    expect(sent).toHaveLength(1);
    expect(sent[0].options.headers).toEqual({ 'user-agent': 'mmrocket-sim-upstream-check' });
  });

  it('retries a 503 through HTTPS after Retry-After and the ordinary pace', async () => {
    const { client, sent, slept } = defaultClient([
      { status: 503, headers: { 'retry-after': '12' } }, { body: '{"recovered":true}' },
    ]);
    expect(await (await client(URL)).json()).toEqual({ recovered: true });
    expect(sent).toHaveLength(2);
    expect(slept).toEqual([5000, 12000]);
  });
});
