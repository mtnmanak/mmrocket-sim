import { expect, it } from 'vitest';
import { gzipSync, unzipSync, zipSync } from 'fflate';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import { bytesOf } from './fixtures.testSupport.js';

const raw = unzipSync(bytesOf('reference.ork'))['rocket.ork']!;
const zip = (b: Uint8Array) => zipSync({ 'rocket.ork': b });
it.each(['/describe', '/experimental/fly'])('%s refuses nested archives as INVALID_FILE', async route => {
  for (const body of [zip(zip(raw)), zip(gzipSync(raw)), gzipSync(gzipSync(raw))]) {
    const response = await worker.fetch(new Request(`http://local${route}?filename=test.ork`, { method: 'POST', body }), undefined, { waitUntil: () => {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_FILE', message: expect.stringMatching(/nested archive/i) } });
  }
});
