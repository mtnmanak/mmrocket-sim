import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Whether this module was invoked directly, including through a directory link. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
