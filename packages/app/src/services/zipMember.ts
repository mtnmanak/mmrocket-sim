import { unzipSync, type UnzipFileInfo } from 'fflate';

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
 * Two properties do the work, and both matter:
 *
 *  - EXACTLY ONE entry is ever inflated: the member the importer will actually
 *    read. Real .ork files carry megabytes of decals beside a small rocket.ork
 *    (ninja_4in_54mm-MMT.ork: 4.5 MB of PNG/JPG against 32 KB of XML), and a
 *    crafted one can park a bomb beside a small valid rocket.ork.
 *  - the entry's declared `originalSize` is checked BEFORE it is inflated, and
 *    fflate sizes its output buffer from exactly that field
 *    (`inflateSync(…, { out: new u8(su) })`, fflate 0.8.3 unzipSync), so the
 *    cap BOUNDS the allocation instead of describing it afterwards. A filter
 *    that returns false skips the inflate entirely — the filter call is the
 *    `if` that guards it — which is why the enumeration pass below is free.
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

/** Entries that are not design data and must never be chosen or inflated. */
function isUsableEntry(f: UnzipFileInfo): boolean {
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
 * `kind` names the format in the two error messages (".ork" / ".rkt"); both
 * reach the user through App.tsx's "Could not open that … file: " prefix.
 */
export function unzipMember(bytes: Uint8Array, extension: string, kind: string): Uint8Array {
  // Pass 1 enumerates the central directory only. Returning false from the
  // filter inflates nothing, so a bomb is weighed without being carried.
  const entries: UnzipFileInfo[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      entries.push(f);
      return false;
    },
  });
  const usable = entries.filter(isUsableEntry);
  const chosen = usable.find((f) => f.name.toLowerCase().endsWith(extension)) ?? usable[0];
  if (!chosen) throw new Error(`Empty ${kind} archive`);
  const mb = (n: number) => Math.round(n / (1024 * 1024));
  if (chosen.originalSize > MAX_ZIP_MEMBER_BYTES) {
    throw new Error(
      `“${chosen.name}” in this archive expands to ${mb(chosen.originalSize)} MB, past the `
      + `${mb(MAX_ZIP_MEMBER_BYTES)} MB this app will open — that is not a rocket design.`);
  }
  // Pass 2 inflates that entry and nothing else. `taken` keeps a zip carrying
  // two entries of the same name from inflating both, and the size test is
  // repeated here so the cap holds on whichever record pass 2 actually meets.
  let taken = false;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (taken || f.name !== chosen.name || f.originalSize > MAX_ZIP_MEMBER_BYTES) return false;
      taken = true;
      return true;
    },
  });
  const out = files[chosen.name];
  if (!out) throw new Error(`Empty ${kind} archive`);
  return out;
}
