import { setTextDecoderFactoryForTests } from '../../app/src/services/xmlUtil.js';
import { worker } from './index.js';

// Test-only: the production worker in a runtime with no windows-1252 decoder, so
// decodeXml takes its built-in table (xmlUtil.ts decodeWindows1252) inside workerd.
setTextDecoderFactoryForTests(label => {
  const decoder = new TextDecoder(label);
  if (decoder.encoding === 'windows-1252') throw new RangeError(`The "${label}" encoding is not supported`);
  return decoder;
});

// eslint-disable-next-line no-restricted-syntax -- Test-only Cloudflare module entry requires a default export.
export default {
  fetch(request: Request, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },
};
