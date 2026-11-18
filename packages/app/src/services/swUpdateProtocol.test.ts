import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

const protocolFile = 'sw-update-protocol-v1.js';
const source = readFileSync(new URL(`../../public/${protocolFile}`, import.meta.url), 'utf8');

function scope(active: { postMessage: ReturnType<typeof vi.fn> } | null, clients: { url: string }[] = [], buildVersion?: unknown, install = true) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  class Channel {
    port1 = { close, onmessage: (_event: unknown) => {} };
    port2 = { close, reply: (data: unknown) => this.port1.onmessage({ data }) };
  }
  const matchAll = vi.fn().mockResolvedValue(clients);
  const fetchVersion = vi.fn();
  const context = { self: {
    registration: { active, scope: 'https://app.test/sim/' }, clients: { matchAll }, skipWaiting,
    addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; },
  }, fetch: fetchVersion, MessageChannel: Channel, setTimeout, clearTimeout, Promise };
  runInNewContext(source, context);
  if (buildVersion !== undefined) {
    runInNewContext(`self.__MMR_BUILD_VERSION = ${JSON.stringify(buildVersion)};`, context);
  }
  const waitUntil = vi.fn();
  if (install) handlers.install!({ waitUntil });
  return { handlers, skipWaiting, waitUntil, close, matchAll, fetchVersion };
}
afterEach(() => vi.useRealTimers());

it('pins the protocol filename and SHA-256: any content change requires a new filename', () => {
  expect({ name: protocolFile, sha256: createHash('sha256').update(source).digest('hex') },
    'content changed: rename the file to -v2 and update vite.config.ts').toEqual({
    name: 'sw-update-protocol-v1.js', sha256: '1558bcf56eccb063662e9420cc34b40696308af28e59b50bc665095b4dfa7f09',
  });
});
it('counts frozen and uncontrolled windows only inside this registration scope', async () => {
  const s = scope(null, [
    { url: 'https://app.test/sim/' }, { url: 'https://app.test/sim/?rocket=1' },
    { url: 'https://app.test/sim/other' }, { url: 'https://app.test/similar/' },
    { url: 'https://other.test/sim/' },
  ]);
  const postMessage = vi.fn();
  const waitUntil = vi.fn();
  s.handlers.message!({ data: { type: 'MMR_COUNT_WINDOWS' }, ports: [{ postMessage }], waitUntil });
  await waitUntil.mock.calls[0]![0];
  expect(s.matchAll).toHaveBeenCalledExactlyOnceWith({ type: 'window', includeUncontrolled: true });
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ windows: 3 });
  s.handlers.message!({ data: { type: 'MMR_COUNT_WINDOWS' }, ports: [], waitUntil });
  expect(s.matchAll).toHaveBeenCalledOnce();
});
it('old worker silent: skips waiting after exactly 10 s', async () => {
  vi.useFakeTimers();
  const postMessage = vi.fn();
  const s = scope({ postMessage });
  expect(postMessage.mock.calls[0]![0]).toEqual({ type: 'MMR_UPDATE_PROTOCOL' });
  expect(s.waitUntil).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(9999);
  expect(s.skipWaiting).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await s.waitUntil.mock.calls[0]![0];
  expect(s.skipWaiting).toHaveBeenCalledTimes(1);
  expect(s.close).toHaveBeenCalledTimes(2);
});
it.each([1, 2])('protocol %s waits for the user', async protocol => {
  vi.useFakeTimers();
  const s = scope({ postMessage: vi.fn((_message, ports) => ports[0].reply({ protocol })) });
  await s.waitUntil.mock.calls[0]![0];
  await vi.advanceTimersByTimeAsync(10000);
  expect(s.skipWaiting).not.toHaveBeenCalled();
});
it.each([null, {}, { protocol: 0 }, { protocol: '1' }])('invalid protocol %j uses the transition fallback', async reply => {
  const s = scope({ postMessage: vi.fn((_message, ports) => ports[0].reply(reply)) });
  await s.waitUntil.mock.calls[0]![0];
  expect(s.skipWaiting).toHaveBeenCalledOnce();
});
it('postMessage throwing skips waiting', async () => {
  const s = scope({ postMessage: vi.fn(() => { throw new Error('unsupported'); }) });
  await s.waitUntil.mock.calls[0]![0];
  expect(s.skipWaiting).toHaveBeenCalledOnce();
});
it('first install sends no message and does not skip waiting', () => {
  const s = scope(null);
  expect(s.waitUntil).not.toHaveBeenCalled();
  expect(s.fetchVersion).not.toHaveBeenCalled();
  expect(s.skipWaiting).not.toHaveBeenCalled();
});
it('answers protocol queries on their port and ignores unrelated messages', () => {
  const s = scope(null);
  const postMessage = vi.fn();
  s.handlers.message!({ data: { type: 'MMR_UPDATE_PROTOCOL' }, ports: [{ postMessage }] });
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ protocol: 1 });
  s.handlers.message!({ data: { type: 'OTHER' }, ports: [{ postMessage }] });
  s.handlers.message!({ data: { type: 'MMR_UPDATE_PROTOCOL' }, ports: [] });
  expect(postMessage).toHaveBeenCalledTimes(1);
});

it.each([true, false])('answers its baked build version with install event = %s', install => {
  // The build import runs after the protocol import, including worker restarts.
  const s = scope(null, [], '0.210', install);
  const postMessage = vi.fn();
  s.handlers.message!({ data: { type: 'MMR_VERSION' }, ports: [{ postMessage }] });
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ version: '0.210' });
  s.handlers.message!({ data: { type: 'MMR_VERSION' }, ports: [] });
  s.handlers.message!({ data: { type: 'OTHER' }, ports: [{ postMessage }] });
  expect(postMessage).toHaveBeenCalledOnce();
  expect(s.fetchVersion).not.toHaveBeenCalled();
  expect(s.waitUntil).not.toHaveBeenCalled();
});

it.each([undefined, null, 0.21, 210, '', 'v0.210', '210', '0.210suffix', '0..210', {}])(
  'reports unknown for a missing or malformed build global %j', buildVersion => {
    const s = scope(null, [], buildVersion);
    const postMessage = vi.fn();
    s.handlers.message!({ data: { type: 'MMR_VERSION' }, ports: [{ postMessage }] });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ version: null });
    expect(s.fetchVersion).not.toHaveBeenCalled();
    expect(s.waitUntil).not.toHaveBeenCalled();
  });
