import { statSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import { resolveSetting } from '../../../../scripts/machine-profile.mjs';

/** Optional local corpus: an explicit corpus root wins over the profile's Dropbox. */
export function rocksimCorpusPath() {
  try {
    const override = env['ROCKSIM_CORPUS'];
    const dropbox = override ? undefined : resolveSetting({ key: 'dropbox', isPath: true }).value;
    const root = override || (dropbox ? join(dropbox, 'Rocksim Designs') : null);
    return root && statSync(root).isDirectory() ? root : null;
  } catch {
    // CI, foreign profiles, stale paths and inaccessible folders all mean skip.
    return null;
  }
}
