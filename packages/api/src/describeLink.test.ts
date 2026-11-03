import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import { bytesOf, orkOf } from './fixtures.testSupport.js';
import { decodeShareFragment, MAX_INFLATED_BYTES } from '../../app/src/services/shareLink.js';

const appUrl = 'https://mmrsim.mountainmanrockets.com/';
const fetchSpy = vi.fn(() => { throw new Error('describe must not fetch'); });
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); expect(fetchSpy).not.toHaveBeenCalled(); });
const post = (body: Uint8Array) => worker.fetch(new Request('http://local/describe?filename=reference.ork',
  { method: 'POST', body: new Uint8Array(body).buffer }), {}, { waitUntil: () => {} });

it('puts the root path before the design fragment without a network request', async () => {
  const response = await post(bytesOf('reference.ork'));
  expect(response.status).toBe(200);
  const out = await response.json() as { link: string; fragment: string };
  expect(out.link).toBe(appUrl + out.fragment);
  expect(out.fragment).toMatch(/^#d=1\./);
  // The API emits the link; its reader is the app's shared codec, not an upload endpoint.
  const suffixed = new URL(out.link + '&motor=5f4294d2000231000000001d&delay=5');
  expect(await decodeShareFragment(suffixed.hash)).toBe(await decodeShareFragment(out.fragment));
});

it('points an oversized-link refusal to the same app root path', async () => {
  const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
  const body = orkOf(xml.replace('<rocket>', '<rocket><comment>' + 'x'.repeat(MAX_INFLATED_BYTES) + '</comment>'));
  const response = await post(body);
  expect(response.status).toBe(413);
  const out = await response.json() as { error: { code: string; message: string } };
  expect(out.error.code).toBe('LINK_TOO_LARGE');
  expect(out.error.message).toContain('Use ' + appUrl + ' with the file itself.');
});
