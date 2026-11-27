import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Verify exactly the buffer the importer will receive, on each side's read. */
export function readVerifiedInput(file) {
  const data = readFileSync(file.path);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== file.sha256) throw new Error(`Corpus input changed since manifest: ${file.path}`);
  return data;
}
