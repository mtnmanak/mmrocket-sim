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
 *   3. profile `openrocketSource` in ~/.machine/machine.json (or MACHINE_PROFILE)
 *   4. a deprecated `.openrocket-src` file at the repo root — one line, the path to the
 *      openrocket-release-24.12 root. Gitignored; see .openrocket-src.example.
 *
 * Only the maintenance scripts need this (carving kernel sources, regenerating
 * the component-preset bundle). A normal `npm run build` does not: the compiled
 * kernel is committed at packages/engine/vendor/orkengine.mjs.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyOpenrocketSource, loadMachineProfile, resolveSetting } from './machine-profile.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The configured openrocket-release-24.12 root, or null if none is set. */
export function openrocketSrcRoot(explicit, { env = process.env, repo = repoRoot } = {}) {
  return resolveSetting({ key: 'openrocketSource', flag: explicit, envVar: 'OPENROCKET_SRC', env,
    isPath: true, legacy: () => legacyOpenrocketSource(repo),
  }).value ?? null;
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
    + '  openrocketSource in machine profile ' + loadMachineProfile().path + '\n'
    + '  .openrocket-src at the repo root (deprecated) (one line; see .openrocket-src.example)\n'
    + '\nThe path is the openrocket-release-24.12 root — the directory containing core/.',
  );
  process.exit(1);
}
