import { addExMotors, parseMotorFile, type ExMotor } from './exMotors.js';

// @atestani TRF #162, Eric 2026-10-06: both pickers share parsing, storage and notices.
export async function importMotorFiles(files: File[]) {
  let notice: string | null = null;
  const motorFiles = files.filter((f) => /\.(eng|rse|txt)$/i.test(f.name));
  if (motorFiles.length === 0) {
    return { parsed: [], write: null, error: 'No .eng or .rse files found in that selection.', notice: null };
  }
  const parsed: ExMotor[] = [];
  const failed: string[] = [];
  /** What the parsers had to say about motors they DID import (a refused nozzle exit, …). */
  const said: string[] = [];
  for (const f of motorFiles) {
    try {
      const notes: string[] = [];
      parsed.push(...parseMotorFile(f.name, await f.text(), notes));
      said.push(...notes.map((n) => `${f.name}: ${n}`));
    } catch (e) {
      failed.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // ONE library write for the whole selection, not one per file: a folder of
  // fifty files rewrote an ever-growing list fifty times, and one write means
  // one honest answer to "did it save?".
  const imported = parsed.map((m) => m.designation);
  const write = parsed.length ? addExMotors(parsed) : null;
  const unsaved = write !== null && !write.stored;
  const some = (names: string[]) => `${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`;
  if (write?.duplicates.length) {
    said.push(`${some(write.duplicates)}: listed more than once with different data — each copy is kept `
      + 'as its own entry under the same name.');
  }
  if (write?.replaced.length) {
    said.push(`${write.replaced.length} replaced the library's earlier motor of the same maker and name `
      + `(${some(write.replaced)}).`);
  }
  const problems: string[] = [];
  if (write) {
    const list = `${imported.length} EX motor${imported.length === 1 ? '' : 's'} `
      + `(${imported.slice(0, 6).join(', ')}${imported.length > 6 ? ', …' : ''})`;
    // Say "survive reloads" only when they do (audit 2026-09-22). A full
    // browser storage used to be swallowed here, and the motors then could
    // not even fly: every reader went back to storage and found nothing.
    if (unsaved) {
      problems.push(`Imported ${list}, but this browser's storage is full or blocked, so they are NOT saved — `
        + 'they fly in this session and are gone after a reload. Free some room (the saved-runs '
        + 'table, or imported motors you no longer need) and import them again to keep them.');
      if (said.length) notice = said.join(' · ');
    } else {
      notice = `Imported ${list} — they live in this browser under manufacturer EX and survive reloads.`
        + (said.length ? ` ${said.join(' · ')}` : '');
    }
  }
  if (failed.length) {
    problems.push(`Skipped ${failed.length} file${failed.length === 1 ? '' : 's'} — ${failed.join(' · ')}`);
  }
  return { parsed, write, error: problems.length ? problems.join(' ') : null, notice };
}
