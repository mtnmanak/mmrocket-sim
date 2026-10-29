import { setTextDecoderFactoryForTests } from '../../app/src/services/xmlUtil.js';
import { authenticatedWorker as worker } from './auth.testSupport.js';

// Test-only: the production worker in a runtime whose windows-1252 decoder takes the
// label but reads every byte as its own code point (ISO-8859-1, 0x99 as U+0099).
// decodeXml's probe must reject it, so the WHATWG name back shows the probe ran.
let windows1252Calls = 0;
setTextDecoderFactoryForTests(label => {
  const decoder = new TextDecoder(label);
  if (decoder.encoding !== 'windows-1252') return decoder;
  windows1252Calls++;
  return { encoding: 'windows-1252', fatal: false, ignoreBOM: false,
    decode: (input?: AllowSharedBufferSource) =>
      Array.from(input as Uint8Array, b => String.fromCharCode(b)).join('') } as TextDecoder;
});

// eslint-disable-next-line no-restricted-syntax -- Test-only Cloudflare module entry requires a default export.
export default {
  fetch(request: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/decoder-calls') return Promise.resolve(Response.json({ windows1252Calls }));
    return worker.fetch(request, env, ctx);
  },
};
