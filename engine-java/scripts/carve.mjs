#!/usr/bin/env node
/**
 * Carve: copy the manifest-listed OpenRocket kernel sources verbatim into
 * src/carved/java. Idempotent; verifies existing copies match upstream so
 * accidental local edits of carved files are caught loudly.
 *
 * PATCHES: if patches/<same-relative-path> exists, THAT file is the source
 * of truth instead of upstream (used for TeaVM-classlib gaps and quirks-
 * ledger bug fixes). Every patch must be documented in patches/LEDGER.md.
 * The upstream file must still exist (so upstream updates that touch a
 * patched file are noticed at upgrade time).
 *
 * Usage: node scripts/carve.mjs [--source <path-to-openrocket-core-java-root>]
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, '..');

const DEFAULT_SOURCE =
  '<local path>/Open_Rocket_Source_Code/openrocket-release-24.12/core/src/main/java';

const argIdx = process.argv.indexOf('--source');
const sourceRoot = argIdx >= 0 ? process.argv[argIdx + 1] : DEFAULT_SOURCE;
const targetRoot = join(engineRoot, 'src', 'carved', 'java');

if (!existsSync(sourceRoot)) {
  console.error(`OpenRocket source not found at: ${sourceRoot}`);
  console.error('Download openrocket release-24.12 source and pass --source <core/src/main/java>.');
  process.exit(1);
}

const manifest = readFileSync(join(engineRoot, 'carve-manifest.txt'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let copied = 0;
let verified = 0;
let patched = 0;
let drifted = [];

for (const rel of manifest) {
  const upstream = join(sourceRoot, rel);
  const patchFile = join(engineRoot, 'patches', rel);
  const dst = join(targetRoot, rel);
  if (!existsSync(upstream)) {
    console.error(`MISSING upstream file: ${upstream}`);
    process.exit(1);
  }
  const isPatched = existsSync(patchFile);
  const src = isPatched ? patchFile : upstream;
  if (isPatched) patched++;
  if (existsSync(dst)) {
    if (sha(src) === sha(dst)) {
      verified++;
    } else if (isPatched) {
      // The patch file changed — refresh the carved copy from it.
      copyFileSync(src, dst);
      copied++;
    } else {
      drifted.push(rel);
    }
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied++;
  }
}

if (drifted.length) {
  console.error('DRIFT: carved copies differ from upstream (carved files must never be edited):');
  for (const f of drifted) console.error('  ' + f);
  console.error('Restore them via: delete the file and re-run carve. Patches belong in the quirks ledger.');
  process.exit(1);
}

console.log(`carve ok: ${copied} copied, ${verified} verified unchanged, ${patched} patched, ${manifest.length} total`);
