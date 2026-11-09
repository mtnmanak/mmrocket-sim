import { writeFileSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Replace only after a complete sibling write; failed writes leave the old bytes intact. */
export function atomicWriteFileSync(path, data, options, io = { writeFileSync, renameSync, rmSync, statSync, chmodSync }) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    io.writeFileSync(temporary, data, options);
    let mode;
    try { mode = io.statSync(path).mode & 0o7777; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // New files already use writeFileSync's default 0666 filtered by umask.
    if (mode !== undefined) io.chmodSync(temporary, mode);
    io.renameSync(temporary, path);
  } finally {
    io.rmSync(temporary, { force: true });
  }
}
