/**
 * Share-link codec: a whole .ork design travels inside the URL FRAGMENT as
 * `#d=<version>.<base64url(deflate-raw(xml))>`.
 *
 * The FRAGMENT is the deliberate choice of carrier: browsers never send it on
 * the wire, so a shared rocket touches no server log — and the service-worker
 * cache keys on the path, so one precached app shell serves every link.
 *
 * Framing: the payload starts with a version prefix ("1.") so the format can
 * evolve — a future encoder can switch algorithms and old builds fail with a
 * clear "newer version" message instead of feeding garbage to the inflater.
 * base64url has no '.', so the first '.' always delimits the version.
 *
 * Compression is the browser-native CompressionStream ('deflate-raw', no
 * zlib/gzip header — the framing already identifies the format, headers are
 * pure overhead in a URL). Node ≥ 21.2 has the same globals, so the unit
 * tests run the identical code path.
 */

const SHARE_PREFIX = '#d=';
const VERSION = '1';

/**
 * Decompression bomb cap. deflate's ~1000:1 ratio makes a 49 KB crafted
 * fragment inflate to 12 MB of perfectly valid XML (664 KB → 500 MB, 2.6 GB
 * RSS — measured), so the inflater must be stopped by OUTPUT size, not input
 * size. Real designs are tens of KB compressed and well under 4 MB as XML.
 */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/**
 * Cheap pre-decode sanity cap for callers holding the raw fragment: no
 * legitimate share link approaches 1 MB of base64url (the copy path already
 * warns at 64 KB), so anything longer is refused before base64/inflate ever
 * run. Characters, not bytes — the fragment is ASCII by construction.
 */
export const MAX_FRAGMENT_CHARS = 1024 * 1024;

/** Does this location.hash carry a share payload? */
export function hasSharePayload(hash: string): boolean {
  return hash.startsWith(SHARE_PREFIX);
}

/** Pump bytes through a CompressionStream and collect them. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Blob → stream → Response drains the transform without a hand-rolled
  // reader loop. Fine for COMPRESSION: output is smaller than the input the
  // app itself produced. Decompression must never use this path — it drains
  // the whole stream before any size can be checked (the bomb vector).
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The cap error keeps its message through decodeShareFragment's rewording. */
const BOMB_ERROR_NAME = 'ShareLinkInflateCapError';

/**
 * Inflate with a hard output cap: a manual reader loop that aborts the moment
 * the running total passes the cap, instead of materializing whatever the
 * stream expands to (Response.arrayBuffer() has no brake).
 */
async function inflateCapped(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_INFLATED_BYTES) {
        const err = new Error(
          `this link expands past ${MAX_INFLATED_BYTES / (1024 * 1024)} MB — that is not a rocket design`);
        err.name = BOMB_ERROR_NAME;
        throw err;
      }
      chunks.push(value);
    }
  } finally {
    // Stop the inflater the moment the loop exits early (cap or corrupt
    // stream); on a finished stream this is a resolved no-op.
    reader.cancel().catch(() => { /* already errored — nothing to release */ });
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  // Chunked: String.fromCharCode(...bytes) overflows the argument limit on
  // large designs (spread puts every byte on the call stack).
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  // atob throws on anything outside the alphabet — that IS the validation.
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a .ork XML string as a URL fragment ("#d=1.…"). */
export async function encodeShareFragment(xml: string): Promise<string> {
  const deflated = await deflate(new TextEncoder().encode(xml));
  return `${SHARE_PREFIX}${VERSION}.${toBase64Url(deflated)}`;
}

/**
 * Decode a share fragment (with or without the leading '#') back to the .ork
 * XML string. Throws on anything malformed — wrong shape, unknown version,
 * corrupt base64, truncated deflate stream — the caller turns that into a
 * user-facing note.
 */
export async function decodeShareFragment(hash: string): Promise<string> {
  const m = /^#?d=([0-9]+)\.(.+)$/.exec(hash);
  if (!m) throw new Error('not a share link (missing the d=<version>.<data> payload)');
  if (m[1] !== VERSION) {
    throw new Error(`this link was made by a newer version of the app (format ${m[1]})`);
  }
  let inflated: Uint8Array;
  try {
    inflated = await inflateCapped(fromBase64Url(m[2]!));
  } catch (e) {
    // The cap error already names its condition — let it through untouched.
    if (e instanceof Error && e.name === BOMB_ERROR_NAME) throw e;
    // Chromium surfaces a bad deflate stream as a generic "Failed to fetch"
    // (the stream read) — name the actual condition instead.
    throw new Error('the compressed data is corrupt or cut short');
  }
  return new TextDecoder().decode(inflated);
}
