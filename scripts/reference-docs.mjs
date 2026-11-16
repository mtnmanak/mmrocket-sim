import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMachineProfile, resolveSetting } from './machine-profile.mjs';

export const REFERENCE_FOLDERS = [
  'User files', 'RCS Schematics', 'Loki Data', 'Flight Data', 'Screenshots',
  'Camera Shrouds', 'Motor Testing Docs', '2D_3D_Models', 'archive',
  'research/flights-2026-10-04', 'research/Boat-tails', 'research/api-minimal-2026-10-02',
];

// Test runners may serve import.meta.url through /@fs/. Anchor the default
// checkout at cwd first; callers measuring another checkout can inject it.
function repositoryRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    try { if (statSync(join(dir, 'version.json')).isFile()) return dir; } catch { /* keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try { return fileURLToPath(new URL('..', import.meta.url)); }
  catch { return process.cwd(); } // Non-file module URLs cannot anchor a checkout.
}

/** Ordered optional roots. Invalid/foreign profiles must not hide local docs. */
export function referenceRoots({ env = process.env, repoRoot = repositoryRoot() } = {}) {
  const roots = [];
  if (typeof env.MMRSIM_REFERENCE_ROOT === 'string' && env.MMRSIM_REFERENCE_ROOT) roots.push(env.MMRSIM_REFERENCE_ROOT);
  try {
    const { value } = resolveSetting({ key: 'repos.online_open_rocket.referenceDocs', env,
      profile: loadMachineProfile({ env }), isPath: true });
    if (typeof value === 'string') roots.push(value);
  } catch { /* Missing, stale, unreadable or foreign profile: try the checkout. */ }
  roots.push(join(repoRoot, 'docs'), join(repoRoot, '..', '..', 'online_open_rocket', 'docs'));
  return [...new Set(roots)];
}

const isDirectory = path => statSync(path).isDirectory();

/** First existing directory for a static reference folder, or null (CI). */
export function referenceDir(name, options = {}) {
  try {
    for (const root of referenceRoots(options)) {
      try {
        const path = join(root, name);
        if ((options.isDirectory ?? isDirectory)(path)) return path;
      } catch { /* An inaccessible candidate is not an available corpus. */ }
    }
  } catch { /* Optional reference discovery never throws. */ }
  return null;
}

/** A member of an optional folder; preserve null so callers can skip cleanly. */
export function referenceFile(name, ...parts) {
  const root = referenceDir(name);
  return root ? join(root, ...parts) : null;
}
