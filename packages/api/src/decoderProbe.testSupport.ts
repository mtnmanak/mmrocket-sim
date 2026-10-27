/**
 * Test-only workerd entry: what this runtime's own TextDecoder does with
 * single-byte labels, as JSON. Recorded by encoding.test.ts, never asserted;
 * the app's decodeXml must not depend on it (xmlUtil.ts decodeWindows1252).
 */
const LABELS = ['windows-1252', 'iso-8859-1', 'latin1', 'l1', 'us-ascii', 'ascii', 'cp1252', 'iso_8859-1:1987',
  'utf-16le', 'utf-16be', 'iso-8859-2', 'windows-1251'];
const C1_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
const codePoints = (s: string) => Array.from(s, c => c.codePointAt(0)!);

export function probeDecoders() {
  return LABELS.map(label => {
    try {
      const decoder = new TextDecoder(label);
      return {
        label, encoding: decoder.encoding,
        decoded: codePoints(decoder.decode(C1_BYTES)),
        streamed: codePoints(new TextDecoder(label).decode(C1_BYTES, { stream: true })),
      };
    } catch (e) {
      return { label, threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  });
}

// eslint-disable-next-line no-restricted-syntax -- Test-only Cloudflare module entry requires a default export.
export default {
  fetch(): Response {
    return Response.json(probeDecoders());
  },
};
