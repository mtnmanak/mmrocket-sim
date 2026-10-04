import { Deflate, gunzipSync, gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { gunzipCapped, MAX_ZIP_ENTRIES, MAX_ZIP_MEMBER_BYTES, unzipMember } from './zipMember.js';

/**
 * The zip reader both design importers share, attacked directly. The import-
 * level tests (the right member is chosen, the declared-size cap, an empty
 * archive) live in orkFileHardening.test.ts and rocksimFileHardening.test.ts;
 * these are the archive-structure attacks from the 2026-09-22 audit, which
 * never reach an importer's own code at all.
 */

const u32 = (d: Uint8Array, at: number, v: number): void =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(at, v, true);
const u16 = (d: Uint8Array, at: number, v: number): void =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).setUint16(at, v, true);

/** Offset of the central-directory record for `name` (fields at +10, +24 …). */
function centralRecord(zip: Uint8Array, name: string): number {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let b = 0; b + 46 <= zip.length; b++) {
    if (dv.getUint32(b, true) !== 0x02014b50) continue;
    const nameLen = dv.getUint16(b + 28, true);
    if (new TextDecoder().decode(zip.subarray(b + 46, b + 46 + nameLen)) === name) return b;
  }
  throw new Error(`no central-directory record for ${name}`);
}

/**
 * The audit's 98-byte file: a zip64 end record declaring 2^32 - 1 entries, its
 * locator, and a classic end record whose own count is nonzero (fflate returns
 * an empty archive at once on a zero). Nothing else — no entry exists.
 */
function zip64CountBomb(): Uint8Array {
  const f = new Uint8Array(98);
  u32(f, 0, 0x06064b50); // [0,56) zip64 end-of-central-directory record
  u32(f, 32, 0xffffffff); //   total entries (the low 32 bits are what is read)
  u32(f, 48, 0); //            central directory offset
  u32(f, 56, 0x07064b50); // [56,76) zip64 locator
  u32(f, 64, 0); //            offset of the zip64 end record
  u32(f, 76, 0x06054b50); // [76,98) classic end record
  u16(f, 76 + 8, 1);
  return f;
}

/**
 * A single-member ZIP64 archive built by hand — fflate never writes one for a
 * small file, and real .ork writers do for large ones. Every 32-bit size and
 * offset field is saturated, so all three values come from the zip64 extra.
 */
function zip64Archive(name: string, data: Uint8Array, compressed: Uint8Array, method: number): Uint8Array {
  const nm = strToU8(name);
  const extra = new Uint8Array(4 + 24);
  u16(extra, 0, 1);
  u16(extra, 2, 24);
  u32(extra, 4, data.length); // original size (low word; high word 0)
  u32(extra, 12, compressed.length); // compressed size
  u32(extra, 20, 0); // local-header offset
  const local = new Uint8Array(30 + nm.length);
  u32(local, 0, 0x04034b50);
  u16(local, 8, method);
  u16(local, 26, nm.length);
  local.set(nm, 30);
  const central = new Uint8Array(46 + nm.length + extra.length);
  u32(central, 0, 0x02014b50);
  u16(central, 10, method);
  // ZIP and GZIP state the same CRC-32; use an independent writer for it.
  const gz = gzipSync(data);
  const crc = new DataView(gz.buffer, gz.byteOffset, gz.byteLength).getUint32(gz.length - 8, true);
  u32(local, 14, crc);
  u32(central, 16, crc);
  u32(central, 20, 0xffffffff);
  u32(central, 24, 0xffffffff);
  u16(central, 28, nm.length);
  u16(central, 30, extra.length);
  u32(central, 42, 0xffffffff);
  central.set(nm, 46);
  central.set(extra, 46 + nm.length);
  const cdOffset = local.length + compressed.length;
  const end64 = new Uint8Array(56);
  u32(end64, 0, 0x06064b50);
  u32(end64, 24, 1);
  u32(end64, 32, 1);
  u32(end64, 40, central.length);
  u32(end64, 48, cdOffset);
  const locator = new Uint8Array(20);
  u32(locator, 0, 0x07064b50);
  u32(locator, 8, cdOffset + central.length);
  const end = new Uint8Array(22);
  u32(end, 0, 0x06054b50);
  u16(end, 8, 0xffff);
  u16(end, 10, 0xffff);
  u32(end, 12, 0xffffffff);
  u32(end, 16, 0xffffffff);
  const parts = [local, compressed, central, end64, locator, end];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

describe('the central-directory walk is bounded', () => {
  it('refuses the 98-byte zip64 entry-count bomb at once, with words a user can read', () => {
    // Before: fflate's enumeration trusted the declared 4,294,967,295 and read
    // zeros past the end of a 98-byte buffer for ever — the heap grew ~250 MB/s
    // to an out-of-memory crash no try/catch can catch (reproduced 2026-09-22:
    // FATAL ERROR at a 256 MB heap). Now it is a thrown Error, which App.tsx
    // shows as "Could not open that .ork file: This archive lists …".
    const t0 = performance.now();
    expect(() => unzipMember(zip64CountBomb(), '.ork', '.ork'))
      .toThrow(/lists 4,294,967,295 entries, past the 10,000 this app will read/);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('refuses a count past MAX_ZIP_ENTRIES even when every record is real', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) files[`d/${i}`] = new Uint8Array(0);
    expect(() => unzipMember(zipSync(files, { level: 0 }), '.ork', '.ork'))
      .toThrow(/past the 10,000 this app will read/);
  });

  it('refuses a count the file has no room for', () => {
    // Under MAX_ZIP_ENTRIES, but 500 records of at least 46 bytes cannot fit
    // in a file this size: the directory is lying about the file.
    const zip = zipSync({ 'rocket.ork': strToU8('<openrocket/>') });
    u16(zip, zip.length - 22 + 8, 500);
    expect(() => unzipMember(zip, '.ork', '.ork')).toThrow(/Not a readable \.ork archive/);
  });

  it('refuses a directory record that is not where the end record says', () => {
    const zip = zipSync({ 'rocket.ork': strToU8('<openrocket/>') });
    u32(zip, zip.length - 22 + 16, 1); // central-directory offset -> inside the data
    expect(() => unzipMember(zip, '.ork', '.ork')).toThrow(/directory entry 1 of 1 is missing/);
  });

  it('refuses a file with no end record, instead of scanning past its start', () => {
    expect(() => unzipMember(strToU8('PK not a zip'), '.rkt', '.rkt'))
      .toThrow(/Not a readable \.rkt archive — it has no end-of-directory record/);
  });

  it('reads a real ZIP64 archive exactly as fflate does', () => {
    // All three sizes live in the zip64 extra field, the path the count bomb
    // shares its end records with — refusing the bomb must not refuse this.
    const data = strToU8(`<openrocket>${'x'.repeat(5000)}</openrocket>`);
    const deflated = zipSync({ 'rocket.ork': data });
    const cd = centralRecord(deflated, 'rocket.ork');
    const dv = new DataView(deflated.buffer);
    const compressedSize = dv.getUint32(cd + 20, true);
    const localNameLen = dv.getUint16(26, true) + dv.getUint16(28, true);
    const compressed = deflated.slice(30 + localNameLen, 30 + localNameLen + compressedSize);
    const zip = zip64Archive('rocket.ork', data, compressed, 8);
    expect(unzipSync(zip)['rocket.ork']).toEqual(data); // the fixture is a real zip64 file
    expect(unzipMember(zip, '.ork', '.ork')).toEqual(data);
    const stored = zip64Archive('rocket.ork', data, data, 0);
    expect(unzipMember(stored, '.ork', '.ork')).toEqual(data);
  });
});

describe('the chosen member is inflated as a bounded stream', () => {
  it('refuses a member that inflates past the size its directory declares', () => {
    // Before: `inflateSync` into a buffer of the declared size decoded the
    // member's WHOLE true stream and dropped what did not fit — 1,874 ms for a
    // gigabyte of real output behind a 1,000-byte declaration (measured
    // 2026-09-22), and then it RETURNED the truncated 1,000 bytes as though
    // they were the file. Now the stream stops at the declared size and says so.
    const zip = zipSync({ 'rocket.ork': new Uint8Array(4 * 1024 * 1024) });
    u32(zip, centralRecord(zip, 'rocket.ork') + 24, 1000);
    expect(() => unzipMember(zip, '.ork', '.ork'))
      .toThrow(/“rocket\.ork” in this archive inflates past the 1,000 bytes its directory declares/);
  });

  it('refuses a stored member longer than its declared size', () => {
    const zip = zipSync({ 'rocket.ork': [strToU8('<openrocket/>'), { level: 0 }] });
    u32(zip, centralRecord(zip, 'rocket.ork') + 24, 4);
    expect(() => unzipMember(zip, '.ork', '.ork')).toThrow(/inflates past the 4 bytes/);
  });

  it('names the member when its compressed data is damaged', () => {
    const zip = zipSync({ 'rocket.ork': strToU8('<openrocket>' + 'abc'.repeat(3000) + '</openrocket>') });
    const cd = centralRecord(zip, 'rocket.ork');
    const dataAt = 30 + new DataView(zip.buffer).getUint16(26, true) + new DataView(zip.buffer).getUint16(28, true);
    zip.fill(0xff, dataAt, dataAt + new DataView(zip.buffer).getUint32(cd + 20, true));
    expect(() => unzipMember(zip, '.ork', '.ork'))
      .toThrow(/Not a readable \.ork archive — “rocket\.ork” is damaged \(/);
  });

  it('returns exactly what unzipSync returns, across members, methods and sizes', () => {
    // Several KB of structured XML so the member spans more than one inflate
    // push; a stored decal beside it; and the member chosen by extension.
    const xml = strToU8(`<openrocket>${Array.from({ length: 40000 }, (_, i) =>
      `<p x="${i * 0.001}" y="${(i * 7919) % 1000}"/>`).join('')}</openrocket>`);
    const zip = zipSync({
      'decals/a.png': [new Uint8Array(3000).map((_, i) => (i * 31) & 255), { level: 0 }],
      'rocket.ork': xml,
    });
    const got = unzipMember(zip, '.ork', '.ork');
    expect(got.length).toBe(xml.length);
    const ref = unzipSync(zip)['rocket.ork']!;
    // A byte loop, not toEqual: a deep diff of a megabyte array costs a second.
    expect(got.every((b, i) => b === ref[i])).toBe(true);
  });
});

/**
 * A GZIP-compressed .ork (magic 1f 8b), the form older OpenRocket releases
 * saved, which desktop 24.12 still opens (audit 2026-09-30). A gzip states no
 * size it can be held to — its trailer is modulo 2^32 and describes only the
 * last member — so the only defence against a bomb is the stream itself.
 */
describe('a GZIP design file is inflated as a bounded stream', () => {
  const MIB = 1024 * 1024;
  const join = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  /**
   * `count` members of one mebibyte of zeros each, back to back: a valid
   * multi-member stream (desktop's GZIPInputStream reads them as one file)
   * that inflates about a thousand times over — ~1 KB per MiB.
   */
  const zeroMembers = (count: number): Uint8Array => {
    const one = gzipSync(new Uint8Array(MIB));
    return join(...Array.from({ length: count }, () => one));
  };

  it('returns exactly what gunzipSync returns, across many pushes', () => {
    const xml = strToU8(`<openrocket>${Array.from({ length: 40000 }, (_, i) =>
      `<p x="${i * 0.001}" y="${(i * 7919) % 1000}"/>`).join('')}</openrocket>`);
    const gz = gzipSync(xml);
    expect(gz.length).toBeGreaterThan(64 * 1024); // more than one push
    const got = gunzipCapped(gz, '.ork');
    expect(got.length).toBe(xml.length);
    const ref = gunzipSync(gz);
    expect(got.every((b, i) => b === ref[i])).toBe(true);
  });

  it('reads every member of a multi-member stream, as desktop does', () => {
    const got = gunzipCapped(join(gzipSync(strToU8('<openrocket>')), gzipSync(strToU8('</openrocket>'))), '.ork');
    expect(new TextDecoder().decode(got)).toBe('<openrocket></openrocket>');
  });

  it('refuses a file cut short, wherever it was cut, instead of passing on what it read', () => {
    // fflate's streaming Gunzip returns some truncations as a shorter file with
    // no error (measured: 179 of 2,418 cuts of this document) and checks no
    // trailer. Every cut must be refused, by fflate or by the trailer check.
    const gz = gzipSync(strToU8(`<openrocket>${Array.from({ length: 4000 }, (_, i) =>
      `<p x="${i * 0.001}" y="${(i * 7919) % 1000}"/>`).join('')}</openrocket>`));
    let passed = 0;
    let byTrailer = 0;
    for (let keep = 1; keep < gz.length; keep += 7) {
      try {
        gunzipCapped(gz.subarray(0, keep), '.ork');
        passed++;
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toMatch(/^Not a readable compressed \.ork file — it is damaged \(/);
        if (message.includes('does not match its own checksum')) byTrailer++;
      }
    }
    expect(passed).toBe(0);
    expect(byTrailer).toBeGreaterThan(0); // the cuts fflate alone lets through
    // One of them, measured: fflate returns 2,595 of its 9,025 bytes, no error.
    const small = gzipSync(strToU8(`<openrocket>${'abc'.repeat(3000)}</openrocket>`));
    expect(() => gunzipCapped(small.subarray(0, small.length - 20), '.ork'))
      .toThrow(/does not match its own checksum — the file is cut short or corrupted/);
  });

  /**
   * A stored (level 0) member — its text sits in the file as written — with
   * one character of that text replaced. Searched from past the 10-byte
   * header, whose timestamp is fixed here: gzipSync stamps the current time,
   * and a byte of the clock was once found instead of the text.
   */
  const storedWithTypo = (text: string, from: string, to: string): Uint8Array => {
    const gz = gzipSync(strToU8(text), { level: 0, mtime: 0 });
    const at = gz.indexOf(from.charCodeAt(0), 10);
    expect(at).toBeGreaterThan(10);
    expect(new TextDecoder().decode(gunzipCapped(gz, '.ork'))).toBe(text); // sound before the change
    gz[at] = to.charCodeAt(0);
    return gz;
  };

  it('refuses a member whose data no longer matches its checksum', () => {
    // Stored blocks inflate whatever bytes they hold, so a changed byte comes
    // back as a same-length file with one wrong character in it — the shape
    // that could open with a wrong number and nothing said.
    const gz = storedWithTypo('<openrocket><length>0.3</length></openrocket>', '3', '9');
    expect(() => gunzipCapped(gz, '.ork')).toThrow(/does not match its own checksum/);
  });

  it('checks every member’s trailer, not only the last one', () => {
    const first = storedWithTypo('<openrocket>', 'o', 'O');
    expect(() => gunzipCapped(join(first, gzipSync(strToU8('</openrocket>'))), '.ork'))
      .toThrow(/part 1 of 2 does not match its own checksum/);
  });

  it('refuses bytes after the last member', () => {
    // Stricter than desktop, whose GZIPInputStream skips bytes there that do
    // not begin another member: the last trailer is found at the end.
    const gz = gzipSync(strToU8('<openrocket/>'));
    for (const pad of [1, 2, 8]) {
      expect(() => gunzipCapped(join(gz, new Uint8Array(pad)), '.ork'), String(pad))
        .toThrow(/^Not a readable compressed \.ork file — it is damaged/);
    }
  });

  it('names a header it cannot read', () => {
    expect(() => gunzipCapped(new Uint8Array([0x1f, 0x8b, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0]), '.rkt'))
      .toThrow(/^Not a readable compressed \.rkt file — it is damaged \(invalid gzip data\)\.$/);
  });

  it('accepts output right up to the zip cap', () => {
    expect(MAX_ZIP_MEMBER_BYTES % MIB).toBe(0);
    expect(gunzipCapped(zeroMembers(MAX_ZIP_MEMBER_BYTES / MIB), '.ork').length).toBe(MAX_ZIP_MEMBER_BYTES);
  });

  it('refuses one byte past the cap, with words a user can read', () => {
    const bomb = join(zeroMembers(MAX_ZIP_MEMBER_BYTES / MIB), gzipSync(new Uint8Array(1)));
    expect(() => gunzipCapped(bomb, '.ork'))
      .toThrow(/^This compressed \.ork file expands past the 64 MB this app will open — that is not a rocket design\.$/);
  });

  it('stops at the cap WHILE inflating: nothing after it is ever decoded', () => {
    // Past the cap, then a member whose deflate data is garbage. Checked as
    // the stream runs, the cap refuses the file before the garbage is reached;
    // inflated whole and measured after, the garbage is reached first and the
    // refusal reads "damaged" — after the whole bomb was already in memory.
    const garbage = gzipSync(strToU8('<openrocket/>'));
    garbage.fill(0xff, 10, garbage.length - 8); // header kept, deflate data destroyed
    expect(() => gunzipCapped(garbage, '.ork')).toThrow(/damaged/); // the tail on its own
    const bomb = join(zeroMembers(MAX_ZIP_MEMBER_BYTES / MIB + 1), garbage);
    expect(() => gunzipCapped(bomb, '.ork')).toThrow(/expands past the 64 MB this app will open/);
  });

  it('stops at the cap WHILE inflating ONE member, not only between members', () => {
    // The test above holds at member granularity alone: fflate hands over each
    // member's output as that member ends, even when the whole file is pushed
    // at once. A bomb is as easily ONE member (zeros deflate about 1,000:1),
    // and pushed whole, all of it is inflated before the cap sees a byte: a
    // 519 KiB file of 512 MiB of zeros peaked at 1,075 MiB that way, against
    // 239 MiB in INFLATE_CHUNK pushes (measured 2026-10-01, Node 24).
    //
    // Built from one deflate segment of 1 MiB of zeros ending on a sync flush:
    // byte-aligned and referring to nothing before it, so copies back to back
    // are one sound stream.
    const segment = (() => {
      const parts: Uint8Array[] = [];
      const deflate = new Deflate((c) => { parts.push(c); });
      deflate.push(new Uint8Array(MIB), false);
      deflate.flush(true);
      return join(...parts);
    })();
    const header = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
    const sound = join(header, segment, segment,
      new Uint8Array([1, 0, 0, 0xff, 0xff]), // an empty final block
      gzipSync(new Uint8Array(2 * MIB)).subarray(-8)); // the trailer 2 MiB of zeros has
    expect(gunzipCapped(sound, '.ork').length).toBe(2 * MIB);
    // The same, then a block of type 3, which does not exist (0x07: BFINAL, type 3).
    const damagedAfter = (mib: number): Uint8Array => join(header,
      ...Array.from({ length: mib }, () => segment), new Uint8Array([0x07]), new Uint8Array(8));
    expect(() => gunzipCapped(damagedAfter(1), '.ork')).toThrow(/damaged \(invalid block type\)/);
    // 160 MiB in one member. Its first two 64 KiB pushes inflate past the cap
    // on their own, and the damage lies after them: in chunks the cap refuses
    // the file there; pushed whole, the damage is reached first and the file
    // is called damaged, once all 160 MiB has been held.
    const bomb = damagedAfter(160);
    const twoPushes = 2 * 64 * 1024;
    expect(Math.floor((twoPushes - header.length) / segment.length) * MIB).toBeGreaterThan(MAX_ZIP_MEMBER_BYTES);
    expect(bomb.length - 9).toBeGreaterThan(twoPushes); // where the 0x07 sits
    expect(() => gunzipCapped(bomb, '.ork')).toThrow(/expands past the 64 MB this app will open/);
  });
});


describe('ZIP member integrity', () => {
  const original = '<openrocket><radius>0.025</radius></openrocket>';
  const changed = original.replace('0.025', '0.095');

  it('refuses a stored member with a valid-text byte flipped', () => {
    const zip = zipSync({ 'rocket.ork': strToU8(original) }, { level: 0 });
    expect(new TextDecoder().decode(unzipMember(zip, '.ork', '.ork'))).toBe(original);
    const dv = new DataView(zip.buffer);
    const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    zip[start + original.indexOf('2')] = '9'.charCodeAt(0);
    expect(new TextDecoder().decode(unzipSync(zip)['rocket.ork'])).toBe(changed);
    expect(() => unzipMember(zip, '.ork', '.ork')).toThrow(/does not match its own checksum/);
  });

  it('refuses a deflated member re-zipped with a stale CRC', () => {
    const old = zipSync({ 'rocket.ork': strToU8(original) });
    const zip = zipSync({ 'rocket.ork': strToU8(changed) });
    const crc = new DataView(old.buffer).getUint32(centralRecord(old, 'rocket.ork') + 16, true);
    u32(zip, centralRecord(zip, 'rocket.ork') + 16, crc);
    u32(zip, 14, crc);
    expect(new TextDecoder().decode(unzipSync(zip)['rocket.ork'])).toBe(changed);
    expect(() => unzipMember(zip, '.ork', '.ork')).toThrow(/does not match its own checksum/);
  });

  it.each([0, 6] as const)('refuses a short member at compression level %i', (level) => {
    const zip = zipSync({ 'rocket.ork': strToU8(original) }, { level });
    u32(zip, centralRecord(zip, 'rocket.ork') + 24, original.length + 100);
    expect(() => unzipMember(zip, '.ork', '.ork')).toThrow(/does not match its declared size/);
  });
});
