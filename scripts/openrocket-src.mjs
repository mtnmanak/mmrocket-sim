/**
 * Locates the OpenRocket 24.12 reference source tree.
 *
 * The reference source is a large third-party checkout that deliberately lives
 * OUTSIDE this repository, so every machine keeps it somewhere different. That
 * location is personal, so it is not hard-coded here — this repo is public.
 *
 * Resolution order, first hit wins:
 *   1. an explicit path passed by the caller (a `--source` flag)
 *   2. the OPENROCKET_SRC environment variable
 *   3. a `.openrocket-src` file at the repo root — one line, the path to the
 *      openrocket-release-24.12 root. Gitignored; see .openrocket-src.example.
 *
 * Only the maintenance scripts need this (carving kernel sources, regenerating
 * the component-preset bundle). A normal `npm run build` does not: the compiled
 * kernel is committed at packages/engine/vendor/orkengine.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The configured openrocket-release-24.12 root, or null if none is set. */
export function openrocketSrcRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.OPENROCKET_SRC) return process.env.OPENROCKET_SRC;
  const pointer = join(repoRoot, '.openrocket-src');
  if (existsSync(pointer)) {
    const line = readFileSync(pointer, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (line) return line;
  }
  return null;
}

/**
 * The same, but exits with an actionable message rather than failing somewhere
 * deep in a walk with a confusing path.
 */
export function requireOpenrocketSrc(explicit, what = 'this script') {
  const root = openrocketSrcRoot(explicit);
  if (root && existsSync(root)) return root;
  console.error(
    `${what} needs the OpenRocket 24.12 reference source, and it was not found.\n`
    + (root ? `  Configured path does not exist: ${root}\n` : '  No path is configured.\n')
    + '\nSet one of:\n'
    + '  --source <path>                  (this run only)\n'
    + '  OPENROCKET_SRC=<path>            (environment)\n'
    + '  .openrocket-src at the repo root (one line; see .openrocket-src.example)\n'
    + '\nThe path is the openrocket-release-24.12 root — the directory containing core/.',
  );
  process.exit(1);
}
