import { Inflate, strFromU8 } from 'fflate';

/**
 * The ONE zip reader for the design-file importers (.ork, and a .rkt someone
 * zipped). Both open UNTRUSTED files — a .ork is passed around the beta thread
 * and by email — and `unzipSync(bytes)` with no options inflates EVERY
 * central-directory entry into memory before anything looks at a single byte
 * of XML.
 *
 * That is the decompression-bomb vector shareLink.ts already documents for the
 * URL fragment (MAX_INFLATED_BYTES + inflateCapped, shareLink.ts:23-94):
 * DEFLATE tops out near 1032:1, so a 1 MB crafted archive expands to ~1 GB and
 * the tab dies on an allocation failure that NO try/catch around the import can
 * catch — App.tsx's included — so the user loses the design they had open with
 * nothing on screen saying why. shareLink's stream reader cannot serve this
 * path (it reads a raw-deflate stream, not a zip), hence this module.
 *
 * Three properties do the work, and all three matter:
 *
 *  - the central directory is walked HERE, bounded, not by fflate's
 *    `unzipSync`. Its enumeration loop trusts the entry count a zip64 end
 *    record declares (32 bits of it) and keeps going after the buffer ends —
 *    reads past the end return 0, so it never errors. The 8 September version
 *    of this file called that pass "free" because its filter returned false;
 *    it was not. A 98-byte crafted .ork declaring 2^32 entries grew the heap
 *    ~250 MB/s to an uncatchable out-of-memory crash, and without the array
 *    the loop alone was ~420 s of frozen main thread (audit 2026-09-22). The
 *    count is now refused before a single record is read when it passes
 *    MAX_ZIP_ENTRIES or cannot fit in the file at all (every record is at
 *    least CD_RECORD_BYTES long), and every record is bounds- and
 *    signature-checked as it is read.
 *  - EXACTLY ONE entry is ever inflated: the member the importer will actually
 *    read. Real .ork files carry megabytes of decals beside a small rocket.ork
 *    (ninja_4in_54mm-MMT.ork: 4.5 MB of PNG/JPG against 32 KB of XML), and a
 *    crafted one can park a bomb beside a small valid rocket.ork.
 *  - that entry is refused on its declared `originalSize` BEFORE anything is
 *    inflated, and then inflated as a STREAM, INFLATE_CHUNK compressed bytes
 *    at a time, stopping the moment the output passes that declared size. The
 *    declared size alone bounded memory but not time: `inflateSync` into a
 *    fixed buffer keeps decoding the member's TRUE stream and drops what does
 *    not fit, so a member whose directory size was patched small cost ~1.75 s
 *    of main thread per GB of real output — about two minutes at App's 64 MB
 *    file limit, behind a "page unresponsive" prompt (audit 2026-09-22).
 */

/**
 * Per-entry inflated-size ceiling.
 *
 * Deliberately far above shareLink's 4 MB fragment cap: a .ork's XML carries
 * every simulation's per-timestep `<databranch>`, so real files dwarf a shared
 * design. Measured across the 50-file .ork/.rkt corpus in this repo, the
 * largest member is the 15.16 MB `rocket.ork` inside
 * `Wildman Mach 2 this one.ork` (4.2 MB zipped) — a file posted to the beta
 * thread and the one this repo's bare-`auto` radius handling was written for.
 * 64 MiB clears that four times over while still bounding one allocation to
 * something a browser tab survives. Raise it only against a measured real
 * file, never to make a crafted one open.
 */
export const MAX_ZIP_MEMBER_BYTES = 64 * 1024 * 1024;

/**
 * Most central-directory entries an archive may declare. A real .ork holds the
 * rocket plus its decals — a handful of entries, a few dozen at most — so
 * 10,000 refuses nothing genuine while bounding the walk to milliseconds.
 */
export const MAX_ZIP_ENTRIES = 10_000;

/**
 * The fixed part of a central-directory record (APPNOTE 4.3.12), before its
 * name, extra field and comment. A declared count whose records cannot fit in
 * the file is a lie about the file, whatever the count.
 */
const CD_RECORD_BYTES = 46;

/**
 * Compressed bytes handed to the inflater per push. DEFLATE's ~1032:1 ceiling
 * means one push can still produce ~66 MB before the size check sees it, so
 * this bounds the overshoot rather than eliminating it.
 */
const INFLATE_CHUNK = 64 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

// Little-endian readers. A read past the end yields 0 (`undefined | 0`), the
// same convention fflate uses — which is exactly why every walk below checks
// its bounds explicitly instead of waiting for a signature to go missing.
const b2 = (d: Uint8Array, b: number): number => d[b]! | (d[b + 1]! << 8);
const b4 = (d: Uint8Array, b: number): number =>
  (d[b]! | (d[b + 1]! << 8) | (d[b + 2]! << 16) | (d[b + 3]! << 24)) >>> 0;
const b8 = (d: Uint8Array, b: number): number => b4(d, b) + b4(d, b + 4) * 4294967296;

/** One central-directory entry: what fflate's filter used to see, plus where it lives. */
interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; anything else is refused if it is chosen. */
  compression: number;
  /** Compressed size (bytes in the archive). */
  size: number;
  /** Declared inflated size — the number the cap is checked against. */
  originalSize: number;
  /** Offset of the entry's LOCAL header, after which its data begins. */
  localHeader: number;
}

/**
 * Walk the central directory, mirroring fflate 0.8.3 `unzipSync` record for
 * record (end-record search, zip64 locator, `z64hs` extra field, the UTF-8
 * name flag) so every real archive enumerates exactly as it did — but bounded:
 * the declared count is refused before the walk, and each record is checked
 * against the end of the file before it is read.
 */
function readCentralDirectory(d: Uint8Array, kind: string): ZipEntry[] {
  const damaged = (why: string) => new Error(`Not a readable ${kind} archive — ${why}.`);
  // The end record sits in the last 22 bytes plus at most a 65,535-byte comment.
  let e = d.length - 22;
  for (; b4(d, e) !== SIG_EOCD; --e) {
    if (e <= 0 || d.length - e > 65558) throw damaged('it has no end-of-directory record');
  }
  let count = b2(d, e + 8);
  let offset = b4(d, e + 16);
  let zip64 = false;
  if (e >= 20 && b4(d, e - 20) === SIG_ZIP64_LOCATOR) {
    const ze = b4(d, e - 12);
    if (ze + 56 <= d.length && b4(d, ze) === SIG_ZIP64_EOCD) {
      zip64 = true;
      count = b4(d, ze + 32);
      offset = b4(d, ze + 48);
    }
  }
  if (count > MAX_ZIP_ENTRIES) {
    throw new Error(`This archive lists ${count.toLocaleString('en-US')} entries, past the `
      + `${MAX_ZIP_ENTRIES.toLocaleString('en-US')} this app will read — that is not a rocket design.`);
  }
  if (count * CD_RECORD_BYTES > d.length) {
    throw damaged(`its directory lists ${count} entries, more than ${d.length} bytes can hold`);
  }
  const entries: ZipEntry[] = [];
  let o = offset;
  for (let i = 0; i < count; i++) {
    if (o + CD_RECORD_BYTES > d.length || b4(d, o) !== SIG_CENTRAL) {
      throw damaged(`directory entry ${i + 1} of ${count} is missing`);
    }
    const nameStart = o + CD_RECORD_BYTES;
    const extraStart = nameStart + b2(d, o + 28);
    const extraEnd = extraStart + b2(d, o + 30);
    const next = extraEnd + b2(d, o + 32); // + the entry comment
    if (next > d.length) {
      throw damaged(`directory entry ${i + 1} of ${count} runs past the end of the file`);
    }
    let size = b4(d, o + 20);
    let originalSize = b4(d, o + 24);
    let localHeader = b4(d, o + 42);
    const wideSize = size === 0xffffffff;
    const wideOriginal = originalSize === 0xffffffff;
    const wideOffset = localHeader === 0xffffffff;
    if (zip64 && (wideSize || wideOriginal || wideOffset)) {
      // The zip64 extra field (id 1) carries the 64-bit values in the fixed
      // order original size, compressed size, local-header offset — each
      // present only when its 32-bit field is saturated (fflate `z64hs`).
      let found = false;
      for (let x = extraStart; x + 4 < extraEnd; x += 4 + b2(d, x + 2)) {
        if (b2(d, x) !== 1) continue;
        if (wideOriginal) originalSize = b8(d, x + 4);
        if (wideSize) size = b8(d, x + 4 + 8 * Number(wideOriginal));
        if (wideOffset) localHeader = b8(d, x + 4 + 8 * (Number(wideOriginal) + Number(wideSize)));
        found = true;
        break;
      }
      if (!found) throw damaged(`directory entry ${i + 1} of ${count} has no zip64 sizes`);
    }
    entries.push({
      name: strFromU8(d.subarray(nameStart, extraStart), !(b2(d, o + 8) & 0x800)),
      compression: b2(d, o + 10),
      size,
      originalSize,
      localHeader,
    });
    o = next;
  }
  return entries;
}

/** Entries that are not design data and must never be chosen or inflated. */
function isUsableEntry(f: ZipEntry): boolean {
  if (f.name.endsWith('/')) return false; // directory record, zero bytes
  // macOS zips a file alongside `__MACOSX/._name` AppleDouble sidecars. One of
  // those sorting first is why a perfectly good .rkt used to decode as binary
  // junk and be reported to the user as an XML parse error.
  if (f.name.startsWith('__MACOSX/')) return false;
  return !(f.name.split('/').pop() ?? '').startsWith('._');
}

/**
 * Inflate the ONE member of `bytes` that the importer wants: the first entry
 * whose name ends in `extension`, else the first entry that is real data.
 *
 * `kind` names the format in the error messages (".ork" / ".rkt"); every one
 * of them reaches the user through App.tsx's "Could not open that … file: "
 * prefix.
 */
export function unzipMember(bytes: Uint8Array, extension: string, kind: string): Uint8Array {
  const usable = readCentralDirectory(bytes, kind).filter(isUsableEntry);
  const chosen = usable.find((f) => f.name.toLowerCase().endsWith(extension)) ?? usable[0];
  if (!chosen) throw new Error(`Empty ${kind} archive`);
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  if (chosen.originalSize > MAX_ZIP_MEMBER_BYTES) {
    throw new Error(
      `“${chosen.name}” in this archive expands to ${mb(chosen.originalSize)} MB, past the `
      + `${mb(MAX_ZIP_MEMBER_BYTES)} MB this app will open — that is not a rocket design.`);
  }
  const damaged = (why: string) =>
    new Error(`Not a readable ${kind} archive — “${chosen.name}” ${why}.`);
  const lh = chosen.localHeader;
  if (lh + 30 > bytes.length || b4(bytes, lh) !== SIG_LOCAL) throw damaged('has no local header');
  const start = lh + 30 + b2(bytes, lh + 26) + b2(bytes, lh + 28);
  const end = start + chosen.size;
  if (end > bytes.length) throw damaged('runs past the end of the file');

  // The declared size passed the cap above, so it IS the ceiling here: the
  // output buffer is sized from it (as fflate's `inflateSync(…, { out: new
  // u8(su) })` was), and output past it is refused instead of being decoded
  // and dropped.
  const overflow = new Error(
    `“${chosen.name}” in this archive inflates past the ${chosen.originalSize.toLocaleString('en-US')} `
    + 'bytes its directory declares — the archive is damaged or crafted, not a rocket design.');
  if (chosen.compression === 0) {
    if (chosen.size > chosen.originalSize) throw overflow;
    return bytes.slice(start, end);
  }
  if (chosen.compression !== 8) {
    throw damaged(`uses compression method ${chosen.compression}, which this app cannot read`);
  }
  const out = new Uint8Array(chosen.originalSize);
  let total = 0;
  const inflater = new Inflate((chunk) => {
    if (total + chunk.length > out.length) throw overflow;
    out.set(chunk, total);
    total += chunk.length;
  });
  try {
    for (let p = start; p < end; p += INFLATE_CHUNK) {
      const q = Math.min(p + INFLATE_CHUNK, end);
      inflater.push(bytes.subarray(p, q), q === end);
    }
  } catch (err) {
    if (err === overflow) throw err;
    // fflate's own errors ("invalid block type", "unexpected EOF") are real
    // but terse; say which archive member they are about.
    throw damaged(`is damaged (${err instanceof Error ? err.message : String(err)})`);
  }
  return out.subarray(0, total);
}
